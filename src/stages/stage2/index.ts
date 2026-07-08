import * as cheerio from 'cheerio';
import fs from 'fs-extra';
import path from 'path';
import type { ProjectConfig } from '../../core/config.js';
import {
  dbGetPagesByProject,
  dbGetProjectBySlug,
  dbGetTranslatedPageUrls,
  dbGetTranslatedPages,
  dbUpsertPageTranslation,
} from '../../core/db.js';
import { logger } from '../../utils/logger.js';
import { getCachedTranslation, storeCachedTranslation } from './cache.js';
import { extractFragments } from './extractor.js';
import {
  generateRuntimePatch,
  injectRuntimePatchReferences,
  injectTranslations,
} from './injector.js';
import { rewritePath } from '../../core/pathRewrite.js';
import { rewriteLinks } from './linkRewriter.js';
import { processMeta } from './meta.js';
import { generateSitemap } from './sitemap.js';
import { translateCodeComments, translateFragments, translateJsonLdValues } from './translator.js';
import { applyPreTranslationInMemory, applyRule } from '../stage1/personalizer.js';
import { writeRedirectsTo } from '../stage1/redirects.js';
import { applyBrandFooter, applyInternalLinkingRules } from '../stage3/internalLinking.js';

// ─── Stage 2 Orchestrator ─────────────────────────────────────────────────────

export interface TranslationResult {
  pagesTranslated: number;
  pagesFailed: number;
  cacheHits: number;
  cacheMisses: number;
}

/**
 * Translates all captured pages for the given languages.
 * Reads from original/, writes to each language directory.
 * Supports resuming: skips pages already translated unless forced.
 */
