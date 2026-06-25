import fs from 'fs-extra';
import path from 'path';
import { rewritePath } from '../../core/pathRewrite.js';
import type { PathRewriteRule } from '../../core/config.js';


// ─── Types ────────────────────────────────────────────────────────────────────

export interface DetectedRedirect {
  from: string;
  to: string;
  statusCode: number;
  detectedDuring: 'crawl';
}

export interface ManualRedirect {
  from: string;
  to: string;
  statusCode: number;
  description?: string;
}

export interface RedirectsFile {
  detectedAt: string;
  totalRedirects: number;
  redirects: DetectedRedirect[];
  manual: ManualRedirect[];
}

// ─── File Helpers ─────────────────────────────────────────────────────────────

const PROJECTS_DIR = path.join(process.cwd(), 'projects');

/** Returns the path to the redirects.json file for a given project slug. */
export function getRedirectsFilePath(slug: string): string {
  return path.join(PROJECTS_DIR, slug, 'redirects.json');
}

/** Reads redirects.json for a project, or returns an empty structure if not found. */
export function loadRedirectsFile(slug: string): RedirectsFile {
  const filePath = getRedirectsFilePath(slug);
  if (!fs.existsSync(filePath)) {
    return {
      detectedAt: new Date().toISOString(),
      totalRedirects: 0,
      redirects: [],
      manual: [],
    };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as RedirectsFile;
  } catch {
    return {
      detectedAt: new Date().toISOString(),
      totalRedirects: 0,
      redirects: [],
      manual: [],
    };
  }
}

/** Writes redirects.json for a project (recalculates totalRedirects). */
export function saveRedirectsFile(slug: string, data: RedirectsFile): void {
  const filePath = getRedirectsFilePath(slug);
  fs.ensureDirSync(path.dirname(filePath));
  data.totalRedirects = data.redirects.length + data.manual.length;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Merges newly detected redirects into the persisted redirects.json.
 * Deduplicates by `from` path — last detection wins (handles re-crawls).
 */
export function mergeDetectedRedirects(slug: string, newRedirects: DetectedRedirect[]): void {
  if (newRedirects.length === 0) return;
  const data = loadRedirectsFile(slug);

  const existing = new Map(data.redirects.map((r) => [r.from, r]));
  for (const r of newRedirects) {
    existing.set(r.from, r);
  }

  data.redirects = Array.from(existing.values());
  data.detectedAt = new Date().toISOString();
  saveRedirectsFile(slug, data);
}

// ─── _redirects File Generation ───────────────────────────────────────────────

/**
 * Builds the plain-text content of a `_redirects` file.
 * Compatible with Cloudflare Pages and Netlify format:
 * one rule per line — "/from  /to  statusCode"
 */
export function buildRedirectsContent(data: RedirectsFile, pathRewriteRules?: PathRewriteRule[]): string {
  const allRedirects = [...data.redirects, ...data.manual];
  const rewrittenRedirects = allRedirects.map((r) => {
    const rewrittenFrom = rewritePath(r.from, pathRewriteRules);
    const rewrittenTo = rewritePath(r.to, pathRewriteRules);
    return {
      ...r,
      from: rewrittenFrom,
      to: rewrittenTo,
    };
  });
  const lines: string[] = [
    `# Generated automatically by staticl10n`,
    `# Detected redirects: ${data.redirects.length} | Manual: ${data.manual.length}`,
    '',
    ...rewrittenRedirects.map((r) => `${r.from}  ${r.to}  ${r.statusCode}`),
  ];
  return lines.join('\n') + '\n';
}

/**
 * Reads the project's redirects.json and writes a `_redirects` file
 * to the given output directory (e.g. original/, es/, fr/).
 */
export function writeRedirectsTo(outputDir: string, slug: string, pathRewriteRules?: PathRewriteRule[]): void {
  const data = loadRedirectsFile(slug);
  const content = buildRedirectsContent(data, pathRewriteRules);
  fs.ensureDirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, '_redirects'), content, 'utf-8');
}
