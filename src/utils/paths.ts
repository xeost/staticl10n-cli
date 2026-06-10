import path from 'path';
import { URL } from 'url';

/**
 * Converts an absolute URL to a relative filesystem path.
 * e.g. https://example.com/about/team → about/team/index.html
 */
export function urlToFilePath(pageUrl: string): string {
  const parsed = new URL(pageUrl);
  let pathname = parsed.pathname;

  // Remove leading slash
  if (pathname.startsWith('/')) {
    pathname = pathname.slice(1);
  }

  // If the path ends with a slash or has no extension, treat as directory
  if (pathname === '' || pathname.endsWith('/')) {
    return path.join(pathname, 'index.html');
  }

  // If the path has no file extension, treat as directory/index.html
  const basename = path.basename(pathname);
  if (!basename.includes('.')) {
    return path.join(pathname, 'index.html');
  }

  return pathname;
}

/**
 * Converts an asset URL to a relative local path.
 *
 * Same-origin assets preserve their natural path structure:
 *   https://example.com/_next/static/css/main.css → _next/static/css/main.css
 *
 * This ensures JS runtimes that hardcode /_next/ (Next.js, Nuxt, etc.) still
 * work when the output directory is served with a static HTTP server.
 *
 * External / CDN assets are namespaced under _assets/<hostname>/:
 *   https://cdn.example.com/lib.js → _assets/cdn.example.com/lib.js
 */
export function assetUrlToLocalPath(assetUrl: string, baseUrl: string): string {
  const parsed = new URL(assetUrl, baseUrl);
  const base = new URL(baseUrl);

  let assetPath = parsed.pathname;
  if (assetPath.startsWith('/')) assetPath = assetPath.slice(1);

  if (parsed.origin === base.origin) {
    return assetPath || 'index.html';
  } else {
    return path.join('_assets', parsed.hostname, assetPath);
  }
}

/**
 * Computes the relative path from a page file to the assets directory.
 * e.g. for about/team/index.html → ../../_assets
 */
export function relativeAssetsPath(pageFilePath: string): string {
  const pageDir = path.dirname(pageFilePath);
  const depth = pageDir === '.' ? 0 : pageDir.split(path.sep).length;
  const prefix = depth === 0 ? '.' : Array(depth).fill('..').join('/');
  return `${prefix}/_assets`;
}

/**
 * Normalizes a URL according to project config flags.
 * Removes trailing slash and/or query params as configured.
 */
export function normalizeUrl(
  rawUrl: string,
  opts: { normalizeTrailingSlash: boolean; stripQueryParams: boolean },
): string {
  const parsed = new URL(rawUrl);

  // Hash fragments are client-side only — the server returns identical HTML
  // for /page#section-a and /page#section-b, so always strip them.
  parsed.hash = '';

  if (opts.stripQueryParams) {
    parsed.search = '';
  }

  if (opts.normalizeTrailingSlash && parsed.pathname.endsWith('/') && parsed.pathname !== '/') {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  return parsed.href;
}

/**
 * Returns true if the URL is internal to the given base origin.
 */
export function isInternalUrl(url: string, baseUrl: string): boolean {
  try {
    const base = new URL(baseUrl);
    const target = new URL(url, baseUrl);
    return target.origin === base.origin;
  } catch {
    return false;
  }
}
