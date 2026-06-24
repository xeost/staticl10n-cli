import chalk from 'chalk';
import cliProgress from 'cli-progress';
import inquirer from 'inquirer';
import type { ProjectConfig } from '../../core/config.js';
import { dbGetProjectBySlug } from '../../core/db.js';
import { capturePages } from '../../stages/stage1/exporter.js';
import { translateProject } from '../../stages/stage2/index.js';
import { diffSite } from '../../stages/stage4/differ.js';
import { getPendingChanges, ignoreChange, markReTranslated } from '../../stages/stage4/reporter.js';
import { logger } from '../../utils/logger.js';
import { clearScreen, printStageHeader, promptSelect } from '../ui.js';

// ─── Stage 4 Menu ─────────────────────────────────────────────────────────────

export async function stage4Menu(projectSlug: string, config: ProjectConfig): Promise<void> {
  clearScreen();
  let lastChoiceValue = 'check';
  while (true) {
    const action = await promptSelect(
      'Stage 4: Monitoring',
      [
        { name: 'Check site for changes', value: 'check' },
        { name: 'View pages with detected changes', value: 'view-changes' },
        { name: 'Re-process page with changes', value: 'reprocess' },
        { name: 'Mark changes as ignored', value: 'ignore' },
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
      case 'check':
        await runDiff(projectSlug, config);
        break;
      case 'view-changes':
        viewChanges(projectSlug);
        break;
      case 'reprocess':
        await reprocessPage(projectSlug, config);
        break;
      case 'ignore':
        await ignoreChanges(projectSlug);
        break;
    }
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function runDiff(projectSlug: string, config: ProjectConfig): Promise<void> {
  const project = dbGetProjectBySlug(projectSlug)!;
  const bar = new cliProgress.SingleBar(
    { format: 'Checking | {bar} | {value}/{total} pages' },
    cliProgress.Presets.shades_classic,
  );
  bar.start(100, 0);

  try {
    const result = await diffSite(projectSlug, config, (_url, done, total) => {
      bar.setTotal(total);
      bar.update(done);
    });
    bar.stop();
    logger.success(
      `Check complete: ${result.checked} pages checked, ${result.changed} changes detected, ${result.errors} errors.`,
    );
    void project;
  } catch (err) {
    bar.stop();
    logger.error(`Diff failed: ${(err as Error).message}`);
  }
}

function viewChanges(projectSlug: string): void {
  const changes = getPendingChanges(projectSlug);

  if (changes.length === 0) {
    logger.info('No pending changes detected.');
    return;
  }

  console.log(chalk.bold(`\nPages with detected changes (${changes.length}):\n`));
  for (const change of changes) {
    console.log(
      `  ${chalk.yellow('#' + change.detectionId)} ${chalk.cyan(change.url)}\n` +
        `  ${chalk.gray('Detected: ' + change.detectedAt)}\n`,
    );
  }
}

async function reprocessPage(projectSlug: string, config: ProjectConfig): Promise<void> {
  const changes = getPendingChanges(projectSlug);

  if (changes.length === 0) {
    logger.info('No pending changes to reprocess.');
    return;
  }

  const { detectionId } = await inquirer.prompt([
    {
      type: 'list',
      name: 'detectionId',
      message: 'Select page to re-capture and re-translate:',
      choices: changes.map((c) => ({
        name: `#${c.detectionId} — ${c.url}`,
        value: c.detectionId,
      })),
    },
  ]);

  const change = changes.find((c) => c.detectionId === detectionId)!;

  logger.info(`Re-capturing ${change.url}...`);
  try {
    await capturePages(projectSlug, config, undefined, change.url);
    logger.info(`Re-translating ${change.url}...`);
    await translateProject(projectSlug, config, undefined, change.url);
    markReTranslated(detectionId);
    logger.success(`Page re-processed and marked as re-translated.`);
  } catch (err) {
    logger.error(`Re-processing failed: ${(err as Error).message}`);
  }
}

async function ignoreChanges(projectSlug: string): Promise<void> {
  const changes = getPendingChanges(projectSlug);

  if (changes.length === 0) {
    logger.info('No pending changes to ignore.');
    return;
  }

  const { selected } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selected',
      message: 'Select changes to mark as ignored:',
      choices: changes.map((c) => ({
        name: `#${c.detectionId} — ${c.url}`,
        value: c.detectionId,
      })),
    },
  ]);

  for (const detectionId of selected as number[]) {
    ignoreChange(detectionId);
  }

  if ((selected as number[]).length > 0) {
    logger.success(`${(selected as number[]).length} change(s) marked as ignored.`);
  }
}
