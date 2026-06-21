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

    for (const fragment of batch) {
      const translatedText = results.get(fragment.id);
      if (translatedText !== undefined) {
        // Successful translation: store in map and persist to cache
        translatedTexts.set(fragment.id, translatedText);
        storeCachedTranslation(
          projectId,
          fragment.outerHtml,
          targetLanguage,
          translatedText,
          config.translation.model,
        );
      } else {
        // Failed translation: use original as in-memory fallback only — do not cache,
        // so the fragment is retried on the next run.
        translatedTexts.set(fragment.id, fragment.outerHtml);
      }
    }
  }

  return { fragments, translatedTexts, cacheHits, cacheMisses };
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Sends a single batch to Ollama and returns a map of fragment id → translated text.
 * Only includes successfully verified translations — fallbacks are NOT included so
 * callers can decide whether to cache them.
 */
async function translateBatch(
  fragments: HtmlFragment[],
  targetLanguage: string,
  config: ProjectConfig,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  for (const fragment of fragments) {
    let translated: string | null = null;

    const maxRetries = config.translation.maxRetries ?? 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
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
          `Translation integrity check failed for fragment ${fragment.id} (attempt ${attempt}/${maxRetries})`,
        );
        translated = null;
      } catch (err) {
        logger.warn(
          `Ollama request failed for fragment ${fragment.id} (attempt ${attempt}/${maxRetries}): ${(err as Error).message}`,
        );
        // Exponential backoff
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
      }
    }

    if (translated) {
      results.set(fragment.id, translated);
    } else {
      // Do NOT add to results — caller will use original as fallback without caching it,
      // so the fragment is retried on the next run instead of being stuck permanently.
      logger.warn(`Keeping original for fragment ${fragment.id} after ${maxRetries} failed attempts (not cached).`);
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
  return cleanResponse(data.response, isAttribute);
}

/** Builds the translation prompt for an HTML fragment. */
function buildHtmlPrompt(html: string, sourceLang: string, targetLang: string): string {
  return `Translate the visible text inside the <source> tags from ${sourceLang} to ${targetLang}. Keep all HTML tags, attributes, class names, IDs, and URLs exactly as-is. Reply with only the translated HTML, nothing else.

<source>
${html}
</source>`;
}

/** Builds the translation prompt for a plain-text attribute value. */
function buildAttributePrompt(text: string, sourceLang: string, targetLang: string): string {
  return `Translate the text inside the <source> tags from ${sourceLang} to ${targetLang}. Reply with only the translated text, nothing else.

<source>${text}</source>`;
}

/**
 * Strips XML wrappers the model may add (e.g. <translation>...</translation>)
 * and detects obvious prompt leakage (model returning the prompt rules instead of a translation).
 */
function cleanResponse(raw: string, isAttribute: boolean): string {
  let text = raw.trim();

  // Strip common XML wrapper tags models add around their answer
  text = text.replace(/^```[\w]*\n?/m, '').replace(/\n?```$/m, '').trim();
  for (const tag of ['translation', 'result', 'output', 'answer', 'source']) {
    const open = new RegExp(`^<${tag}[^>]*>\\s*`, 'i');
    const close = new RegExp(`\\s*<\/${tag}>$`, 'i');
    text = text.replace(open, '').replace(close, '').trim();
  }

  // For attribute translations: if the model echoed the prompt instructions, strip them.
  // Pattern: model output starts with the instruction sentence then newline then the real answer.
  if (isAttribute) {
    const instructionLine = /^Translate the text.*?\n/i;
    text = text.replace(instructionLine, '').trim();
  }

  return text;
}

/**
 * Returns true if the response looks like the model returned prompt instructions
 * instead of (or in addition to) the actual translation.
 */
function hasPromptLeakage(text: string): boolean {
  return (
    /\bReturn ONLY\b/i.test(text) ||
    /\bDevuelve SOLO\b/i.test(text) ||
    /\bRegresa SOLO\b/i.test(text) ||
    /^\s*-\s+(Return|Translate|Preserve|Keep|Do NOT)/im.test(text) ||
    /^\s*-\s+(Devuelve|Regresa|Preserva|Conserva|No modif)/im.test(text) ||
    /^\s*(Rules?|Normas?|Reglas?):/im.test(text)
  );
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
  if (isAttribute) return translated.trim().length > 0 && !hasPromptLeakage(translated);

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
