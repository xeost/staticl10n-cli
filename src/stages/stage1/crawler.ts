import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import fs from 'fs-extra';
import path from 'path';
import type { ProjectConfig } from '../../core/config.js';
import {
  dbGetPagesByProject,
  dbGetProjectBySlug,
  dbInsertPageIfNew,
} from '../../core/db.js';
import { abortableDelayWithJitter } from '../../utils/delay.js';
import { logger } from '../../utils/logger.js';
import { isInternalUrl, normalizeUrl, urlToFilePath } from '../../utils/paths.js';
import { type DetectedRedirect, mergeDetectedRedirects } from './redirects.js';

function parseMetaRefresh(html: string): string | null {
  try {
    const $ = cheerio.load(html);
    const refreshContent = $('meta[http-equiv="refresh" i]').attr('content');
    if (refreshContent) {
      const match = refreshContent.match(/^\d+;\s*url=(.+)$/i);
      if (match) {
        let target = match[1].trim();
        if ((target.startsWith('"') && target.endsWith('"')) ||
            (target.startsWith("'") && target.endsWith("'"))) {
          target = target.slice(1, -1);
        }
        return target;
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

// ─── Crawler ──────────────────────────────────────────────────────────────────

export interface CrawlResult {
  discovered: number;
  errors: number;
  aborted: boolean;
  redirectsDetected: number;
}

/**
 * Discovers all internal URLs of a site using Playwright in headless mode.
 * Starts at the project root URL and follows <a href> links recursively.
 * Respects delayMs + jitter between requests, and ignorePatterns / allowPatterns from config.
 */
export async function crawlSite(
  projectSlug: string,
  config: ProjectConfig,
  onProgress?: (url: string, total: number) => void,
  signal?: AbortSignal,
): Promise<CrawlResult> {
  const project = dbGetProjectBySlug(projectSlug);
  if (!project) throw new Error(`Project "${projectSlug}" not found`);

  if (config.crawl.allowPatterns?.length && config.crawl.ignorePatterns.length) {
    logger.warn(
      'crawl.allowPatterns and crawl.ignorePatterns are both set — allowPatterns takes precedence. Remove ignorePatterns to silence this warning.',
    );
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const queue: string[] = [config.url];
  const visited = new Set<string>();
  let discovered = 0;
  let errors = 0;
  let aborted = false;
  // Keyed by 'from' path to deduplicate across the entire crawl session
  const redirectMap = new Map<string, DetectedRedirect>();

  // Pre-populate visited set from pages already in DB to support resuming
  const existingPages = dbGetPagesByProject(project.id);
  for (const page of existingPages) {
    visited.add(page.url);
  }

  try {
    while (queue.length > 0 && discovered < config.crawl.maxPages) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }

      const rawUrl = queue.shift()!
      const url = normalizeUrl(rawUrl, config.crawl);

      if (!isInternalUrl(url, config.url)) {
        logger.debug(`Skipping external URL: ${url}`);
        continue;
      }

      if (visited.has(url)) continue;
      visited.add(url);

      // Check against crawl filter (blocklist or allowlist)
      if (!isUrlAllowed(url, config.crawl)) {
        logger.debug(`Skipping URL (filtered): ${url}`);
        continue;
      }

      logger.debug(`Crawling: ${url}`);

      const page = await context.newPage();
      let httpStatus = 0;

      // Track the first 3xx response seen for this navigation to detect redirects.
      // Playwright follows redirects automatically, so intermediate responses are
      // only visible via the 'response' event.
      let firstRedirectStatus = 0;
      const onResponse = (res: { status(): number }): void => {
        const s = res.status();
        if (s >= 300 && s < 400 && firstRedirectStatus === 0) {
          firstRedirectStatus = s;
        }
      };
      page.on('response', onResponse);

      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        httpStatus = response?.status() ?? 0;

        let rawHtml = '';
        if (response && httpStatus < 400) {
          try {
            rawHtml = await response.text();
          } catch {
            // Ignore
          }
        }

        const metaRedirectTarget = rawHtml ? parseMetaRefresh(rawHtml) : null;
        if (metaRedirectTarget) {
          try {
            const absoluteRedirect = new URL(metaRedirectTarget, url).href;
            const normalizedRedirect = normalizeUrl(absoluteRedirect, config.crawl);
            const fromPath = new URL(url).pathname;
            const toPath = new URL(normalizedRedirect).pathname;

            if (fromPath !== toPath) {
              redirectMap.set(fromPath, {
                from: fromPath,
                to: toPath,
                statusCode: 307,
                detectedDuring: 'crawl',
              });
              logger.info(`Detected meta-refresh redirect: ${fromPath} → ${toPath}`);

              if (isInternalUrl(normalizedRedirect, config.url) && !visited.has(normalizedRedirect)) {
                queue.push(normalizedRedirect);
              }
            }
          } catch (err) {
            logger.warn(`Failed to process meta-refresh redirect target "${metaRedirectTarget}": ${(err as Error).message}`);
          }
          continue;
        }

        const finalUrl = page.url();
        const normalizedFinal = normalizeUrl(finalUrl, config.crawl);
        const isFinalInternal = isInternalUrl(normalizedFinal, config.url);

        // Register redirect if the final URL differs from the requested one
        if (firstRedirectStatus > 0) {
          try {
            const fromPath = new URL(url).pathname;
            const toPath = new URL(normalizedFinal).pathname;
            if (fromPath !== toPath) {
              redirectMap.set(fromPath, {
                from: fromPath,
                to: toPath,
                statusCode: firstRedirectStatus,
                detectedDuring: 'crawl',
              });
            }
          } catch {
            // Ignore malformed URLs
          }
        }

        if (!isFinalInternal) {
          logger.warn(`Redirected to external URL: ${normalizedFinal} - skipping capture`);
          continue;
        }

        const pagePath = urlToFilePath(normalizedFinal);
        const status = httpStatus >= 400 ? 'error' : 'pending';

        dbInsertPageIfNew(project.id, normalizedFinal, pagePath, status, httpStatus);
        discovered++;

        onProgress?.(normalizedFinal, discovered);

        if (httpStatus < 400) {
          // Extract links from the page
          const html = await page.content();
          const links = extractLinks(html, normalizedFinal, config);
          for (const link of links) {
            if (!visited.has(link)) {
              queue.push(link);
            }
          }
        } else {
          logger.warn(`HTTP ${httpStatus} for URL: ${normalizedFinal}`);
          errors++;
        }
      } catch (err) {
        logger.warn(`Failed to crawl ${url}: ${(err as Error).message}`);
        dbInsertPageIfNew(project.id, url, urlToFilePath(url), 'error', 0);
        errors++;
      } finally {
        page.off('response', onResponse);
        await page.close();
      }

      // Polite delay with jitter between requests
      if (queue.length > 0) {
        await abortableDelayWithJitter(config.crawl.delayMs, config.crawl.delayJitterMs, signal);
      }
    }
  } finally {
    await browser.close();
  }

  // Persist detected redirects to redirects.json (merges with any from previous crawls)
  const detectedList = Array.from(redirectMap.values());
  mergeDetectedRedirects(projectSlug, detectedList);
  if (detectedList.length > 0) {
    logger.debug(`Detected ${detectedList.length} redirect(s) and saved to redirects.json`);
  }

  return { discovered, errors, aborted, redirectsDetected: redirectMap.size };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ASSET_EXTENSIONS = new Set([
  // Images
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'avif',
  // Fonts
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  // Archives / downloads
  'zip', 'tar', 'gz', 'bz2', 'rar', '7z',
  // Documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  // Media
  'mp4', 'mp3', 'wav', 'ogg', 'webm', 'avi', 'mov',
  // Code / static
  'css', 'js', 'mjs', 'cjs', 'map',
  // Data / feeds
  'xml', 'rss', 'atom', 'csv', 'txt',
]);

/** Returns true if the URL path ends with a known non-HTML asset extension. */
function isAssetUrl(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    const ext = pathname.split('.').pop()?.toLowerCase() ?? '';
    return ext.length > 0 && ext.length <= 5 && ASSET_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

/** Extracts all internal links from an HTML document. */
function extractLinks(html: string, pageUrl: string, config: ProjectConfig): string[] {
  const $ = cheerio.load(html);
  const links: string[] = [];

  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    try {
      const absolute = new URL(href, pageUrl).href;
      if (isInternalUrl(absolute, config.url)) {
        const normalized = normalizeUrl(absolute, config.crawl);
        if (!isAssetUrl(normalized) && isUrlAllowed(normalized, config.crawl)) {
          links.push(normalized);
        }
      }
    } catch {
      // Ignore invalid URLs (e.g. mailto:, javascript:, #fragment-only)
    }
  });

  return links;
}

/**
 * Returns true if the URL is allowed to be crawled according to the configured
 * filter mode:
 *
 * - allowPatterns (allowlist): the pathname must contain at least one pattern.
 * - ignorePatterns (blocklist): the pathname must not contain any pattern.
 *
 * Both options are mutually exclusive; if both are present, allowPatterns wins
 * and a warning is emitted once (at call time — callers gate on non-empty).
 */
function isUrlAllowed(
  url: string,
  crawl: ProjectConfig['crawl'],
): boolean {
  const { pathname } = new URL(url);

  const matchesPattern = (pattern: string): boolean => {
    if (pattern.startsWith('^') || pattern.endsWith('$')) {
      try {
        return new RegExp(pattern).test(pathname);
      } catch {
        // Fallback to substring match if regex compilation fails
      }
    }
    return pathname.includes(pattern);
  };

  if (crawl.allowPatterns?.length) {
    return crawl.allowPatterns.some(matchesPattern);
  }

  return !crawl.ignorePatterns.some(matchesPattern);
}

export interface CrawlDiscoverResult {
  discovered: number;
  errors: number;
  aborted: boolean;
  mdPath: string;
}

/**
 * Discovers all internal URLs of a site using Playwright in headless mode.
 * Respects configured ignorePatterns/allowPatterns, but does not write to the DB.
 * Instead, saves a list of pathnames to a temporary markdown file, and companion metadata to JSON.
 */
export async function crawlSiteDiscover(
  projectSlug: string,
  config: ProjectConfig,
  onProgress?: (url: string, total: number) => void,
  signal?: AbortSignal,
): Promise<CrawlDiscoverResult> {
  const project = dbGetProjectBySlug(projectSlug);
  if (!project) throw new Error(`Project "${projectSlug}" not found`);

  if (config.crawl.allowPatterns?.length && config.crawl.ignorePatterns.length) {
    logger.warn(
      'crawl.allowPatterns and crawl.ignorePatterns are both set — allowPatterns takes precedence. Remove ignorePatterns to silence this warning.',
    );
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const queue: string[] = [config.url];
  const visited = new Set<string>();
  let discovered = 0;
  let errors = 0;
  let aborted = false;

  // Keyed by 'from' path to deduplicate across the entire crawl session
  const redirectMap = new Map<string, DetectedRedirect>();

  // Keep track of page metadata discovered in this session (keyed by pathname, e.g. "/docs/intro")
  const pagesMetadata = new Map<string, {
    url: string;
    filePath: string;
    status: string;
    httpStatus: number;
  }>();

  // Pre-populate visited set from pages already in DB to support resuming
  const existingPages = dbGetPagesByProject(project.id);
  for (const page of existingPages) {
    visited.add(page.url);
  }

  try {
    while (queue.length > 0 && discovered < config.crawl.maxPages) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }

      const rawUrl = queue.shift()!;
      const url = normalizeUrl(rawUrl, config.crawl);

      if (!isInternalUrl(url, config.url)) {
        logger.debug(`Skipping external URL: ${url}`);
        continue;
      }

      if (visited.has(url)) continue;
      visited.add(url);

      // Check against crawl filter (blocklist or allowlist)
      if (!isUrlAllowed(url, config.crawl)) {
        logger.debug(`Skipping URL (filtered): ${url}`);
        continue;
      }

      logger.debug(`Crawling: ${url}`);

      const page = await context.newPage();
      let httpStatus = 0;

      // Track the first 3xx response seen for this navigation to detect redirects.
      let firstRedirectStatus = 0;
      const onResponse = (res: { status(): number }): void => {
        const s = res.status();
        if (s >= 300 && s < 400 && firstRedirectStatus === 0) {
          firstRedirectStatus = s;
        }
      };
      page.on('response', onResponse);

      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        httpStatus = response?.status() ?? 0;

        let rawHtml = '';
        if (response && httpStatus < 400) {
          try {
            rawHtml = await response.text();
          } catch {
            // Ignore
          }
        }

        const metaRedirectTarget = rawHtml ? parseMetaRefresh(rawHtml) : null;
        if (metaRedirectTarget) {
          try {
            const absoluteRedirect = new URL(metaRedirectTarget, url).href;
            const normalizedRedirect = normalizeUrl(absoluteRedirect, config.crawl);
            const fromPath = new URL(url).pathname;
            const toPath = new URL(normalizedRedirect).pathname;

            if (fromPath !== toPath) {
              redirectMap.set(fromPath, {
                from: fromPath,
                to: toPath,
                statusCode: 307,
                detectedDuring: 'crawl',
              });
              logger.info(`Detected meta-refresh redirect: ${fromPath} → ${toPath}`);

              if (isInternalUrl(normalizedRedirect, config.url) && !visited.has(normalizedRedirect)) {
                queue.push(normalizedRedirect);
              }
            }
          } catch (err) {
            logger.warn(`Failed to process meta-refresh redirect target "${metaRedirectTarget}": ${(err as Error).message}`);
          }
          continue;
        }

        const finalUrl = page.url();
        const normalizedFinal = normalizeUrl(finalUrl, config.crawl);
        const isFinalInternal = isInternalUrl(normalizedFinal, config.url);

        // Register redirect if the final URL differs from the requested one
        if (firstRedirectStatus > 0) {
          try {
            const fromPath = new URL(url).pathname;
            const toPath = new URL(normalizedFinal).pathname;
            if (fromPath !== toPath) {
              redirectMap.set(fromPath, {
                from: fromPath,
                to: toPath,
                statusCode: firstRedirectStatus,
                detectedDuring: 'crawl',
              });
            }
          } catch {
            // Ignore malformed URLs
          }
        }

        if (!isFinalInternal) {
          logger.warn(`Redirected to external URL: ${normalizedFinal} - skipping discovery`);
          continue;
        }

        const pagePath = urlToFilePath(normalizedFinal);
        const status = httpStatus >= 400 ? 'error' : 'pending';
        const finalPathname = new URL(normalizedFinal).pathname;

        if (httpStatus === 404) {
          logger.warn(`HTTP 404 (Not Found) for URL: ${normalizedFinal} - skipping`);
          errors++;
        } else {
          pagesMetadata.set(finalPathname, {
            url: normalizedFinal,
            filePath: pagePath,
            status,
            httpStatus,
          });

          discovered++;
          onProgress?.(normalizedFinal, discovered);

          if (httpStatus < 400) {
            // Extract links from the page
            const html = await page.content();
            const links = extractLinks(html, normalizedFinal, config);
            for (const link of links) {
              if (!visited.has(link)) {
                queue.push(link);
              }
            }
          } else {
            logger.warn(`HTTP ${httpStatus} for URL: ${normalizedFinal}`);
            errors++;
          }
        }
      } catch (err) {
        logger.warn(`Failed to crawl ${url}: ${(err as Error).message}`);
        try {
          const pathname = new URL(url).pathname;
          pagesMetadata.set(pathname, {
            url,
            filePath: urlToFilePath(url),
            status: 'error',
            httpStatus: 0,
          });
        } catch {
          // Ignore completely invalid URLs
        }
        errors++;
      } finally {
        page.off('response', onResponse);
        await page.close();
      }

      // Polite delay with jitter between requests
      if (queue.length > 0) {
        await abortableDelayWithJitter(config.crawl.delayMs, config.crawl.delayJitterMs, signal);
      }
    }
  } finally {
    await browser.close();
  }

  // Ensure crawler directory inside config.paths.tmp exists
  const crawlerTmpDir = path.join(config.paths.tmp, 'crawler');
  fs.ensureDirSync(crawlerTmpDir);

  const mdPath = path.join(crawlerTmpDir, 'detected.md');
  const jsonPath = path.join(crawlerTmpDir, 'metadata.json');

  // Write paths to mdPath, one per line (using only pathnames)
  const pathnames = Array.from(pagesMetadata.keys()).sort();
  fs.writeFileSync(mdPath, pathnames.join('\n') + '\n', 'utf8');

  // Write metadata to jsonPath
  const metadataContent = {
    projectSlug,
    pages: Object.fromEntries(pagesMetadata),
    redirects: Array.from(redirectMap.values()),
  };
  fs.writeFileSync(jsonPath, JSON.stringify(metadataContent, null, 2), 'utf8');

  return { discovered, errors, aborted, mdPath };
}

