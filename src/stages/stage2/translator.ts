import * as cheerio from 'cheerio';
import type { AnyNode, Element, Text } from 'domhandler';
import fs from 'fs-extra';
import path from 'path';
import type { ProjectConfig } from '../../core/config.js';
import { logger } from '../../utils/logger.js';
import type { HtmlFragment, PlaceholderEntry } from './extractor.js';
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
 * Translates an array of fragments using the configured LLM provider.
 * Checks the translation cache first; only calls the model for cache misses.
 */
export async function translateFragments(
  projectId: number,
  pagePath: string,
  fragments: HtmlFragment[],
  targetLanguage: string,
  config: ProjectConfig,
  onFragmentProgress?: (done: number, total: number, tokens: number, fragmentId: string) => void,
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
      onFragmentProgress?.(++fragmentsDone, fragments.length, totalTokens, fragment.id);
    } else {
      toTranslate.push(fragment);
      cacheMisses++;
    }
  }

  if (toTranslate.length === 0) {
    return { fragments, translatedTexts, cacheHits, cacheMisses };
  }

  const startTime = Date.now();
  let pageInputTokens = 0;
  let pageOutputTokens = 0;
  let pageTotalTokens = 0;
  let pageRetries = 0;
  let pageFailedCount = 0;

  // Group fragments into batches
  const batchSize = config.translation.batchSize;
  for (let i = 0; i < toTranslate.length; i += batchSize) {
    const batch = toTranslate.slice(i, i + batchSize);
    const {
      results,
      inputTokens: batchIn,
      outputTokens: batchOut,
      totalTokens: batchTotal,
      retries: batchRetries,
      failedCount: batchFailed,
    } = await translateBatch(
      projectId,
      pagePath,
      batch,
      fragments,
      targetLanguage,
      config,
      (fragTokens, fragmentId) => {
        totalTokens += fragTokens;
        onFragmentProgress?.(++fragmentsDone, fragments.length, totalTokens, fragmentId);
      },
      (fragmentId) => {
        onFragmentProgress?.(fragmentsDone, fragments.length, totalTokens, fragmentId);
      },
    );

    pageInputTokens += batchIn;
    pageOutputTokens += batchOut;
    pageTotalTokens += batchTotal;
    pageRetries += batchRetries;
    pageFailedCount += batchFailed;

    for (const fragment of batch) {
      const translatedText = results.get(fragment.id);
      if (translatedText !== undefined) {
        // Successful translation: store in map (already persisted to cache in translateBatch)
        translatedTexts.set(fragment.id, translatedText);
      } else {
        // Failed translation: use original as in-memory fallback only — do not cache,
        // so the fragment is retried on the next run.
        translatedTexts.set(fragment.id, fragment.outerHtml);
      }
    }
  }

  if (toTranslate.length > 0) {
    writeDebugPageSummary({
      projectSlug: config.slug,
      pagePath,
      language: targetLanguage,
      model: getPrimaryModel(config),
      inputTokens: pageInputTokens,
      outputTokens: pageOutputTokens,
      totalTokens: pageTotalTokens,
      durationMs: Date.now() - startTime,
      retries: pageRetries,
      failedCount: pageFailedCount,
    });
  }

  return { fragments, translatedTexts, cacheHits, cacheMisses };
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Sends a single batch to Ollama and returns a map of fragment id → translated text and token metrics.
 * Only includes successfully verified translations — fallbacks are NOT included so
 * callers can decide whether to cache them.
 */
