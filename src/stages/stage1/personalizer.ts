import * as cheerio from 'cheerio';
import fs from 'fs-extra';
import path from 'path';
import type { PersonalizationRule, ProjectConfig } from '../../core/config.js';
import {
  dbGetPagesByProject,
  dbGetProjectBySlug,
  dbUpdatePageStatus,
} from '../../core/db.js';
import { logger } from '../../utils/logger.js';

// ─── Pre-Personalizer ─────────────────────────────────────────────────────────

export interface PersonalizationResult {
  pagesProcessed: number;
  affectedByRule: Record<string, number>;
}

/**
 * Applies pre-translation personalization rules from config.personalization.preTranslation
 * to all captured HTML files in the original/ directory.
 * These rules run AFTER capture but BEFORE translation.
 */
export async function applyPrePersonalization(
  projectSlug: string,
  config: ProjectConfig,
  dryRun = false,
  targetUrl?: string,
): Promise<PersonalizationResult> {
  const project = dbGetProjectBySlug(projectSlug);
  if (!project) throw new Error(`Project "${projectSlug}" not found`);

  const rules = config.personalization.preTranslation;
  if (rules.length === 0) {
    logger.info('No pre-translation personalization rules configured.');
    return { pagesProcessed: 0, affectedByRule: {} };
  }

  let pages = dbGetPagesByProject(project.id, 'captured');
  if (targetUrl) pages = pages.filter((p) => p.url === targetUrl);
  const affectedByRule: Record<string, number> = {};

  for (const rule of rules) {
    affectedByRule[rule.description ?? rule.type] = 0;
  }

  let pagesProcessed = 0;

  for (const pageRow of pages) {
    const htmlPath = path.join(config.paths.original, pageRow.path);
    if (!fs.existsSync(htmlPath)) {
      logger.warn(`HTML file not found, skipping: ${htmlPath}`);
      continue;
    }

    const originalHtml = fs.readFileSync(htmlPath, 'utf-8');
    let $ = cheerio.load(originalHtml);
    let modified = false;

    for (const rule of rules) {
      const key = rule.description ?? rule.type;
      const count = applyRule($, rule);
      if (count > 0) {
        affectedByRule[key] = (affectedByRule[key] ?? 0) + count;
        modified = true;
      }
    }

    if (modified && !dryRun) {
      fs.writeFileSync(htmlPath, $.html(), 'utf-8');
      dbUpdatePageStatus(pageRow.id, 'personalized');
    }

    pagesProcessed++;
  }

  if (dryRun) {
    logger.info('[DRY RUN] No files were modified.');
  }

  return { pagesProcessed, affectedByRule };
}

// ─── Rule Engine ──────────────────────────────────────────────────────────────

/**
 * Applies a single personalization rule to the given cheerio document.
 * Returns the number of elements/occurrences affected.
 */
export function applyRule($: cheerio.CheerioAPI, rule: PersonalizationRule): number {
  switch (rule.type) {
    case 'remove_element': {
      if (!rule.selector) return 0;
      const els = $(rule.selector);
      const count = els.length;
      els.remove();
      return count;
    }

    case 'remove_attribute': {
      if (!rule.selector || !rule.attribute) return 0;
      let count = 0;
      $(rule.selector).each((_i, el) => {
        if ($(el).attr(rule.attribute!)) {
          $(el).removeAttr(rule.attribute!);
          count++;
        }
      });
      return count;
    }

    case 'replace_text': {
      if (!rule.search || rule.replace === undefined) return 0;
      let count = 0;
      const body = $.html('body') ?? '';
      const newBody = body.split(rule.search).join(rule.replace);
      if (newBody !== body) {
        $('body').html(newBody);
        count = 1;
      }
      return count;
    }

    case 'inject_html': {
      if (!rule.html) return 0;
      const pos = rule.position ?? 'body_end';
      if (pos === 'head_end') {
        $('head').append(rule.html);
      } else if (pos === 'body_start') {
        $('body').prepend(rule.html);
      } else if (pos === 'body_end') {
        $('body').append(rule.html);
      } else if (pos.startsWith('after_selector:')) {
        const sel = pos.replace('after_selector:', '');
        $(sel).after(rule.html);
      }
      return 1;
    }

    case 'add_attribute': {
      if (!rule.selector || !rule.attribute || rule.replace === undefined) return 0;
      let count = 0;
      $(rule.selector).each((_i, el) => {
        $(el).attr(rule.attribute!, rule.replace!);
        count++;
      });
      return count;
    }

    default:
      logger.warn(`Unknown personalization rule type: ${(rule as PersonalizationRule).type}`);
      return 0;
  }
}
