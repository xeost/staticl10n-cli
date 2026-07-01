#!/usr/bin/env node

// Load .env file if present (Node.js 20.12+ built-in — no dotenv required)
try { (process as typeof process & { loadEnvFile?: () => void }).loadEnvFile?.(); } catch { /* .env is optional */ }

import chalk from 'chalk';
import { Command } from 'commander';
import inquirer from 'inquirer';
import readline from 'readline';
import path from 'path';
import { readConfig } from '../core/config.js';
import {
  dbBackup,
  dbGetPagesByProject,
  dbGetProjectBySlug,
  dbGetTranslationsByPage,
  dbListProjects,
} from '../core/db.js';
import { getProjectConfig } from '../core/project.js';
import { printChangeReport } from '../stages/stage4/reporter.js';
import { diffSite } from '../stages/stage4/differ.js';
import { logger } from '../utils/logger.js';
import { clearScreen, printBanner, printStageHeader, C, promptSelect } from './ui.js';
import { projectsMenu } from './menus/projects.js';
import { stage1Menu } from './menus/stage1.js';
import { stage2Menu } from './menus/stage2.js';
import { stage3Menu } from './menus/stage3.js';
import { stage4Menu } from './menus/stage4.js';
import { testMenu } from './menus/test.js';

// ─── Non-Interactive CLI Commands (via commander) ─────────────────────────────

const program = new Command();

program
  .name('staticl10n')
  .description('Static localization CLI: capture, translate and monitor websites')
  .version('0.1.0');