export async function translateProject(
  projectSlug: string,
  config: ProjectConfig,
  targetLanguages?: string[],
  targetPageUrl?: string,
  onProgress?: (url: string, lang: string, done: number, total: number) => void,
  onFragmentProgress?: (done: number, total: number, tokens: number, url: string, lang: string, fragmentId: string) => void,
  isManualMode = false,
): Promise<TranslationResult> {
  const project = dbGetProjectBySlug(projectSlug);
  if (!project) throw new Error(`Project "${projectSlug}" not found`);

  const languages = targetLanguages ?? config.translation.targetLanguages;

  let pages = dbGetPagesByProject(project.id, ['captured', 'personalized']);
  if (targetPageUrl) {
    pages = pages.filter((p) => p.url === targetPageUrl);
  }

  // Pre-compute, per language, the set of URLs that are already translated in the DB
  // plus all pages being processed in this run. Links to URLs in this set keep their
  // relative form (or are rewritten to the target domain); links outside it are
  // rewritten to absolute URLs on the original site.
  const currentRunUrlSet = new Set(pages.map((p) => p.url));
  const translatedUrlSets = new Map<string, Set<string>>();
  for (const lang of languages) {
    const dbTranslated = dbGetTranslatedPageUrls(project.id, lang);
    const combinedUrls = new Set([...dbTranslated, ...currentRunUrlSet]);
    translatedUrlSets.set(lang, buildTranslatedUrlSet(combinedUrls, config));
  }

  const total = pages.length * languages.length;
  let done = 0;
  let pagesTranslated = 0;
  let pagesFailed = 0;
  let totalCacheHits = 0;
  let totalCacheMisses = 0;

  for (const pageRow of pages) {
    const originalHtmlPath = path.join(config.paths.original, pageRow.path);
    if (!fs.existsSync(originalHtmlPath)) {
      logger.warn(`Original HTML not found, skipping: ${originalHtmlPath}`);
      continue;
    }

    const rawHtml = fs.readFileSync(originalHtmlPath, 'utf-8');
    // Apply preTranslation rules in-memory — original/ is never modified
    const originalHtml = applyPreTranslationInMemory(rawHtml, config);

    for (const lang of languages) {
      try {
        const outputDir = config.paths.translations[lang];
        if (!outputDir) {
          logger.warn(`No output path configured for language: ${lang}`);
          continue;
        }

        // Extract translatable fragments (also returns HTML with data-sl-id attributes injected)
        const { html: taggedHtml, fragments } = extractFragments(
          originalHtml,
          config.translation.maxFragmentTokens,
        );

        // Translate fragments (uses cache)
        const { translatedTexts, cacheHits, cacheMisses } = await translateFragments(
          project.id,
          pageRow.path,
          fragments,
          lang,
          config,
          onFragmentProgress
            ? (done, total, tokens, fragmentId) => onFragmentProgress(done, total, tokens, pageRow.url, lang, fragmentId)
            : undefined,
          isManualMode,
        );
        totalCacheHits += cacheHits;
        totalCacheMisses += cacheMisses;

        // Start from the tagged HTML so injectTranslations can locate [data-sl-id] elements
        let translatedHtml = taggedHtml;

        // For sites that need the runtime patch (e.g. Next.js), avoid baking translations
        // statically into the HTML (see detailed explanation below).
        const needsPatch = config.siteType === 'nextjs';

        // For Next.js (and other hydrating frameworks), do NOT bake translated text/
        // attributes into the static HTML. That HTML must stay byte-structurally
        // identical to what the framework's embedded RSC/flight payload describes,
        // or hydration fails (React error #418: server/client text mismatch) and
        // React falls back to a full client-side re-render — discarding the static
        // translation entirely and reverting the page to the original language (and
        // wiping any DOM attributes our anti-FOUC scripts had set). The already
        // hydration-safe translations.js runtime patch (generated below) applies
        // these same translations to the DOM right after hydration completes, so
        // the on-disk HTML only needs the [data-sl-id]/[data-sl-attr] markers.
        if (!needsPatch) {
          // Inject fragment translations into the HTML
          translatedHtml = injectTranslations(translatedHtml, translatedTexts, fragments);
        }

        // Translate code comment spans inside <pre><code> blocks.
        // Skipped for hydrating frameworks for the same reason as above — the
        // runtime patch does not (yet) defend inline code comments, so translating
        // them statically would risk the same hydration mismatch.
        if (!needsPatch && config.translation.translateCodeBlockComments !== false) {
          const { html: commentHtml, cacheHits: chHits, cacheMisses: chMisses } =
            await translateCodeComments(translatedHtml, lang, project.id, config, isManualMode);
          translatedHtml = commentHtml;
          totalCacheHits += chHits;
          totalCacheMisses += chMisses;
        }

        // Create a simple translation function for meta tags
        const translateText = async (text: string): Promise<string> => {
          const cached = getCachedTranslation(project.id, text, lang, config);
          if (cached) return cached;
          const singleFragment = [{ id: 'meta_0', outerHtml: text, isAttribute: true }];
          const result = await translateFragments(project.id, pageRow.path, singleFragment, lang, config, undefined, isManualMode);
          return result.translatedTexts.get('meta_0') ?? text;
        };

        // Translate meta tags and inject hreflang
        translatedHtml = await processMeta(
          translatedHtml,
          pageRow.url,
          lang,
          config,
          translateText,
        );

        // Translate JSON-LD structured data
        const $ = cheerio.load(translatedHtml);
        $('script[type="application/ld+json"]').each((_i, el) => {
          try {
            const raw = $(el).html() ?? '{}';
            const data = JSON.parse(raw);
            // Build a simple text lookup from translations
            const textLookup = new Map<string, string>();
            for (const fragment of fragments) {
              const t = translatedTexts.get(fragment.id);
              if (t) textLookup.set(fragment.outerHtml, t);
            }
            const translated = translateJsonLdValues(data, textLookup);
            $(el).html(JSON.stringify(translated, null, 0));
          } catch {
            logger.warn(`Could not process JSON-LD for page: ${pageRow.url}`);
          }
        });
        translatedHtml = $.html();

        // Rewrite links: translated pages keep relative form (or target domain for absolute),
        // untranslated pages get absolute URLs pointing to the original site.
        translatedHtml = rewriteLinks(
          translatedHtml,
          pageRow.url,
          lang,
          config,
          translatedUrlSets.get(lang) ?? new Set(),
        );

        // Copy or symlink assets to the language directory
        await syncAssets(config.paths.original, outputDir, config.copyAssetsMode);

        // Apply path rewrite rules to determine the output location.
        // The source is always read from the original (unrewritten) path.
        const outputPath = rewritePath(pageRow.path, config.pathRewrite);

        // For sites that need the runtime patch (e.g. Next.js), generate translations.js
        if (needsPatch) {
          translatedHtml = injectRuntimePatchReferences(translatedHtml);
          const patchContent = generateRuntimePatch(fragments, translatedTexts, translatedHtml, config, lang);
          const patchPath = path.join(outputDir, path.dirname(outputPath), 'translations.js');
          fs.ensureDirSync(path.dirname(patchPath));
          fs.writeFileSync(patchPath, patchContent, 'utf-8');
        }

        // Apply postTranslation personalization rules
        const postRules = config.personalization.postTranslation;
        const conversionLinks = config.internalLinking?.links ?? [];
        const defaultLinkTemplate = config.internalLinking?.defaultLinkTemplate;
        const brandFooterHtml = config.internalLinking?.brandFooterHtml;
        if (postRules.length > 0 || conversionLinks.length > 0 || brandFooterHtml) {
          const $rules = cheerio.load(translatedHtml);
          let modified = false;
          for (const rule of postRules) {
            if (rule.languages && !rule.languages.includes(lang)) continue;
            const count = applyRule($rules, rule);
            if (count > 0) {
              modified = true;
            }
          }
          if (conversionLinks.length > 0) {
            const pagePathname = new URL(pageRow.url).pathname;
            const linkCount = applyInternalLinkingRules($rules, conversionLinks, pagePathname, lang, defaultLinkTemplate);
            if (linkCount > 0) modified = true;
          }
          if (applyBrandFooter($rules, brandFooterHtml)) {
            modified = true;
          }
          if (modified) {
            translatedHtml = $rules.html();
          }
        }

        // Save translated HTML
        const outputHtmlPath = path.join(outputDir, outputPath);
        fs.ensureDirSync(path.dirname(outputHtmlPath));
        fs.writeFileSync(outputHtmlPath, translatedHtml, 'utf-8');

        // Update DB translation status
        dbUpsertPageTranslation(pageRow.id, lang, 'translated', pageRow.checksum ?? undefined);

        pagesTranslated++;
        done++;
        onProgress?.(pageRow.url, lang, done, total);
        logger.debug(`Translated [${lang}]: ${pageRow.url}`);
      } catch (err) {
        logger.error(`Failed to translate [${lang}] ${pageRow.url}: ${(err as Error).message}`);
        dbUpsertPageTranslation(pageRow.id, lang, 'failed');
        pagesFailed++;
        done++;
      }
    }
  }

  // Retroactively update links in previously translated pages that are not in the current run
  for (const lang of languages) {
    const outputDir = config.paths.translations[lang];
    if (!outputDir) continue;

    const allTranslatedPages = dbGetTranslatedPages(project.id, lang);
    const finalTranslatedUrlSet = buildTranslatedUrlSet(allTranslatedPages.map((p) => p.url), config);

    const pagesToUpdate = allTranslatedPages.filter((p) => !currentRunUrlSet.has(p.url));

    for (const page of pagesToUpdate) {
      const outputPath = rewritePath(page.path, config.pathRewrite);
      const outputHtmlPath = path.join(outputDir, outputPath);
      if (!fs.existsSync(outputHtmlPath)) {
        continue;
      }

      try {
        const html = fs.readFileSync(outputHtmlPath, 'utf-8');
        const updatedHtml = rewriteLinks(
          html,
          page.url,
          lang,
          config,
          finalTranslatedUrlSet,
        );

        if (updatedHtml !== html) {
          fs.writeFileSync(outputHtmlPath, updatedHtml, 'utf-8');
          logger.debug(`Updated links in previously translated page [${lang}]: ${page.url}`);
        }
      } catch (err) {
        logger.warn(
          `Failed to update links in previously translated page [${lang}] ${page.url}: ${(err as Error).message}`,
        );
      }
    }
  }

  // Generate sitemap.xml and _redirects for each language using ALL translated pages in the DB
  for (const lang of languages) {
    const outputDir = config.paths.translations[lang];
    if (!outputDir) continue;
    const allTranslatedUrls = dbGetTranslatedPageUrls(project.id, lang);
    if (allTranslatedUrls.length > 0) {
      generateSitemap(outputDir, config.url, config.targetUrls[lang] ?? '', allTranslatedUrls, config.pathRewrite);
      logger.debug(`Sitemap written: ${outputDir}/sitemap.xml (${allTranslatedUrls.length} URLs)`);
    }
    writeRedirectsTo(outputDir, project.slug, config.pathRewrite);
    logger.debug(`Redirects written: ${outputDir}/_redirects`);
  }

  return { pagesTranslated, pagesFailed, cacheHits: totalCacheHits, cacheMisses: totalCacheMisses };
}

