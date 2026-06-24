import * as cheerio from 'cheerio';
import type { ProjectConfig } from '../../core/config.js';
import { rewritePath } from '../../core/pathRewrite.js';

// ─── Link Rewriter ────────────────────────────────────────────────────────────

/** Ensures a base URL has an https:// scheme — config values may be bare hostnames. */
function normalizeBaseUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `https://${url}`;
}

function hasFileExtension(pathname: string): boolean {
  const segment = pathname.split('/').pop() ?? '';
  return /\.[a-z0-9]+$/i.test(segment);
}

/** Builds a normalized absolute URL from a pathname for set-membership checks. */
function toNormalizedUrl(pathname: string, origin: string, normalizeTrailingSlash: boolean): string {
  let p = pathname;
  if (normalizeTrailingSlash && p.endsWith('/') && p !== '/') {
    p = p.slice(0, -1);
  }
  return origin + p;
}

/**
 * Rewrites <a href> links in translated HTML with two goals:
 *
 * 1. Links to pages that ARE translated are rewritten to be root-relative
 *    URLs (e.g. /blog/) so they work in both local development/preview
 *    environments and production.
 *
 * 2. Links to pages that are NOT yet translated are rewritten to absolute URLs
 *    pointing to the original site (config.url), so users land on the real
 *    original page instead of a missing translated page.
 *
 * 3. Links to external domains listed in `config.domainMap` are rewritten
 *    to the mapped (translated) domain, keeping the original path/query/hash.
 */
export function rewriteLinks(
  html: string,
  pageUrl: string,
  targetLanguage: string,
  config: ProjectConfig,
  translatedUrlSet: Set<string>,
): string {
  const $ = cheerio.load(html);
  const originalOrigin = new URL(config.url).origin;
  const targetBaseUrl = config.targetUrls[targetLanguage];
  const targetOrigin = targetBaseUrl
    ? new URL(normalizeBaseUrl(targetBaseUrl)).origin
    : null;
  const pageBase = new URL(pageUrl);
  const normalizeSlash = config.crawl.normalizeTrailingSlash;
  let modified = false;

  // Pre-compute domain map entries (origin → origin) for cross-project links.
  // Each domainMap entry maps an external origin to a per-language translated origin;
  // we resolve only the entry for the current targetLanguage.
  const domainMapEntries: [string, string][] = [];
  if (config.domainMap) {
    for (const [from, langMap] of Object.entries(config.domainMap)) {
      const to = langMap[targetLanguage];
      if (!to) continue;
      try {
        domainMapEntries.push([new URL(normalizeBaseUrl(from)).origin, new URL(normalizeBaseUrl(to)).origin]);
      } catch { /* skip malformed entries */ }
    }
  }

  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href') ?? '';
    if (!raw || /^(#|mailto:|tel:|javascript:|data:)/i.test(raw)) return;

    let resolved: URL;
    try {
      resolved = new URL(raw, pageBase);
    } catch {
      return;
    }

    const isInternal = resolved.origin === originalOrigin || (targetOrigin && resolved.origin === targetOrigin);

    if (!isInternal) {
      // External links — check domain map for cross-project sibling sites
      for (const [fromOrigin, toOrigin] of domainMapEntries) {
        if (resolved.origin === fromOrigin) {
          $(el).attr('href', toOrigin + resolved.pathname + resolved.search + resolved.hash);
          modified = true;
          break;
        }
      }
      return;
    }

    const normalizedOriginalUrl = toNormalizedUrl(resolved.pathname, originalOrigin, normalizeSlash);

    if (translatedUrlSet.has(normalizedOriginalUrl)) {
      // Page IS translated: rewrite link to be root-relative.
      const rewrittenPathname = rewritePath(resolved.pathname, config.pathRewrite);
      const suffix = resolved.search + resolved.hash;

      $(el).attr('href', rewrittenPathname + suffix);
      modified = true;
    } else {
      // Page is NOT translated: make the link absolute to the original site
      // so the user is sent to the real original page.
      $(el).attr('href', normalizedOriginalUrl);
      modified = true;
    }
  });

  return modified ? $.html() : html;
}

