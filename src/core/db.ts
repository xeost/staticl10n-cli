import Database from 'better-sqlite3';
import fs from 'fs-extra';
import path from 'path';

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'staticl10n.db');

let db: Database.Database | null = null;

/** Returns the singleton SQLite database instance. */
export function getDb(): Database.Database {
  if (!db) {
    fs.ensureDirSync(DB_DIR);
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      slug       TEXT UNIQUE NOT NULL,
      name       TEXT NOT NULL,
      config_path TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pages (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id       INTEGER REFERENCES projects(id),
      url              TEXT NOT NULL,
      path             TEXT NOT NULL,
      status           TEXT DEFAULT 'pending',
      http_status      INTEGER,
      last_crawled_at  DATETIME,
      last_captured_at DATETIME,
      last_checked_at  DATETIME,
      has_changes      INTEGER DEFAULT 0,
      checksum         TEXT,
      UNIQUE(project_id, url)
    );

    CREATE TABLE IF NOT EXISTS page_translations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id         INTEGER REFERENCES pages(id),
      language        TEXT NOT NULL,
      status          TEXT DEFAULT 'pending',
      translated_at   DATETIME,
      source_checksum TEXT,
      UNIQUE(page_id, language)
    );

    CREATE TABLE IF NOT EXISTS translation_cache (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id       INTEGER REFERENCES projects(id),
      source_hash      TEXT NOT NULL,
      source_text      TEXT NOT NULL,
      target_language  TEXT NOT NULL,
      translated_text  TEXT NOT NULL,
      model            TEXT NOT NULL,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, source_hash, target_language)
    );

    CREATE TABLE IF NOT EXISTS stage_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER REFERENCES projects(id),
      stage       INTEGER NOT NULL,
      status      TEXT NOT NULL,
      started_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME,
      details     TEXT
    );

    CREATE TABLE IF NOT EXISTS change_detections (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id      INTEGER REFERENCES pages(id),
      detected_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      old_checksum TEXT,
      new_checksum TEXT,
      status       TEXT DEFAULT 'pending'
    );
  `);
}

// ─── Projects ────────────────────────────────────────────────────────────────

export interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  config_path: string;
  created_at: string;
  updated_at: string;
}

export function dbInsertProject(slug: string, name: string, configPath: string): number {
  const stmt = getDb().prepare(
    `INSERT INTO projects (slug, name, config_path) VALUES (?, ?, ?)`,
  );
  const result = stmt.run(slug, name, configPath);
  return result.lastInsertRowid as number;
}

export function dbGetProjectBySlug(slug: string): ProjectRow | undefined {
  return getDb().prepare(`SELECT * FROM projects WHERE slug = ?`).get(slug) as
    | ProjectRow
    | undefined;
}

export function dbListProjects(): ProjectRow[] {
  return getDb().prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all() as ProjectRow[];
}

export function dbDeleteProject(slug: string): void {
  const project = dbGetProjectBySlug(slug);
  if (!project) return;
  const db = getDb();
  // Cascade delete related records
  const pageIds = (
    db.prepare(`SELECT id FROM pages WHERE project_id = ?`).all(project.id) as { id: number }[]
  ).map((r) => r.id);

  if (pageIds.length > 0) {
    const placeholders = pageIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM page_translations WHERE page_id IN (${placeholders})`).run(...pageIds);
    db.prepare(`DELETE FROM change_detections WHERE page_id IN (${placeholders})`).run(...pageIds);
  }

  db.prepare(`DELETE FROM pages WHERE project_id = ?`).run(project.id);
  db.prepare(`DELETE FROM translation_cache WHERE project_id = ?`).run(project.id);
  db.prepare(`DELETE FROM stage_runs WHERE project_id = ?`).run(project.id);
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(project.id);
}

// ─── Pages ───────────────────────────────────────────────────────────────────

export interface PageRow {
  id: number;
  project_id: number;
  url: string;
  path: string;
  status: string;
  http_status: number | null;
  last_crawled_at: string | null;
  last_captured_at: string | null;
  last_checked_at: string | null;
  has_changes: number;
  checksum: string | null;
}

