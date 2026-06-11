import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
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
 * Respects delayMs + jitter between requests, and ignorePatterns from config.
 */
export async function crawlSite(
  projectSlug: string,
  config: ProjectConfig,
  onProgress?: (url: string, total: number) => void,
  signal?: AbortSignal,
): Promise<CrawlResult> {
  const project = dbGetProjectBySlug(projectSlug);
  if (!project) throw new Error(`Project "${projectSlug}" not found`);

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

      if (visited.has(url)) continue;
      visited.add(url);

      // Check against ignore patterns
      if (shouldIgnore(url, config.crawl.ignorePatterns)) {
        logger.debug(`Ignoring URL: ${url}`);
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

        const finalUrl = page.url();
        const normalizedFinal = normalizeUrl(finalUrl, config.crawl);

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
        if (!isAssetUrl(normalized) && !shouldIgnore(normalized, config.crawl.ignorePatterns)) {
          links.push(normalized);
        }
      }
    } catch {
      // Ignore invalid URLs (e.g. mailto:, javascript:, #fragment-only)
    }
  });

  return links;
}

/** Returns true if the URL matches any of the configured ignore patterns. */
function shouldIgnore(url: string, patterns: string[]): boolean {
  const { pathname } = new URL(url);
  return patterns.some((pattern) => pathname.includes(pattern));
}
