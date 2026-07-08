import fs from 'fs-extra';
import path from 'path';
import { load as yamlLoad } from 'js-yaml';

// ─── Centralized Conversion Article Registry ─────────────────────────────────
//
// Loads data/conversion-articles.yaml — the single source of truth for
// affiliate/monetization article URLs referenced by projects' `internalLinking`
// config. See design/estrategia-de-enlazado-interno.md for the strategy.

export interface ConversionArticle {
  id: string;
  url: string;
  title: string;
  topics?: string[];
}

const REGISTRY_PATH = path.join(process.cwd(), 'data', 'conversion-articles.yaml');

let cache: ConversionArticle[] | null = null;

/** Returns the path to the centralized conversion-articles registry file. */
export function getConversionArticlesPath(): string {
  return REGISTRY_PATH;
}

/** Loads and parses data/conversion-articles.yaml (cached after first call). */
export function loadConversionArticles(forceReload = false): ConversionArticle[] {
  if (cache && !forceReload) return cache;
  if (!fs.existsSync(REGISTRY_PATH)) {
    throw new Error(`Conversion articles registry not found at: ${REGISTRY_PATH}`);
  }
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  const parsed = yamlLoad(raw) as { articles?: ConversionArticle[] } | undefined;
  cache = parsed?.articles ?? [];
  return cache;
}

/** Returns a Map keyed by article id for O(1) lookups. */
export function getConversionArticlesById(): Map<string, ConversionArticle> {
  const articles = loadConversionArticles();
  return new Map(articles.map((a) => [a.id, a]));
}

/** Resolves a single article by id, or undefined if not found in the registry. */
export function resolveConversionArticle(articleId: string): ConversionArticle | undefined {
  return getConversionArticlesById().get(articleId);
}
