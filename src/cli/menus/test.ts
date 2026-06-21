import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import path from 'path';
import type { ProjectConfig } from '../../core/config.js';
import { dbGetProjectBySlug, dbUpsertPage } from '../../core/db.js';
import { capturePages } from '../../stages/stage1/exporter.js';
import { applyPrePersonalization } from '../../stages/stage1/personalizer.js';
import { translateProject } from '../../stages/stage2/index.js';
import { applyPostPersonalization } from '../../stages/stage3/rules.js';
import { logger } from '../../utils/logger.js';
import { urlToFilePath } from '../../utils/paths.js';

// ─── Single-Page Test Menu ─────────────────────────────────────────────────────

export async function testMenu(projectSlug: string, config: ProjectConfig): Promise<void> {
  console.log();
  console.log(chalk.yellow.bold('  ⚡ Single-Page Test Mode'));
  console.log(
    chalk.gray(
      '  Runs the full pipeline (capture → personalize → translate → post-personalize)\n' +
        '  on a single URL so you can verify the output without processing the whole site.\n',
    ),
  );

  const { url } = await inquirer.prompt([
    {
      type: 'input',
      name: 'url',
      message: 'URL to test (must be reachable from this machine):',
      default: config.url,
      validate: (v: string) => {
        try {
          new URL(v);
          return true;
        } catch {
          return 'Enter a valid URL';
        }
      },
    },
  ]);

  const { languages } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'languages',
      message: 'Languages to translate into (space to toggle):',
      choices: config.translation.targetLanguages.map((l) => ({ name: l, value: l, checked: true })),
    },
  ]);

  if ((languages as string[]).length === 0) {
    logger.warn('No languages selected. Aborting.');
    return;
  }

  const { stages } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'stages',
      message: 'Which stages to run (space to toggle):',
      choices: [
        { name: 'Stage 1 : Capture', value: 'capture', checked: true },
        { name: 'Stage 1b: Pre-personalization', value: 'pre-personalize', checked: true },
        { name: 'Stage 2 : Translation', value: 'translate', checked: true },
        { name: 'Stage 3 : Post-personalization', value: 'post-personalize', checked: true },
      ],
    },
  ]);

  if ((stages as string[]).length === 0) {
    logger.warn('No stages selected. Aborting.');
    return;
  }

  console.log();
  await runTestPipeline(projectSlug, config, url as string, languages as string[], stages as string[]);
}

// ─── Pipeline ──────────────────────────────────────────────────────────────────

