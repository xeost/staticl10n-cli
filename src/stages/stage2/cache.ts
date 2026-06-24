import crypto from 'crypto';
import type { ProjectConfig } from '../../core/config.js';
import {
  dbGetCachedTranslation,
  dbInsertCacheEntry,
} from '../../core/db.js';
import { compareModelPriority } from '../../core/globalConfig.js';
import { logger } from '../../utils/logger.js';

// ─── Translation Cache ────────────────────────────────────────────────────────

/**
 * Computes the SHA-256 hash of a source fragment used as the cache key.
 */
export function hashFragment(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Checks the translation cache for a pre-existing translation.
 * Returns the cached translated text or null if not found.
 */
export function getCachedTranslation(
  projectId: number,
  sourceText: string,
  targetLanguage: string,
  config: ProjectConfig,
): string | null {
  const expiry = config.translation.cacheExpiry ?? -1;
  if (expiry === 0) return null; // cache disabled

  const hash = hashFragment(sourceText);
  const maxAge = expiry > 0 ? expiry : undefined;
  
  const row = dbGetCachedTranslation(projectId, hash, targetLanguage, maxAge);
  if (!row) return null;

  const currentModel = Array.isArray(config.translation.model)
    ? config.translation.model[0]
    : config.translation.model;

  const cachedModel = row.model;

  // If the current model is strictly superior to the cached model, we force a re-translation
  if (compareModelPriority(currentModel, cachedModel) > 0) {
    logger.debug(
      `Cache hit for "${sourceText.slice(0, 30)}..." but current model "${currentModel}" is superior to cached model "${cachedModel}". Forcing re-translation.`,
    );
    return null;
  }

  return row.translated_text;
}

/**
 * Stores a translation result in the cache.
 */
export function storeCachedTranslation(
  projectId: number,
  sourceText: string,
  targetLanguage: string,
  translatedText: string,
  model: string,
): void {
  const hash = hashFragment(sourceText);
  dbInsertCacheEntry(projectId, hash, sourceText, targetLanguage, translatedText, model);
}
