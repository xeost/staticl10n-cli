import {
  dbDeleteProject,
  dbGetProjectBySlug,
  dbInsertProject,
  dbListProjects,
  type ProjectRow,
} from './db.js';
import {
  buildDefaultConfig,
  getConfigPath,
  readConfig,
  writeConfig,
  type ProjectConfig,
  type SiteType,
} from './config.js';
import fs from 'fs-extra';

// ─── Project Business Logic ───────────────────────────────────────────────────

export interface CreateProjectOptions {
  name: string;
  slug: string;
  url: string;
  targetUrls: Record<string, string>;
  siteType: SiteType;
  outputBaseDir: string;
}

/** Creates a new project: writes the config JSON and inserts a DB record. */
export function createProject(opts: CreateProjectOptions): ProjectRow {
  const configPath = getConfigPath(opts.slug);

  if (fs.existsSync(configPath)) {
    throw new Error(`Project "${opts.slug}" already exists at ${configPath}`);
  }

  const config = buildDefaultConfig(opts);
  writeConfig(configPath, config);

  const id = dbInsertProject(opts.slug, opts.name, configPath);

  const project = dbGetProjectBySlug(opts.slug);
  if (!project) throw new Error('Failed to retrieve newly created project');

  // Mark the ID returned by insert (it may differ if there were previously deleted rows)
  void id;

  return project;
}

/** Returns the config for a project slug, reading from JSON. */
export function getProjectConfig(slug: string): ProjectConfig {
  const project = dbGetProjectBySlug(slug);
  if (!project) throw new Error(`Project "${slug}" not found`);
  return readConfig(project.config_path);
}

/** Lists all registered projects from the database. */
export function listProjects(): ProjectRow[] {
  return dbListProjects();
}

/** Deletes a project and all its data from the database. Does NOT remove output directories. */
export function deleteProject(slug: string): void {
  const project = dbGetProjectBySlug(slug);
  if (!project) throw new Error(`Project "${slug}" not found`);
  dbDeleteProject(slug);
}

/** Generates a URL-safe slug from a name. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
