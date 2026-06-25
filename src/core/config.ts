import fs from 'fs-extra';
import path from 'path';
import { load as yamlLoad } from 'js-yaml';

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
  /** For post-translation rules: limit to specific language directories (e.g. [\"es\", \"fr\"]). Omit to apply to all directories including original. */
  languages?: string[];
}

export interface PathRewriteRule {
  /** A regular-expression pattern matched against the URL pathname (e.g. \"^/en/\"). */
  pattern: string;
  /** Replacement string (supports regex capture groups, e.g. \"$1\"). */
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
   *   { \"pattern\": \"^/en/\", \"replacement\": \"/\" }
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
    tmp: string;
    translations: Record<string, string>;
  };
  translation: {
    /**
     * Translation provider.
     * - \"ollama\": local Ollama instance (requires `ollamaUrl`).
     * - \"gemini\": Google Gemini API (requires GOOGLE_GEMINI_API_KEY env var).
     */
    provider: 'ollama' | 'gemini';
    /** Ollama base URL — only used when provider is \"ollama\". */
    ollamaUrl?: string;
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
   *   \"domainMap\": {
   *     \"https://docs.astro.build\": {
   *       \"es\": \"https://astro-docs.esdocu.com\",
   *       \"fr\": \"https://astro-docs.frdocu.com\"
   *     }
   *   }
   */
  domainMap?: Record<string, Record<string, string>>;
}

const PROJECTS_DIR = path.join(process.cwd(), 'projects');

/** Returns the path to the YAML config file for a given slug. */
export function getConfigPath(slug: string): string {
  return path.join(PROJECTS_DIR, slug, 'config.yaml');
}

/**
 * Reads and parses the project config file.
 * Tries config.yaml first; falls back to config.json for backward compatibility.
 */
export function readConfig(configPath: string): ProjectConfig {
  // If a specific path was given, use it directly (may be .yaml or .json).
  // If not found, try the sibling extension as a fallback.
  let resolvedPath = configPath;

  if (!fs.existsSync(resolvedPath)) {
    // Try the alternate extension
    if (resolvedPath.endsWith('.yaml')) {
      const jsonFallback = resolvedPath.replace(/\.yaml$/, '.json');
      if (fs.existsSync(jsonFallback)) {
        resolvedPath = jsonFallback;
      }
    } else if (resolvedPath.endsWith('.json')) {
      const yamlFallback = resolvedPath.replace(/\.json$/, '.yaml');
      if (fs.existsSync(yamlFallback)) {
        resolvedPath = yamlFallback;
      }
    }
  }

  const raw = fs.readFileSync(resolvedPath, 'utf-8');

  if (resolvedPath.endsWith('.json')) {
    return JSON.parse(raw) as ProjectConfig;
  }

  // YAML (default)
  return yamlLoad(raw) as ProjectConfig;
}

// ─── YAML serialization with inline comments ──────────────────────────────────

/** Serializes a value as an inline YAML flow sequence (e.g. [a, b, c]). */
function yamlInlineList(arr: unknown[]): string {
  if (arr.length === 0) return '[]';
  return `[${arr.map((v) => (typeof v === 'string' ? `"${v}"` : String(v))).join(', ')}]`;
}

