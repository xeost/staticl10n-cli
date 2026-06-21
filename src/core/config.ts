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
}

export interface ProjectConfig {
  name: string;
  slug: string;
  url: string;
  targetUrls: Record<string, string>;
  siteType: SiteType;
  crawl: {
    delayMs: number;
    delayJitterMs: number;
    maxPages: number;
    ignorePatterns: string[];
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
    model: string;
    sourceLanguage: string;
    targetLanguages: string[];
    batchSize: number;
    maxFragmentTokens: number;
    maxRetries?: number;
    cacheExpiry?: number;
    context?: string;
    preserveTerms?: string[];
    translateCodeBlocks?: boolean;
  };
  personalization: {
    preTranslation: PersonalizationRule[];
    postTranslation: PersonalizationRule[];
  };
  copyAssetsMode: CopyAssetsMode;
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
    },
    paths: {
      original: path.join(opts.outputBaseDir, 'original'),
      raw: path.join(opts.outputBaseDir, 'raw'),
      translations: translationPaths,
    },
    translation: {
      provider: 'ollama',
      ollamaUrl: 'http://localhost:11434',
      model: 'gemma4',
      sourceLanguage: 'en',
      targetLanguages,
      batchSize: 20,
      maxFragmentTokens: 2000,
      maxRetries: 5,
      cacheExpiry: -1,
      context: '',
      preserveTerms: [],
      translateCodeBlocks: true,
    },
    personalization: {
      preTranslation: [],
      postTranslation: [],
    },
    copyAssetsMode: 'copy',
  };
}
