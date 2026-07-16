import * as cheerio from 'cheerio';
import fs from 'fs-extra';
import path from 'path';
import type { BrowserContext } from 'playwright';
import { logger } from '../../utils/logger.js';
import { assetUrlToLocalPath } from '../../utils/paths.js';

// ─── Asset Downloader ─────────────────────────────────────────────────────────

export interface DownloadResult {
  /** Maps original asset URL → local relative path */
  assetMap: Map<string, string>;
  downloaded: number;
  failed: number;
}

/**
 * Finds all referenced assets in an HTML document, downloads them using
 * Playwright's request API (to preserve cookies/headers), and saves them
 * under the outputDir/_assets directory.
 * Returns a map of original URL → local relative path for path rewriting.
 */
export async function downloadAssets(
  html: string,
  pageUrl: string,
  outputDir: string,
  context: BrowserContext,
): Promise<DownloadResult> {
  const assetUrls = collectAssetUrls(html, pageUrl);
  const assetMap = new Map<string, string>();
  let downloaded = 0;
  let failed = 0;

  for (const assetUrl of assetUrls) {
    const localRelPath = assetUrlToLocalPath(assetUrl, pageUrl);
    const localAbsPath = path.join(outputDir, localRelPath);

    // Skip if already downloaded in a previous run
    if (fs.existsSync(localAbsPath)) {
      assetMap.set(assetUrl, localRelPath);
      continue;
    }

    try {
      const apiRequest = context.request;
      const response = await apiRequest.get(assetUrl);

      if (response.ok()) {
        const buffer = await response.body();
        fs.ensureDirSync(path.dirname(localAbsPath));
        fs.writeFileSync(localAbsPath, buffer);
        assetMap.set(assetUrl, localRelPath);
        downloaded++;

        // If this is a CSS file, also scan it for url() references
        if (assetUrl.endsWith('.css')) {
          const cssText = buffer.toString('utf-8');
          const cssAssets = extractCssAssets(cssText, assetUrl);
          for (const cssAssetUrl of cssAssets) {
            if (!assetMap.has(cssAssetUrl)) {
              const cssLocalPath = assetUrlToLocalPath(cssAssetUrl, pageUrl);
              const cssLocalAbs = path.join(outputDir, cssLocalPath);
              try {
                const cssRes = await apiRequest.get(cssAssetUrl);
                if (cssRes.ok()) {
                  const cssBuffer = await cssRes.body();
                  fs.ensureDirSync(path.dirname(cssLocalAbs));
                  fs.writeFileSync(cssLocalAbs, cssBuffer);
                  assetMap.set(cssAssetUrl, cssLocalPath);
                  downloaded++;
                }
              } catch {
                logger.warn(`Failed to download CSS asset: ${cssAssetUrl}`);
              }
            }
          }
        }

        // If this is a JS/MJS file, scan it for dynamically-referenced assets
        // (e.g. import(), fetch(), importScripts(), new Worker()) so that
        // companion files like *.wasm, *.mjs, *.dart2js.js are also downloaded.
        if (assetUrl.endsWith('.js') || assetUrl.endsWith('.mjs') || assetUrl.endsWith('.cjs')) {
          const jsText = buffer.toString('utf-8');
          const jsAssets = extractJsAssets(jsText, assetUrl, new URL(pageUrl).origin);
          for (const jsAssetUrl of jsAssets) {
            if (!assetMap.has(jsAssetUrl)) {
              const jsLocalPath = assetUrlToLocalPath(jsAssetUrl, pageUrl);
              const jsLocalAbs = path.join(outputDir, jsLocalPath);
              try {
                if (fs.existsSync(jsLocalAbs)) {
                  assetMap.set(jsAssetUrl, jsLocalPath);
                  continue;
                }
                const jsRes = await apiRequest.get(jsAssetUrl);
                if (jsRes.ok()) {
                  const jsBuffer = await jsRes.body();
                  fs.ensureDirSync(path.dirname(jsLocalAbs));
                  fs.writeFileSync(jsLocalAbs, jsBuffer);
                  assetMap.set(jsAssetUrl, jsLocalPath);
                  downloaded++;
                } else {
                  logger.warn(`JS asset returned ${jsRes.status()}: ${jsAssetUrl}`);
                }
              } catch {
                logger.warn(`Failed to download JS asset: ${jsAssetUrl}`);
              }
            }
          }
        }
      } else {
        if (response.status() === 404 && assetUrl.endsWith('.json')) {
          // Write an empty JSON object to prevent local dev servers from serving fallback HTML
          fs.ensureDirSync(path.dirname(localAbsPath));
          fs.writeFileSync(localAbsPath, '{}');
          assetMap.set(assetUrl, localRelPath);
          downloaded++;
        } else {
          logger.warn(`Asset returned ${response.status()}: ${assetUrl}`);
          failed++;
        }
      }
    } catch (err) {
      logger.warn(`Failed to download asset ${assetUrl}: ${(err as Error).message}`);
      failed++;
    }
  }

  return { assetMap, downloaded, failed };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Collects all asset URLs referenced in an HTML document. */
function collectAssetUrls(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html);
  const urls = new Set<string>();
  const base = new URL(pageUrl);

  function resolve(href: string | undefined): void {
    if (!href || href.startsWith('data:') || href.startsWith('#')) return;
    try {
      const abs = new URL(href, pageUrl).href;
      // Only download same-origin assets
      if (new URL(abs).origin === base.origin) {
        urls.add(abs);
      }
    } catch {
      // Ignore invalid URLs
    }
  }

  // CSS files
  $('link[rel="stylesheet"]').each((_i, el) => resolve($(el).attr('href')));
  // Scripts
  $('script[src]').each((_i, el) => resolve($(el).attr('src')));
  // Images
  $('img[src]').each((_i, el) => resolve($(el).attr('src')));
  // Images srcset
  $('img[srcset]').each((_i, el) => {
    const srcset = $(el).attr('srcset') ?? '';
    srcset.split(',').forEach((entry) => {
      const url = entry.trim().split(/\s+/)[0];
      resolve(url);
    });
  });
  // Source elements (picture, video, audio)
  $('source[src]').each((_i, el) => resolve($(el).attr('src')));
  $('source[srcset]').each((_i, el) => {
    const srcset = $(el).attr('srcset') ?? '';
    srcset.split(',').forEach((entry) => resolve(entry.trim().split(/\s+/)[0]));
  });
  // Preloaded fonts, styles, and images (e.g. next/font CSS, hero images)
  $('link[rel="preload"]').each((_i, el) => {
    const as = $(el).attr('as');
    if (as === 'font' || as === 'style' || as === 'image') {
      resolve($(el).attr('href'));
    }
  });

  // Favicons and other link tags
  $('link[href]:not([rel="stylesheet"]):not([rel="canonical"]):not([rel="alternate"])').each(
    (_i, el) => {
      const rel = $(el).attr('rel') ?? '';
      if (rel.includes('icon') || rel === 'manifest' || rel === 'apple-touch-icon') {
        resolve($(el).attr('href'));
      }
    },
  );

  // Parse __config JSON block if present to download search worker and search index
  const configScript = $('script#__config').html();
  if (configScript) {
    try {
      const parsedConfig = JSON.parse(configScript.trim());
      if (parsedConfig.search) {
        resolve(parsedConfig.search);
      }
    } catch {
      // Ignore invalid JSON
    }
    // Download search index and version files relative to origin
    resolve('/search/search_index.json');
    resolve('/search.json');
    resolve('/versions.json');
  }

  return Array.from(urls);
}

