import crypto from 'crypto';
import { chromium } from 'playwright';
import type { ProjectConfig } from '../../core/config.js';
import {
  dbGetPagesByProject,
  dbGetProjectBySlug,
  dbInsertChangeDetection,
} from '../../core/db.js';
import { delayWithJitter } from '../../utils/delay.js';
import { logger } from '../../utils/logger.js';
import { extractFragments } from '../stage2/extractor.js';

// ─── Change Differ ────────────────────────────────────────────────────────────

export interface DiffResult {
  checked: number;
  changed: number;
  errors: number;
}

/**
 * Re-visits each page in the database, extracts translatable content,
 * computes a checksum, and compares it with the stored checksum.
 * Only flags pages where the translatable content has changed.
 */
export async function diffSite(
  projectSlug: string,
  config: ProjectConfig,
  onProgress?: (url: string, done: number, total: number) => void,
): Promise<DiffResult> {
  const project = dbGetProjectBySlug(projectSlug);
  if (!project) throw new Error(`Project "${projectSlug}" not found`);

  const pages = dbGetPagesByProject(project.id);
  const total = pages.length;
  let checked = 0;
  let changed = 0;
  let errors = 0;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  try {
    for (const pageRow of pages) {
      const playwrightPage = await context.newPage();
      try {
        await playwrightPage.goto(pageRow.url, { waitUntil: 'networkidle', timeout: 30000 });
        const html = await playwrightPage.content();

        // Compute checksum only on translatable content (same logic as stage 2 extractor)
        const newChecksum = computeTranslatableChecksum(html);

        const oldChecksum = pageRow.checksum;
        if (oldChecksum && oldChecksum !== newChecksum) {
          dbInsertChangeDetection(pageRow.id, oldChecksum, newChecksum);
          logger.info(`Change detected: ${pageRow.url}`);
          changed++;
        }

        checked++;
        onProgress?.(pageRow.url, checked, total);
      } catch (err) {
        logger.warn(`Error checking ${pageRow.url}: ${(err as Error).message}`);
        errors++;
      } finally {
        await playwrightPage.close();
      }

      if (pages.indexOf(pageRow) < pages.length - 1) {
        await delayWithJitter(config.crawl.delayMs, config.crawl.delayJitterMs);
      }
    }
  } finally {
    await browser.close();
  }

  return { checked, changed, errors };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Computes a SHA-256 hash of only the translatable content in the HTML.
 * Uses the same extraction logic as Stage 2 to avoid false positives from
 * dynamic scripts, bundler hashes, etc.
 */
export function computeTranslatableChecksum(html: string): string {
  const fragments = extractFragments(html);
  const content = fragments.map((f) => f.outerHtml).join('|');
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}
