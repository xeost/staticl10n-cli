import fs from 'fs-extra';
import path from 'path';

// ─── Project Configuration Types ─────────────────────────────────────────────

export type SiteType = 'generic' | 'nextjs';
export type CopyAssetsMode = 'copy' | 'symlink';
export type PersonalizationRuleType =
  | 'remove_element'
  | 'remove_attribute'
  | 'replace_text'
  | 'inject_html'
  | 'add_attribute';

export interface PersonalizationRule {
  type: PersonalizationRuleType;
  selector?: string;
  attribute?: string;
  search?: string;
  replace?: string;
  html?: string;
  position?: 'head_end' | 'body_start' | 'body_end' | `after_selector:${string}`;
  description?: string;
  /** For post-translation rules: limit to specific language directories (e.g. ["es", "fr"]). Omit to apply to all directories including original. */
  languages?: string[];
}

export interface PathRewriteRule {
  /** A regular-expression pattern matched against the URL pathname (e.g. "^/en/"). */
  pattern: string;
  /** Replacement string (supports regex capture groups, e.g. "$1"). */
  replacement: string;
}

export interface ProjectConfig {
  name: string;
  slug: string;
  url: string;
  targetUrls: Record<string, string>;
  /**
   * Optional list of path rewrite rules applied to URL pathnames at output time.
   * Rules are applied in order. Useful when crawling a language-prefixed version of a site
   * (e.g. /en/…) but wanting the translated output to use the prefix-free path (e.g. /…).
   *
   * Example:
   *   { "pattern": "^/en/", "replacement": "/" }
   *   transforms /en/getting-started/ → /getting-started/
   */
  pathRewrite?: PathRewriteRule[];
  siteType: SiteType;
  crawl: {
    delayMs: number;
    delayJitterMs: number;
    maxPages: number;
    /**
     * Blocklist mode: crawl all paths EXCEPT those whose pathname contains one of these strings.
     * Mutually exclusive with `allowPatterns`.
     */
    ignorePatterns: string[];
    /**
     * Allowlist mode: crawl ONLY paths whose pathname contains at least one of these strings.
     * Mutually exclusive with `ignorePatterns`.
     * When set, `ignorePatterns` is ignored (a warning is logged if both are present).
     */
    allowPatterns?: string[];
    normalizeTrailingSlash: boolean;
    stripQueryParams: boolean;
    postHydrationDelayMs?: number;
  };
  paths: {
    original: string;
    raw: string;
    translations: Record<string, string>;
  };
  translation: {
    provider: 'ollama';
    ollamaUrl: string;
    model: string | string[];
    sourceLanguage: string;
    targetLanguages: string[];
    batchSize: number;
    maxFragmentTokens: number;
    maxRetries?: number;
    cacheExpiry?: number;
    context?: string;
    preserveTerms?: string[];
    translateCodeBlockComments?: boolean;
  };
  personalization: {
    preTranslation: PersonalizationRule[];
    postTranslation: PersonalizationRule[];
  };
  copyAssetsMode: CopyAssetsMode;
  /**
   * Maps external (sibling-project) domains to their translated equivalents,
   * per target language. Each key is an external origin; each value is a
   * Record mapping language codes to the translated domain for that language.
   *
   * Example — two related Astro translation projects:
   *   "domainMap": {
   *     "https://docs.astro.build": {
   *       "es": "https://astro-docs.esdocu.com",
   *       "fr": "https://astro-docs.frdocu.com"
   *     }
   *   }
   */
  domainMap?: Record<string, Record<string, string>>;
}

const PROJECTS_DIR = path.join(process.cwd(), 'projects');

/** Returns the path to the config file for a given slug. */
export function getConfigPath(slug: string): string {
  return path.join(PROJECTS_DIR, slug, 'config.json');
}

/** Reads and parses the project config JSON file. */
export function readConfig(configPath: string): ProjectConfig {
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as ProjectConfig;
}

/** Writes the project config JSON file (pretty-printed). */
export function writeConfig(configPath: string, config: ProjectConfig): void {
  fs.ensureDirSync(path.dirname(configPath));
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/** Builds a default config skeleton for a new project. */
export function buildDefaultConfig(opts: {
  name: string;
  slug: string;
  url: string;
  targetUrls: Record<string, string>;
  siteType: SiteType;
  outputBaseDir: string;
}): ProjectConfig {
  const targetLanguages = Object.keys(opts.targetUrls);
  const translationPaths: Record<string, string> = {};
  for (const lang of targetLanguages) {
    translationPaths[lang] = path.join(opts.outputBaseDir, lang);
  }

  return {
    name: opts.name,
    slug: opts.slug,
    url: opts.url,
    targetUrls: opts.targetUrls,
    siteType: opts.siteType,
    crawl: {
      delayMs: 1500,
      delayJitterMs: 500,
      maxPages: 500,
      ignorePatterns: [],
      normalizeTrailingSlash: true,
      stripQueryParams: true,
      postHydrationDelayMs: 800,
    },
    paths: {
      original: path.join(opts.outputBaseDir, 'original'),
      raw: path.join(opts.outputBaseDir, 'raw'),
      translations: translationPaths,
    },
    translation: {
      provider: 'ollama',
      ollamaUrl: 'http://localhost:11434',
      model: ['llama3.1', 'gemma4'],
      sourceLanguage: 'en',
      targetLanguages,
      batchSize: 20,
      maxFragmentTokens: 2000,
      maxRetries: 3,
      cacheExpiry: -1,
      context: '',
      preserveTerms: [],
      translateCodeBlockComments: true,
    },
    personalization: {
      preTranslation: [],
      postTranslation: [],
    },
    copyAssetsMode: 'copy',
    pathRewrite: [],
    domainMap: {},
  };
}
