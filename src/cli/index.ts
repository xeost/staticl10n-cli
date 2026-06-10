#!/usr/bin/env node
import chalk from 'chalk';
import { Command } from 'commander';
import inquirer from 'inquirer';
import { readConfig } from '../core/config.js';
import {
  dbGetPagesByProject,
  dbGetProjectBySlug,
  dbGetTranslationsByPage,
  dbListProjects,
} from '../core/db.js';
import { getProjectConfig } from '../core/project.js';
import { printChangeReport } from '../stages/stage4/reporter.js';
import { diffSite } from '../stages/stage4/differ.js';
import { logger } from '../utils/logger.js';
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
  // No args → interactive mode
  runInteractive().catch((err: Error) => {
    logger.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}

// ─── Main Interactive Loop ─────────────────────────────────────────────────────

async function runInteractive(): Promise<void> {
  printBanner();

  while (true) {
    const activeProject = session.activeProjectSlug
      ? dbGetProjectBySlug(session.activeProjectSlug)
      : null;

    const projectLabel = activeProject
      ? chalk.green(`[${activeProject.name}]`)
      : chalk.gray('[no project selected]');

    const baseChoices = [
      { name: 'Manage projects', value: 'projects' },
      { name: `Select active project  ${projectLabel}`, value: 'select-project' },
    ];

    const projectChoices = activeProject
      ? [
          new inquirer.Separator(chalk.dim('─────── Active project ───────')),
          { name: 'View project status', value: 'status' },
          { name: 'Stage 1: Capture', value: 'stage1' },
          { name: 'Stage 2: Translation', value: 'stage2' },
          { name: 'Stage 3: Post-Personalization', value: 'stage3' },
          { name: 'Stage 4: Monitoring', value: 'stage4' },
          new inquirer.Separator(),
          { name: chalk.yellow('⚡ Test: process single page'), value: 'test' },
        ]
      : [];

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Main Menu',
        choices: [
          ...baseChoices,
          ...projectChoices,
          new inquirer.Separator(),
          { name: chalk.red('Exit'), value: 'exit' },
        ],
      },
    ]);

    if (action === 'exit') {
      console.log(chalk.cyan('\nGoodbye!\n'));
      process.exit(0);
    }

    await handleMainAction(action);
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

  const { slug } = await inquirer.prompt([
    {
      type: 'list',
      name: 'slug',
      message: 'Select active project:',
      choices: projects.map((p) => ({
        name: `${chalk.cyan(p.slug)} — ${p.name}`,
        value: p.slug,
      })),
    },
  ]);

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

// ─── Banner ────────────────────────────────────────────────────────────────────

function printBanner(): void {
  console.log(
    chalk.cyan.bold(`
  ╔═══════════════════════════════════════╗
  ║         staticl10n  v0.1.0           ║
  ║   Static Localization CLI Tool       ║
  ╚═══════════════════════════════════════╝
`),
  );
}
