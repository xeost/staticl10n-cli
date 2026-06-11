import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { chromium } from 'playwright';
import { GenericAdapter } from '../../adapters/generic.js';
import { NextjsAdapter } from '../../adapters/nextjs.js';
import type { SiteAdapter } from '../../adapters/base.js';
import type { ProjectConfig } from '../../core/config.js';
import {
  dbGetPagesByProject,
  dbGetProjectBySlug,
  dbUpdatePageStatus,
} from '../../core/db.js';
import { delayWithJitter } from '../../utils/delay.js';
import { logger } from '../../utils/logger.js';
import { urlToFilePath } from '../../utils/paths.js';
import { downloadAssets, rewriteDownloadedCssUrls } from './downloader.js';
import { writeRedirectsTo } from './redirects.js';

// ─── Exporter ─────────────────────────────────────────────────────────────────

export interface ExportResult {
  captured: number;
  failed: number;
}

/**
 * Captures every pending/crawled page with Playwright, processes it through
 * the appropriate adapter, downloads assets, and saves the static output.
 */
export async function capturePages(
  projectSlug: string,
  config: ProjectConfig,
  onProgress?: (url: string, done: number, total: number) => void,
  targetUrl?: string,
): Promise<ExportResult> {
  const project = dbGetProjectBySlug(projectSlug);
  if (!project) throw new Error(`Project "${projectSlug}" not found`);

  const adapter = resolveAdapter(config);

  // Select pages to capture
  let pages = dbGetPagesByProject(project.id).filter(
    (p) => p.status === 'pending' || p.status === 'crawled',
  );
  if (targetUrl) {
    pages = pages.filter((p) => p.url === targetUrl);
  }

  const total = pages.length;
  let captured = 0;
  let failed = 0;

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
        await playwrightPage.goto(pageRow.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Run the adapter's before-capture hook (e.g. wait for hydration)
        await adapter.beforeCapture(playwrightPage, config);

        // Capture the final DOM
        const rawHtml = await playwrightPage.content();

        // Save raw HTML before any processing
        const rawFilePath = path.join(config.paths.raw, pageRow.path);
        fs.ensureDirSync(path.dirname(rawFilePath));
        fs.writeFileSync(rawFilePath, rawHtml, 'utf-8');

        // Run adapter-specific HTML post-processing
        let processedHtml = await adapter.processHTML(rawHtml, pageRow.url, config);

        // Download assets and build the asset map
        const { assetMap } = await downloadAssets(
          processedHtml,
          pageRow.url,
          config.paths.original,
          context,
        );

        // Also download additional adapter-specific assets (e.g. Next.js fonts)
        const extraAssets = adapter.getAdditionalAssets(processedHtml, pageRow.url);
        for (const assetUrl of extraAssets) {
          if (!assetMap.has(assetUrl)) {
            try {
              const res = await context.request.get(assetUrl);
              if (res.ok()) {
                const { assetUrlToLocalPath } = await import('../../utils/paths.js');
                const localRelPath = assetUrlToLocalPath(assetUrl, pageRow.url);
                const localAbsPath = path.join(config.paths.original, localRelPath);
                fs.ensureDirSync(path.dirname(localAbsPath));
                fs.writeFileSync(localAbsPath, await res.body());
                assetMap.set(assetUrl, localRelPath);
              }
            } catch (err) {
              logger.warn(`Failed to download extra asset ${assetUrl}: ${(err as Error).message}`);
            }
          }
        }

        // Rewrite asset paths to relative local paths.
        // assetMap values are root-relative (e.g. "_assets/foo.css"). We must
        // convert them to paths relative to the page's own directory so that
        // nested pages (e.g. about/index.html) resolve assets correctly when
        // served by any static HTTP server.
        const pageDir = path.dirname(pageRow.path); // "." for root, "about" for /about/
        const pageRelativeAssetMap = new Map<string, string>();
        for (const [origUrl, rootRelPath] of assetMap) {
          const relPath = path.relative(pageDir, rootRelPath).split(path.sep).join('/');
          pageRelativeAssetMap.set(origUrl, relPath);
        }
        processedHtml = adapter.rewriteAssetPaths(processedHtml, pageRelativeAssetMap, pageRow.url);

        // Rewrite absolute url() references inside downloaded CSS files
        // (e.g. @font-face src that still point to the original domain)
        rewriteDownloadedCssUrls(config.paths.original, assetMap);

        // Save __NEXT_DATA__ JSON if present (useful for debugging)
        if (config.siteType === 'nextjs') {
          saveNextData(processedHtml, pageRow.path, config.paths.original);
        }

        // Save the processed HTML to the original/ directory
        const outputFilePath = path.join(config.paths.original, pageRow.path);
        fs.ensureDirSync(path.dirname(outputFilePath));
        fs.writeFileSync(outputFilePath, processedHtml, 'utf-8');

        // Compute checksum for change detection
        const checksum = crypto.createHash('sha256').update(processedHtml).digest('hex');

        dbUpdatePageStatus(pageRow.id, 'captured', checksum);
        captured++;
        onProgress?.(pageRow.url, captured, total);

        logger.debug(`Captured: ${pageRow.url}`);
      } catch (err) {
        logger.error(`Failed to capture ${pageRow.url}: ${(err as Error).message}`);
        dbUpdatePageStatus(pageRow.id, 'error');
        failed++;
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

  // Write _redirects to original/ from the project's redirects.json.
  // This runs even on partial captures so the file stays up to date.
  writeRedirectsTo(config.paths.original, projectSlug);

  return { captured, failed };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Picks the appropriate adapter based on siteType config. */
function resolveAdapter(config: ProjectConfig): SiteAdapter {
  switch (config.siteType) {
    case 'nextjs':
      return new NextjsAdapter();
    default:
      return new GenericAdapter();
  }
}

/** Saves __NEXT_DATA__ JSON to a companion file if present in the HTML. */
function saveNextData(html: string, pagePath: string, outputDir: string): void {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return;
  try {
    const data = JSON.parse(match[1]);
    const jsonPath = path.join(outputDir, path.dirname(pagePath), '__next_data__.json');
    fs.ensureDirSync(path.dirname(jsonPath));
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Ignore JSON parse failures
  }
}

/** Resolves the output file path for a given URL and output directory. */
export function resolveOutputPath(pageUrl: string, outputDir: string): string {
  return path.join(outputDir, urlToFilePath(pageUrl));
}
