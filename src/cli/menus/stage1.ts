import chalk from 'chalk';
import cliProgress from 'cli-progress';
import inquirer from 'inquirer';
import ora from 'ora';
import type { ProjectConfig } from '../../core/config.js';
import { dbDeletePagesByProject, dbGetPagesByProject, dbGetProjectBySlug } from '../../core/db.js';
import { capturePages } from '../../stages/stage1/exporter.js';
import { applyPrePersonalization } from '../../stages/stage1/personalizer.js';
import { crawlSite } from '../../stages/stage1/crawler.js';
import { loadRedirectsFile, writeRedirectsTo } from '../../stages/stage1/redirects.js';
import { logger } from '../../utils/logger.js';
import { clearScreen, printStageHeader, promptSelect } from '../ui.js';

// ─── Stage 1 Menu ─────────────────────────────────────────────────────────────

export async function stage1Menu(projectSlug: string, config: ProjectConfig): Promise<void> {
  clearScreen();
  let lastChoiceValue = 'crawl';
  while (true) {
    const action = await promptSelect(
      'Stage 1: Capture',
      [
        { name: 'Detect URLs (crawler)', value: 'crawl' },
        { name: 'Capture pending pages', value: 'capture' },
        { name: 'Re-capture specific page', value: 'recapture' },
        { name: 'Apply pre-personalization (on original/)', value: 'pre-personalize' },
        { name: 'Preview pre-personalization (dry-run)', value: 'pre-personalize-dry' },
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
      case 'crawl':
        await runCrawl(projectSlug, config);
        break;
      case 'capture':
        await runCapture(projectSlug, config);
        break;
      case 'recapture':
        await runRecapture(projectSlug, config);
        break;
      case 'pre-personalize':
        await runPrePersonalization(projectSlug, config, false);
        break;
      case 'pre-personalize-dry':
        await runPrePersonalization(projectSlug, config, true);
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

async function runCrawl(projectSlug: string, config: ProjectConfig): Promise<void> {
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
      logger.info('Cleared existing pages. Starting fresh crawl.');
    }
  }

  const controller = new AbortController();

  // Keypress-based cancellation: works even when spawned via pnpm (which also
  // receives SIGINT and kills the whole process group before our handler runs).
  let keypressCleanup: (() => void) | null = null;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onData = (key: string): void => {
      // q / Q / Escape / Ctrl+C
      if (key === 'q' || key === 'Q' || key === '\u001b' || key === '\u0003') {
        controller.abort();
      }
    };

    process.stdin.on('data', onData);

    keypressCleanup = (): void => {
      process.stdin.removeListener('data', onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    };
  }

  const spinner = ora('Starting crawler...').start();
  const bar = new cliProgress.SingleBar(
    { format: `Crawling | {bar} | {value} URLs found  ${chalk.gray('[q] cancel')}` },
    cliProgress.Presets.shades_classic,
  );
  bar.start(config.crawl.maxPages, 0);
  spinner.stop();

  try {
    const result = await crawlSite(projectSlug, config, (_url, total) => {
      bar.update(total);
    }, controller.signal);
    bar.stop();
    const redirectMsg = result.redirectsDetected > 0
      ? `, ${result.redirectsDetected} redirect(s) detected`
      : '';
    if (result.aborted) {
      logger.warn(`Crawl cancelled: ${result.discovered} URLs discovered, ${result.errors} errors${redirectMsg}.`);
    } else {
      logger.success(`Crawl complete: ${result.discovered} URLs discovered, ${result.errors} errors${redirectMsg}.`);
    }
  } catch (err) {
    bar.stop();
    logger.error(`Crawl failed: ${(err as Error).message}`);
  } finally {
    keypressCleanup?.();
  }
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

async function runRecapture(projectSlug: string, config: ProjectConfig): Promise<void> {
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
      message: 'Select page to re-capture:',
      choices: pages.map((p) => ({ name: `[${p.status}] ${p.url}`, value: p.url })),
    },
  ]);

  const spinner = ora(`Re-capturing ${url}...`).start();
  try {
    const result = await capturePages(projectSlug, config, undefined, url);
    spinner.stop();
    if (result.captured > 0) {
      logger.success(`Re-captured successfully: ${url}`);
    } else {
      logger.warn(`Re-capture failed for: ${url}`);
    }
  } catch (err) {
    spinner.stop();
    logger.error(`Re-capture error: ${(err as Error).message}`);
  }
}

async function runPrePersonalization(
  projectSlug: string,
  config: ProjectConfig,
  dryRun: boolean,
): Promise<void> {
  const spinner = ora(
    dryRun ? 'Previewing pre-personalization...' : 'Applying pre-personalization...',
  ).start();
  try {
    const result = await applyPrePersonalization(projectSlug, config, dryRun);
    spinner.stop();
    logger.success(
      `${dryRun ? '[DRY RUN] ' : ''}Pre-personalization complete: ${result.pagesProcessed} pages processed.`,
    );
    for (const [rule, count] of Object.entries(result.affectedByRule)) {
      console.log(`  ${chalk.cyan(rule)}: ${count} element(s) affected`);
    }
  } catch (err) {
    spinner.stop();
    logger.error(`Pre-personalization failed: ${(err as Error).message}`);
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
    console.log(`  ${chalk.cyan(r.statusCode)}  ${chalk.yellow(r.from)}  →  ${chalk.green(r.to)}`);
  }
  if (data.manual.length > 0) {
    console.log(chalk.bold('\nManual:'));
    for (const r of data.manual) {
      const desc = r.description ? chalk.gray(` (${r.description})`) : '';
      console.log(`  ${chalk.cyan(r.statusCode)}  ${chalk.yellow(r.from)}  →  ${chalk.green(r.to)}${desc}`);
    }
  }
  console.log();
}

async function runRegenRedirects(projectSlug: string, config: ProjectConfig): Promise<void> {
  const spinner = ora('Regenerating _redirects files...').start();
  try {
    const outputDirs = [config.paths.original, ...Object.values(config.paths.translations)];
    for (const dir of outputDirs) {
      writeRedirectsTo(dir, projectSlug);
    }
    spinner.stop();
    logger.success(`_redirects written to ${outputDirs.length} director(ies).`);
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
