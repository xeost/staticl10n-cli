import * as cheerio from 'cheerio';
import type { ProjectConfig } from '../../core/config.js';
import { rewritePath } from '../../core/pathRewrite.js';
import type { HtmlFragment } from './extractor.js';

// ─── Meta Tag Handler ─────────────────────────────────────────────────────────

export const META_SELECTORS: Array<{ selector: string; attrName: string; id: string }> = [
  { selector: 'meta[name="description"]', attrName: 'content', id: 'meta_desc' },
  { selector: 'meta[property="og:title"]', attrName: 'content', id: 'meta_og_title' },
  { selector: 'meta[property="og:description"]', attrName: 'content', id: 'meta_og_desc' },
  { selector: 'meta[property="og:site_name"]', attrName: 'content', id: 'meta_og_site_name' },
  { selector: 'meta[name="twitter:title"]', attrName: 'content', id: 'meta_twitter_title' },
  { selector: 'meta[name="twitter:description"]', attrName: 'content', id: 'meta_twitter_desc' },
];

/**
 * Extracts title and metadata tags text from original HTML to include them as manual translation fragments.
 */
export function extractMetaFragments(html: string): HtmlFragment[] {
  const $ = cheerio.load(html);
  const metaFrags: HtmlFragment[] = [];

  // 1. Title
  const titleEl = $('head > title');
  if (titleEl.length) {
    const original = titleEl.text().trim();
    if (original) {
      metaFrags.push({
        id: 'meta_title',
        outerHtml: original,
        isAttribute: false,
      });
    }
  }

  // 2. Meta tags
  for (const item of META_SELECTORS) {
    const el = $(item.selector);
    if (el.length) {
      const original = el.attr(item.attrName) ?? '';
      if (original.trim()) {
        metaFrags.push({
          id: item.id,
          outerHtml: original.trim(),
          isAttribute: true,
          attributeName: item.attrName,
        });
      }
    }
  }

  return metaFrags;
}

/**
 * Updates the HTML lang attribute, translates SEO meta tags,
 * and injects hreflang alternate links for all configured languages.
 */
export async function processMeta(
  html: string,
  pageUrl: string,
  targetLanguage: string,
  config: ProjectConfig,
  translateText: (text: string) => Promise<string>,
): Promise<string> {
  const $ = cheerio.load(html);

  // Update <html lang="...">
  $('html').attr('lang', targetLanguage);

  // Translate <title> — scope to head only; body may contain SVG <title> accessibility elements
  const titleEl = $('head > title');
  if (titleEl.length) {
    const original = titleEl.text().trim();
    if (original) {
      titleEl.text(await translateText(original));
    }
  }

  // Translate key meta tags
  for (const item of META_SELECTORS) {
    const el = $(item.selector);
    if (el.length) {
      const original = el.attr(item.attrName) ?? '';
      if (original.trim()) {
        el.attr(item.attrName, await translateText(original));
      }
    }
  }

  // Inject hreflang alternate links
  injectHreflangLinks($, pageUrl, config);

  return $.html();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Ensures a base URL has an https:// scheme — config values may be bare hostnames. */
function normalizeBaseUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `https://${url}`;
}

/** Injects hreflang <link> tags for all configured languages plus x-default. */
function injectHreflangLinks(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  config: ProjectConfig,
): void {
  // Remove any existing hreflang links to avoid duplicates on re-runs
  $('link[hreflang]').remove();

  const pagePath = new URL(pageUrl).pathname;
  // Path rewrite is applied for target-language URLs (translated output).
  // The source language and x-default always point to the original site with the original path.
  const rewrittenPagePath = rewritePath(pagePath, config.pathRewrite);

  // Inject original language link (original path — no rewrite)
  $('head').append(
    `<link rel="alternate" hreflang="${config.translation.sourceLanguage}" href="${config.url}${pagePath}" />`,
  );

  // Inject a link for each target language (rewritten path)
  for (const [lang, baseUrl] of Object.entries(config.targetUrls)) {
    $('head').append(
      `<link rel="alternate" hreflang="${lang}" href="${normalizeBaseUrl(baseUrl)}${rewrittenPagePath}" />`,
    );
  }

  // x-default points to the original domain (original path — no rewrite)
  $('head').append(
    `<link rel="alternate" hreflang="x-default" href="${config.url}${pagePath}" />`,
  );
}

/** Rewrites absolute internal links in the HTML to point to the target language domain. */
export function rewriteInternalLinks(
  html: string,
  targetLanguage: string,
  config: ProjectConfig,
): string {
  const $ = cheerio.load(html);
  const targetBaseUrl = config.targetUrls[targetLanguage];

  if (!targetBaseUrl) return html;

  const originalOrigin = new URL(config.url).origin;
  const targetOrigin = new URL(normalizeBaseUrl(targetBaseUrl)).origin;

  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href') ?? '';
    if (href.startsWith(originalOrigin)) {
      $(el).attr('href', href.replace(originalOrigin, targetOrigin));
    }
  });

  return $.html();
}
