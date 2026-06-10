import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import type { ProjectConfig } from '../../core/config.js';
import {
  dbGetPagesByProject,
  dbGetProjectBySlug,
  dbUpsertPage,
} from '../../core/db.js';
import { delayWithJitter } from '../../utils/delay.js';
import { logger } from '../../utils/logger.js';
import { isInternalUrl, normalizeUrl, urlToFilePath } from '../../utils/paths.js';

// ─── Crawler ──────────────────────────────────────────────────────────────────

export interface CrawlResult {
  discovered: number;
  errors: number;
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

  // Pre-populate visited set from pages already in DB to support resuming
  const existingPages = dbGetPagesByProject(project.id);
  for (const page of existingPages) {
    visited.add(page.url);
  }

  try {
    while (queue.length > 0 && discovered < config.crawl.maxPages) {
      const rawUrl = queue.shift()!;
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

      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        httpStatus = response?.status() ?? 0;

        const finalUrl = page.url();
        const normalizedFinal = normalizeUrl(finalUrl, config.crawl);

        const pagePath = urlToFilePath(normalizedFinal);
        const status = httpStatus >= 400 ? 'error' : 'pending';

        dbUpsertPage(project.id, normalizedFinal, pagePath, status, httpStatus);
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
        dbUpsertPage(project.id, url, urlToFilePath(url), 'error', 0);
        errors++;
      } finally {
        await page.close();
      }

      // Polite delay with jitter between requests
      if (queue.length > 0) {
        await delayWithJitter(config.crawl.delayMs, config.crawl.delayJitterMs);
      }
    }
  } finally {
    await browser.close();
  }

  return { discovered, errors };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
        if (!shouldIgnore(normalized, config.crawl.ignorePatterns)) {
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
