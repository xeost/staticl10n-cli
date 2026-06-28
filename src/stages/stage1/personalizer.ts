import * as cheerio from 'cheerio';
import type { PersonalizationRule, ProjectConfig } from '../../core/config.js';
import { logger } from '../../utils/logger.js';

// ─── Pre-Personalizer ─────────────────────────────────────────────────────────

/**
 * Applies pre-translation personalization rules in-memory.
 * The original/ directory is NOT modified — it stays immutable.
 * Call this before extracting translation fragments in Stage 2.
 */
export function applyPreTranslationInMemory(
  html: string,
  config: Pick<ProjectConfig, 'personalization'>,
): string {
  const rules = config.personalization.preTranslation;
  if (rules.length === 0) return html;
  const $ = cheerio.load(html);
  for (const rule of rules) {
    applyRule($, rule);
  }
  return $.html();
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
      if (rule.selector) {
        $(rule.selector).each((_i, el) => {
          const current = $(el).html() ?? '';
          const updated = current.split(rule.search!).join(rule.replace!);
          if (updated !== current) {
            $(el).html(updated);
            count++;
          }
        });
      } else {
        const body = $.html('body') ?? '';
        const newBody = body.split(rule.search).join(rule.replace);
        if (newBody !== body) {
          $('body').html(newBody);
          count = 1;
        }
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
