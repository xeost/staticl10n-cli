import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import type { ProjectConfig } from '../../core/config.js';
import { applyPostPersonalization, listPostRules } from '../../stages/stage3/rules.js';
import { logger } from '../../utils/logger.js';

// ─── Stage 3 Menu ─────────────────────────────────────────────────────────────

export async function stage3Menu(projectSlug: string, config: ProjectConfig): Promise<void> {
  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: chalk.bold('Stage 3: Post-Personalization'),
      choices: [
        { name: 'Apply post-personalization rules', value: 'apply' },
        { name: 'Preview rules (dry-run)', value: 'dry' },
        { name: 'View configured rules', value: 'view' },
        { name: chalk.gray('← Back'), value: 'back' },
      ],
    },
  ]);

  switch (action) {
    case 'apply':
      await runPostPersonalization(projectSlug, config, false);
      break;
    case 'dry':
      await runPostPersonalization(projectSlug, config, true);
      break;
    case 'view':
      viewRules(config);
      break;
    case 'back':
      return;
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function runPostPersonalization(
  projectSlug: string,
  config: ProjectConfig,
  dryRun: boolean,
): Promise<void> {
  const spinner = ora(
    dryRun ? 'Previewing post-personalization...' : 'Applying post-personalization...',
  ).start();

  try {
    const result = await applyPostPersonalization(projectSlug, config, dryRun);
    spinner.stop();
    logger.success(
      `${dryRun ? '[DRY RUN] ' : ''}Post-personalization complete.`,
    );
    logger.info(`Directories processed: ${result.directoriesProcessed.join(', ')}`);
    logger.info(`Pages processed: ${result.pagesProcessed}`);
    console.log();
    for (const [rule, count] of Object.entries(result.affectedByRule)) {
      console.log(`  ${chalk.cyan(rule)}: ${count} element(s) affected`);
    }
  } catch (err) {
    spinner.stop();
    logger.error(`Post-personalization failed: ${(err as Error).message}`);
  }
}

function viewRules(config: ProjectConfig): void {
  const rules = listPostRules(config);
  if (rules.length === 0) {
    logger.info('No post-translation rules configured.');
    return;
  }
  console.log(chalk.bold(`\nPost-Translation Rules (${rules.length}):\n`));
  rules.forEach((rule, i) => {
    console.log(`  ${chalk.cyan(`${i + 1}.`)} [${chalk.yellow(rule.type)}] ${rule.description ?? ''}`);
    if (rule.selector) console.log(`     Selector: ${chalk.gray(rule.selector)}`);
    if (rule.html) console.log(`     HTML: ${chalk.gray(rule.html.slice(0, 60))}...`);
  });
}
