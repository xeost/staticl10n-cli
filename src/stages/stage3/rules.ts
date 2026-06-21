import * as cheerio from 'cheerio';
import fs from 'fs-extra';
import path from 'path';
import type { PersonalizationRule, ProjectConfig } from '../../core/config.js';
import { dbGetPagesByProject, dbGetProjectBySlug } from '../../core/db.js';
import { logger } from '../../utils/logger.js';
import { applyRule } from '../stage1/personalizer.js';

// ─── Post-Personalization Rules ───────────────────────────────────────────────

export interface PostPersonalizationResult {
  directoriesProcessed: string[];
  pagesProcessed: number;
  affectedByRule: Record<string, number>;
}

/**
 * Applies post-translation personalization rules to the original/ directory
 * and every language directory. Runs AFTER translation.
 */
export async function applyPostPersonalization(
  projectSlug: string,
  config: ProjectConfig,
  dryRun = false,
  targetUrl?: string,
): Promise<PostPersonalizationResult> {
  const project = dbGetProjectBySlug(projectSlug);
  if (!project) throw new Error(`Project "${projectSlug}" not found`);

  const rules = config.personalization.postTranslation;
  if (rules.length === 0) {
    logger.info('No post-translation personalization rules configured.');
    return { directoriesProcessed: [], pagesProcessed: 0, affectedByRule: {} };
  }

  const affectedByRule: Record<string, number> = {};
  for (const rule of rules) {
    affectedByRule[rule.description ?? rule.type] = 0;
  }

  // Collect all directories: original + each language
  const directories = [
    { label: 'original', dir: config.paths.original },
    ...Object.entries(config.paths.translations).map(([lang, dir]) => ({ label: lang, dir })),
  ];

  const processedDirs: string[] = [];
  let pagesProcessed = 0;

  let pages = dbGetPagesByProject(project.id);
  if (targetUrl) pages = pages.filter((p) => p.url === targetUrl);

  for (const { label, dir } of directories) {
    if (!fs.existsSync(dir)) {
      logger.warn(`Directory not found, skipping: ${dir}`);
      continue;
    }

    processedDirs.push(label);

    for (const pageRow of pages) {
      const htmlPath = path.join(dir, pageRow.path);
      if (!fs.existsSync(htmlPath)) continue;

      const originalHtml = fs.readFileSync(htmlPath, 'utf-8');
      const $ = cheerio.load(originalHtml);
      let modified = false;

      for (const rule of rules) {
        if (rule.languages && !rule.languages.includes(label)) continue;
        const key = rule.description ?? rule.type;
        const count = applyRule($, rule);
        if (count > 0) {
          affectedByRule[key] = (affectedByRule[key] ?? 0) + count;
          modified = true;
        }
      }

      if (modified && !dryRun) {
        fs.writeFileSync(htmlPath, $.html(), 'utf-8');
      }

      pagesProcessed++;
    }
  }

  if (dryRun) {
    logger.info('[DRY RUN] No files were modified.');
  }

  return { directoriesProcessed: processedDirs, pagesProcessed, affectedByRule };
}

/** Returns the list of configured post-personalization rules from config. */
export function listPostRules(config: ProjectConfig): PersonalizationRule[] {
  return config.personalization.postTranslation;
}
