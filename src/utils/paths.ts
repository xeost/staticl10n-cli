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
 * Converts an asset URL to a relative local path under _assets/.
 * e.g. https://example.com/_next/static/css/main.css → _assets/_next/static/css/main.css
 */
export function assetUrlToLocalPath(assetUrl: string, baseUrl: string): string {
  const parsed = new URL(assetUrl, baseUrl);
  let assetPath = parsed.pathname;
  if (assetPath.startsWith('/')) {
    assetPath = assetPath.slice(1);
  }
  return path.join('_assets', assetPath);
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
