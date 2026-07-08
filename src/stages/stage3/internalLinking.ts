import * as cheerio from 'cheerio';
import type { ConversionLinkRule } from '../../core/config.js';
import { resolveConversionArticle } from '../../core/conversionArticles.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_LINK_TEMPLATE = '<a href="{{url}}" rel="sponsored noopener">{{anchorText}}</a>';

// ─── Internal-Linking / Affiliate-Conversion Rule Engine ──────────────────────
//
// Applies `internalLinking.links` rules (see design/estrategia-de-enlazado-interno.md)
// to a single page's HTML. Rules are page-scoped (unlike generic personalization
// rules, which apply globally across all pages of a directory).

/** Normalizes a URL pathname for comparison (strip trailing slash, except root "/"). */
function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

/** Returns true if the given rule applies to the page at `pagePathname`. */
export function ruleMatchesPage(rule: ConversionLinkRule, pagePathname: string): boolean {
  return normalizePathname(rule.page) === normalizePathname(pagePathname);
}

/** Replaces `{{url}}`, `{{anchorText}}`, and `{{title}}` placeholders in an HTML template. */
export function renderLinkTemplate(
  template: string,
  vars: { url: string; anchorText: string; title: string },
): string {
  return template.replace(/{{\s*(url|anchorText|title)\s*}}/g, (_match, key: keyof typeof vars) => vars[key]);
}

/**
 * Builds the HTML fragment for a conversion link rule, using (in priority order):
 * the rule's own `htmlTemplate`, the project's `internalLinking.defaultLinkTemplate`,
 * or a plain `<a>` tag as the final fallback.
 */
export function buildLinkHtml(
  rule: ConversionLinkRule,
  article: { url: string; title: string },
  defaultTemplate?: string,
): string {
  const template = rule.htmlTemplate ?? defaultTemplate ?? DEFAULT_LINK_TEMPLATE;
  return renderLinkTemplate(template, { url: article.url, anchorText: rule.anchorText, title: article.title });
}

/**
 * Applies all internalLinking rules that match `pagePathname` and `lang` to the
 * given cheerio document. Returns the number of links actually injected.
 */
export function applyInternalLinkingRules(
  $: cheerio.CheerioAPI,
  rules: ConversionLinkRule[],
  pagePathname: string,
  lang: string,
  defaultLinkTemplate?: string,
): number {
  let injected = 0;
  for (const rule of rules) {
    if (!ruleMatchesPage(rule, pagePathname)) continue;
    if (rule.languages && !rule.languages.includes(lang)) continue;

    const article = resolveConversionArticle(rule.articleId);
    if (!article) {
      logger.warn(
        `internalLinking: unknown articleId "${rule.articleId}" (page: ${rule.page}). Skipping — check data/conversion-articles.yaml.`,
      );
      continue;
    }

    if (!$(rule.selector).length) {
      logger.warn(
        `internalLinking: selector "${rule.selector}" not found on page "${rule.page}". Skipping rule for articleId "${rule.articleId}".`,
      );
      continue;
    }

    const html = buildLinkHtml(rule, article, defaultLinkTemplate);
    const position = rule.position ?? `after_selector:${rule.selector}`;

    if (position === 'head_end') {
      $('head').append(html);
    } else if (position === 'body_start') {
      $('body').prepend(html);
    } else if (position === 'body_end') {
      $('body').append(html);
    } else if (position.startsWith('after_selector:')) {
      const sel = position.replace('after_selector:', '');
      $(sel).after(html);
    } else {
      continue;
    }
    injected++;
  }
  return injected;
}

/**
 * Injects the project's `internalLinking.brandFooterHtml` fragment right before `</body>`.
 * Implements §1 "Arquitectura de Autoridad de Marca (Domain Authority)" — applied to EVERY
 * page of the site (all directories, all languages), independent of `links`.
 */
export function applyBrandFooter($: cheerio.CheerioAPI, brandFooterHtml: string | undefined): boolean {
  if (!brandFooterHtml) return false;
  $('body').append(brandFooterHtml);
  return true;
}
