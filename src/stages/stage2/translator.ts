import * as cheerio from 'cheerio';
import type { AnyNode, Element, Text } from 'domhandler';
import type { ProjectConfig } from '../../core/config.js';
import { logger } from '../../utils/logger.js';
import type { HtmlFragment } from './extractor.js';
import { getCachedTranslation, storeCachedTranslation } from './cache.js';

// ─── Model Helpers ────────────────────────────────────────────────────────────

/** Returns the primary (first) model name. Used as the cache key for all translations. */
function getPrimaryModel(config: ProjectConfig): string {
  const m = config.translation.model;
  return Array.isArray(m) ? m[0] : m;
}

/** Returns all configured models as an ordered array. */
function getModels(config: ProjectConfig): string[] {
  const m = config.translation.model;
  return Array.isArray(m) ? m : [m];
}

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
  onFragmentProgress?: (done: number, total: number, tokens: number) => void,
): Promise<TranslationBatch> {
  const translatedTexts = new Map<string, string>();
  const toTranslate: HtmlFragment[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  let fragmentsDone = 0;
  let totalTokens = 0;

  // Check cache first
  for (const fragment of fragments) {
    const cached = getCachedTranslation(projectId, fragment.outerHtml, targetLanguage, config);
    if (cached !== null) {
      translatedTexts.set(fragment.id, cached);
      cacheHits++;
      onFragmentProgress?.(++fragmentsDone, fragments.length, totalTokens);
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
    const results = await translateBatch(
      batch,
      targetLanguage,
      config,
      (fragTokens) => {
        totalTokens += fragTokens;
        onFragmentProgress?.(++fragmentsDone, fragments.length, totalTokens);
      },
    );

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
          getPrimaryModel(config),
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
  onFragmentDone?: (tokens: number) => void,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  const models = getModels(config);
  const maxRetries = config.translation.maxRetries ?? 5;

  for (const fragment of fragments) {
    let translated: string | null = null;
    let fragmentTokens = 0;

    modelLoop:
    for (const model of models) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const { text: callText, tokens: callTokens } = await callOllama(
            fragment.outerHtml,
            config.translation.sourceLanguage,
            targetLanguage,
            config,
            fragment.isAttribute,
            model,
          );
          fragmentTokens += callTokens;
          translated = callText;

          if (translated) {
            if (!fragment.isAttribute) {
              translated = restoreStructuralAttributes(fragment.outerHtml, translated);
            }
            if (verifyTranslationIntegrity(fragment.outerHtml, translated, fragment.isAttribute)) {
              break modelLoop;
            }
          }

          logger.warn(
            `Integrity check failed for fragment ${fragment.id} (model: ${model}, attempt ${attempt}/${maxRetries})`,
          );
          translated = null;
        } catch (err) {
          logger.warn(
            `Ollama request failed for fragment ${fragment.id} (model: ${model}, attempt ${attempt}/${maxRetries}): ${(err as Error).message}`,
          );
          await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
        }
      }
      if (translated === null && models.indexOf(model) < models.length - 1) {
        logger.warn(`Model "${model}" exhausted for fragment ${fragment.id}, trying next model...`);
      }
    }

    if (translated) {
      results.set(fragment.id, translated);
    } else if (!fragment.isAttribute) {
      // All models exhausted — fall back to translating text nodes individually.
      logger.warn(`All models exhausted for fragment ${fragment.id}. Falling back to text-node strategy.`);
      const { html: textNodeResult, tokens: fallbackTokens } = await translateByTextNodes(fragment, targetLanguage, config);
      fragmentTokens += fallbackTokens;
      if (textNodeResult) {
        results.set(fragment.id, textNodeResult);
      } else {
        logger.warn(`Keeping original for fragment ${fragment.id} after all strategies failed (not cached).`);
      }
    } else {
      logger.warn(`Keeping original for attribute fragment ${fragment.id} after all models failed (not cached).`);
    }

    onFragmentDone?.(fragmentTokens);
  }

  return results;
}

/**
 * Restores non-translatable attribute values (class, id, href, src) in a translated
 * HTML fragment by matching elements to their originals via depth-first traversal order.
 * Called before the integrity check to prevent spurious failures caused by the model
 * accidentally altering structural attributes.
 */