program
  .command('check <project-slug>')
  .description('Non-interactive: check a project for site changes (suitable for cron)')
  .action(async (slug: string) => {
    try {
      const config = getProjectConfig(slug);
      logger.info(`Checking project "${slug}" for changes...`);
      const result = await diffSite(slug, config);
      logger.info(`Checked ${result.checked} pages, ${result.changed} changes detected.`);
      printChangeReport(slug);
      process.exit(0);
    } catch (err) {
      logger.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ─── Interactive Session State ─────────────────────────────────────────────────

interface Session {
  activeProjectSlug: string | null;
}

const session: Session = { activeProjectSlug: null };

// ─── Dispatch: non-interactive sub-commands vs. interactive mode ───────────────

const args = process.argv.slice(2);
const isSubcommand = args.length > 0 && !args[0].startsWith('-');
const isFlagOnly = args.length > 0 && args.every((a) => a.startsWith('-'));

if (isSubcommand || isFlagOnly) {
  // commander handles: check <slug>, --version, --help
  program.parseAsync(process.argv).catch((err: Error) => {
    logger.error(err.message);
    process.exit(1);
  });
} else {
  // Handle SIGINT (Ctrl+C) gracefully to ensure automated database backup runs
  process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n\nInterrupted! Saving database backup before exit...'));
    await runAutoBackup();
    process.exit(130);
  });

  // No args → interactive mode
  runInteractive().catch((err: Error) => {
    logger.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}

// ─── Main Interactive Loop ─────────────────────────────────────────────────────

async function runInteractive(): Promise<void> {
  clearScreen();
  let lastChoiceValue = 'projects';
  while (true) {
    const activeProject = session.activeProjectSlug
      ? dbGetProjectBySlug(session.activeProjectSlug)
      : null;

    const projectLabel = activeProject
      ? chalk.green(`[${activeProject.name}]`)
      : chalk.gray('[no project selected]');

    // Build menu items dynamically
    const choices = [
      { name: 'Manage projects', value: 'projects' },
      { name: `Select active project  ${projectLabel}`, value: 'select-project' },
      { name: 'Backup database', value: 'backup' },
    ];

    if (activeProject) {
      choices.push({ name: 'View project status', value: 'status' });
      choices.push({ name: 'Stage 1: Capture', value: 'stage1' });
      choices.push({ name: 'Stage 2: Translation', value: 'stage2' });
      choices.push({ name: 'Stage 3: Post-Personalization', value: 'stage3' });
      choices.push({ name: 'Stage 4: Monitoring', value: 'stage4' });
      choices.push({ name: '⚡ Test: process single page', value: 'test' });
    }

    choices.push({ name: 'Exit', value: 'exit' });

    const choice = await promptSelect(
      'Main Menu',
      choices,
      activeProject ? activeProject.name : undefined,
      lastChoiceValue
    );

    if (choice === 'clear') {
      clearScreen();
      continue;
    }

    if (choice === 'exit') {
      await runAutoBackup();
      console.log(chalk.cyan('\nGoodbye!\n'));
      process.exit(0);
    }

    lastChoiceValue = choice;

    await handleMainAction(choice);
    printStageHeader('Main Menu');
  }
}

// ─── Action Router ─────────────────────────────────────────────────────────────

async function handleMainAction(action: string): Promise<void> {
  switch (action) {
    case 'projects':
      await projectsMenu();
      break;

    case 'select-project':
      await selectProjectMenu();
      break;

    case 'backup':
      await runBackupMenu();
      break;

    case 'status':
      if (session.activeProjectSlug) {
        viewProjectStatus(session.activeProjectSlug);
      }
      break;

    case 'stage1': {
      if (!session.activeProjectSlug) break;
      const config = getProjectConfig(session.activeProjectSlug);
      await stage1Menu(session.activeProjectSlug, config);
      break;
    }

    case 'stage2': {
      if (!session.activeProjectSlug) break;
      const config = getProjectConfig(session.activeProjectSlug);
      await stage2Menu(session.activeProjectSlug, config);
      break;
    }

    case 'stage3': {
      if (!session.activeProjectSlug) break;
      const config = getProjectConfig(session.activeProjectSlug);
      await stage3Menu(session.activeProjectSlug, config);
      break;
    }

    case 'stage4': {
      if (!session.activeProjectSlug) break;
      const config = getProjectConfig(session.activeProjectSlug);
      await stage4Menu(session.activeProjectSlug, config);
      break;
    }

    case 'test': {
      if (!session.activeProjectSlug) break;
      const config = getProjectConfig(session.activeProjectSlug);
      await testMenu(session.activeProjectSlug, config);
      break;
    }
  }
}

// ─── Project Selection ─────────────────────────────────────────────────────────

async function selectProjectMenu(): Promise<void> {
  const projects = dbListProjects();

  if (projects.length === 0) {
    logger.info('No projects found. Create one first using "Manage projects".');
    return;
  }

  const slug = await promptSelect(
    'Select active project',
    [
      ...projects.map((p) => ({
        name: `${p.slug} — ${p.name}`,
        value: p.slug,
      })),
      { name: '← Back', value: 'back' },
    ]
  );

  if (slug === 'clear' || slug === 'back') {
    return;
  }

  session.activeProjectSlug = slug;
  logger.success(`Active project set to: ${slug}`);
}

// ─── Project Status ────────────────────────────────────────────────────────────

function viewProjectStatus(projectSlug: string): void {
  const project = dbGetProjectBySlug(projectSlug);
  if (!project) return;

  const config = readConfig(project.config_path);
  const pages = dbGetPagesByProject(project.id);

  // Count pages by status
  const pagesByStatus: Record<string, number> = {};
  for (const page of pages) {
    pagesByStatus[page.status] = (pagesByStatus[page.status] ?? 0) + 1;
  }

  console.log(chalk.bold(`\nProject: ${project.name} (${project.slug})`));
  console.log(chalk.gray(`URL: ${config.url}`));
  console.log(chalk.gray(`Site type: ${config.siteType}`));
  console.log();

  console.log(chalk.bold('Page Status:'));
  for (const [status, count] of Object.entries(pagesByStatus)) {
    const color =
      status === 'captured' || status === 'personalized'
        ? chalk.green
        : status === 'error'
          ? chalk.red
          : chalk.yellow;
    console.log(`  ${color(status.padEnd(15))} ${count}`);
  }
  console.log(`  ${'Total'.padEnd(15)} ${pages.length}`);

  if (config.translation.targetLanguages.length > 0) {
    console.log();
    console.log(chalk.bold('Translation Status:'));

    for (const lang of config.translation.targetLanguages) {
      const translations = pages.flatMap((p) =>
        dbGetTranslationsByPage(p.id).filter((t) => t.language === lang),
      );
      const translated = translations.filter((t) => t.status === 'translated').length;
      const failed = translations.filter((t) => t.status === 'failed').length;
      console.log(
        `  ${chalk.cyan(lang.padEnd(8))}  ${chalk.green(`✓ ${translated}`)}  ${chalk.red(`✗ ${failed}`)}  pending: ${pages.length - translated - failed}`,
      );
    }
  }

  console.log();
}

// ─── Database Backup Menu ──────────────────────────────────────────────────────

async function runBackupMenu(): Promise<void> {
  clearScreen();
  printStageHeader('Backup Database');

  const backupDir = process.env.DB_BACKUP_DIR;
  if (!backupDir) {
    logger.warn('Warning: DB_BACKUP_DIR environment variable is not defined in your .env file.');
    logger.info('Please define DB_BACKUP_DIR (e.g. DB_BACKUP_DIR=data/backups) in your .env file to enable backups.');
    console.log();
    await inquirer.prompt([
      {
        type: 'input',
        name: 'continue',
        message: 'Press Enter to return to Main Menu...',
      },
    ]);
    return;
  }

  logger.info(`Starting database backup to: ${backupDir}...`);
  try {
    const res = await dbBackup(backupDir);
    logger.success(`Backup process completed!`);

    const logTier = (tierName: string, item: { path: string; created: boolean } | null) => {
      if (item) {
        const action = item.created ? chalk.green('Created') : chalk.gray('Up-to-date');
        const fileBasename = path.basename(item.path);
        logger.info(`  ${tierName.padEnd(8)}: [${action}] ${fileBasename}`);
      }
    };
    logTier('Hourly', res.hourly);
    logTier('Daily', res.daily);
    logTier('Weekly', res.weekly);
    logTier('Monthly', res.monthly);
  } catch (error) {
    logger.error((error as Error).message);
  }

  console.log();
  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: 'Press Enter to return to Main Menu...',
    },
  ]);
}

async function runAutoBackup(): Promise<void> {
  const backupDir = process.env.DB_BACKUP_DIR;
  if (!backupDir) return;

  process.stdout.write(chalk.cyan('[Backup] Running automated database backup... '));
  try {
    const res = await dbBackup(backupDir);
    const createdTiers: string[] = [];
    if (res.hourly?.created) createdTiers.push('Hourly');
    if (res.daily?.created) createdTiers.push('Daily');
    if (res.weekly?.created) createdTiers.push('Weekly');
    if (res.monthly?.created) createdTiers.push('Monthly');

    if (createdTiers.length > 0) {
      console.log(chalk.green(`✓ Tiered backup complete (${createdTiers.join(', ')}).`));
    } else {
      console.log(chalk.gray('Up-to-date.'));
    }
  } catch (error) {
    console.log(chalk.red(`✗ Failed: ${(error as Error).message}`));
  }
}