// ─── Post-Processing Reapplication ────────────────────────────────────────────

export interface ReapplyResult {
  pagesProcessed: number;
  pagesFailed: number;
}

/**
 * Re-applies all post-translation processing steps to already-translated pages
 * without re-running the translation itself. Useful when config changes
 * (pathRewrite, domainMap, postTranslation rules) need to be applied to existing
 * translated HTML files.
 *
 * Steps per page/language:
 *  1. Reads the translated HTML from disk.
 *  2. Re-applies rewriteLinks() (handles domainMap + pathRewrite for <a href>).
 *  3. Refreshes the <html lang> attribute and hreflang <link> tags.
 *  4. Re-applies postTranslation personalization rules.
 *  5. Writes the updated HTML back to the output path.
 *
 * Also regenerates sitemap.xml for each language.
 */
export async function reapplyPostProcessing(
  projectSlug: string,
  config: ProjectConfig,
  targetLanguages?: string[],
  targetPageUrl?: string,
): Promise<ReapplyResult> {
  const project = dbGetProjectBySlug(projectSlug);
  if (!project) throw new Error(`Project "${projectSlug}" not found`);

  const languages = targetLanguages ?? config.translation.targetLanguages;
  const postRules = config.personalization.postTranslation;
  const conversionLinks = config.internalLinking?.links ?? [];
  const defaultLinkTemplate = config.internalLinking?.defaultLinkTemplate;
  const brandFooterHtml = config.internalLinking?.brandFooterHtml;

  let pagesProcessed = 0;
  let pagesFailed = 0;

  for (const lang of languages) {
    const outputDir = config.paths.translations[lang];
    if (!outputDir) {
      logger.warn(`No output path configured for language: ${lang}`);
      continue;
    }

    // Fetch all translated pages from the DB for this language
    let translatedPages = dbGetTranslatedPages(project.id, lang);
    if (targetPageUrl) {
      translatedPages = translatedPages.filter((p) => p.url === targetPageUrl);
    }

    if (translatedPages.length === 0) {
      logger.info(`No translated pages found for language: ${lang}`);
      continue;
    }

    // Build the full translated URL set for accurate link rewriting
    const allTranslatedUrls = dbGetTranslatedPageUrls(project.id, lang);
    const translatedUrlSet = buildTranslatedUrlSet(allTranslatedUrls, config);

    for (const page of translatedPages) {
      const outputPath = rewritePath(page.path, config.pathRewrite);
      const outputHtmlPath = path.join(outputDir, outputPath);

      if (!fs.existsSync(outputHtmlPath)) {
        logger.warn(`Translated file not found, skipping: ${outputHtmlPath}`);
        continue;
      }

      try {
        let html = fs.readFileSync(outputHtmlPath, 'utf-8');

        // Re-apply link rewriting (domainMap + pathRewrite for <a href>)
        html = rewriteLinks(html, page.url, lang, config, translatedUrlSet);

        // Refresh <html lang> attribute and hreflang <link> tags
        // (Remove existing hreflang links and re-inject with current config/pathRewrite)
        const $meta = cheerio.load(html);
        $meta('html').attr('lang', lang);
        $meta('link[hreflang]').remove();
        const pagePath = new URL(page.url).pathname;
        const rewrittenPagePath = rewritePath(pagePath, config.pathRewrite);
        $meta('head').append(
          `<link rel="alternate" hreflang="${config.translation.sourceLanguage}" href="${config.url}${pagePath}" />`,
        );
        for (const [hrefLang, baseUrl] of Object.entries(config.targetUrls)) {
          const normalizedBase = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
          $meta('head').append(
            `<link rel="alternate" hreflang="${hrefLang}" href="${normalizedBase}${rewrittenPagePath}" />`,
          );
        }
        $meta('head').append(
          `<link rel="alternate" hreflang="x-default" href="${config.url}${pagePath}" />`,
        );
        html = $meta.html();

        // Re-apply postTranslation personalization rules
        if (postRules.length > 0 || conversionLinks.length > 0 || brandFooterHtml) {
          const $rules = cheerio.load(html);
          for (const rule of postRules) {
            // Skip rules restricted to other languages
            if (rule.languages && !rule.languages.includes(lang)) continue;
            applyRule($rules, rule);
          }
          if (conversionLinks.length > 0) {
            applyInternalLinkingRules($rules, conversionLinks, pagePath, lang, defaultLinkTemplate);
          }
          applyBrandFooter($rules, brandFooterHtml);
          html = $rules.html();
        }

        // Write the updated HTML back to disk
        fs.ensureDirSync(path.dirname(outputHtmlPath));
        fs.writeFileSync(outputHtmlPath, html, 'utf-8');
        pagesProcessed++;
        logger.debug(`Re-applied post-processing [${lang}]: ${page.url}`);
      } catch (err) {
        logger.warn(`Failed to re-apply post-processing [${lang}] ${page.url}: ${(err as Error).message}`);
        pagesFailed++;
      }
    }

    // Regenerate sitemap.xml and rewritten _redirects for this language
    const allUrls = dbGetTranslatedPageUrls(project.id, lang);
    if (allUrls.length > 0) {
      generateSitemap(outputDir, config.url, config.targetUrls[lang] ?? '', allUrls, config.pathRewrite);
      logger.debug(`Sitemap regenerated: ${outputDir}/sitemap.xml (${allUrls.length} URLs)`);
    }
    writeRedirectsTo(outputDir, project.slug, config.pathRewrite);
    logger.debug(`Redirects regenerated: ${outputDir}/_redirects`);
  }

  return { pagesProcessed, pagesFailed };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildTranslatedUrlSet(urls: Iterable<string>, config: ProjectConfig): Set<string> {
  const set = new Set<string>();
  const originalOrigin = new URL(config.url).origin;
  const normalizeSlash = config.crawl.normalizeTrailingSlash;

  for (const url of urls) {
    try {
      const u = new URL(url);
      
      // 1. Original normalized URL
      let p1 = u.pathname;
      if (normalizeSlash && p1.endsWith('/') && p1 !== '/') {
        p1 = p1.slice(0, -1);
      }
      set.add(originalOrigin + p1);
      
      // 2. Rewritten normalized URL (if different)
      const rewrittenPath = rewritePath(u.pathname, config.pathRewrite);
      if (rewrittenPath !== u.pathname) {
        let p2 = rewrittenPath;
        if (normalizeSlash && p2.endsWith('/') && p2 !== '/') {
          p2 = p2.slice(0, -1);
        }
        set.add(originalOrigin + p2);
      }
    } catch {
      // Skip invalid URLs
    }
  }
  return set;
}

// ─── Asset Sync ───────────────────────────────────────────────────────────────

/**
 * Copies or symlinks all asset content recursively from original/ to the language directory.
 * Excludes HTML pages, sitemaps, and redirects to avoid polluting target directories.
 */
async function syncAssets(
  originalDir: string,
  targetDir: string,
  mode: 'copy' | 'symlink',
): Promise<void> {
  if (!fs.existsSync(originalDir)) return;

  const recursiveSync = (srcDir: string, destDir: string) => {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      if (entry.isDirectory()) {
        recursiveSync(srcPath, destPath);
      } else if (entry.isFile()) {
        const nameLower = entry.name.toLowerCase();
        // Ignore html files, redirects, and sitemaps
        if (nameLower.endsWith('.html') || nameLower.endsWith('.htm')) continue;
        if (nameLower === '_redirects' || nameLower === 'sitemap.xml') continue;

        let pathExists = false;
        try {
          fs.lstatSync(destPath);
          pathExists = true;
        } catch {}

        if (!pathExists) {
          fs.ensureDirSync(destDir);
          if (mode === 'symlink') {
            fs.symlinkSync(srcPath, destPath);
          } else {
            fs.copySync(srcPath, destPath);
          }
        }
      }
    }
  };

  recursiveSync(originalDir, targetDir);
}

export { extractFragments } from './extractor.js';
export { translateFragments } from './translator.js';
export { injectTranslations, generateRuntimePatch } from './injector.js';
export { processMeta } from './meta.js';
