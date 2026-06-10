import {
  dbGetPendingChanges,
  dbGetProjectBySlug,
  dbMarkChangeStatus,
} from '../../core/db.js';
import { logger } from '../../utils/logger.js';

// ─── Change Reporter ──────────────────────────────────────────────────────────

export interface ChangeEntry {
  detectionId: number;
  url: string;
  detectedAt: string;
  pageId: number;
}

/**
 * Returns all pages with pending (unacknowledged) changes for a project.
 */
export function getPendingChanges(projectSlug: string): ChangeEntry[] {
  const project = dbGetProjectBySlug(projectSlug);
  if (!project) throw new Error(`Project "${projectSlug}" not found`);

  const rows = dbGetPendingChanges(project.id);

  return rows.map((row) => ({
    detectionId: row.detection_id,
    url: row.page.url,
    detectedAt: row.detected_at,
    pageId: row.page.id,
  }));
}

/**
 * Marks a detected change as ignored.
 */
export function ignoreChange(detectionId: number): void {
  dbMarkChangeStatus(detectionId, 'ignored');
  logger.info(`Change ${detectionId} marked as ignored.`);
}

/**
 * Marks a detected change as re-translated.
 */
export function markReTranslated(detectionId: number): void {
  dbMarkChangeStatus(detectionId, 're-translated');
}

/**
 * Writes a non-interactive change report to stdout (for cron use).
 */
export function printChangeReport(projectSlug: string): void {
  const changes = getPendingChanges(projectSlug);

  if (changes.length === 0) {
    logger.info(`[${projectSlug}] No pending changes detected.`);
    return;
  }

  logger.info(`[${projectSlug}] ${changes.length} page(s) with detected changes:`);
  for (const change of changes) {
    logger.plain(
      `  - [${change.detectedAt}] ${change.url} (detection #${change.detectionId})`,
    );
  }
}
