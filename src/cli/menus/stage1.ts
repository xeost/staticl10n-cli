import chalk from 'chalk';
import cliProgress from 'cli-progress';
import inquirer from 'inquirer';
import ora from 'ora';
import type { ProjectConfig } from '../../core/config.js';
import { dbGetPagesByProject, dbGetProjectBySlug } from '../../core/db.js';
import { capturePages } from '../../stages/stage1/exporter.js';
import { applyPrePersonalization } from '../../stages/stage1/personalizer.js';
import { crawlSite } from '../../stages/stage1/crawler.js';
import { logger } from '../../utils/logger.js';

// ─── Stage 1 Menu ─────────────────────────────────────────────────────────────

export async function stage1Menu(projectSlug: string, config: ProjectConfig): Promise<void> {
  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: chalk.bold('Stage 1: Capture'),
      choices: [
        { name: 'Detect URLs (crawler)', value: 'crawl' },
        { name: 'Capture pending pages', value: 'capture' },
        { name: 'Re-capture specific page', value: 'recapture' },
        { name: 'Apply pre-personalization (on original/)', value: 'pre-personalize' },
        { name: 'Preview pre-personalization (dry-run)', value: 'pre-personalize-dry' },
        { name: 'View captured pages', value: 'view' },
        { name: chalk.gray('← Back'), value: 'back' },
      ],
    },
  ]);

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
    case 'back':
      return;
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function runCrawl(projectSlug: string, config: ProjectConfig): Promise<void> {
  const spinner = ora('Starting crawler...').start();
  const bar = new cliProgress.SingleBar(
    { format: 'Crawling | {bar} | {value} URLs found' },
    cliProgress.Presets.shades_classic,
  );
  bar.start(config.crawl.maxPages, 0);
  spinner.stop();

  try {
    const result = await crawlSite(projectSlug, config, (_url, total) => {
      bar.update(total);
    });
    bar.stop();
    logger.success(`Crawl complete: ${result.discovered} URLs discovered, ${result.errors} errors.`);
  } catch (err) {
    bar.stop();
    logger.error(`Crawl failed: ${(err as Error).message}`);
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
