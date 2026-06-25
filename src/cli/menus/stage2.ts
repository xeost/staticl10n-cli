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
import { runManualTranslationStage } from '../../stages/stage2/manual.js';
import { logger } from '../../utils/logger.js';
import { clearScreen, printStageHeader, promptSelect } from '../ui.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m ${s % 60}s`;
}

function formatEstimations(elapsedMs: number, done: number, total: number): string {
  if (done <= 0 || elapsedMs <= 0 || done >= total) return '';
  const avg = elapsedMs / done;
  const remainingMs = avg * (total - done);
  const totalMs = avg * total;
  return ` (ETA: ${formatElapsed(remainingMs)} | Total: ${formatElapsed(totalMs)})`;
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
  let lastChoiceValue = 'translate-all';
  while (true) {
    const action = await promptSelect(
      'Stage 2: Translation',
      [
        { name: 'Translate all captured pages', value: 'translate-all' },
        { name: 'Translate pending pages only', value: 'translate-pending' },
        { name: 'Translate to a specific language', value: 'translate-lang' },
        { name: 'Re-translate specific page', value: 'retranslate' },
        { name: 'Translate all captured pages (manual)', value: 'manual-translate-all' },
        { name: 'Translate pending pages only (manual)', value: 'manual-translate-pending' },
        { name: 'Translate to a specific language (manual)', value: 'manual-translate-lang' },
        { name: 'Re-translate specific page (manual)', value: 'manual-retranslate' },
        { name: 'View translation status by language', value: 'status' },
        { name: 'Purge cache (this project)', value: 'purge-cache-project' },
        { name: 'Purge cache (all projects)', value: 'purge-cache-all' },
        { name: 'Purge code block cache (this project)', value: 'purge-cache-code' },
        { name: 'View cache statistics', value: 'cache-stats' },
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
      case 'manual-translate-all':
        await runManualTranslation(projectSlug, config, false);
        break;
      case 'manual-translate-pending':
        await runManualTranslation(projectSlug, config, true);
        break;
      case 'manual-translate-lang':
        await runManualTranslateLanguage(projectSlug, config);
        break;
      case 'manual-retranslate':
        await runManualRetranslate(projectSlug, config);
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
  let currentFragmentsDone = 0;
  let currentFragmentsTotal = 0;
  let currentUrl = '';
  let currentLang = '';
  let currentFragmentId = '';

  const timerInterval = setInterval(() => {
    if (currentFragmentsTotal > 0) {
      const elapsed = Date.now() - pageStart;
      const estimations = formatEstimations(elapsed, currentFragmentsDone, currentFragmentsTotal);
      const fragIdStr = currentFragmentId ? ` (${currentFragmentId})` : '';
      bar.update(barDone, {
        url: currentUrl ? `[${currentLang}] ${currentUrl.slice(-50)}` : '',
        fragment: `${currentFragmentsDone}/${currentFragmentsTotal} fragments${fragIdStr}`,
        elapsed: formatElapsed(elapsed) + estimations,
        tokens: formatTokens(grandTotalTokens)
      });
    }
  }, 100);

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
        currentFragmentsDone = 0;
        currentFragmentsTotal = 0;
        currentFragmentId = '';
        currentUrl = url;
        currentLang = lang;
        bar.update(done, { url: `[${lang}] ${url.slice(-50)}`, fragment: '-', elapsed: '0.0s', tokens: formatTokens(grandTotalTokens) });
      },
      (done, fragmentTotal, tokens, _url, _lang, fragmentId) => {
        grandTotalTokens += tokens - currentPagePrevTokens;
        currentPagePrevTokens = tokens;
        currentFragmentsDone = done;
        currentFragmentsTotal = fragmentTotal;
        currentFragmentId = fragmentId;
        const elapsed = Date.now() - pageStart;
        const estimations = formatEstimations(elapsed, done, fragmentTotal);
        bar.update(barDone, { fragment: `${done}/${fragmentTotal} fragments (${fragmentId})`, elapsed: formatElapsed(elapsed) + estimations, tokens: formatTokens(grandTotalTokens) });
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
  } finally {
    clearInterval(timerInterval);
  }
}

async function runTranslateLanguage(projectSlug: string, config: ProjectConfig): Promise<void> {
  const lang = await promptSelect(
    'Select target language',
    config.translation.targetLanguages.map((l) => ({ name: l, value: l })),
    config.name
  );

  if (lang === 'clear') return;

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
      choices: [
        ...pages.map((p) => ({ name: p.url, value: p.url })),
        new inquirer.Separator(),
        { name: '← Back', value: 'back' },
      ],
    },
  ]);

  if (url === 'back') return;

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
  const pages = dbGetPagesByProject(project.id, ['captured', 'personalized']);

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

async function runManualTranslation(
  projectSlug: string,
  config: ProjectConfig,
  pendingOnly = false,
): Promise<void> {
  const project = dbGetProjectBySlug(projectSlug)!;
  let pages = dbGetPagesByProject(project.id, ['captured', 'personalized']);
  const languages = config.translation.targetLanguages;

  if (pendingOnly) {
    pages = pages.filter((page) => {
      const translations = dbGetTranslationsByPage(page.id);
      return languages.some(
        (l) => !translations.find((t) => t.language === l && t.status === 'translated'),
      );
    });
  }

  if (pages.length === 0) {
    logger.info('No pages found for manual translation.');
    return;
  }

  await runManualTranslationStage(projectSlug, config, {
    pages,
    languages,
    actionName: pendingOnly ? 'pending pages (manual)' : 'all pages (manual)',
  });
}

async function runManualTranslateLanguage(
  projectSlug: string,
  config: ProjectConfig,
): Promise<void> {
  const project = dbGetProjectBySlug(projectSlug)!;
  const pages = dbGetPagesByProject(project.id, ['captured', 'personalized']);

  if (pages.length === 0) {
    logger.info('No pages captured to translate.');
    return;
  }

  const { lang } = await inquirer.prompt([
    {
      type: 'list',
      name: 'lang',
      message: 'Select language for manual translation:',
      choices: config.translation.targetLanguages,
    },
  ]);

  await runManualTranslationStage(projectSlug, config, {
    pages,
    languages: [lang],
    actionName: `language ${lang} (manual)`,
  });
}

async function runManualRetranslate(
  projectSlug: string,
  config: ProjectConfig,
): Promise<void> {
  const project = dbGetProjectBySlug(projectSlug)!;
  const pages = dbGetPagesByProject(project.id, ['captured', 'personalized', 'translated']);

  if (pages.length === 0) {
    logger.info('No pages found to translate.');
    return;
  }

  const choices = [
    { name: '← Back', value: 'back' },
    ...pages.map((p) => ({ name: `[${p.status}] ${p.url}`, value: p.url })),
  ];

  const { url } = await inquirer.prompt([
    {
      type: 'list',
      name: 'url',
      message: 'Select page for manual re-translation:',
      choices,
      pageSize: 15,
    },
  ]);

  if (url === 'back') return;

  const targetPage = pages.find((p) => p.url === url)!;

  await runManualTranslationStage(projectSlug, config, {
    pages: [targetPage],
    languages: config.translation.targetLanguages,
    actionName: `page ${url} (manual)`,
    targetPageUrl: url,
  });
}
