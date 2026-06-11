import * as cheerio from 'cheerio';
import fs from 'fs-extra';
import path from 'path';
import type { ProjectConfig } from '../../core/config.js';
import {
  dbGetPagesByProject,
  dbGetProjectBySlug,
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
import { processMeta, rewriteInternalLinks } from './meta.js';
import { translateFragments, translateJsonLdValues } from './translator.js';

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
): Promise<TranslationResult> {
  const project = dbGetProjectBySlug(projectSlug);
  if (!project) throw new Error(`Project "${projectSlug}" not found`);

  const languages = targetLanguages ?? config.translation.targetLanguages;

  let pages = dbGetPagesByProject(project.id, 'captured');
  if (targetPageUrl) {
    pages = pages.filter((p) => p.url === targetPageUrl);
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

    const originalHtml = fs.readFileSync(originalHtmlPath, 'utf-8');

    for (const lang of languages) {
      try {
        const outputDir = config.paths.translations[lang];
        if (!outputDir) {
          logger.warn(`No output path configured for language: ${lang}`);
          continue;
        }

        // Extract translatable fragments
        const fragments = extractFragments(originalHtml, config.translation.maxFragmentTokens);

        // Translate fragments (uses cache)
        const { translatedTexts, cacheHits, cacheMisses } = await translateFragments(
          project.id,
          fragments,
          lang,
          config,
        );
        totalCacheHits += cacheHits;
        totalCacheMisses += cacheMisses;

        // Start with the original HTML
        let translatedHtml = originalHtml;

        // Inject fragment translations into the HTML
        translatedHtml = injectTranslations(translatedHtml, translatedTexts, fragments);

        // Create a simple translation function for meta tags
        const translateText = async (text: string): Promise<string> => {
          const cached = getCachedTranslation(project.id, text, lang);
          if (cached) return cached;
          const singleFragment = [{ id: 'meta_0', outerHtml: text, isAttribute: true }];
          const result = await translateFragments(project.id, singleFragment, lang, config);
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

        // Rewrite internal absolute links to the target language domain
        translatedHtml = rewriteInternalLinks(translatedHtml, lang, config);

        // Copy or symlink assets to the language directory
        await syncAssets(config.paths.original, outputDir, config.copyAssetsMode);

        // For sites that need the runtime patch (e.g. Next.js), generate translations.js
        const needsPatch = config.siteType === 'nextjs';
        if (needsPatch) {
          translatedHtml = injectRuntimePatchReferences(translatedHtml);
          const patchContent = generateRuntimePatch(fragments, translatedTexts);
          const patchPath = path.join(outputDir, path.dirname(pageRow.path), 'translations.js');
          fs.ensureDirSync(path.dirname(patchPath));
          fs.writeFileSync(patchPath, patchContent, 'utf-8');
        }

        // Save translated HTML
        const outputHtmlPath = path.join(outputDir, pageRow.path);
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

  return { pagesTranslated, pagesFailed, cacheHits: totalCacheHits, cacheMisses: totalCacheMisses };
}

// ─── Asset Sync ───────────────────────────────────────────────────────────────

/**
 * Copies or symlinks all asset content from original/ to the language directory.
 *
 * Assets now live at their natural root-relative paths (_next/, favicons/, _assets/, etc.)
 * rather than being nested under a single _assets/ prefix, so we sync the entire
 * originalDir tree.  HTML files are excluded — the translation step writes those.
 */
async function syncAssets(
  originalDir: string,
  targetDir: string,
  mode: 'copy' | 'symlink',
): Promise<void> {
  if (!fs.existsSync(originalDir)) return;

  if (mode === 'symlink') {
    // Create a symlink per top-level entry (skip HTML files)
    const entries = fs.readdirSync(originalDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.html')) continue;
      const src = path.join(originalDir, entry.name);
      const dst = path.join(targetDir, entry.name);
      if (!fs.existsSync(dst)) {
        fs.ensureDirSync(path.dirname(dst));
        fs.symlinkSync(src, dst);
      }
    }
  } else {
    // Copy everything; translated HTML will be written (and overwrite) separately
    fs.copySync(originalDir, targetDir, {
      overwrite: false,
      filter: (src: string) => !src.endsWith('.html'),
    });
  }
}

export { extractFragments } from './extractor.js';
export { translateFragments } from './translator.js';
export { injectTranslations, generateRuntimePatch } from './injector.js';
export { processMeta } from './meta.js';