export function dbUpsertPage(
  projectId: number,
  url: string,
  pagePath: string,
  status: string,
  httpStatus?: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO pages (project_id, url, path, status, http_status, last_crawled_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(project_id, url) DO UPDATE SET
         status = excluded.status,
         http_status = excluded.http_status,
         last_crawled_at = CURRENT_TIMESTAMP`,
    )
    .run(projectId, url, pagePath, status, httpStatus ?? null);
}

/** Inserts a page only if it does not already exist (no-op on conflict). */
export function dbInsertPageIfNew(
  projectId: number,
  url: string,
  pagePath: string,
  status: string,
  httpStatus?: number,
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO pages (project_id, url, path, status, http_status, last_crawled_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    )
    .run(projectId, url, pagePath, status, httpStatus ?? null);
}

/** Deletes all pages (and related records) for a project. Used to reset a crawl from scratch. */
export function dbDeletePagesByProject(projectId: number): void {
  const database = getDb();
  const pageIds = (
    database.prepare(`SELECT id FROM pages WHERE project_id = ?`).all(projectId) as { id: number }[]
  ).map((r) => r.id);

  if (pageIds.length > 0) {
    const placeholders = pageIds.map(() => '?').join(',');
    database.prepare(`DELETE FROM page_translations WHERE page_id IN (${placeholders})`).run(...pageIds);
    database.prepare(`DELETE FROM change_detections WHERE page_id IN (${placeholders})`).run(...pageIds);
  }

  database.prepare(`DELETE FROM pages WHERE project_id = ?`).run(projectId);
}

export function dbUpdatePageStatus(
  pageId: number,
  status: string,
  checksum?: string,
): void {
  if (checksum !== undefined) {
    getDb()
      .prepare(
        `UPDATE pages SET status = ?, checksum = ?, last_captured_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(status, checksum, pageId);
  } else {
    getDb()
      .prepare(`UPDATE pages SET status = ?, last_captured_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(status, pageId);
  }
}

export function dbGetPagesByProject(projectId: number, status?: string | string[]): PageRow[] {
  if (status) {
    const statuses = Array.isArray(status) ? status : [status];
    const placeholders = statuses.map(() => '?').join(', ');
    return getDb()
      .prepare(`SELECT * FROM pages WHERE project_id = ? AND status IN (${placeholders})`)
      .all(projectId, ...statuses) as PageRow[];
  }
  return getDb()
    .prepare(`SELECT * FROM pages WHERE project_id = ?`)
    .all(projectId) as PageRow[];
}

export function dbGetPageByUrl(projectId: number, url: string): PageRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM pages WHERE project_id = ? AND url = ?`)
    .get(projectId, url) as PageRow | undefined;
}

export function dbGetPageById(pageId: number): PageRow | undefined {
  return getDb().prepare(`SELECT * FROM pages WHERE id = ?`).get(pageId) as PageRow | undefined;
}

// ─── Page Translations ────────────────────────────────────────────────────────

export interface PageTranslationRow {
  id: number;
  page_id: number;
  language: string;
  status: string;
  translated_at: string | null;
  source_checksum: string | null;
}

export function dbUpsertPageTranslation(
  pageId: number,
  language: string,
  status: string,
  sourceChecksum?: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO page_translations (page_id, language, status, source_checksum, translated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(page_id, language) DO UPDATE SET
         status = excluded.status,
         source_checksum = excluded.source_checksum,
         translated_at = CURRENT_TIMESTAMP`,
    )
    .run(pageId, language, status, sourceChecksum ?? null);
}

export function dbGetTranslationsByPage(pageId: number): PageTranslationRow[] {
  return getDb()
    .prepare(`SELECT * FROM page_translations WHERE page_id = ?`)
    .all(pageId) as PageTranslationRow[];
}

// ─── Translation Cache ────────────────────────────────────────────────────────

export interface CacheRow {
  source_hash: string;
  translated_text: string;
  model: string;
}

export function dbGetCachedTranslation(
  projectId: number,
  sourceHash: string,
  targetLanguage: string,
  model: string,
  maxAgeSeconds?: number,
): CacheRow | undefined {
  if (maxAgeSeconds !== undefined) {
    return getDb()
      .prepare(
        `SELECT source_hash, translated_text, model FROM translation_cache
         WHERE project_id = ? AND source_hash = ? AND target_language = ? AND model = ?
           AND created_at > datetime('now', '-' || ? || ' seconds')`,
      )
      .get(projectId, sourceHash, targetLanguage, model, maxAgeSeconds) as CacheRow | undefined;
  }
  return getDb()
    .prepare(
      `SELECT source_hash, translated_text, model FROM translation_cache
       WHERE project_id = ? AND source_hash = ? AND target_language = ? AND model = ?`,
    )
    .get(projectId, sourceHash, targetLanguage, model) as CacheRow | undefined;
}

export function dbInsertCacheEntry(
  projectId: number,
  sourceHash: string,
  sourceText: string,
  targetLanguage: string,
  translatedText: string,
  model: string,
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO translation_cache
       (project_id, source_hash, source_text, target_language, translated_text, model)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(projectId, sourceHash, sourceText, targetLanguage, translatedText, model);
}

export function dbPurgeTranslationCache(projectId: number): number {
  const result = getDb()
    .prepare(`DELETE FROM translation_cache WHERE project_id = ?`)
    .run(projectId);
  return result.changes;
}

export function dbPurgeAllTranslationCaches(): number {
  const result = getDb()
    .prepare(`DELETE FROM translation_cache`)
    .run();
  return result.changes;
}

/** Deletes only the code-block cache entries (source_text starts with <pre) for a project. */
export function dbPurgeCodeBlockTranslationCache(projectId: number): number {
  const result = getDb()
    .prepare(`DELETE FROM translation_cache WHERE project_id = ? AND source_text LIKE '<pre%'`)
    .run(projectId);
  return result.changes;
}

export function dbGetCacheStats(projectId: number): { total: number } {
  const row = getDb()
    .prepare(`SELECT COUNT(*) as total FROM translation_cache WHERE project_id = ?`)
    .get(projectId) as { total: number };
  return row;
}

// ─── Stage Runs ───────────────────────────────────────────────────────────────

export function dbStartStageRun(projectId: number, stage: number): number {
  const result = getDb()
    .prepare(
      `INSERT INTO stage_runs (project_id, stage, status) VALUES (?, ?, 'running')`,
    )
    .run(projectId, stage);
  return result.lastInsertRowid as number;
}

export function dbFinishStageRun(
  runId: number,
  status: 'completed' | 'failed',
  details?: Record<string, unknown>,
): void {
  getDb()
    .prepare(
      `UPDATE stage_runs SET status = ?, finished_at = CURRENT_TIMESTAMP, details = ? WHERE id = ?`,
    )
    .run(status, details ? JSON.stringify(details) : null, runId);
}

// ─── Change Detections ────────────────────────────────────────────────────────

export function dbInsertChangeDetection(
  pageId: number,
  oldChecksum: string,
  newChecksum: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO change_detections (page_id, old_checksum, new_checksum)
       VALUES (?, ?, ?)`,
    )
    .run(pageId, oldChecksum, newChecksum);
  getDb()
    .prepare(`UPDATE pages SET has_changes = 1, last_checked_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(pageId);
}

export function dbGetPendingChanges(projectId: number): Array<{ page: PageRow; detection_id: number; detected_at: string }> {
  return getDb()
    .prepare(
      `SELECT p.*, cd.id as detection_id, cd.detected_at
       FROM change_detections cd
       JOIN pages p ON p.id = cd.page_id
       WHERE p.project_id = ? AND cd.status = 'pending'
       ORDER BY cd.detected_at DESC`,
    )
    .all(projectId) as Array<{ page: PageRow; detection_id: number; detected_at: string }>;
}

export function dbMarkChangeStatus(
  detectionId: number,
  status: 'ignored' | 're-translated',
): void {
  getDb()
    .prepare(`UPDATE change_detections SET status = ? WHERE id = ?`)
    .run(status, detectionId);
}