function restoreStructuralAttributes(original: string, translated: string): string {
  const $orig = cheerio.load(original);
  const $trans = cheerio.load(translated);
  const RESTORE_ATTRS = ['class', 'id', 'href', 'src'];

  function collectElements(root: Element): Element[] {
    const els: Element[] = [];
    function walk(el: Element): void {
      els.push(el);
      for (const child of (el.children ?? []) as AnyNode[]) {
        if (child.type === 'tag') walk(child as Element);
      }
    }
    for (const child of (root.children ?? []) as AnyNode[]) {
      if (child.type === 'tag') walk(child as Element);
    }
    return els;
  }

  const origBody = $orig('body').get(0) as Element | undefined;
  const transBody = $trans('body').get(0) as Element | undefined;
  if (!origBody || !transBody) return translated;

  const origEls = collectElements(origBody);
  const transEls = collectElements(transBody);

  const len = Math.min(origEls.length, transEls.length);
  for (let i = 0; i < len; i++) {
    const orig = origEls[i];
    const trans = transEls[i];
    if (orig.tagName !== trans.tagName) continue;
    for (const attr of RESTORE_ATTRS) {
      if (orig.attribs[attr] !== undefined) {
        trans.attribs[attr] = orig.attribs[attr];
      } else if (trans.attribs[attr] !== undefined) {
        delete trans.attribs[attr];
      }
    }
  }

  const firstEl = $trans('body').children().first().get(0);
  return firstEl ? $trans.html(firstEl) : translated;
}

/**
 * Fallback strategy: translates only the visible text nodes inside an HTML fragment,
 * leaving all tags, attributes, and structure completely untouched.
 * Returns the modified outer HTML, or null if nothing could be translated.
 */
async function translateByTextNodes(
  fragment: HtmlFragment,
  targetLanguage: string,
  config: ProjectConfig,
): Promise<{ html: string | null; tokens: number }> {
  const $ = cheerio.load(fragment.outerHtml);
  const SKIP_TEXT_TAGS = new Set(['script', 'style', 'code', 'pre', 'noscript']);

  interface TextTask { node: Text; trimmed: string }
  const tasks: TextTask[] = [];

  function collectTextNodes(node: AnyNode): void {
    if (node.type === 'text') {
      const data = (node as Text).data ?? '';
      const trimmed = data.trim();
      if (trimmed.length > 1 && /[a-zA-ZÀ-ÿ\u4e00-\u9fa5\u3040-\u30ff]/.test(trimmed)) {
        tasks.push({ node: node as Text, trimmed });
      }
      return;
    }
    if (node.type === 'tag') {
      const el = node as Element;
      if (SKIP_TEXT_TAGS.has(el.tagName?.toLowerCase() ?? '')) return;
      ((el.children ?? []) as AnyNode[]).forEach(collectTextNodes);
    }
  }

  const bodyEl = $('body').get(0) as Element | undefined;
  ((bodyEl?.children ?? []) as AnyNode[]).forEach(collectTextNodes);

  if (tasks.length === 0) return { html: null, tokens: 0 };

  const maxRetries = config.translation.maxRetries ?? 5;
  let anyTranslated = false;
  let translateTokens = 0;

  for (const task of tasks) {
    let translated: string | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const { text: result, tokens: callTokens } = await callOllama(
          task.trimmed,
          config.translation.sourceLanguage,
          targetLanguage,
          config,
          true, // isAttribute=true → plain-text prompt and plain-text response
          getPrimaryModel(config),
        );
        translateTokens += callTokens;
        if (result && result.trim().length > 0 && !hasPromptLeakage(result)) {
          translated = result.trim();
          break;
        }
      } catch {
        // silently continue to next attempt
      }
    }

    if (translated) {
      const leading = task.node.data.match(/^(\s*)/)?.[1] ?? '';
      const trailing = task.node.data.match(/(\s*)$/)?.[1] ?? '';
      task.node.data = leading + translated + trailing;
      anyTranslated = true;
    }
  }

  if (!anyTranslated) return { html: null, tokens: translateTokens };

  const firstEl = $('body').children().first().get(0);
  return { html: firstEl ? $.html(firstEl) : null, tokens: translateTokens };
}

