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
  if (normalizeTrailingSlash && !p.endsWith('/') && !hasFileExtension(p)) {
    p += '/';
  }
  return origin + p;
}

/**
 * Rewrites <a href> links in translated HTML with two goals:
 *
 * 1. Links to pages that ARE in `translatedUrlSet` and were written as absolute
 *    URLs pointing to the original site (config.url) are rewritten to the
 *    target language domain, preserving the existing behavior of rewriteInternalLinks.
 *
 * 2. Links to pages that are NOT yet translated are rewritten to absolute URLs
 *    pointing to the original site (config.url), so users land on the real
 *    original page instead of a missing translated page.
 *
 * Relative links to translated pages are left unchanged (they resolve correctly
 * when served from the translated domain).
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

  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href') ?? '';
    if (!raw || /^(#|mailto:|tel:|javascript:|data:)/i.test(raw)) return;

    let resolved: URL;
    try {
      resolved = new URL(raw, pageBase);
    } catch {
      return;
    }

    // Only process internal links — same origin as the original site
    if (resolved.origin !== originalOrigin) return;

    const normalizedOriginalUrl = toNormalizedUrl(resolved.pathname, originalOrigin, normalizeSlash);

    if (translatedUrlSet.has(normalizedOriginalUrl)) {
      // Page IS translated: apply path rewrite and optionally switch to target domain.
      const rewrittenPathname = rewritePath(resolved.pathname, config.pathRewrite);
      const suffix = resolved.search + resolved.hash;
      const pathChanged = rewrittenPathname !== resolved.pathname;

      if (raw.startsWith(originalOrigin)) {
        // Absolute link to original site → redirect to target domain with rewritten path
        const newHref = (targetOrigin ?? originalOrigin) + rewrittenPathname + suffix;
        $(el).attr('href', newHref);
        modified = true;
      } else if (pathChanged) {
        // Relative link whose path was rewritten (e.g. /en/foo/ → /foo/)
        $(el).attr('href', rewrittenPathname + suffix);
        modified = true;
      }
      // Relative link with no path rewrite → left as-is.
    } else {
      // Page is NOT translated: make the link absolute to the original site
      // so the user is sent to the real original page.
      $(el).attr('href', normalizedOriginalUrl);
      modified = true;
    }
  });

  return modified ? $.html() : html;
}
