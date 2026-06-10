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

  rewriteAssetPaths(html: string, assetMap: Map<string, string>): string {
    const $ = cheerio.load(html);

    // Rewrite src attributes
    $('[src]').each((_, el) => {
      const src = $(el).attr('src');
      if (src && assetMap.has(src)) {
        $(el).attr('src', assetMap.get(src)!);
      }
    });

    // Rewrite href attributes on link tags
    $('link[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (href && assetMap.has(href)) {
        $(el).attr('href', assetMap.get(href)!);
      }
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
          const mapped = assetMap.get(url) ?? url;
          return descriptor ? `${mapped} ${descriptor}` : mapped;
        })
        .join(', ');
      $(el).attr('srcset', rewritten);
    });

    return $.html();
  }

  needsRuntimePatch(): boolean {
    // Static sites do not need the runtime patch
    return false;
  }
}