async function translateBatch(
  projectId: number,
  pagePath: string,
  batch: HtmlFragment[],
  allFragments: HtmlFragment[],
  targetLanguage: string,
  config: ProjectConfig,
  onFragmentDone?: (tokens: number, fragmentId: string) => void,
  onFragmentStart?: (fragmentId: string) => void,
): Promise<{
  results: Map<string, string>;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  retries: number;
  failedCount: number;
}> {
  const results = new Map<string, string>();
  let batchInputTokens = 0;
  let batchOutputTokens = 0;
  let batchTotalTokens = 0;
  let batchRetries = 0;
  let batchFailedCount = 0;

  const models = getModels(config);
  const maxRetries = config.translation.maxRetries ?? 5;

  for (const fragment of batch) {
    onFragmentStart?.(fragment.id);
    let translated: string | null = null;
    let successfulModel: string | null = null;
    let fragmentTokens = 0;
    let fragmentLlmCalls = 0;
    const attemptsLog: Array<{
      model: string;
      attempt: number;
      response: string | null;
      error?: string;
      integrityFailed?: boolean;
    }> = [];

    const fragmentIndex = allFragments.indexOf(fragment) + 1;
    const indexStr = `${fragmentIndex}/${allFragments.length} fragments`;

    let hasLoggedSeparatorForFragment = false;
    const ensureSeparator = () => {
      if (!hasLoggedSeparatorForFragment) {
        const header = `─── Fragment ${fragment.id} `;
        const line = header + '─'.repeat(Math.max(0, 70 - header.length));
        logger.warn(line);
        hasLoggedSeparatorForFragment = true;
      }
    };

    modelLoop:
    for (const model of models) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        fragmentLlmCalls++;
        const startTime = Date.now();
        let callText: string | null = null;
        let inputTokens = 0;
        let outputTokens = 0;
        let callTokens = 0;
        let errorMsg: string | undefined;
        let integrityPassed = false;
        let promptText = '';

        try {
          const res = await callLLM(
            fragment.outerHtml,
            config.translation.sourceLanguage,
            targetLanguage,
            config,
            fragment.isAttribute,
            model,
          );
          callText = res.text;
          promptText = res.prompt;
          inputTokens = res.inputTokens;
          outputTokens = res.outputTokens;
          callTokens = res.totalTokens;
          fragmentTokens += callTokens;
          translated = callText;

          const integrityResult = translated
            ? verifyPlaceholderIntegrity(translated, fragment.outerHtml, fragment.placeholders, ensureSeparator)
            : { passed: false, reason: 'translation output was empty' };

          if (translated && integrityResult.passed) {
            integrityPassed = true;
            successfulModel = model;
            batchInputTokens += inputTokens;
            batchOutputTokens += outputTokens;
            batchTotalTokens += callTokens;

            writeDebugAttemptLog({
              projectSlug: config.slug,
              pagePath,
              language: targetLanguage,
              indexStr,
              fragmentId: fragment.id,
              model,
              attempt,
              inputTokens,
              outputTokens,
              totalTokens: callTokens,
              durationMs: Date.now() - startTime,
              status: 'SUCCESS',
              prompt: promptText,
              response: callText,
            });
            break modelLoop;
          }

          ensureSeparator();
          logger.warn(
            `Integrity check failed for fragment ${fragment.id} (model: ${model}, attempt ${attempt}/${maxRetries}): ${integrityResult.reason ?? 'unknown reason'}`,
          );
          batchInputTokens += inputTokens;
          batchOutputTokens += outputTokens;
          batchTotalTokens += callTokens;

          writeDebugAttemptLog({
            projectSlug: config.slug,
            pagePath,
            language: targetLanguage,
            indexStr,
            fragmentId: fragment.id,
            model,
            attempt,
            inputTokens,
            outputTokens,
            totalTokens: callTokens,
            durationMs: Date.now() - startTime,
            status: 'INTEGRITY_FAILED',
            prompt: promptText,
            response: callText ?? '',
            reason: integrityResult.reason,
          });
          attemptsLog.push({
            model,
            attempt,
            response: callText,
            integrityFailed: true,
          });
          translated = null;
        } catch (err) {
          errorMsg = (err as Error).message;
          ensureSeparator();
          logger.warn(
            `LLM request failed for fragment ${fragment.id} (model: ${model}, attempt ${attempt}/${maxRetries}): ${errorMsg}`,
          );
          writeDebugAttemptLog({
            projectSlug: config.slug,
            pagePath,
            language: targetLanguage,
            indexStr,
            fragmentId: fragment.id,
            model,
            attempt,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            durationMs: Date.now() - startTime,
            status: 'ERROR',
            prompt: promptText || (fragment.isAttribute ? buildAttributePrompt(fragment.outerHtml, config.translation.sourceLanguage, targetLanguage, config) : buildPlaceholderPrompt(fragment.outerHtml, config.translation.sourceLanguage, targetLanguage, config)),
            response: `[ERROR] ${errorMsg}`,
            reason: errorMsg,
          });
          attemptsLog.push({
            model,
            attempt,
            response: null,
            error: errorMsg,
          });
          await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
        }
      }
      if (translated === null && models.indexOf(model) < models.length - 1) {
        ensureSeparator();
        logger.warn(`Model "${model}" exhausted for fragment ${fragment.id}, trying next model...`);
      }
    }

    batchRetries += Math.max(0, fragmentLlmCalls - 1);

    if (translated) {
      results.set(fragment.id, translated);
      // Successful translation: persist to cache immediately
      storeCachedTranslation(
        projectId,
        fragment.outerHtml,
        targetLanguage,
        translated,
        successfulModel || getPrimaryModel(config),
      );
      if (hasLoggedSeparatorForFragment) {
        logger.warn(`SUCCESS: fragment ${fragment.id} translated successfully`);
      }
    } else {
      batchFailedCount++;
      ensureSeparator();
      if (hasLoggedSeparatorForFragment) {
        logger.warn(`FAILED: fragment ${fragment.id} failed to translate (kept original)`);
      }
      logger.warn(`Keeping original for fragment ${fragment.id} after all models failed (not cached).`);
      writeFailureLog(projectId, fragment, targetLanguage, attemptsLog);
    }

    onFragmentDone?.(fragmentTokens, fragment.id);
  }

  return {
    results,
    inputTokens: batchInputTokens,
    outputTokens: batchOutputTokens,
    totalTokens: batchTotalTokens,
    retries: batchRetries,
    failedCount: batchFailedCount,
  };
}