/** Serializes a string value, quoting it if necessary. */
function yamlStr(v: string): string {
  // Quote if empty, contains special chars, or could be misinterpreted
  if (v === '' || /[:#\[\]{}&*!,|>'"@`]/.test(v) || /^\s|\s$/.test(v)) {
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return v;
}

/** Serializes a PersonalizationRule[] as indented YAML block items. */
function yamlPersonalizationRules(rules: PersonalizationRule[], indent: string): string {
  if (rules.length === 0) return '[]';
  const lines: string[] = [''];
  for (const rule of rules) {
    lines.push(`${indent}- type: ${rule.type}`);
    if (rule.selector !== undefined) lines.push(`${indent}  selector: ${yamlStr(rule.selector)}`);
    if (rule.attribute !== undefined) lines.push(`${indent}  attribute: ${yamlStr(rule.attribute)}`);
    if (rule.search !== undefined) lines.push(`${indent}  search: ${yamlStr(rule.search)}`);
    if (rule.replace !== undefined) lines.push(`${indent}  replace: ${yamlStr(rule.replace)}`);
    if (rule.html !== undefined) lines.push(`${indent}  html: ${yamlStr(rule.html)}`);
    if (rule.position !== undefined) lines.push(`${indent}  position: ${yamlStr(rule.position)}`);
    if (rule.languages !== undefined) lines.push(`${indent}  languages: ${yamlInlineList(rule.languages)}`);
    if (rule.description !== undefined) lines.push(`${indent}  description: ${yamlStr(rule.description)}`);
  }
  return lines.join('\n');
}

/** Serializes domainMap as an indented YAML block. */
function yamlDomainMap(domainMap: Record<string, Record<string, string>>, indent: string): string {
  const entries = Object.entries(domainMap);
  if (entries.length === 0) return '{}';
  const lines: string[] = [''];
  for (const [domain, langs] of entries) {
    lines.push(`${indent}${yamlStr(domain)}:`);
    for (const [lang, url] of Object.entries(langs)) {
      lines.push(`${indent}  ${lang}: ${yamlStr(url)}`);
    }
  }
  return lines.join('\n');
}

/** Serializes pathRewrite rules as an indented YAML block. */
function yamlPathRewrite(rules: PathRewriteRule[], indent: string): string {
  if (!rules || rules.length === 0) return '[]';
  const lines: string[] = [''];
  for (const rule of rules) {
    lines.push(`${indent}- pattern: ${yamlStr(rule.pattern)}`);
    lines.push(`${indent}  replacement: ${yamlStr(rule.replacement)}`);
  }
  return lines.join('\n');
}

/** Builds the annotated YAML string for a ProjectConfig. */
function buildAnnotatedYaml(config: ProjectConfig): string {
  const t = config.translation;
  const modelVal = Array.isArray(t.model)
    ? '\n' + t.model.map((m) => `    - ${yamlStr(m)}`).join('\n')
    : yamlStr(t.model);

  const translationPaths = Object.entries(config.paths.translations)
    .map(([lang, p]) => `      ${lang}: ${yamlStr(p)}`)
    .join('\n');

  const targetUrls = Object.entries(config.targetUrls)
    .map(([lang, url]) => `  ${lang}: ${yamlStr(url)}`)
    .join('\n');

  const preserveTerms = t.preserveTerms && t.preserveTerms.length > 0
    ? yamlInlineList(t.preserveTerms)
    : '[]';

  const ignorePatterns = config.crawl.ignorePatterns.length > 0
    ? yamlInlineList(config.crawl.ignorePatterns)
    : '[]';

  const allowPatternsLine = config.crawl.allowPatterns !== undefined
    ? `  # Allowlist mode: crawl ONLY paths whose pathname contains at least one of these strings.
  # Mutually exclusive with ignorePatterns — use one or the other, not both.
  allowPatterns: ${yamlInlineList(config.crawl.allowPatterns)}
`
    : '';

  const domainMap = config.domainMap ?? {};
  const pathRewrite = config.pathRewrite ?? [];

  const ollamaUrlLine = t.provider === 'ollama'
    ? `  # Base URL of the local Ollama server (only used when provider is "ollama")
  ollamaUrl: ${yamlStr(t.ollamaUrl ?? 'http://localhost:11434')}
`
    : '';

  return `# Display name of the project (shown in the interactive UI)
name: ${yamlStr(config.name)}

# Unique identifier — also used as the folder name under projects/
slug: ${yamlStr(config.slug)}

# URL of the source site to crawl and translate
url: ${yamlStr(config.url)}

# Deployed URLs for each translated language (used to generate hreflang tags and rewrite links)
targetUrls:
${targetUrls}

# Site type: "generic" (Hugo, Astro, VitePress, Jekyll…) or "nextjs" (Next.js app with React hydration)
siteType: ${config.siteType}

crawl:
  # Milliseconds to wait between page requests (reduces server load)
  delayMs: ${config.crawl.delayMs}
  # Additional random delay per request (helps avoid bot detection)
  delayJitterMs: ${config.crawl.delayJitterMs}
  # Maximum number of pages to crawl (set to a high value to crawl everything)
  maxPages: ${config.crawl.maxPages}
  # Blocklist mode: skip URLs whose pathname contains any of these strings
  # Use this to exclude sections like /blog/, /api/, /admin/, other language prefixes, etc.
  ignorePatterns: ${ignorePatterns}
${allowPatternsLine}  # Strip trailing slashes from crawled URLs for consistent deduplication
  normalizeTrailingSlash: ${config.crawl.normalizeTrailingSlash}
  # Remove query parameters from crawled URLs (keeps ?lang=, ?v=... out of the page list)
  stripQueryParams: ${config.crawl.stripQueryParams}
  # Extra delay (ms) after page hydration — increase for JS-heavy sites like Next.js
  postHydrationDelayMs: ${config.crawl.postHydrationDelayMs ?? 800}

paths:
  # Where processed + pre-personalized HTML files are saved (Stage 1 output)
  original: ${yamlStr(config.paths.original)}
  # Where raw Playwright HTML is saved (used for reprocessing without re-crawling)
  raw: ${yamlStr(config.paths.raw)}
  # Where temporary metadata and cache files are saved
  tmp: ${yamlStr(config.paths.tmp)}
  # Output directories per target language
  translations:
${translationPaths}

translation:
  # Translation provider: "ollama" (local, no API key) or "gemini" (Google Gemini API)
  provider: ${t.provider}
${ollamaUrlLine}  # Model name or list of models for multi-model fallback (tried in order on failure)
  # Comment out any model to temporarily disable it
  model: ${modelVal}
  # Language code of the source content (ISO 639-1, e.g. "en", "es", "fr")
  sourceLanguage: ${yamlStr(t.sourceLanguage)}
  # Target languages to translate into (must match keys in targetUrls and paths.translations)
  targetLanguages: ${yamlInlineList(t.targetLanguages)}
  # Number of HTML fragments sent to the model in a single API call
  batchSize: ${t.batchSize}
  # Maximum token count per HTML fragment before it is split into smaller pieces
  maxFragmentTokens: ${t.maxFragmentTokens}
  # Retries per model before moving to the next one in the list (default: 3)
  maxRetries: ${t.maxRetries ?? 3}
  # Cache entry lifetime in seconds. -1 = no expiry | 0 = cache disabled | N = TTL in seconds
  cacheExpiry: ${t.cacheExpiry ?? -1}
  # Optional context injected into the translation prompt (describe the site for better accuracy)
  context: ${yamlStr(t.context ?? '')}
  # Terms that must never be translated (brand names, technical terms, trademarks, etc.)
  preserveTerms: ${preserveTerms}
  # Set to true to translate comment spans inside <pre><code> blocks (default: true)
  translateCodeBlockComments: ${t.translateCodeBlockComments ?? true}

personalization:
  # Rules applied at the end of Stage 1, BEFORE translation
  # Use to remove analytics, tracking scripts, cookie banners, ads, etc.
  preTranslation: ${yamlPersonalizationRules(config.personalization.preTranslation, '    ')}
  # Rules applied in Stage 3, AFTER translation
  # Use to inject banners, replace copyright text, rename page titles, etc.
  # Add "languages: [es, fr]" to a rule to restrict it to specific language outputs.
  postTranslation: ${yamlPersonalizationRules(config.personalization.postTranslation, '    ')}

# How to handle static assets (CSS, JS, images, fonts): "copy" (default) or "symlink"
copyAssetsMode: ${config.copyAssetsMode}

# Optional: regex rules to rewrite URL pathnames at output time (output files, links, sitemap, hreflang).
# Useful when crawling a language-prefixed site (e.g. /en/…) but publishing without the prefix.
# Example: { pattern: "^/en/", replacement: "/" } → /en/getting-started/ becomes /getting-started/
pathRewrite: ${yamlPathRewrite(pathRewrite, '  ')}

# Optional: map sibling-project domains to their translated equivalents (per language).
# Links in translated HTML pointing to a mapped domain are rewritten to the target language URL.
# Example: links to https://docs.astro.build become https://astro-docs.esdocu.com in Spanish output.
domainMap: ${yamlDomainMap(domainMap, '  ')}
`;
}

/** Writes the project config as an annotated YAML file. */
export function writeConfig(configPath: string, config: ProjectConfig): void {
  // Always write as .yaml — remap path if needed
  const yamlPath = configPath.endsWith('.json')
    ? configPath.replace(/\.json$/, '.yaml')
    : configPath;
  fs.ensureDirSync(path.dirname(yamlPath));
  fs.writeFileSync(yamlPath, buildAnnotatedYaml(config), 'utf-8');
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
      tmp: path.join(opts.outputBaseDir, 'tmp'),
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
