import chalk from 'chalk';
import cliProgress from 'cli-progress';
import inquirer from 'inquirer';
import ora from 'ora';
import type { ProjectConfig } from '../../core/config.js';
import {
  dbGetCacheStats,
  dbGetPagesByProject,
  dbGetProjectBySlug,
  dbGetTranslationsByPage,
  dbPurgeAllTranslationCaches,
  dbPurgeCodeBlockTranslationCache,
  dbPurgeTranslationCache,
} from '../../core/db.js';
import { translateProject } from '../../stages/stage2/index.js';
import { logger } from '../../utils/logger.js';
import { clearScreen, printStageHeader } from '../ui.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m ${s % 60}s`;
}

function formatTokens(n: number): string {
  if (n === 0) return '0 tokens';
  if (n < 1000) return `${n} tokens`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k tokens`;
  return `${(n / 1_000_000).toFixed(2)}M tokens`;
}

// ─── Stage 2 Menu ─────────────────────────────────────────────────────────────

export async function stage2Menu(projectSlug: string, config: ProjectConfig): Promise<void> {
  clearScreen();
  while (true) {
    printStageHeader('Stage 2: Translation', config.name);
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: chalk.bold('Stage 2: Translation'),
        choices: [
          { name: 'Translate all captured pages', value: 'translate-all' },
          { name: 'Translate pending pages only', value: 'translate-pending' },
          { name: 'Translate to a specific language', value: 'translate-lang' },
          { name: 'Re-translate specific page', value: 'retranslate' },
          { name: 'View translation status by language', value: 'status' },
          { name: 'Purge cache (this project)', value: 'purge-cache-project' },
          { name: 'Purge cache (all projects)', value: 'purge-cache-all' },
          { name: 'Purge code block cache (this project)', value: 'purge-cache-code' },
          { name: 'View cache statistics', value: 'cache-stats' },
          { name: chalk.gray('← Back'), value: 'back' },
        ],
      },
    ]);

    switch (action) {
      case 'translate-all':
        await runTranslation(projectSlug, config);
        break;
      case 'translate-pending':
        await runTranslation(projectSlug, config, undefined, true);
        break;
      case 'translate-lang':
        await runTranslateLanguage(projectSlug, config);
        break;
      case 'retranslate':
        await runRetranslate(projectSlug, config);
        break;
      case 'status':
        viewTranslationStatus(projectSlug, config);
        break;
      case 'purge-cache-project':
        await purgeCache(projectSlug, 'project');
        break;
      case 'purge-cache-all':
        await purgeCache(projectSlug, 'all');
        break;
      case 'purge-cache-code':
        await purgeCodeBlockCache(projectSlug);
        break;
      case 'cache-stats':
        viewCacheStats(projectSlug);
        break;
      case 'back':
        return;
    }
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function runTranslation(
  projectSlug: string,
  config: ProjectConfig,
  languages?: string[],
  pendingOnly = false,
): Promise<void> {
  const project = dbGetProjectBySlug(projectSlug)!;
  let pages = dbGetPagesByProject(project.id, ['captured', 'personalized']);

  if (pendingOnly) {
    // Filter to pages that still have pending translations in any language
    const langs = languages ?? config.translation.targetLanguages;
    pages = pages.filter((page) => {
      const translations = dbGetTranslationsByPage(page.id);
      return langs.some(
        (l) => !translations.find((t) => t.language === l && t.status === 'translated'),
      );
    });
  }

  if (pages.length === 0) {
    logger.info('No pages to translate.');
    return;
  }

  const langs = languages ?? config.translation.targetLanguages;
  const total = pages.length * langs.length;

  const model = config.translation.model;
  const bar = new cliProgress.SingleBar(
    { format: `Translating [${model}] | {bar} | {value}/{total} pages | {fragment} | {elapsed} | {tokens} | {url}` },
    cliProgress.Presets.shades_classic,
  );
  bar.start(total, 0, { url: '', fragment: '-', elapsed: '0.0s', tokens: '0 tokens' });

  let barDone = 0;
  let pageStart = Date.now();
  let grandTotalTokens = 0;
  let currentPagePrevTokens = 0;

  try {
    const result = await translateProject(
      projectSlug,
      config,
      langs,
      undefined,
      (url, lang, done) => {
        barDone = done;
        pageStart = Date.now();
        currentPagePrevTokens = 0;
        bar.update(done, { url: `[${lang}] ${url.slice(-50)}`, fragment: '-', elapsed: '0.0s', tokens: formatTokens(grandTotalTokens) });
      },
      (done, fragmentTotal, tokens, _url, _lang) => {
        grandTotalTokens += tokens - currentPagePrevTokens;
        currentPagePrevTokens = tokens;
        bar.update(barDone, { fragment: `${done}/${fragmentTotal} fragments`, elapsed: formatElapsed(Date.now() - pageStart), tokens: formatTokens(grandTotalTokens) });
      },
    );
    bar.stop();
    logger.success(
      `Translation complete: ${result.pagesTranslated} pages translated, ${result.pagesFailed} failed`,
    );
    logger.info(`Total tokens consumed: ${formatTokens(grandTotalTokens)} (input + output)`);
    logger.info(`Cache: ${result.cacheHits} hits / ${result.cacheMisses} misses`);
  } catch (err) {
    bar.stop();
    logger.error(`Translation failed: ${(err as Error).message}`);
  }
}

async function runTranslateLanguage(projectSlug: string, config: ProjectConfig): Promise<void> {
  const { lang } = await inquirer.prompt([
    {
      type: 'list',
      name: 'lang',
      message: 'Select target language:',
      choices: config.translation.targetLanguages,
    },
  ]);
  await runTranslation(projectSlug, config, [lang]);
}

async function runRetranslate(projectSlug: string, config: ProjectConfig): Promise<void> {
  const project = dbGetProjectBySlug(projectSlug)!;
  const pages = dbGetPagesByProject(project.id, ['captured', 'personalized']);

  if (pages.length === 0) {
    logger.info('No captured pages found.');
    return;
  }

  const { url } = await inquirer.prompt([
    {
      type: 'list',
      name: 'url',
      message: 'Select page to re-translate:',
      choices: pages.map((p) => ({ name: p.url, value: p.url })),
    },
  ]);

  const spinner = ora(`Translating ${url}...`).start();
  try {
    const result = await translateProject(projectSlug, config, undefined, url);
    spinner.stop();
    logger.success(`Re-translation complete: ${result.pagesTranslated} page(s) updated.`);
  } catch (err) {
    spinner.stop();
    logger.error(`Re-translation failed: ${(err as Error).message}`);
  }
}

function viewTranslationStatus(projectSlug: string, config: ProjectConfig): void {
  const project = dbGetProjectBySlug(projectSlug)!;
  const pages = dbGetPagesByProject(project.id);

  console.log(chalk.bold('\nTranslation Status:\n'));

  for (const lang of config.translation.targetLanguages) {
    const translations = pages.flatMap((p) =>
      dbGetTranslationsByPage(p.id).filter((t) => t.language === lang),
    );
    const translated = translations.filter((t) => t.status === 'translated').length;
    const failed = translations.filter((t) => t.status === 'failed').length;
    const pending = pages.length - translated - failed;

    console.log(
      `  ${chalk.cyan(lang.padEnd(8))}` +
        `  ${chalk.green(`✓ ${translated}`).padEnd(12)}` +
        `  ${chalk.red(`✗ ${failed}`).padEnd(12)}` +
        `  ${chalk.yellow(`… ${pending}`)} pending`,
    );
  }
}

async function purgeCache(projectSlug: string, scope: 'project' | 'all'): Promise<void> {
  const isAll = scope === 'all';
  const { confirmed } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmed',
      message: isAll
        ? chalk.red('This will delete ALL cached translations across every project. Are you sure?')
        : 'This will delete all cached translations for this project. Are you sure?',
      default: false,
    },
  ]);

  if (!confirmed) {
    logger.info('Cache purge cancelled.');
    return;
  }

  let count: number;
  if (isAll) {
    count = dbPurgeAllTranslationCaches();
    logger.success(`Cache purged: ${count} entries removed across all projects.`);
  } else {
    const project = dbGetProjectBySlug(projectSlug)!;
    count = dbPurgeTranslationCache(project.id);
    logger.success(`Cache purged: ${count} entries removed for project "${projectSlug}".`);
  }
}

async function purgeCodeBlockCache(projectSlug: string): Promise<void> {
  const project = dbGetProjectBySlug(projectSlug)!;
  const count = dbPurgeCodeBlockTranslationCache(project.id);
  logger.success(`Code block cache purged: ${count} entries removed for project "${projectSlug}".`);
}

function viewCacheStats(projectSlug: string): void {
  const project = dbGetProjectBySlug(projectSlug)!;
  const stats = dbGetCacheStats(project.id);
  console.log(chalk.bold('\nTranslation Cache Statistics:\n'));
  console.log(`  Total cached entries: ${chalk.cyan(stats.total)}`);
}
