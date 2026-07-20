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
    try {
      // Wait until the network is idle (with a 15s timeout to prevent hanging on analytics/websockets)
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch {
      // Ignore networkidle timeouts — some sites have persistent websockets or analytics loops
    }
  }

  async processHTML(html: string, _pageUrl: string, _config: ProjectConfig): Promise<string> {
    // ── Dart2JS captured-DOM cleanup ──────────────────────────────────────────
    //
    // Problem: Playwright captures the *live post-hydration DOM*. By the time
    // `page.content()` is called, the Dart2JS runtime has already executed and
    // injected all lazy library chunks as <script> tags into <body>:
    //
    //   <script type="text/javascript" src="/main.client.dart.js_4.part.js"></script>
    //   <script type="text/javascript" src="/main.client.dart.js_7.part.js"></script>
    //   …
    //
    // When this static snapshot is served in a browser:
    //   1. Those injected <script> tags run *synchronously* during HTML parsing,
    //      registering initializers into $__dart_deferred_initializers__ BEFORE
    //      the main bundle (which has `defer`) has even started.
    //   2. When the main bundle eventually runs, it tries to initialize hunks that
    //      were registered before `dartProgram` set up its closure — the hunks
    //      exist but the internal Dart state machine is uninitialized, so the
    //      hunk initializer throws / silently fails.
    //   3. Result: clicks on tabs, carousel arrows, header nav → no response.
    //
    // Fix part 1: Remove all Dart .part.js <script> tags injected into <body>.
    //   The main bundle will re-fetch them lazily (via dynamic <script> injection)
    //   when each deferred library is first used — exactly as on the live site.
    //
    // Fix part 2: Patch document.currentScript so the deferred main bundle can
    //   find its own base URL for those lazy fetches. With `defer`, the browser
    //   sets document.currentScript = null during deferred execution. We use an
    //   inline script immediately before the defer tag to capture the script
    //   element via `document.currentScript.nextSibling` (the inline script's
    //   own `document.currentScript` IS valid and its nextSibling is the deferred
    //   Dart <script> which the parser already created as a DOM node).
    const $ = cheerio.load(html);

    // Part 1: Remove Dart .part.js scripts injected by Playwright into <body>
    $('body script[src]').each((_i, el) => {
      const src = $(el).attr('src') ?? '';
      if (src.includes('.dart.js_') && src.includes('.part.js')) {
        $(el).remove();
      }
    });

    // Part 2: Fix document.currentScript for the deferred main Dart bundle
    const dartScript = $('script[src][defer]').filter((_i, el) => {
      const src = $(el).attr('src') ?? '';
      return src.includes('.dart.js') || src.includes('dart2js');
    }).first();

    if (dartScript.length > 0) {
      // The inline script runs synchronously: document.currentScript points to
      // THIS inline element. Its nextSibling (in the already-parsed DOM) is the
      // deferred Dart script element. We override the document.currentScript
      // getter permanently so Dart's Cz() always returns the right element.
      const patchScript =
        `<script>` +
        `(function(){` +
        `var self_=typeof self!=='undefined'?self:this;` +
        `var cs=document.currentScript;` +
        `var dartEl=cs&&cs.nextSibling;` +
        `while(dartEl&&dartEl.nodeName!=='SCRIPT'){dartEl=dartEl.nextSibling;}` +
        `if(dartEl){` +
        `self_.$__dart_currentScript__=dartEl;` +
        `try{Object.defineProperty(document,'currentScript',{` +
        `get:function(){return self_.$__dart_currentScript__||null;},` +
        `configurable:true` +
        `});}catch(e){}` +
        `}` +
        `})();` +
        `</script>`;
      dartScript.before(patchScript);
    }

    return $.html();
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

    // Rewrite url() references inside inline style attributes
    // e.g. style="background-image: url(/assets/hero.png)"
    $('[style]').each((_, el) => {
      const styleAttr = $(el).attr('style') ?? '';
      const rewritten = rewriteCssUrls(styleAttr, pageUrl, assetMap);
      if (rewritten !== styleAttr) $(el).attr('style', rewritten);
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
