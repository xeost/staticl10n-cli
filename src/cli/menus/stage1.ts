import chalk from 'chalk';
import cliProgress from 'cli-progress';
import inquirer from 'inquirer';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import type { ProjectConfig } from '../../core/config.js';
import { dbDeletePagesByProject, dbGetPagesByProject, dbGetProjectBySlug, dbInsertPageIfNew } from '../../core/db.js';
import { capturePages } from '../../stages/stage1/exporter.js';
import { crawlSiteDiscover } from '../../stages/stage1/crawler.js';
import { loadRedirectsFile, writeRedirectsTo, mergeDetectedRedirects } from '../../stages/stage1/redirects.js';
import { normalizeUrl, urlToFilePath } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';
import { clearScreen, printStageHeader, promptSelect } from '../ui.js';

// ─── Stage 1 Menu ─────────────────────────────────────────────────────────────

export async function stage1Menu(projectSlug: string, config: ProjectConfig): Promise<void> {
  clearScreen();
  let lastChoiceValue = 'crawl-discover';
  while (true) {
    const action = await promptSelect(
      'Stage 1: Capture',
      [
        { name: 'Detect URLs: Stage 1 (Discover & Save)', value: 'crawl-discover' },
        { name: 'Detect URLs: Stage 2 (Import paths)', value: 'crawl-import' },
        { name: 'Import path manually', value: 'import-manual' },
        { name: 'Capture pending pages', value: 'capture' },
        { name: 'Capture all pages', value: 'capture-all' },
        { name: 'Capture specific page', value: 'capture-specific' },
        { name: 'View captured pages', value: 'view' },
        { name: 'View detected redirects', value: 'view-redirects' },
        { name: 'Regenerate _redirects file', value: 'regen-redirects' },
        { name: '← Back', value: 'back' },
      ],
      config.name,
      lastChoiceValue
    );

    if (action === 'clear') {
      clearScreen();
      continue;
    }

    if (action === 'back') {
      return;
    }

    lastChoiceValue = action;

    switch (action) {
      case 'crawl-discover':
        await runCrawlDiscover(projectSlug, config);
        break;
      case 'crawl-import':
        await runCrawlImport(projectSlug, config);
        break;
      case 'import-manual':
        await runImportManual(projectSlug, config);
        break;
      case 'capture':
        await runCapture(projectSlug, config);
        break;
      case 'capture-all':
        await runCaptureAll(projectSlug, config);
        break;
      case 'capture-specific':
        await runCaptureSpecific(projectSlug, config);
        break;
      case 'view':
        viewPages(projectSlug);
        break;
      case 'view-redirects':
        viewRedirects(projectSlug);
        break;
      case 'regen-redirects':
        await runRegenRedirects(projectSlug, config);
        break;
    }
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function runCrawlDiscover(projectSlug: string, config: ProjectConfig): Promise<void> {
  const project = dbGetProjectBySlug(projectSlug)!;
  const existingPages = dbGetPagesByProject(project.id);

  if (existingPages.length > 0) {
    const mode = await promptSelect(
      `Found ${existingPages.length} page(s) already in the database.`,
      [
        { name: 'Resume (skip already discovered URLs)', value: 'resume' },
        { name: 'Start from scratch (clear existing pages)', value: 'reset' },
      ],
      config.name
    );

    if (mode === 'clear') return;

    if (mode === 'reset') {
      dbDeletePagesByProject(project.id);
      logger.info('Cleared existing pages. Starting fresh discovery.');
    }
  }

  const controller = new AbortController();

  // Keypress-based cancellation
  let keypressCleanup: (() => void) | null = null;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = (key: Buffer): void => {
      // q / Q / Escape / Ctrl+C
      if (
        key[0] === 0x71 || // 'q'
        key[0] === 0x51 || // 'Q'
        key[0] === 0x1b || // Escape
        key[0] === 0x03    // Ctrl+C
      ) {
        controller.abort();
      }
    };

    process.stdin.on('data', onData);

    keypressCleanup = (): void => {
      process.stdin.removeListener('data', onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    };
  }

  const spinner = ora('Starting crawler discovery...').start();
  const bar = new cliProgress.SingleBar(
    { format: `Discovering | {bar} | {value} URLs found  ${chalk.gray('[q] cancel')}` },
    cliProgress.Presets.shades_classic,
  );
  bar.start(config.crawl.maxPages, 0);
  spinner.stop();

  try {
    const result = await crawlSiteDiscover(projectSlug, config, (_url, total) => {
      bar.update(total);
    }, controller.signal);
    bar.stop();
    if (result.aborted) {
      logger.warn(`Crawl discovery cancelled: ${result.discovered} URLs discovered.`);
    } else {
      logger.success(`Crawl discovery complete: ${result.discovered} URLs discovered.`);
    }
    logger.info(`Paths saved to: ${result.mdPath}`);
    logger.info('Please review the list of paths in the markdown file, delete the ones you do not want, and run "Detect URLs: Stage 2 (Import paths)".');
  } catch (err) {
    bar.stop();
    logger.error(`Crawl discovery failed: ${(err as Error).message}`);
  } finally {
    keypressCleanup?.();
  }
}

async function runCrawlImport(projectSlug: string, config: ProjectConfig): Promise<void> {
  const project = dbGetProjectBySlug(projectSlug)!;
  const crawlerTmpDir = path.join(config.paths.tmp, 'crawler');
  const mdPath = path.join(crawlerTmpDir, 'detected.md');
  const jsonPath = path.join(crawlerTmpDir, 'metadata.json');

  if (!fs.existsSync(mdPath) || !fs.existsSync(jsonPath)) {
    logger.error(`No crawler results found for project "${projectSlug}". Please run "Detect URLs: Stage 1 (Discover & Save)" first.`);
    return;
  }

  const spinner = ora('Importing paths...').start();
  try {
    const mdContent = fs.readFileSync(mdPath, 'utf8');
    const importPaths = mdContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    const jsonContent = fs.readFileSync(jsonPath, 'utf8');
    const metadata = JSON.parse(jsonContent);

    let pagesInserted = 0;
    const approvedPathsSet = new Set(importPaths);

    for (const pathname of importPaths) {
      const pageMeta = metadata.pages[pathname];
      let url: string;
      let filePath: string;
      let status: string;
      let httpStatus: number;

      if (pageMeta) {
        url = pageMeta.url;
        filePath = pageMeta.filePath;
        status = pageMeta.status;
        httpStatus = pageMeta.httpStatus;
      } else {
        // Fallback if user manually added/modified a path
        try {
          url = new URL(pathname, config.url).href;
        } catch {
          url = config.url.replace(/\/$/, '') + pathname;
        }
        url = normalizeUrl(url, config.crawl);
        filePath = urlToFilePath(url);
        status = 'pending';
        httpStatus = 200;
      }

      dbInsertPageIfNew(project.id, url, filePath, status, httpStatus);
      pagesInserted++;
    }

    // Filter redirects: only keep redirects where target path is in the approved paths
    const redirectsToMerge = (metadata.redirects || []).filter((r: any) => {
      return approvedPathsSet.has(r.to);
    });

    if (redirectsToMerge.length > 0) {
      mergeDetectedRedirects(projectSlug, redirectsToMerge);
    }

    // Delete temporary files after import
    fs.unlinkSync(mdPath);
    fs.unlinkSync(jsonPath);

    spinner.stop();
    logger.success(`Import complete: ${pagesInserted} page(s) imported, ${redirectsToMerge.length} redirect(s) registered.`);
  } catch (err) {
    spinner.stop();
    logger.error(`Import failed: ${(err as Error).message}`);
  }
}

async function runImportManual(projectSlug: string, config: ProjectConfig): Promise<void> {
  const project = dbGetProjectBySlug(projectSlug)!;

  const { inputPath } = await inquirer.prompt([
    {
      type: 'input',
      name: 'inputPath',
      message: 'Enter path to import (e.g. /about or https://example.com/about, leave empty to cancel):',
    },
  ]);

  const trimmed = inputPath.trim();
  if (!trimmed) {
    logger.info('Import cancelled.');
    return;
  }

  let absoluteUrl = '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    absoluteUrl = trimmed;
  } else {
    let relativePath = trimmed;
    if (!relativePath.startsWith('/')) {
      relativePath = '/' + relativePath;
    }
    absoluteUrl = new URL(relativePath, config.url).href;
  }

  let inputOrigin = '';
  const projectOrigin = new URL(config.url).origin;
  try {
    inputOrigin = new URL(absoluteUrl).origin;
  } catch {
    logger.error('Invalid URL or path format.');
    return;
  }

  if (projectOrigin !== inputOrigin) {
    logger.error(`The URL "${absoluteUrl}" does not belong to the project origin "${projectOrigin}".`);
    return;
  }

  const normalizedUrl = normalizeUrl(absoluteUrl, config.crawl);
  const spinner = ora(`Checking URL existence: ${normalizedUrl}...`).start();

  let exists = false;
  let httpStatus = 0;

  try {
    const res = await fetch(normalizedUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
    httpStatus = res.status;
    exists = res.ok || (res.status >= 300 && res.status < 400);
  } catch (err) {
    spinner.fail(`Connection check failed: ${(err as Error).message}`);
    return;
  }

  if (!exists) {
    spinner.fail(`URL does not exist on the source website (HTTP Status ${httpStatus}).`);
    return;
  }

  spinner.succeed(`URL verified (HTTP Status ${httpStatus}).`);
  const pagePath = urlToFilePath(normalizedUrl);
  dbInsertPageIfNew(project.id, normalizedUrl, pagePath, 'pending', httpStatus);
  logger.success(`Path successfully imported as pending: ${normalizedUrl}`);
}

async function runCapture(projectSlug: string, config: ProjectConfig): Promise<void> {
  const project = dbGetProjectBySlug(projectSlug)!;
  const pending = dbGetPagesByProject(project.id).filter(
    (p) => p.status === 'pending' || p.status === 'crawled',
  );

  if (pending.length === 0) {
    logger.info('No pending pages to capture. Run the crawler first.');
    return;
  }

  const bar = new cliProgress.SingleBar(
    { format: 'Capturing | {bar} | {value}/{total} pages' },
    cliProgress.Presets.shades_classic,
  );
  bar.start(pending.length, 0);

  try {
    const result = await capturePages(projectSlug, config, (_url, done, total) => {
      bar.setTotal(total);
      bar.update(done);
    });
    bar.stop();
    logger.success(`Capture complete: ${result.captured} captured, ${result.failed} failed.`);
  } catch (err) {
    bar.stop();
    logger.error(`Capture failed: ${(err as Error).message}`);
  }
}

async function runCaptureAll(projectSlug: string, config: ProjectConfig): Promise<void> {
  const project = dbGetProjectBySlug(projectSlug)!;
  const pages = dbGetPagesByProject(project.id);

  if (pages.length === 0) {
    logger.info('No pages found to capture. Run the crawler or import pages first.');
    return;
  }

  const bar = new cliProgress.SingleBar(
    { format: 'Capturing | {bar} | {value}/{total} pages' },
    cliProgress.Presets.shades_classic,
  );
  bar.start(pages.length, 0);

  try {
    const result = await capturePages(projectSlug, config, (_url, done, total) => {
      bar.setTotal(total);
      bar.update(done);
    }, undefined, true);
    bar.stop();
    logger.success(`Capture complete: ${result.captured} captured, ${result.failed} failed.`);
  } catch (err) {
    bar.stop();
    logger.error(`Capture failed: ${(err as Error).message}`);
  }
}

async function runCaptureSpecific(projectSlug: string, config: ProjectConfig): Promise<void> {
  const project = dbGetProjectBySlug(projectSlug)!;
  const pages = dbGetPagesByProject(project.id);

  if (pages.length === 0) {
    logger.info('No pages found. Run the crawler first.');
    return;
  }

  const { url } = await inquirer.prompt([
    {
      type: 'list',
      name: 'url',
      message: 'Select page to capture:',
      choices: [
        ...pages.map((p) => ({ name: `[${p.status}] ${p.url}`, value: p.url })),
        new inquirer.Separator(),
        { name: '← Back', value: 'back' },
      ],
    },
  ]);

  if (url === 'back') return;

  const spinner = ora(`Capturing ${url}...`).start();
  try {
    const result = await capturePages(projectSlug, config, undefined, url);
    spinner.stop();
    if (result.captured > 0) {
      logger.success(`Captured successfully: ${url}`);
    } else {
      logger.warn(`Capture failed for: ${url}`);
    }
  } catch (err) {
    spinner.stop();
    logger.error(`Capture error: ${(err as Error).message}`);
  }
}


function viewRedirects(projectSlug: string): void {
  const data = loadRedirectsFile(projectSlug);
  const all = [...data.redirects, ...data.manual];

  if (all.length === 0) {
    logger.info('No redirects detected yet. Run the crawler first.');
    return;
  }

  console.log(chalk.bold(`\nDetected redirects (${data.redirects.length}) + manual (${data.manual.length}):\n`));
  for (const r of data.redirects) {
    const status = r.disabled ? chalk.gray(' (disabled)') : '';
    console.log(`  ${chalk.cyan(r.statusCode)}  ${chalk.yellow(r.from)}  →  ${chalk.green(r.to)}${status}`);
  }
  if (data.manual.length > 0) {
    console.log(chalk.bold('\nManual:'));
    for (const r of data.manual) {
      const status = r.disabled ? chalk.gray(' (disabled)') : '';
      const desc = r.description ? chalk.gray(` (${r.description})`) : '';
      console.log(`  ${chalk.cyan(r.statusCode)}  ${chalk.yellow(r.from)}  →  ${chalk.green(r.to)}${desc}${status}`);
    }
  }
  console.log();
}

async function runRegenRedirects(projectSlug: string, config: ProjectConfig): Promise<void> {
  const spinner = ora('Regenerating _redirects files...').start();
  try {
    // Write original unrewritten redirects to original/
    writeRedirectsTo(config.paths.original, projectSlug);

    // Write rewritten redirects to each translation output directory
    for (const [lang, dir] of Object.entries(config.paths.translations)) {
      if (dir) {
        writeRedirectsTo(dir, projectSlug, config.pathRewrite);
      }
    }
    spinner.stop();
    logger.success(`_redirects written to original and target directories.`);
  } catch (err) {
    spinner.stop();
    logger.error(`Failed to regenerate _redirects: ${(err as Error).message}`);
  }
}

function viewPages(projectSlug: string): void {
  const project = dbGetProjectBySlug(projectSlug)!;
  const pages = dbGetPagesByProject(project.id);

  if (pages.length === 0) {
    logger.info('No pages found.');
    return;
  }

  const byStatus: Record<string, number> = {};
  for (const page of pages) {
    byStatus[page.status] = (byStatus[page.status] ?? 0) + 1;
  }

  console.log(chalk.bold('\nPage Summary:\n'));
  for (const [status, count] of Object.entries(byStatus)) {
    const color =
      status === 'captured' || status === 'personalized'
        ? chalk.green
        : status === 'error'
          ? chalk.red
          : chalk.yellow;
    console.log(`  ${color(status.padEnd(15))} ${count}`);
  }
  console.log(`\n  ${'Total'.padEnd(15)} ${pages.length}`);
}