/**
 * After all assets are downloaded, rewrites absolute url() references inside
 * downloaded CSS files so that fonts and images resolve correctly when served
 * from the local _assets/ directory.
 */
export function rewriteDownloadedCssUrls(
  outputDir: string,
  assetMap: Map<string, string>,
): void {
  for (const [assetUrl, localRelPath] of assetMap) {
    if (!assetUrl.toLowerCase().endsWith('.css')) continue;
    const localAbsPath = path.join(outputDir, localRelPath);
    if (!fs.existsSync(localAbsPath)) continue;

    let css = fs.readFileSync(localAbsPath, 'utf-8');
    let modified = false;

    css = css.replace(/url\(["']?([^"')]+)["']?\)/g, (_match: string, raw: string) => {
      if (raw.startsWith('data:')) return _match;
      // Resolve the raw url() value against the CSS file's own original URL
      let fullUrl: string;
      try {
        fullUrl = new URL(raw, assetUrl).href;
      } catch {
        return _match;
      }
      const targetRelPath = assetMap.get(fullUrl);
      if (!targetRelPath) return _match;
      // Compute the relative path from the CSS file's directory to the target asset
      const cssDir = path.dirname(localRelPath);
      const relPath = path.relative(cssDir, targetRelPath).split(path.sep).join('/');
      modified = true;
      return `url('${relPath}')`;
    });

    if (modified) fs.writeFileSync(localAbsPath, css, 'utf-8');
  }
}