/**
 * Appends a detailed report of a translation failure (where all models and attempts failed
 * to validate integrity or succeed) to a log file inside the logs directory.
 */
function writeFailureLog(
  projectId: number,
  fragment: HtmlFragment,
  targetLanguage: string,
  attemptsLog: Array<{
    model: string;
    attempt: number;
    response: string | null;
    error?: string;
    integrityFailed?: boolean;
  }>,
): void {
  try {
    const logDir = path.join(process.cwd(), 'data', 'logs');
    const logPath = path.join(logDir, 'translation_failures.log');
    fs.ensureDirSync(logDir);

    const timestamp = new Date().toISOString();
    let placeholdersStr = '';
    if (fragment.placeholders && fragment.placeholders.size > 0) {
      placeholdersStr = Array.from(fragment.placeholders.entries())
        .map(([n, entry]) => `  id: ${n}, tag: ${entry.name}, close: ${entry.close}, attribs: ${JSON.stringify(entry.attribs)}`)
        .join('\n');
    } else {
      placeholdersStr = '  (none)';
    }

    const attemptsStr = attemptsLog
      .map((log) => {
        let status = '';
        let detail = '';
        if (log.error) {
          status = 'ERROR';
          detail = log.error;
        } else if (log.integrityFailed) {
          status = 'INTEGRITY FAILED';
          detail = `Response: "${log.response}"`;
        }
        return `  - Model: ${log.model}, Attempt ${log.attempt}: [${status}] ${detail}`;
      })
      .join('\n');

    const logEntry = `
================================================================================
TIMESTAMP: ${timestamp}
PROJECT ID: ${projectId}
TARGET LANGUAGE: ${targetLanguage}
FRAGMENT ID: ${fragment.id}
IS ATTRIBUTE: ${fragment.isAttribute}
SOURCE TEXT: "${fragment.outerHtml}"
EXPECTED PLACEHOLDERS:
${placeholdersStr}
ATTEMPTS HISTORY:
${attemptsStr}
================================================================================
`;

    fs.appendFileSync(logPath, logEntry, 'utf-8');
  } catch (err) {
    logger.error(`Failed to write translation failure log: ${(err as Error).message}`);
  }
}

