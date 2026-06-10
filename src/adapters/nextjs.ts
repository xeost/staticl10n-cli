import * as cheerio from 'cheerio';
import path from 'path';
import type { Page } from 'playwright';
import type { ProjectConfig } from '../core/config.js';
import { delay } from '../utils/delay.js';
import type { SiteAdapter } from './base.js';

// ─── Next.js Adapter ──────────────────────────────────────────────────────────
// Handles the specifics of Next.js sites: hydration, image optimization,
// prefetch cleanup, SPA navigation prevention, and the runtime patch flag.

export class NextjsAdapter implements SiteAdapter {
  name = 'nextjs';

  detect(html: string, _url: string): boolean {
    return (
      html.includes('id="__NEXT_DATA__"') ||
      html.includes('/_next/static/') ||
      html.includes('name="generator" content="Next.js"') ||
      html.includes('self.__next_f.push(') ||
      html.includes('data-nextjs-scroll-focus-boundary')
    );
  }

  async beforeCapture(page: Page, config: ProjectConfig): Promise<void> {
    // Wait for network to settle
    await page.waitForLoadState('networkidle');

    // Wait for React hydration to complete
    await page.waitForFunction(() => {
      // Pages Router: __NEXT_DATA__ is present and document is ready
      const nextData = document.getElementById('__NEXT_DATA__');
      if (nextData && document.readyState === 'complete') return true;
      // App Router: #__next root exists and document is ready
      const root = document.getElementById('__next');
      if (root && document.readyState === 'complete') return true;
      // Generic fallback
      return document.readyState === 'complete';
    });

    // Additional configurable delay for post-hydration JS execution
    const postHydrationDelay = config.crawl.postHydrationDelayMs ?? 800;
    await delay(postHydrationDelay);
  }

  async processHTML(html: string, pageUrl: string, _config: ProjectConfig): Promise<string> {
    const $ = cheerio.load(html);

    // ── 1. Rewrite Next.js image optimization URLs ─────────────────────────
    $('img').each((_, el) => {
      const src = $(el).attr('src');
      if (src) $(el).attr('src', rewriteNextImageSrc(src));

      const srcset = $(el).attr('srcset');
      if (srcset) {
        const rewritten = srcset
          .split(',')
          .map((entry) => {
            const parts = entry.trim().split(/\s+/);
            const url = parts[0];
            const descriptor = parts.slice(1).join(' ');
            return descriptor
              ? `${rewriteNextImageSrc(url)} ${descriptor}`
              : rewriteNextImageSrc(url);
          })
          .join(', ');
        $(el).attr('srcset', rewritten);
      }
    });

    // ── 2. Remove noscript fallbacks for Next.js Image (they contain data-nimg) ──
    $('noscript').each((_, el) => {
      if ($(el).html()?.includes('data-nimg')) $(el).remove();
    });

    // ── 3. Remove Next.js prefetch/preload script tags (they 404 on static hosting) ──
    $('link[rel="preload"][as="script"][href*="/_next/"]').remove();
    $('link[rel="prefetch"][href*="/_next/"]').remove();
    $('link[rel="modulepreload"][href*="/_next/"]').remove();

    // ── 4. Save __NEXT_DATA__ reference for potential analysis ────────────────
    // (This is handled by the exporter; we just note it here.)

    // ── 5. Inject script to prevent SPA navigation ────────────────────────────
    // Next.js intercepts <a> clicks and performs client-side navigation.
    // On a static server without the correct JSON chunks, this would fail.
    // We force full-page reloads for all internal links.
    const preventSPAScript = `<script>
  document.addEventListener('click', function(e) {
    var link = e.target.closest('a');
    if (link && link.href && link.origin === location.origin) {
      e.preventDefault();
      e.stopImmediatePropagation();
      window.location.href = link.href;
    }
  }, true);
</script>`;
    $('head').prepend(preventSPAScript);

    void pageUrl; // acknowledged but unused at this level
    return $.html();
  }

  getAdditionalAssets(html: string, pageUrl: string): string[] {
    const $ = cheerio.load(html);
    const fontUrls: string[] = [];

    // Detect Next.js fonts embedded in <style> tags (next/font generates @font-face rules)
    $('style').each((_, el) => {
      const css = $(el).html() ?? '';
      const matches = css.matchAll(/url\(["']?([\/_next][^"')]+\.woff2?)["']?\)/g);
      for (const match of matches) {
        try {
          fontUrls.push(new URL(match[1], pageUrl).href);
        } catch {
          // Ignore invalid URLs
        }
      }
    });

    return fontUrls;
  }

  rewriteAssetPaths(html: string, assetMap: Map<string, string>): string {
    const $ = cheerio.load(html);

    $('[src]').each((_, el) => {
      const src = $(el).attr('src');
      if (src && assetMap.has(src)) $(el).attr('src', assetMap.get(src)!);
    });

    $('link[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (href && assetMap.has(href)) $(el).attr('href', assetMap.get(href)!);
    });

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

    // Also rewrite url() references inside <style> tags
    $('style').each((_, el) => {
      let css = $(el).html() ?? '';
      assetMap.forEach((localPath, originalUrl) => {
        css = css.replaceAll(originalUrl, localPath);
      });
      $(el).html(css);
    });

    return $.html();
  }

  needsRuntimePatch(): boolean {
    // Next.js sites need the runtime patch to defend against React rehydration
    return true;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Unwraps Next.js image optimization URLs to their original form. */
function rewriteNextImageSrc(src: string): string {
  if (src.includes('/_next/image')) {
    const qIndex = src.indexOf('?');
    if (qIndex !== -1) {
      const params = new URLSearchParams(src.slice(qIndex + 1));
      const originalUrl = params.get('url');
      if (originalUrl) return decodeURIComponent(originalUrl);
    }
  }
  return src;
}

/** Returns the local path for a Next.js static asset. */
export function nextjsAssetLocalPath(href: string): string {
  // /_next/static/... → _assets/_next/static/...
  if (href.startsWith('/_next/')) {
    return path.join('_assets', href.slice(1));
  }
  return href;
}
