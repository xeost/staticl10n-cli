import * as cheerio from 'cheerio';
import type { ProjectConfig } from '../../core/config.js';
import { logger } from '../../utils/logger.js';
import type { HtmlFragment } from './extractor.js';
import { getCachedTranslation, storeCachedTranslation } from './cache.js';

// ─── Translator ───────────────────────────────────────────────────────────────

export interface TranslationBatch {
  fragments: HtmlFragment[];
  translatedTexts: Map<string, string>;
  cacheHits: number;
  cacheMisses: number;
}

const MAX_RETRIES = 3;

/**
 * Translates an array of fragments using the Ollama API.
 * Checks the translation cache first; only calls the model for cache misses.
 */
export async function translateFragments(
  projectId: number,
  fragments: HtmlFragment[],
  targetLanguage: string,
  config: ProjectConfig,
): Promise<TranslationBatch> {
  const translatedTexts = new Map<string, string>();
  const toTranslate: HtmlFragment[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;

  // Check cache first
  for (const fragment of fragments) {
    const cached = getCachedTranslation(projectId, fragment.outerHtml, targetLanguage);
    if (cached !== null) {
      translatedTexts.set(fragment.id, cached);
      cacheHits++;
    } else {
      toTranslate.push(fragment);
      cacheMisses++;
    }
  }

  if (toTranslate.length === 0) {
    return { fragments, translatedTexts, cacheHits, cacheMisses };
  }

  // Group fragments into batches
  const batchSize = config.translation.batchSize;
  for (let i = 0; i < toTranslate.length; i += batchSize) {
    const batch = toTranslate.slice(i, i + batchSize);
    const results = await translateBatch(batch, targetLanguage, config);

    for (const [id, translatedText] of results) {
      translatedTexts.set(id, translatedText);
      const fragment = batch.find((f) => f.id === id);
      if (fragment) {
        storeCachedTranslation(
          projectId,
          fragment.outerHtml,
          targetLanguage,
          translatedText,
          config.translation.model,
        );
      }
    }
  }

  return { fragments, translatedTexts, cacheHits, cacheMisses };
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/** Sends a single batch to Ollama and returns a map of fragment id → translated text. */
async function translateBatch(
  fragments: HtmlFragment[],
  targetLanguage: string,
  config: ProjectConfig,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  for (const fragment of fragments) {
    let translated: string | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        translated = await callOllama(
          fragment.outerHtml,
          config.translation.sourceLanguage,
          targetLanguage,
          config,
          fragment.isAttribute,
        );

        if (translated && verifyTranslationIntegrity(fragment.outerHtml, translated, fragment.isAttribute)) {
          break;
        }

        logger.warn(
          `Translation integrity check failed for fragment ${fragment.id} (attempt ${attempt}/${MAX_RETRIES})`,
        );
        translated = null;
      } catch (err) {
        logger.warn(
          `Ollama request failed for fragment ${fragment.id} (attempt ${attempt}/${MAX_RETRIES}): ${(err as Error).message}`,
        );
        // Exponential backoff
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
      }
    }

    if (translated) {
      results.set(fragment.id, translated);
    } else {
      // Fallback: keep original text if translation failed
      logger.warn(`Keeping original for fragment ${fragment.id} after ${MAX_RETRIES} failed attempts.`);
      results.set(fragment.id, fragment.outerHtml);
    }
  }

  return results;
}

/** Calls the Ollama API to translate a single fragment. */
async function callOllama(
  text: string,
  sourceLang: string,
  targetLang: string,
  config: ProjectConfig,
  isAttribute: boolean,
): Promise<string> {
  const prompt = isAttribute
    ? buildAttributePrompt(text, sourceLang, targetLang)
    : buildHtmlPrompt(text, sourceLang, targetLang);

  const response = await fetch(`${config.translation.ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.translation.model,
      prompt,
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as { response: string };
  return data.response.trim();
}

/** Builds the translation prompt for an HTML fragment. */
function buildHtmlPrompt(html: string, sourceLang: string, targetLang: string): string {
  return `Translate the following HTML fragment from ${sourceLang} to ${targetLang}.
Rules:
- Translate ONLY visible text content
- Do NOT modify any HTML tags, attributes, class names, IDs, or URLs
- You MAY reorder HTML elements if the target language grammar requires it
- Preserve ALL whitespace inside tags
- Return ONLY the translated HTML fragment, no explanations

${html}`;
}

/** Builds the translation prompt for a plain-text attribute value. */
function buildAttributePrompt(text: string, sourceLang: string, targetLang: string): string {
  return `Translate the following text from ${sourceLang} to ${targetLang}.
Rules:
- Return ONLY the translated text, no explanations
- Preserve any special characters or formatting

${text}`;
}

/**
 * Verifies structural integrity of a translated HTML fragment.
 * Checks that tag counts match (reordering is allowed).
 * Returns true if the translation is valid.
 */
function verifyTranslationIntegrity(
  original: string,
  translated: string,
  isAttribute: boolean,
): boolean {
  if (isAttribute) return translated.trim().length > 0;

  const originalCounts = countTags(original);
  const translatedCounts = countTags(translated);

  for (const [tag, count] of originalCounts) {
    if (translatedCounts.get(tag) !== count) {
      return false;
    }
  }

  // Verify attributes are preserved
  const originalAttrs = extractSignificantAttributes(original);
  const translatedAttrs = extractSignificantAttributes(translated);

  for (const attr of originalAttrs) {
    if (!translatedAttrs.has(attr)) return false;
  }

  return true;
}

/** Counts the number of each HTML tag in a string. */
function countTags(html: string): Map<string, number> {
  const $ = cheerio.load(html);
  const counts = new Map<string, number>();
  $('*').each((_i, el) => {
    if (el.type === 'tag') {
      const tag = el.tagName.toLowerCase();
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  });
  return counts;
}

/** Extracts class, id, href, src attribute values from HTML for integrity checking. */
function extractSignificantAttributes(html: string): Set<string> {
  const attrs = new Set<string>();
  const $ = cheerio.load(html);
  $('[class],[id],[href],[src]').each((_i, el) => {
    if (el.type !== 'tag') return;
    const a = el.attribs;
    if (a.class) attrs.add(`class:${a.class}`);
    if (a.id) attrs.add(`id:${a.id}`);
    if (a.href) attrs.add(`href:${a.href}`);
    if (a.src) attrs.add(`src:${a.src}`);
  });
  return attrs;
}

/** Translates JSON-LD structured data values. */
export function translateJsonLdValues(
  data: unknown,
  translations: Map<string, string>,
): unknown {
  if (typeof data === 'string') {
    return translations.get(data) ?? data;
  }
  if (Array.isArray(data)) {
    return data.map((item) => translateJsonLdValues(item, translations));
  }
  if (data && typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
      result[key] = translateJsonLdValues(val, translations);
    }
    return result;
  }
  return data;
}
