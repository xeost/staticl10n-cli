import crypto from 'crypto';
import type { ProjectConfig } from '../../core/config.js';
import {
  dbGetCachedTranslation,
  dbInsertCacheEntry,
} from '../../core/db.js';

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
  const row = dbGetCachedTranslation(projectId, hash, targetLanguage, config.translation.model, maxAge);
  return row?.translated_text ?? null;
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
