import crypto from 'crypto';
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
): string | null {
  const hash = hashFragment(sourceText);
  const row = dbGetCachedTranslation(projectId, hash, targetLanguage);
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
