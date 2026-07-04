import * as cheerio from 'cheerio';
import fs from 'fs-extra';
import path from 'path';
import type { Page, Response } from 'playwright';
import type { ProjectConfig } from '../core/config.js';
import { delay } from '../utils/delay.js';
import { logger } from '../utils/logger.js';
import type { SiteAdapter } from './base.js';
import { lookupAsset, rewriteCssUrls } from './generic.js';

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
    try {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch {
      // Ignore networkidle timeouts — some sites have persistent websockets or analytics loops
    }

    // Wait for React hydration to complete
    try {
      await page.waitForFunction(() => {
        // Pages Router: __NEXT_DATA__ is present and document is ready
        const nextData = document.getElementById('__NEXT_DATA__');
        if (nextData && document.readyState === 'complete') return true;
        // App Router: #__next root exists and document is ready
        const root = document.getElementById('__next');
        if (root && document.readyState === 'complete') return true;
        // Generic fallback
        return document.readyState === 'complete';
      }, { timeout: 10000 });
    } catch {
      // Ignore hydration wait errors
    }

    // Additional configurable delay for post-hydration JS execution
    const postHydrationDelay = config.crawl.postHydrationDelayMs ?? 800;
    await delay(postHydrationDelay);
  }

  async getRawHtml(_page: Page, navigationResponse: Response | null): Promise<string> {
    // Return the original server response body rather than page.content().
    //
    // Next.js (App Router) streams a flight/RSC payload alongside the SSR
    // HTML describing the pristine server-rendered tree. `page.content()`
    // (taken after beforeCapture() waits for hydration) reflects the DOM
    // *after* React has committed hydration-time mutations — e.g. the
    // anti-FOUC theme script's classList changes on <html>. That mutated
    // snapshot no longer matches the embedded flight payload byte-for-byte,
    // so every real visitor's browser fails to hydrate it (React error
    // #418) and falls back to a full client-side re-render, wiping any
    // class/attribute the original SSR response had that the client render
    // doesn't explicitly restore (this is what caused broken theme/layout
    // styles until the user manually set an explicit theme preference).
    // Using the untouched response body keeps the HTML and flight payload
    // in sync, exactly like a real (uncached) request to the live site.
    if (navigationResponse) {
      try {
        return await navigationResponse.text();
      } catch {
        // Fall through to page.content() if the response body is unavailable
        // (e.g. already consumed or navigated away).
      }
    }
    return _page.content();
  }

  async processHTML(html: string, pageUrl: string, _config: ProjectConfig): Promise<string> {
    const $ = cheerio.load(html);

    // ── 0. Strip runtime theme classes baked into <html> by the capture browser ──
    // beforeCapture() waits for hydration before the DOM is serialized, so the
    // captured markup already reflects classes added by the site's anti-FOUC
    // theme script (e.g. "light"/"dark"/"system", "os-macos") — classes that a
    // real Next.js server response never includes (they're only ever applied by
    // client-side JS). The RSC/flight payload embedded further down in the page
    // still describes the pristine, class-less server render. Serving the
    // mutated class list as if it were the original SSR output makes every
    // real visitor's hydration mismatch (React error #418) on <html>, which
    // forces a full client-side re-render and wipes any class not explicitly
    // re-applied by a React effect (breaking layout/theme CSS until the user
    // manually triggers a theme change that stores an explicit preference).
    // Stripping these classes back out restores the exact state the live
    // server would emit, so the site's own inline script re-adds them
    // consistently and hydration matches on first load.
    const DYNAMIC_THEME_CLASSES = new Set(['light', 'dark', 'system', 'os-macos']);
    const htmlEl = $('html').first();
    const htmlClass = htmlEl.attr('class');
    if (htmlClass) {
      const filtered = htmlClass
        .split(/\s+/)
        .filter((c) => c && !DYNAMIC_THEME_CLASSES.has(c));
      htmlEl.attr('class', filtered.join(' '));
    }

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
    // Next.js uses history.pushState / replaceState for client-side navigation.
    // We intercept those calls and force a full-page reload when the pathname
    // changes, while leaving same-page updates (hash, query, theme state) alone.
    //
    // Crucially, we do NOT touch click events — intercepting clicks with
    // stopImmediatePropagation in capture phase would prevent React from
    // receiving events, breaking dropdowns, theme switching, and all other
    // interactive components.
    const preventSPAScript = `<script>
(function () {
  function intercept(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      var u = new URL(url, location.href);
      if (u.origin !== location.origin) return false;
      if (u.pathname === location.pathname) return false;
      window.location.href = u.href;
      return true;
    } catch (e) { return false; }
  }
  var _push = history.pushState.bind(history);
  history.pushState = function (s, t, url) { if (!intercept(url)) _push(s, t, url); };
  var _replace = history.replaceState.bind(history);
  history.replaceState = function (s, t, url) { if (!intercept(url)) _replace(s, t, url); };
})();
</script>`;
    $('head').prepend(preventSPAScript);

    // ── 6. Theme-class protection ──────────────────────────────────────────────
    // Problem: the TailwindCSS docs Iframe preview component does
    //   document.documentElement.className = theme
    // where `theme` comes from ThemeContext (initially null). This wipes ALL
    // classes from <html> — font classes, antialiased, dark:bg-gray-950, os-macos
    // — replacing them with just "null" or the bare theme value. Even after the
    // MutationObserver re-applies the theme class, the other classes are gone.
    //
    // Fix A — className interceptor: intercepts the `.className =` property
    // setter on document.documentElement. Any simple theme-value assignment
    // (dark/light/system/null/"") is redirected so it only changes the theme
    // class while restoring the full set of non-theme base classes captured at
    // script load time (before any JS runs). Full class strings (containing
    // spaces or unknown values) are passed through unchanged.
    //
    // Fix B — MutationObserver: covers the setAttribute("class", …) path used
    // by React's commit phase. When the stored preference is missing from the
    // class after any attribute mutation, _updateTheme re-applies it.
    const themeGuardScript = `<script>
(function () {
  var THEME = { dark: true, light: true, system: true };
  var htmlEl = document.documentElement;

  // Capture all non-theme base classes at script load time (before any JS runs).
  var baseClasses = htmlEl.className.split(/[\\s]+/).filter(function (c) {
    return c && !THEME[c];
  });

  // Find className descriptor on the prototype chain.
  var proto = htmlEl, desc;
  while (proto) {
    desc = Object.getOwnPropertyDescriptor(proto, 'className');
    if (desc && desc.set) break;
    proto = Object.getPrototypeOf(proto);
  }
  if (!desc || !desc.set) return;

  // Install interceptor on the element instance (shadows the prototype).
  Object.defineProperty(htmlEl, 'className', {
    configurable: true, enumerable: true,
    get: function () { return desc.get.call(this); },
    set: function (val) {
      var str = (val == null ? '' : String(val)).trim();
      if (str === '' || str === 'null' || THEME[str]) {
        // Simple theme-value assignment: rebuild from captured base classes.
        var theme = THEME[str] ? str : null;
        if (!theme) {
          // Preserve whatever theme class is already set.
          var cur = desc.get.call(this);
          cur.split(/[\\s]+/).forEach(function (c) { if (THEME[c]) theme = c; });
        }
        var parts = baseClasses.slice();
        if (theme) parts.push(theme);
        desc.set.call(this, parts.join(' '));
      } else {
        desc.set.call(this, str);
      }
    }
  });

  // MutationObserver covers setAttribute("class", …) mutations (e.g. React).
  var key = 'currentTheme';
  var applying = false;
  var observer = new MutationObserver(function () {
    if (applying) return;
    var stored;
    try { stored = localStorage.getItem(key); } catch (_) { return; }
    if (!stored) return;
    if (document.documentElement.classList.contains(stored)) return;
    applying = true;
    try { window._updateTheme && window._updateTheme(stored); } catch (_) {}
    applying = false;
  });
  observer.observe(htmlEl, { attributes: true, attributeFilter: ['class'] });
  setTimeout(function () { observer.disconnect(); }, 5000);
})();
</script>`;
    $('head').prepend(themeGuardScript);

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

  rewriteAssetPaths(html: string, assetMap: Map<string, string>, pageUrl: string): string {
    const $ = cheerio.load(html);

    $('[src]').each((_, el) => {
      const src = $(el).attr('src');
      const local = src ? lookupAsset(src, pageUrl, assetMap) : undefined;
      if (local) $(el).attr('src', local);
    });

    $('link[href]').each((_, el) => {
      const href = $(el).attr('href');
      const local = href ? lookupAsset(href, pageUrl, assetMap) : undefined;
      if (local) $(el).attr('href', local);
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
          const mapped = lookupAsset(url, pageUrl, assetMap) ?? url;
          return descriptor ? `${mapped} ${descriptor}` : mapped;
        })
        .join(', ');
      $(el).attr('srcset', rewritten);
    });

    // Rewrite url() references inside <style> tags (handles full URLs, root-relative, bare filenames)
    $('style').each((_, el) => {
      const rewritten = rewriteCssUrls($(el).html() ?? '', pageUrl, assetMap);
      $(el).html(rewritten);
    });

    return $.html();
  }

  needsRuntimePatch(): boolean {
    // Next.js sites need the runtime patch to defend against React rehydration
    return true;
  }

  async postCapture(outputDir: string): Promise<void> {
    // ── Patch Next.js Image component default loader ───────────────────────────
    // The compiled Image component chunks contain a default loader that builds
    // `/_next/image?url=ENCODED_SRC&w=WIDTH&q=QUALITY` URLs. When the static HTML
    // has direct paths (from processHTML's rewriteNextImageSrc) but React's client
    // render calls this loader and generates `/_next/image?url=...`, React detects
    // a hydration mismatch and throws error #418, falling back to full client
    // rendering. After the re-render, all <img> elements get `/_next/image?url=...`
    // which 404s on static hosting.
    //
    // Fix: replace the loader's return statement with `return src` so the Image
    // component uses the source path directly, matching the static HTML.
    const chunksDir = path.join(outputDir, '_next', 'static', 'chunks');
    if (!fs.existsSync(chunksDir)) return;

    const files = fs.readdirSync(chunksDir).filter((f) => f.endsWith('.js'));
    let patchCount = 0;

    for (const file of files) {
      const filePath = path.join(chunksDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');

      // Quick skip: only process files that have both markers
      if (!content.includes('__next_img_default') || !content.includes('encodeURIComponent')) {
        continue;
      }

      const patched = patchNextjsImageLoader(content);
      if (patched !== content) {
        fs.writeFileSync(filePath, patched, 'utf-8');
        logger.debug(`Patched Next.js image loader: ${file}`);
        patchCount++;
      }
    }

    if (patchCount > 0) {
      logger.debug(`Patched image loader in ${patchCount} JS chunk(s).`);
    }
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

/**
 * Patches the Next.js Image component default loader inside a compiled JS chunk.
 * Replaces the `return \`\${path}?url=\${encodeURIComponent(src)}...\`` return statement
 * with `return src` so the Image component uses the source path directly rather than
 * wrapping it in a `/_next/image?url=...` optimization URL.
 *
 * The loader pattern always ends with `:""}\`` (the closing of the ternary + outer
 * template literal). The src variable is captured from `encodeURIComponent(VAR)`.
 */
function patchNextjsImageLoader(content: string): string {
  const startMarker = 'return`';
  // End of the outer template literal: `:""` (falsy branch) + `}` (closes ${…}) + `` ` `` (closes template)
  const endMarker = ':""}' + '`';
  let pos = 0;
  let result = '';

  while (true) {
    const start = content.indexOf(startMarker, pos);
    if (start === -1) {
      result += content.slice(pos);
      break;
    }

    // Peek ahead to check this is the image loader (has `?url=` and `encodeURIComponent`)
    const lookAhead = content.slice(start, start + 350);
    const eucMatch = /encodeURIComponent\(([a-z])\)/.exec(lookAhead);

    if (!eucMatch || !lookAhead.includes('?url=')) {
      result += content.slice(pos, start + startMarker.length);
      pos = start + startMarker.length;
      continue;
    }

    const end = content.indexOf(endMarker, start);
    if (end === -1 || end - start > 500) {
      result += content.slice(pos, start + startMarker.length);
      pos = start + startMarker.length;
      continue;
    }

    const srcVar = eucMatch[1];
    result += content.slice(pos, start);  // content before `return\``
    result += `return ${srcVar}`;          // passthrough: just return src directly
    pos = end + endMarker.length;          // skip past `:""}` + backtick
    // The `}` that closes the enclosing function body remains at `pos`
  }

  return result;
}

/** Returns the local path for a Next.js static asset. */
export function nextjsAssetLocalPath(href: string): string {
  // /_next/static/... → _assets/_next/static/...
  if (href.startsWith('/_next/')) {
    return path.join('_assets', href.slice(1));
  }
  return href;
}
