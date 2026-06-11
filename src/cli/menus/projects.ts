import { execSync } from 'child_process';
import chalk from 'chalk';
import inquirer from 'inquirer';
import type { SiteType } from '../../core/config.js';
import { dbGetProjectBySlug, dbListProjects } from '../../core/db.js';
import { createProject, deleteProject, slugify } from '../../core/project.js';
import { logger } from '../../utils/logger.js';
import { clearScreen, printStageHeader } from '../ui.js';

// ─── Project Management Menu ──────────────────────────────────────────────────

/** Displays and handles the project management submenu. */
export async function projectsMenu(): Promise<void> {
  clearScreen();
  while (true) {
    printStageHeader('Project Management');
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Project Management',
        choices: [
          { name: 'List projects', value: 'list' },
          { name: 'Create new project', value: 'create' },
          { name: 'Edit project config', value: 'edit' },
          { name: 'Delete project', value: 'delete' },
          { name: chalk.gray('← Back'), value: 'back' },
        ],
      },
    ]);

    switch (action) {
      case 'list':
        await listProjectsMenu();
        break;
      case 'create':
        await createProjectMenu();
        break;
      case 'edit':
        await editProjectMenu();
        break;
      case 'delete':
        await deleteProjectMenu();
        break;
      case 'back':
        return;
    }
  }
}

// ─── List ──────────────────────────────────────────────────────────────────────

async function listProjectsMenu(): Promise<void> {
  const projects = dbListProjects();
  if (projects.length === 0) {
    logger.info('No projects found. Create one first.');
    return;
  }
  console.log(chalk.bold('\nRegistered projects:\n'));
  for (const p of projects) {
    console.log(`  ${chalk.cyan(p.slug.padEnd(20))} ${chalk.white(p.name)}`);
    console.log(`  ${chalk.gray('Config:')} ${p.config_path}`);
    console.log();
  }
}

// ─── Create ────────────────────────────────────────────────────────────────────

async function createProjectMenu(): Promise<void> {
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Project name:',
      validate: (v: string) => (v.trim().length > 0 ? true : 'Name is required'),
    },
    {
      type: 'input',
      name: 'url',
      message: 'Source site URL (e.g. https://example.com):',
      validate: (v: string) => {
        try {
          new URL(v);
          return true;
        } catch {
          return 'Enter a valid URL';
        }
      },
    },
    {
      type: 'input',
      name: 'targetLanguages',
      message: 'Target languages (comma-separated, e.g. es,fr,de):',
      validate: (v: string) => (v.trim().length > 0 ? true : 'Enter at least one language'),
    },
    {
      type: 'input',
      name: 'targetUrlsRaw',
      message:
        'Target URLs per language (format lang:url comma-separated, e.g. es:https://es.example.com,fr:https://fr.example.com):',
      validate: (v: string) => (v.trim().length > 0 ? true : 'Enter target URLs'),
    },
    {
      type: 'list',
      name: 'siteType',
      message: 'Site type:',
      choices: [
        { name: 'Generic (Hugo, Astro, VitePress, Jekyll...)', value: 'generic' },
        { name: 'Next.js', value: 'nextjs' },
      ],
    },
    {
      type: 'input',
      name: 'outputBaseDir',
      message: 'Output base directory (absolute path, e.g. /data/my-project):',
      validate: (v: string) => (v.startsWith('/') ? true : 'Enter an absolute path'),
    },
  ]);

  const slug = slugify(answers.name);
  const targetUrls: Record<string, string> = {};
  for (const pair of (answers.targetUrlsRaw as string).split(',')) {
    const [lang, url] = pair.trim().split(':');
    if (lang && url) targetUrls[lang.trim()] = url.trim();
  }

  try {
    const project = createProject({
      name: answers.name as string,
      slug,
      url: answers.url as string,
      targetUrls,
      siteType: answers.siteType as SiteType,
      outputBaseDir: answers.outputBaseDir as string,
    });
    logger.success(`Project "${project.name}" (${project.slug}) created successfully.`);
    logger.info(`Config saved at: ${project.config_path}`);
  } catch (err) {
    logger.error(`Failed to create project: ${(err as Error).message}`);
  }
}

// ─── Edit ──────────────────────────────────────────────────────────────────────

async function editProjectMenu(): Promise<void> {
  const projects = dbListProjects();
  if (projects.length === 0) {
    logger.info('No projects found.');
    return;
  }

  const { slug } = await inquirer.prompt([
    {
      type: 'list',
      name: 'slug',
      message: 'Select project to edit:',
      choices: projects.map((p) => ({ name: `${p.slug} — ${p.name}`, value: p.slug })),
    },
  ]);

  const project = dbGetProjectBySlug(slug);
  if (!project) return;

  const editor = process.env.EDITOR ?? 'vi';
  logger.info(`Opening ${project.config_path} with ${editor}...`);
  try {
    execSync(`${editor} "${project.config_path}"`, { stdio: 'inherit' });
    logger.success('Config file saved.');
  } catch {
    logger.warn('Editor exited with non-zero status.');
  }
}

// ─── Delete ────────────────────────────────────────────────────────────────────

async function deleteProjectMenu(): Promise<void> {
  const projects = dbListProjects();
  if (projects.length === 0) {
    logger.info('No projects found.');
    return;
  }

  const { slug } = await inquirer.prompt([
    {
      type: 'list',
      name: 'slug',
      message: 'Select project to delete:',
      choices: projects.map((p) => ({ name: `${p.slug} — ${p.name}`, value: p.slug })),
    },
  ]);

  const { confirmed } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmed',
      message: `Are you sure you want to delete project "${slug}" and all its data?`,
      default: false,
    },
  ]);

  if (!confirmed) {
    logger.info('Delete cancelled.');
    return;
  }

  try {
    deleteProject(slug);
    logger.success(`Project "${slug}" deleted successfully.`);
  } catch (err) {
    logger.error(`Failed to delete project: ${(err as Error).message}`);
  }
}