/** Extracts url() references from a CSS string (e.g. for fonts and background images). */
function extractCssAssets(css: string, cssUrl: string): string[] {
  const urls: string[] = [];
  const urlPattern = /url\(["']?([^"')]+)["']?\)/g;
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(css)) !== null) {
    const href = match[1];
    if (!href.startsWith('data:')) {
      try {
        urls.push(new URL(href, cssUrl).href);
      } catch {
        // Ignore
      }
    }
  }
  return urls;
}

/**
 * Extracts asset references from a JavaScript/MJS file that are loaded
 * dynamically at runtime (import(), fetch(), importScripts(), new Worker(),
 * and string literals for files with known binary/module extensions).
 * Also extracts Dart2JS `deferredPartUris` arrays so all deferred feature
 * chunks (cookie_notice, theme_switcher, site_switcher, etc.) are downloaded.
 * Only same-origin URLs are returned.
 */
function extractJsAssets(js: string, jsUrl: string, origin: string): string[] {
  const found = new Set<string>();

  // Patterns that load a file by URL string:
  //   import("./foo.mjs")          — dynamic ESM import
  //   fetch("./foo.wasm")          — Wasm / JSON fetch
  //   importScripts("./foo.js")    — Web Worker classic script
  //   new Worker("./foo.js")       — Web Worker constructor
  //   relativeURL("./foo.mjs")     — Dart-compiled helper
  const callPattern = /(?:import|fetch|importScripts|new\s+Worker|relativeURL)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = callPattern.exec(js)) !== null) {
    tryResolve(m[1], jsUrl, origin, found);
  }

  // Plain string literals that look like relative asset paths with known extensions.
  // Catches patterns like: src = "./main.client.dart2js.js"
  const JS_ASSET_EXTENSIONS = /\.(?:js|mjs|cjs|wasm|json)(["'`?#]|$)/;
  const stringLiteralPattern = /["'`]((?:\.{1,2}\/)[^"'`\s]+)["'`]/g;
  while ((m = stringLiteralPattern.exec(js)) !== null) {
    if (JS_ASSET_EXTENSIONS.test(m[1])) {
      tryResolve(m[1], jsUrl, origin, found);
    }
  }

  // Dart2JS deferred loading: the compiled bundle lists all lazy-loaded chunk
  // filenames in a deferredPartUris:[...] array. Each entry is a path relative
  // to the script itself. These chunks are only fetched when a deferred library
  // (e.g. _cookie_notice, _theme_switcher) is first used, so they are never
  // discovered by watching network traffic during capture. We must extract and
  // download them eagerly.
  //
  // Example pattern inside dart2js output:
  //   deferredPartUris:["main.client.dart2js.js_2.part.js","main.client.dart2js.js_13.part.js",...]
  const deferredUrisPattern = /deferredPartUris\s*:\s*\[([^\]]+)\]/g;
  while ((m = deferredUrisPattern.exec(js)) !== null) {
    const entries = m[1].matchAll(/["']([^"']+\.part\.js)["']/g);
    for (const entry of entries) {
      tryResolve(entry[1], jsUrl, origin, found);
    }
  }

  return Array.from(found);
}


/** Resolves a raw href against a base URL and adds it to the set if same-origin. */
function tryResolve(raw: string, base: string, origin: string, out: Set<string>): void {
  if (!raw || raw.startsWith('data:') || raw.startsWith('#')) return;
  try {
    const abs = new URL(raw, base);
    if (abs.origin === origin) out.add(abs.href);
  } catch {
    // Ignore unparseable values
  }
}
