#!/usr/bin/env tsx
import fs from 'fs-extra';
import path from 'path';
import { dump as yamlDump } from 'js-yaml';
import { readConfig, type ConversionLinkRule } from '../core/config.js';
import { loadConversionArticles } from '../core/conversionArticles.js';
import { logger } from '../utils/logger.js';

// ─── Internal-Linking Strategy Auditor ─────────────────────────────────────────
//
// Manually run this script to:
//   1. Scan every projects/<slug>/config.yaml for `internalLinking.links` rules.
//   2. Resolve each rule's `articleId` against data/conversion-articles.yaml and
//      count how many times each conversion article URL is used, project by project.
//   3. Persist the aggregated usage counts to data/internal-linking-registry.yaml.
//   4. Verify every condition from design/estrategia-de-enlazado-interno.md:
//        - Home page: at most 1 link.
//        - Internal pages: 0, or between 3 and 5 links.
//        - Total per subdomain: 0, or between 4 and 6 links.
//        - No repeated anchor text within the same project.
//        - `articleId` must resolve to a known conversion article.
//        - `page` is required for placement: "internal".
//        - Footprint warning: same articleId + anchorText combo reused across projects.
//
// Usage: pnpm audit:internal-linking

const PROJECTS_DIR = path.join(process.cwd(), 'projects');
const REGISTRY_OUTPUT_PATH = path.join(process.cwd(), 'data', 'internal-linking-registry.yaml');

interface ProjectAuditResult {
  slug: string;
  homeLinks: number;
  internalLinks: number;
  totalLinks: number;
  anchorTexts: string[];
  issues: string[];
  valid: boolean;
}

interface ArticleUsage {
  url: string;
  title: string;
  totalOccurrences: number;
  projects: Record<string, number>;
}

function findProjectConfigFiles(): { slug: string; configPath: string }[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  const results: { slug: string; configPath: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const yamlPath = path.join(PROJECTS_DIR, entry.name, 'config.yaml');
    const jsonPath = path.join(PROJECTS_DIR, entry.name, 'config.json');
    if (fs.existsSync(yamlPath)) {
      results.push({ slug: entry.name, configPath: yamlPath });
    } else if (fs.existsSync(jsonPath)) {
      results.push({ slug: entry.name, configPath: jsonPath });
    }
  }
  return results;
}

function auditProject(
  slug: string,
  links: ConversionLinkRule[],
  articlesById: Map<string, { url: string; title: string }>,
  articleUsage: Map<string, ArticleUsage>,
  footprintIndex: Map<string, string[]>,
): ProjectAuditResult {
  const issues: string[] = [];
  const anchorTexts: string[] = [];
  let homeLinks = 0;
  let internalLinks = 0;

  for (const link of links) {
    // Structural validation
    if (link.placement === 'internal' && !link.page) {
      issues.push(`Rule for articleId "${link.articleId}" has placement "internal" but no "page" specified.`);
    }

    const article = articlesById.get(link.articleId);
    if (!article) {
      issues.push(`Unknown articleId "${link.articleId}" — not found in data/conversion-articles.yaml.`);
      continue; // Can't count usage for an unresolved article
    }

    if (link.placement === 'home') homeLinks++;
    else internalLinks++;

    anchorTexts.push(link.anchorText);

    // Update centralized usage registry
    let usage = articleUsage.get(link.articleId);
    if (!usage) {
      usage = { url: article.url, title: article.title, totalOccurrences: 0, projects: {} };
      articleUsage.set(link.articleId, usage);
    }
    usage.totalOccurrences++;
    usage.projects[slug] = (usage.projects[slug] ?? 0) + 1;

    // Footprint tracking: same articleId + anchorText combo across different projects
    const footprintKey = `${link.articleId}::${link.anchorText}`;
    const seenIn = footprintIndex.get(footprintKey) ?? [];
    if (!seenIn.includes(slug)) seenIn.push(slug);
    footprintIndex.set(footprintKey, seenIn);
  }

  // Anchor text uniqueness within the same project (§3, "Variación de Textos Ancla")
  const duplicateAnchors = anchorTexts.filter((t, i) => anchorTexts.indexOf(t) !== i);
  for (const dup of new Set(duplicateAnchors)) {
    issues.push(`Anchor text repeated within the project: "${dup}".`);
  }

  const totalLinks = homeLinks + internalLinks;

  // Quota validation (§2)
  if (homeLinks > 1) {
    issues.push(`Home page has ${homeLinks} link(s); maximum allowed is 1.`);
  }
  if (internalLinks > 0 && (internalLinks < 3 || internalLinks > 5)) {
    issues.push(`Internal pages have ${internalLinks} link(s); allowed range is 3 to 5.`);
  }
  if (totalLinks > 0 && (totalLinks < 4 || totalLinks > 6)) {
    issues.push(`Total links for the subdomain is ${totalLinks}; allowed range is 4 to 6.`);
  }

  return {
    slug,
    homeLinks,
    internalLinks,
    totalLinks,
    anchorTexts,
    issues,
    valid: issues.length === 0,
  };
}