/** Calls the Ollama API to translate a single fragment. */
async function callOllama(
  text: string,
  sourceLang: string,
  targetLang: string,
  config: ProjectConfig,
  isAttribute: boolean,
  model: string,
): Promise<{ text: string; tokens: number }> {
  const prompt = isAttribute
    ? buildAttributePrompt(text, sourceLang, targetLang, config)
    : buildHtmlPrompt(text, sourceLang, targetLang, config);

  const response = await fetch(`${config.translation.ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    response: string;
    prompt_eval_count?: number;
    eval_count?: number;
  };
  const tokens = (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0);
  return { text: cleanResponse(data.response, isAttribute), tokens };
}

/** Builds the translation prompt for an HTML fragment. */
function buildHtmlPrompt(html: string, sourceLang: string, targetLang: string, config: ProjectConfig): string {
  const contextLine = config.translation.context
    ? `\nContext: ${config.translation.context}\n`
    : '';
  const termsLine = config.translation.preserveTerms?.length
    ? `\n- Never translate these terms (keep them verbatim): ${config.translation.preserveTerms.join(', ')}\n`
    : '';

  return `Translate the visible text inside the <source> tags from ${sourceLang} to ${targetLang}.
${contextLine}
Guidelines:
- Tone: professional and friendly. Use the informal/familiar form of address (e.g., "tú" in Spanish, "tu" in French, "du" in German, "tu" in Italian) — never the formal form (e.g., "usted", "vous", "Sie", "Lei").
- Match the style of the original: keep concise text concise, keep explanatory text explanatory.
- Do NOT translate: HTML tags, attributes, class names, IDs, URLs, code snippets, technical identifiers, or brand/product names.${termsLine}- Keep all whitespace, line breaks, and HTML structure exactly as in the source.
- Do NOT include notes, explanations, or comments about your translation. Output ONLY the translated HTML.
- Reply with only the translated HTML, nothing else.

<source>
${html}
</source>`;
}

/** Builds the translation prompt for a plain-text attribute value. */
function buildAttributePrompt(text: string, sourceLang: string, targetLang: string, config: ProjectConfig): string {
  const terms = config.translation.preserveTerms?.length
    ? ` Never translate: ${config.translation.preserveTerms.join(', ')}.`
    : '';

  return `Translate the text inside the <source> tags from ${sourceLang} to ${targetLang}. Use a professional and friendly tone with the informal form of address. Do not translate technical terms, URLs, or brand names.${terms} Do NOT include notes, explanations, or comments. Reply with only the translated text, nothing else.

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

  // Strip model meta-commentary: "(Note: ...)" parenthetical notes anywhere in the text
  text = text.replace(/\s*\([Nn]ote:[^)]+\)/g, '').trim();

  if (isAttribute) {
    // For plain-text attributes: strip trailing " Note: ..." or newline-separated notes
    text = text.replace(/[\s\n]+[Nn]ote:[^\n]*/gs, '').trim();
  } else {
    // For HTML fragments: strip notes appended AFTER the last closing HTML tag
    text = text.replace(/(<\/[^>]+>)\s+[Nn]ote:[\s\S]*$/i, '$1').trim();
    // Also strip notes that appear after the last text content on a new line
    text = text.replace(/\n[Nn]ote:[^\n]*/g, '').trim();
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

// ─── Code Comment Translator ─────────────────────────────────────────────────

interface CommentParts { prefix: string; body: string; suffix: string }

/**
 * Splits a comment line into marker prefix + translatable body + closing suffix.
 * Handles: // line, # shell, block (slash-star ... star-slash), HTML comments, and star continuations.
 */
function splitCommentMarker(line: string): CommentParts {
  let m: RegExpMatchArray | null;

  // Block comment on one line: /* body */
  m = line.match(/^(\s*\/\*+\s*)(.*?)(\s*\*+\/\s*)$/s);
  if (m) return { prefix: m[1], body: m[2].trim(), suffix: m[3] };

  // HTML / template comment: <!-- body -->
  m = line.match(/^(\s*<!--\s*)(.*?)(\s*-->\s*)$/s);
  if (m) return { prefix: m[1], body: m[2].trim(), suffix: m[3] };

  // Line comment: // or #
  m = line.match(/^(\s*(?:\/\/+|#+)\s*)(.*)(\s*)$/);
  if (m) return { prefix: m[1], body: m[2].trimEnd(), suffix: m[3] };

  // Block-comment continuation line: * body
  m = line.match(/^(\s*\*\s+)(.*)(\s*)$/);
  if (m) return { prefix: m[1], body: m[2].trimEnd(), suffix: m[3] };

  return { prefix: '', body: line, suffix: '' };
}

/** Scans a translated HTML string for Prism comment spans inside code blocks,
 * translates each contiguous group as plain text, and returns the updated HTML.
 * Never touches any code element — only spans with class "token comment".
 */
export async function translateCodeComments(
  html: string,
  targetLanguage: string,
  projectId: number,
  config: ProjectConfig,
): Promise<{ html: string; cacheHits: number; cacheMisses: number }> {
  const $ = cheerio.load(html);

  interface Group { elements: Element[]; lines: string[] }
  const groups: Group[] = [];

  $('pre code').each((_i, codeEl) => {
    let currentEls: Element[] = [];
    let currentLines: string[] = [];

    const flush = () => {
      if (currentEls.length > 0) {
        groups.push({ elements: [...currentEls], lines: [...currentLines] });
        currentEls = [];
        currentLines = [];
      }
    };

    $(codeEl).contents().each((_j, node) => {
      if (node.type === 'tag') {
        const el = node as Element;
        const cls = el.attribs?.class ?? '';
        if (el.tagName === 'span' && cls.includes('token') && cls.includes('comment')) {
          currentEls.push(el);
          currentLines.push($(el).text());
          return;
        }
      }
      // Whitespace-only text nodes don't break the group
      if (node.type === 'text' && /^[\s]*$/.test((node as Text).data ?? '')) return;
      flush();
    });
    flush();
  });

  let cacheHits = 0;
  let cacheMisses = 0;

  for (const group of groups) {
    // Split each original line into marker prefix + translatable body + closing suffix
    const parts = group.lines.map(splitCommentMarker);
    const bodies = parts.map(p => p.body);
    const bodyText = bodies.join('\n');

    // Use the original lines (with markers) as the stable cache key
    const cacheKey = group.lines.join('\n');
    if (!cacheKey.trim()) continue;

    const cached = getCachedTranslation(projectId, cacheKey, targetLanguage, config);
    let translatedBodies: string[] = bodies; // default: keep originals

    if (cached !== null) {
      translatedBodies = redistributeLines(cached, group.lines.length);
      cacheHits++;
    } else {
      if (bodyText.trim()) {
        const models = getModels(config);
        for (const model of models) {
          try {
            const result = await callOllamaComment(
              bodyText,
              config.translation.sourceLanguage,
              targetLanguage,
              config,
              model,
            );
            translatedBodies = redistributeLines(result.text, group.lines.length);
            storeCachedTranslation(projectId, cacheKey, targetLanguage, result.text, getPrimaryModel(config));
            break;
          } catch (err) {
            if (models.indexOf(model) < models.length - 1) {
              logger.warn(`Code comment translation failed with model "${model}", trying next...`);
            } else {
              logger.warn(`Code comment translation failed with all models: ${(err as Error).message}`);
            }
          }
        }
      }
      cacheMisses++;
    }

    // Reassemble: original prefix + translated body + original suffix
    const finalLines = parts.map((p, i) => p.prefix + (translatedBodies[i] ?? p.body) + p.suffix);
    applyCommentGroup($, group.elements, finalLines);
  }

  return { html: $.html() ?? html, cacheHits, cacheMisses };
}

/** Applies the final (reassembled) lines back to the original comment spans. */
function applyCommentGroup(
  $: cheerio.CheerioAPI,
  elements: Element[],
  finalLines: string[],
): void {
  for (let i = 0; i < elements.length; i++) {
    if (finalLines[i] !== undefined) $(elements[i]).text(finalLines[i]);
  }
}

/** Splits translated text into exactly n parts, one per original span.
 * Prefers splitting by newlines; falls back to proportional word distribution. */
function redistributeLines(text: string, n: number): string[] {
  if (n === 1) return [text];
  const lines = text.split('\n');
  if (lines.length === n) return lines;
  if (lines.length > n) {
    // More lines than spans: merge excess into last bucket
    return [...lines.slice(0, n - 1), lines.slice(n - 1).join('\n')];
  }
  // Fewer lines than spans: distribute words proportionally
  const words = text.split(/\s+/).filter(Boolean);
  const perPart = Math.max(1, Math.ceil(words.length / n));
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(words.slice(i * perPart, (i + 1) * perPart).join(' '));
  }
  while (parts.length < n) parts.push('');
  return parts;
}

/** Calls the Ollama API to translate plain-text code comments. */
async function callOllamaComment(
  text: string,
  sourceLang: string,
  targetLang: string,
  config: ProjectConfig,
  model: string,
): Promise<{ text: string; tokens: number }> {
  const lineCount = text.split('\n').length;
  const prompt = `Translate the following text from ${sourceLang} to ${targetLang}.
Keep exactly ${lineCount} line${lineCount > 1 ? 's' : ''} in the output.
Reply with only the translated text, nothing else.

${text}`;

  const response = await fetch(`${config.translation.ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
  const data = (await response.json()) as {
    response: string;
    prompt_eval_count?: number;
    eval_count?: number;
  };
  const tokens = (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0);
  return { text: data.response.trim(), tokens };
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
