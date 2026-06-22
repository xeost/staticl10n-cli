import * as cheerio from 'cheerio';
import type { ProjectConfig } from '../../core/config.js';

// ─── Meta Tag Handler ─────────────────────────────────────────────────────────

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
  const metaSelectors: Array<[string, string]> = [
    ['meta[name="description"]', 'content'],
    ['meta[property="og:title"]', 'content'],
    ['meta[property="og:description"]', 'content'],
    ['meta[property="og:site_name"]', 'content'],
    ['meta[name="twitter:title"]', 'content'],
    ['meta[name="twitter:description"]', 'content'],
  ];

  for (const [selector, attrName] of metaSelectors) {
    const el = $(selector);
    if (el.length) {
      const original = el.attr(attrName) ?? '';
      if (original.trim()) {
        el.attr(attrName, await translateText(original));
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

  // Inject original language link
  $('head').append(
    `<link rel="alternate" hreflang="${config.translation.sourceLanguage}" href="${config.url}${pagePath}" />`,
  );

  // Inject a link for each target language
  for (const [lang, baseUrl] of Object.entries(config.targetUrls)) {
    $('head').append(
      `<link rel="alternate" hreflang="${lang}" href="${normalizeBaseUrl(baseUrl)}${pagePath}" />`,
    );
  }

  // x-default points to the original domain
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
