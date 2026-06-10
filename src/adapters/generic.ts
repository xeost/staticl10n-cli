import * as cheerio from 'cheerio';
import type { Page } from 'playwright';
import type { ProjectConfig } from '../core/config.js';
import type { SiteAdapter } from './base.js';

// ─── Generic Adapter ──────────────────────────────────────────────────────────
// Handles most static-site generators (Hugo, Astro, VitePress, Jekyll, etc.)

export class GenericAdapter implements SiteAdapter {
  name = 'generic';

  detect(_html: string, _url: string): boolean {
    // The generic adapter is the fallback; it accepts everything
    return true;
  }

  async beforeCapture(page: Page, _config: ProjectConfig): Promise<void> {
    // Wait until the network is idle and the document is complete
    await page.waitForLoadState('networkidle');
  }

  async processHTML(html: string, _pageUrl: string, _config: ProjectConfig): Promise<string> {
    // No special processing needed for generic static sites
    return html;
  }

  getAdditionalAssets(_html: string, _pageUrl: string): string[] {
    // No additional framework-specific assets
    return [];
  }

  rewriteAssetPaths(html: string, assetMap: Map<string, string>, pageUrl: string): string {
    const $ = cheerio.load(html);

    // Rewrite src attributes
    $('[src]').each((_, el) => {
      const src = $(el).attr('src');
      const local = src ? lookupAsset(src, pageUrl, assetMap) : undefined;
      if (local) $(el).attr('src', local);
    });

    // Rewrite href attributes on link tags
    $('link[href]').each((_, el) => {
      const href = $(el).attr('href');
      const local = href ? lookupAsset(href, pageUrl, assetMap) : undefined;
      if (local) $(el).attr('href', local);
    });

    // Rewrite srcset attributes
    $('[srcset]').each((_, el) => {
      const srcset = $(el).attr('srcset');
      if (!srcset) return;
      const rewritten = srcset
        .split(',')
        .map((entry) => {
          const parts = entry.trim().split(/\s+/);
          const url = parts[0];
          const descriptor = parts.slice(1).join(' ');
          const mapped = lookupAsset(url, pageUrl, assetMap) ?? url;
          return descriptor ? `${mapped} ${descriptor}` : mapped;
        })
        .join(', ');
      $(el).attr('srcset', rewritten);
    });

    // Rewrite url() references inside <style> tags
    $('style').each((_, el) => {
      let css = $(el).html() ?? '';
      css = rewriteCssUrls(css, pageUrl, assetMap);
      $(el).html(css);
    });

    return $.html();
  }

  needsRuntimePatch(): boolean {
    // Static sites do not need the runtime patch
    return false;
  }
}

// ─── Shared URL-rewriting helpers ─────────────────────────────────────────────

/**
 * Looks up a raw attribute value in the asset map, trying both the raw value
 * and its fully-resolved absolute URL so that root-relative (/path) and
 * relative (./path, filename) references are matched correctly.
 */
export function lookupAsset(
  raw: string,
  pageUrl: string,
  map: Map<string, string>,
): string | undefined {
  if (!raw || raw.startsWith('data:') || raw.startsWith('#')) return undefined;
  if (map.has(raw)) return map.get(raw);
  try {
    const abs = new URL(raw, pageUrl).href;
    if (map.has(abs)) return map.get(abs);
  } catch {
    // Ignore unparseable values
  }
  return undefined;
}

/**
 * Replaces url() references in a CSS string using the asset map.
 * Handles full URLs, root-relative paths, and bare filenames.
 */
export function rewriteCssUrls(
  css: string,
  pageUrl: string,
  map: Map<string, string>,
): string {
  return css.replace(/url\(["']?([^"')]+)["']?\)/g, (_match, raw: string) => {
    const local = lookupAsset(raw, pageUrl, map);
    return local ? `url('${local}')` : _match;
  });
}