/**
 * Dispatches an LLM translation call to the appropriate provider.
 */
async function callLLM(
  text: string,
  sourceLang: string,
  targetLang: string,
  config: ProjectConfig,
  isAttribute: boolean,
  model: string,
): Promise<{ text: string; prompt: string; inputTokens: number; outputTokens: number; totalTokens: number }> {
  if (config.translation.provider === 'gemini') {
    return callGemini(text, sourceLang, targetLang, config, isAttribute, model);
  }
  return callOllama(text, sourceLang, targetLang, config, isAttribute, model);
}

/** Calls the Ollama API to translate a single fragment. */
async function callOllama(
  text: string,
  sourceLang: string,
  targetLang: string,
  config: ProjectConfig,
  isAttribute: boolean,
  model: string,
): Promise<{ text: string; prompt: string; inputTokens: number; outputTokens: number; totalTokens: number }> {
  const prompt = isAttribute
    ? buildAttributePrompt(text, sourceLang, targetLang, config)
    : buildPlaceholderPrompt(text, sourceLang, targetLang, config);

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
  const inputTokens = data.prompt_eval_count ?? 0;
  const outputTokens = data.eval_count ?? 0;
  const totalTokens = inputTokens + outputTokens;
  return {
    text: cleanResponse(data.response, isAttribute),
    prompt,
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

/** Builds the translation prompt for a block fragment using placeholder notation. */
function buildPlaceholderPrompt(text: string, sourceLang: string, targetLang: string, config: ProjectConfig): string {
  const contextLine = config.translation.context
    ? `\nContext: You are translating the ${config.translation.context}\n`
    : '';
  const termsLine = config.translation.preserveTerms?.length
    ? `\n- Never translate these terms (keep them verbatim): ${config.translation.preserveTerms.join(', ')}\n`
    : '';

  return `You are a professional web translator. Translate the text inside the <source> tag from ${sourceLang} to ${targetLang}.${contextLine}

Guidelines:
- Use an informal, friendly tone (e.g. "tú" in Spanish, "tu" in French, "du" in German).
- Do NOT translate, modify, add, or remove any placeholder tags or their attributes.
- Do not translate technical terms, URLs, code, or brand names.${termsLine}
- Do NOT wrap your response in <source> tags, and do NOT include the opening <source> or closing </source> tags in your output. Reply with ONLY the raw translated text, containing only the span placeholders, and absolutely nothing else. Do NOT include any introductory or concluding messages, notes, commentary, explanations, warnings, or responses directed to me.

<source>
${text}
</source>
`;
}

/** Builds the translation prompt for a plain-text attribute value. */
function buildAttributePrompt(text: string, sourceLang: string, targetLang: string, config: ProjectConfig): string {
  const terms = config.translation.preserveTerms?.length
    ? ` Never translate: ${config.translation.preserveTerms.join(', ')}.`
    : '';

  return `Translate the text inside the <source> tags from ${sourceLang} to ${targetLang}. Use a professional and friendly tone with the informal form of address. Do not translate technical terms, URLs, or brand names.${terms} Do NOT include notes, explanations, or comments. Reply with only the translated text, nothing else. Do NOT wrap your response in <source> tags, and do NOT include the opening <source> or closing </source> tags. Do NOT include any introductory or concluding messages, notes, commentary, explanations, warnings, or responses directed to me.

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
 * Verifies that placeholder tags are preserved in the translated text.
 * Checks that every placeholder number (id attribute) and tag name
 * appears correctly in the translation.
 */
/**
 * Verifies that placeholder tags are preserved in the translated text.
 * Checks that every placeholder number (id attribute) and tag name
 * appears correctly in the translation.
 */
function verifyPlaceholderIntegrity(
  translated: string,
  originalText: string,
  placeholders: Map<number, PlaceholderEntry> | undefined,
  onWarning?: () => void,
): { passed: boolean; reason?: string } {
  const logWarning = (reason: string) => {
    onWarning?.();
    logger.warn(`Integrity check failed: ${reason}`);
  };

  // Reject if the translated text contains any literal hexadecimal byte representations (e.g. <0xC2>, <0xA0>)
  const hexByteRegex = /<0x[0-9a-fA-F]{2}>/i;
  if (hexByteRegex.test(translated)) {
    const reason = `translation contains hex byte literal sequence (e.g. <0xXX>)`;
    logWarning(reason);
    return { passed: false, reason };
  }

  // Check text expansion / contraction limit
  const cleanOriginal = originalText.replace(/<[^>]+>/g, '').trim();
  const cleanTranslated = translated.replace(/<[^>]+>/g, '').trim();
  const lenOrig = cleanOriginal.length;
  const lenTrans = cleanTranslated.length;

  if (lenOrig > 0) {
    const diff = Math.abs(lenTrans - lenOrig);
    const isExpansion = lenTrans > lenOrig;
    const limit = isExpansion ? Math.max(40, lenOrig * 1.5) : Math.max(15, lenOrig * 0.8);
    const maxPercentage = isExpansion ? 150 : 80;

    if (diff > limit) {
      const percentage = ((diff / lenOrig) * 100).toFixed(1);
      const reason = `text length changed by ${percentage}% (${lenOrig} -> ${lenTrans} chars), exceeding the ${maxPercentage}% limit (with a minimum of ${isExpansion ? 40 : 15} chars difference). Original: ${lenOrig} chars, Translated: ${lenTrans} chars`;
      logWarning(reason);
      return { passed: false, reason };
    }
  }

  // Find all HTML tags in the raw translated string
  const allTags = translated.match(/<[^>]+>/g) || [];

  // 1. All tags must be valid span tags: either <span ...> or </span>
  const openingSpanRegex = /^<span\b[^>]*>$/i;
  const closingSpanRegex = /^<\/span>$/i;

  let countOpening = 0;
  let countClosing = 0;

  for (const tag of allTags) {
    if (openingSpanRegex.test(tag)) {
      countOpening++;
    } else if (closingSpanRegex.test(tag)) {
      countClosing++;
    } else {
      const reason = `translation contains forbidden tag/markup: "${tag}"`;
      logWarning(reason);
      return { passed: false, reason };
    }
  }

  // 2. Count of opening and closing spans must be equal
  if (countOpening !== countClosing) {
    const reason = `unbalanced span tags. Opening: ${countOpening}, Closing: ${countClosing}`;
    logWarning(reason);
    return { passed: false, reason };
  }

  // 3. Count must match expected placeholders count exactly
  const expectedCount = placeholders ? placeholders.size : 0;
  if (countOpening !== expectedCount) {
    const reason = `tag count (${countOpening}) does not match expected placeholder count (${expectedCount})`;
    logWarning(reason);
    return { passed: false, reason };
  }

  const $ = cheerio.load(translated);

  // 4. Strict tag structure validation:
  // Every tag node in the parsed body must be a 'span' element and have a valid 'id' attribute matching one of our expected placeholder IDs.
  let isValidStructure = true;
  let structureReason = '';
  $('body *').each((_i, el) => {
    if (el.type === 'tag') {
      const tag = el.tagName.toLowerCase();
      if (tag !== 'span') {
        structureReason = `translation contains forbidden tag <${tag}>`;
        logWarning(structureReason);
        isValidStructure = false;
        return false; // break each
      }
      const idAttr = $(el).attr('id');
      if (!idAttr) {
        structureReason = `translation contains a <span> tag without an id attribute`;
        logWarning(structureReason);
        isValidStructure = false;
        return false; // break each
      }
      const n = parseInt(idAttr, 10);
      if (isNaN(n) || !placeholders || !placeholders.has(n)) {
        structureReason = `translation contains unexpected placeholder id="${idAttr}"`;
        logWarning(structureReason);
        isValidStructure = false;
        return false; // break each
      }
      const entry = placeholders.get(n);
      if (entry) {
        const isVoid = entry.close === '';
        const isAtomic = entry.innerHTML !== undefined;
        if (isVoid || isAtomic) {
          const innerText = $(el).text().trim();
          if (innerText.length > 0) {
            structureReason = `placeholder id="${idAttr}" is void/atomic and must remain empty, but contains text: "${innerText}"`;
            logWarning(structureReason);
            isValidStructure = false;
            return false; // break each
          }
        }
      }
    }
  });

  if (!isValidStructure) return { passed: false, reason: structureReason };

  // 5. Strict presence validation:
  // Every expected placeholder in the map must exist in the translated response.
  if (placeholders && placeholders.size > 0) {
    for (const [n] of placeholders) {
      const el = $(`body [id="${n}"]`);
      if (el.length === 0) {
        const reason = `missing expected placeholder id="${n}"`;
        logWarning(reason);
        return { passed: false, reason };
      }
    }
  } else {
    // If no placeholders are expected, the output should not contain any tags.
    if ($('body *').length > 0) {
      const reason = `contains tags but none were expected`;
      logWarning(reason);
      return { passed: false, reason };
    }
  }

  if (hasPromptLeakage(translated)) {
    const reason = `potential prompt leakage detected in translation`;
    logWarning(reason);
    return { passed: false, reason };
  }

  return { passed: true };
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
            const result = await callLLMComment(
              bodyText,
              config.translation.sourceLanguage,
              targetLanguage,
              config,
              model,
            );
            translatedBodies = redistributeLines(result.text, group.lines.length);
            storeCachedTranslation(projectId, cacheKey, targetLanguage, result.text, model);
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

/**
 * Dispatches a code-comment translation call to the appropriate provider.
 */
async function callLLMComment(
  text: string,
  sourceLang: string,
  targetLang: string,
  config: ProjectConfig,
  model: string,
): Promise<{ text: string; tokens: number }> {
  if (config.translation.provider === 'gemini') {
    return callGeminiComment(text, sourceLang, targetLang, config, model);
  }
  return callOllamaComment(text, sourceLang, targetLang, config, model);
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

// ─── Gemini Provider ─────────────────────────────────────────────────────────

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Calls the Google Gemini API to translate a single fragment or attribute. */
async function callGemini(
  text: string,
  sourceLang: string,
  targetLang: string,
  config: ProjectConfig,
  isAttribute: boolean,
  model: string,
): Promise<{ text: string; prompt: string; inputTokens: number; outputTokens: number; totalTokens: number }> {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY env var is not set');

  const prompt = isAttribute
    ? buildAttributePrompt(text, sourceLang, targetLang, config)
    : buildPlaceholderPrompt(text, sourceLang, targetLang, config);

  const response = await fetch(`${GEMINI_BASE_URL}/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1 },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Gemini returned HTTP ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };

  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
  const totalTokens = data.usageMetadata?.totalTokenCount ?? (inputTokens + outputTokens);
  return {
    text: cleanResponse(raw, isAttribute),
    prompt,
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

/** Calls the Google Gemini API to translate plain-text code comments. */
async function callGeminiComment(
  text: string,
  sourceLang: string,
  targetLang: string,
  config: ProjectConfig,
  model: string,
): Promise<{ text: string; tokens: number }> {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY env var is not set');

  const lineCount = text.split('\n').length;
  const prompt = `Translate the following text from ${sourceLang} to ${targetLang}.\nKeep exactly ${lineCount} line${lineCount > 1 ? 's' : ''} in the output.\nReply with only the translated text, nothing else.\n\n${text}`;

  const response = await fetch(`${GEMINI_BASE_URL}/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1 },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Gemini returned HTTP ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { totalTokenCount?: number };
  };

  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const tokens = data.usageMetadata?.totalTokenCount ?? 0;
  return { text: raw.trim(), tokens };
}

// ─── JSON-LD ──────────────────────────────────────────────────────────────────

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

// ─── Development Debug Logging ──────────────────────────────────────────────────

let debugLogPath: string | null = null;

/**
 * Returns the path to the translation debug log file for the current CLI run.
 * Initialised once per run under data/logs/ if DEBUG_TRANSLATION_LOG=true.
 */
function getDebugLogPath(): string | null {
  if (process.env.DEBUG_TRANSLATION_LOG !== 'true') return null;
  if (!debugLogPath) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const logDir = path.join(process.cwd(), 'data', 'logs');
    fs.ensureDirSync(logDir);
    debugLogPath = path.join(logDir, `translation_debug_${dateStr}_${timeStr}.log`);
  }
  return debugLogPath;
}

interface DebugAttemptInput {
  projectSlug: string;
  pagePath: string;
  language: string;
  indexStr: string;
  fragmentId: string;
  model: string;
  attempt: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  status: 'SUCCESS' | 'INTEGRITY_FAILED' | 'ERROR';
  prompt: string;
  response: string;
  reason?: string;
}

/**
 * Appends a detailed attempt log for a single fragment translation.
 */
function writeDebugAttemptLog(input: DebugAttemptInput): void {
  const logPath = getDebugLogPath();
  if (!logPath) return;

  const reasonLine = input.reason ? `REASON: ${input.reason}\n` : '';
  const entry = `
================================================================================
PROJECT: ${input.projectSlug}
LANGUAGE: ${input.language}
PAGE PATH: ${input.pagePath}
FRAGMENT: ${input.indexStr}
FRAGMENT ID: ${input.fragmentId}
MODEL USED: ${input.model}
RETRY NUMBER: ${input.attempt}
STATUS: ${input.status}
${reasonLine}DURATION: ${input.durationMs}ms
TOKENS: Input: ${input.inputTokens} | Output: ${input.outputTokens} | Total: ${input.totalTokens}

--- PROMPT SENT ---
${input.prompt}

--- RESPONSE RECEIVED ---
${input.response}
================================================================================
`;
  fs.appendFileSync(logPath, entry, 'utf-8');
}

interface DebugPageSummaryInput {
  projectSlug: string;
  pagePath: string;
  language: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  retries: number;
  failedCount: number;
}

/**
 * Appends a summary log when a page translation completes.
 */
function writeDebugPageSummary(input: DebugPageSummaryInput): void {
  const logPath = getDebugLogPath();
  if (!logPath) return;

  const entry = `
################################################################################
######################### PAGE TRANSLATION COMPLETE ############################
################################################################################
PROJECT: ${input.projectSlug}
LANGUAGE: ${input.language}
PAGE PATH: ${input.pagePath}
MODEL USED: ${input.model}
TOTAL TIME TAKEN: ${input.durationMs}ms
TOTAL TOKENS: Input: ${input.inputTokens} | Output: ${input.outputTokens} | Total: ${input.totalTokens}
TOTAL RETRIES: ${input.retries}
FAILED FRAGMENTS (EXHAUSTED): ${input.failedCount}
################################################################################
################################################################################
`;
  fs.appendFileSync(logPath, entry, 'utf-8');
}