async function runTestPipeline(
  projectSlug: string,
  config: ProjectConfig,
  url: string,
  languages: string[],
  stages: string[],
): Promise<void> {
  const project = dbGetProjectBySlug(projectSlug)!;
  const pagePath = urlToFilePath(url);

  // Ensure the URL exists in the DB so stage functions can find it
  dbUpsertPage(project.id, url, pagePath, 'pending');

  const results: Record<string, string> = {};

  // ── Stage 1: Capture ──────────────────────────────────────────────────────
  if (stages.includes('capture')) {
    const spinner = ora(`[1/4] Capturing ${url}...`).start();
    try {
      const result = await capturePages(projectSlug, config, undefined, url);
      if (result.captured > 0) {
        spinner.succeed(`[1/4] Captured → ${path.join(config.paths.original, pagePath)}`);
        results['capture'] = 'ok';
      } else {
        spinner.fail('[1/4] Capture failed — check logs for details.');
        results['capture'] = 'failed';
        return; // Cannot continue without a captured page
      }
    } catch (err) {
      spinner.fail(`[1/4] Capture error: ${(err as Error).message}`);
      return;
    }
  }

  // ── Stage 1b: Pre-personalization ─────────────────────────────────────────
  if (stages.includes('pre-personalize')) {
    const spinner = ora('[1b] Applying pre-personalization rules...').start();
    try {
      const result = await applyPrePersonalization(projectSlug, config, false, url);
      spinner.succeed(
        `[1b] Pre-personalization done — ${result.pagesProcessed} page, rules: ${
          Object.entries(result.affectedByRule)
            .map(([k, v]) => `${k}:${v}`)
            .join(', ') || 'none'
        }`,
      );
      results['pre-personalize'] = 'ok';
    } catch (err) {
      spinner.warn(`[1b] Pre-personalization error: ${(err as Error).message}`);
      results['pre-personalize'] = 'error';
    }
  }

  // ── Stage 2: Translation ──────────────────────────────────────────────────
  if (stages.includes('translate')) {
    const spinner = ora(`[2/4] Translating into: ${languages.join(', ')}...`).start();
    const pageStart = Date.now();
    try {
      const result = await translateProject(
        projectSlug, config, languages, url,
        undefined,
        (done, total, _url, lang) => {
          const elapsed = ((Date.now() - pageStart) / 1000).toFixed(1);
          spinner.text = `[2/4] [${lang}] fragment ${done}/${total} · ${elapsed}s elapsed`;
        },
      );
      const totalElapsed = ((Date.now() - pageStart) / 1000).toFixed(1);
      if (result.pagesTranslated > 0) {
        spinner.succeed(
          `[2/4] Translation done in ${totalElapsed}s — cache hits: ${result.cacheHits}, misses: ${result.cacheMisses}`,
        );
        results['translate'] = 'ok';
        for (const lang of languages) {
          const translatedPath = path.join(config.paths.translations[lang] ?? '', pagePath);
          logger.info(`  [${lang}] → ${translatedPath}`);
        }
      } else {
        spinner.fail('[2/4] Translation produced no output — check Ollama is running and accessible.');
        results['translate'] = 'failed';
      }
    } catch (err) {
      spinner.fail(`[2/4] Translation error: ${(err as Error).message}`);
      results['translate'] = 'error';
    }
  }

  // ── Stage 3: Post-personalization ─────────────────────────────────────────
  if (stages.includes('post-personalize')) {
    const spinner = ora('[3/4] Applying post-personalization rules...').start();
    try {
      const result = await applyPostPersonalization(projectSlug, config, false, url);
      spinner.succeed(
        `[3/4] Post-personalization done — ${result.pagesProcessed} file(s) in: ${
          result.directoriesProcessed.join(', ')
        }`,
      );
      results['post-personalize'] = 'ok';
    } catch (err) {
      spinner.warn(`[3/4] Post-personalization error: ${(err as Error).message}`);
      results['post-personalize'] = 'error';
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log();
  console.log(chalk.bold('  Test Summary'));
  console.log(chalk.gray('  ─────────────────────────────────────────'));
  const stageLabels: Record<string, string> = {
    capture: '  Stage 1 : Capture',
    'pre-personalize': '  Stage 1b: Pre-personalization',
    translate: '  Stage 2 : Translation',
    'post-personalize': '  Stage 3 : Post-personalization',
  };
  for (const [key, label] of Object.entries(stageLabels)) {
    if (!(key in results)) continue;
    const status =
      results[key] === 'ok'
        ? chalk.green('✓ ok')
        : results[key] === 'failed'
          ? chalk.red('✗ failed')
          : chalk.yellow('⚠ error');
    console.log(`  ${label.padEnd(34)} ${status}`);
  }
  console.log();

  if (results['capture'] === 'ok') {
    console.log(chalk.cyan(`  Output location:`));
    console.log(chalk.gray(`    original/  : ${path.join(config.paths.original, pagePath)}`));
    for (const lang of languages) {
      if (config.paths.translations[lang]) {
        console.log(
          chalk.gray(`    [${lang.padEnd(6)}]: ${path.join(config.paths.translations[lang], pagePath)}`),
        );
      }
    }
    console.log();
    console.log(chalk.gray('  Tip: open the translated HTML file in a browser to verify the output.'));
  }

}