function main(): void {
  const articles = loadConversionArticles();
  const articlesById = new Map(articles.map((a) => [a.id, { url: a.url, title: a.title }]));

  const configFiles = findProjectConfigFiles();
  if (configFiles.length === 0) {
    logger.warn(`No project config files found under ${PROJECTS_DIR}`);
    return;
  }

  const articleUsage = new Map<string, ArticleUsage>();
  const footprintIndex = new Map<string, string[]>();
  const projectResults: ProjectAuditResult[] = [];
  const projectsMissingBrandFooter: string[] = [];

  for (const { slug, configPath } of configFiles) {
    let links: ConversionLinkRule[] = [];
    try {
      const config = readConfig(configPath);
      links = config.internalLinking?.links ?? [];
      if (!config.internalLinking?.brandFooterHtml) {
        projectsMissingBrandFooter.push(slug);
      }
    } catch (err) {
      projectResults.push({
        slug,
        homeLinks: 0,
        internalLinks: 0,
        totalLinks: 0,
        anchorTexts: [],
        issues: [`Failed to read/parse config: ${(err as Error).message}`],
        valid: false,
      });
      continue;
    }

    if (links.length === 0) continue; // No internal-linking configured — allowed (§4)

    projectResults.push(auditProject(slug, links, articlesById, articleUsage, footprintIndex));
  }

  // Footprint warnings: same articleId + anchorText reused across multiple projects
  const footprintWarnings: string[] = [];
  for (const [key, projectsUsingIt] of footprintIndex) {
    if (projectsUsingIt.length > 1) {
      const [articleId, anchorText] = key.split('::');
      footprintWarnings.push(
        `articleId "${articleId}" with anchor text "${anchorText}" is reused across projects: ${projectsUsingIt.join(', ')} (footprint risk, see §3.3).`,
      );
    }
  }

  // ─── Persist the centralized registry ───────────────────────────────────────
  const registry = {
    generatedAt: new Date().toISOString(),
    articles: Object.fromEntries(
      articles.map((a) => {
        const usage = articleUsage.get(a.id);
        return [
          a.id,
          {
            url: a.url,
            totalOccurrences: usage?.totalOccurrences ?? 0,
            projects: usage?.projects ?? {},
          },
        ];
      }),
    ),
    projects: Object.fromEntries(
      projectResults.map((p) => [
        p.slug,
        {
          homeLinks: p.homeLinks,
          internalLinks: p.internalLinks,
          totalLinks: p.totalLinks,
          anchorTexts: p.anchorTexts,
          valid: p.valid,
          issues: p.issues,
        },
      ]),
    ),
    footprintWarnings,
    projectsMissingBrandFooter,
  };

  fs.ensureDirSync(path.dirname(REGISTRY_OUTPUT_PATH));
  fs.writeFileSync(
    REGISTRY_OUTPUT_PATH,
    `# Auto-generated by src/scripts/audit-internal-linking.ts — do not edit manually.\n# Run "pnpm audit:internal-linking" to regenerate.\n${yamlDump(registry, { lineWidth: -1 })}`,
    'utf-8',
  );

  // ─── Console report ──────────────────────────────────────────────────────────
  logger.info(`Scanned ${configFiles.length} project config file(s); ${projectResults.length} with internalLinking rules.`);
  logger.info(`Registry written to: ${REGISTRY_OUTPUT_PATH}\n`);

  let hasViolations = false;
  for (const result of projectResults) {
    if (result.valid) {
      logger.success(
        `[${result.slug}] OK — home: ${result.homeLinks}, internal: ${result.internalLinks}, total: ${result.totalLinks}`,
      );
    } else {
      hasViolations = true;
      logger.error(`[${result.slug}] FAILED — home: ${result.homeLinks}, internal: ${result.internalLinks}, total: ${result.totalLinks}`);
      for (const issue of result.issues) {
        logger.error(`  - ${issue}`);
      }
    }
  }

  if (footprintWarnings.length > 0) {
    logger.warn('\nFootprint warnings (non-blocking):');
    for (const warning of footprintWarnings) {
      logger.warn(`  - ${warning}`);
    }
  }

  if (projectsMissingBrandFooter.length > 0) {
    logger.warn('\n§1 Domain Authority — projects without internalLinking.brandFooterHtml (non-blocking):');
    for (const slug of projectsMissingBrandFooter) {
      logger.warn(`  - ${slug}`);
    }
  }

  if (hasViolations) {
    logger.error('\nInternal-linking audit FAILED. Fix the issues above.');
    process.exit(1);
  } else {
    logger.success('\nInternal-linking audit PASSED — all configured projects comply with the strategy.');
  }
}

main();
