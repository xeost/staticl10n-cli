import Database from 'better-sqlite3';
import { exec } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { promisify } from 'util';
import { readGlobalConfig } from './globalConfig.js';

const execAsync = promisify(exec);

const DB_DIR = path.join(process.cwd(), 'data', 'db');
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

/** Returns the URLs of all pages that have been successfully translated for a given language. */
export function dbGetTranslatedPageUrls(projectId: number, language: string): string[] {
  return (
    getDb()
      .prepare(
        `SELECT p.url FROM pages p
         JOIN page_translations pt ON pt.page_id = p.id
         WHERE p.project_id = ? AND pt.language = ? AND pt.status = 'translated'`,
      )
      .all(projectId, language) as { url: string }[]
  ).map((r) => r.url);
}

/** Returns the URL and path of all pages that have been successfully translated for a given language. */
export function dbGetTranslatedPages(projectId: number, language: string): { url: string; path: string }[] {
  return getDb()
    .prepare(
      `SELECT p.url, p.path FROM pages p
       JOIN page_translations pt ON pt.page_id = p.id
       WHERE p.project_id = ? AND pt.language = ? AND pt.status = 'translated'`,
    )
    .all(projectId, language) as { url: string; path: string }[];
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
  maxAgeSeconds?: number,
): CacheRow | undefined {
  if (maxAgeSeconds !== undefined) {
    return getDb()
      .prepare(
        `SELECT source_hash, translated_text, model FROM translation_cache
         WHERE project_id = ? AND source_hash = ? AND target_language = ?
           AND created_at > datetime('now', '-' || ? || ' seconds')`,
      )
      .get(projectId, sourceHash, targetLanguage, maxAgeSeconds) as CacheRow | undefined;
  }
  return getDb()
    .prepare(
      `SELECT source_hash, translated_text, model FROM translation_cache
       WHERE project_id = ? AND source_hash = ? AND target_language = ?`,
    )
    .get(projectId, sourceHash, targetLanguage) as CacheRow | undefined;
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

export interface BackupResult {
  hourly: { path: string; created: boolean } | null;
  daily: { path: string; created: boolean } | null;
  weekly: { path: string; created: boolean } | null;
  monthly: { path: string; created: boolean } | null;
}

function getISOWeekString(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  const weekStr = String(weekNo).padStart(2, '0');
  return `${d.getUTCFullYear()}-W${weekStr}`;
}

function cleanRetention(directory: string, limit: number): void {
  if (limit <= 0) return;
  if (!fs.existsSync(directory)) return;

  const files = fs.readdirSync(directory)
    .filter(f => f.startsWith('staticl10n-backup-') && f.endsWith('.zip'))
    .sort();

  if (files.length > limit) {
    const toDelete = files.slice(0, files.length - limit);
    for (const file of toDelete) {
      const filePath = path.join(directory, file);
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Backs up the database to the specified directory using the native sqlite3 CLI tool.
 * Implements a tiered structure (hourly, daily, weekly, monthly) with retention policies.
 */
export async function dbBackup(backupDir: string): Promise<BackupResult> {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const weekStr = getISOWeekString(now);

  const hourlyDir = path.join(backupDir, 'hourly');
  const dailyDir = path.join(backupDir, 'daily');
  const weeklyDir = path.join(backupDir, 'weekly');
  const monthlyDir = path.join(backupDir, 'monthly');

  // Ensure target backup directories exist
  fs.ensureDirSync(hourlyDir);
  fs.ensureDirSync(dailyDir);
  fs.ensureDirSync(weeklyDir);
  fs.ensureDirSync(monthlyDir);

  const hourlyFilename = `staticl10n-backup-${yyyy}-${mm}-${dd}-${hh}.zip`;
  const hourlyZipPath = path.join(hourlyDir, hourlyFilename);

  const result: BackupResult = {
    hourly: null,
    daily: null,
    weekly: null,
    monthly: null,
  };

  // 1. Hourly tier
  if (!fs.existsSync(hourlyZipPath)) {
    const tempDbFilename = `staticl10n-backup-${yyyy}-${mm}-${dd}-${hh}.db`;
    const tempDbPath = path.join(hourlyDir, tempDbFilename);

    const command = `sqlite3 "${DB_PATH}" ".backup '${tempDbPath}'"`;
    try {
      await execAsync(command);
    } catch (error) {
      throw new Error(
        `Failed to run native sqlite3 backup. Please ensure the 'sqlite3' CLI tool is installed on your system. Details: ${(error as Error).message}`
      );
    }

    const zipCommand = `zip -j "${hourlyZipPath}" "${tempDbPath}"`;
    try {
      await execAsync(zipCommand);
      await fs.unlink(tempDbPath);
      result.hourly = { path: hourlyZipPath, created: true };
    } catch (error) {
      if (fs.existsSync(tempDbPath)) {
        try {
          await fs.unlink(tempDbPath);
        } catch {
          // ignore
        }
      }
      throw new Error(
        `Failed to compress backup into a ZIP file. Please ensure the 'zip' CLI tool is installed on your system. Details: ${(error as Error).message}`
      );
    }
  } else {
    result.hourly = { path: hourlyZipPath, created: false };
  }

  // 2. Daily tier
  const dailyFilename = `staticl10n-backup-${yyyy}-${mm}-${dd}.zip`;
  const dailyZipPath = path.join(dailyDir, dailyFilename);
  if (!fs.existsSync(dailyZipPath)) {
    try {
      fs.copyFileSync(hourlyZipPath, dailyZipPath);
      result.daily = { path: dailyZipPath, created: true };
    } catch (error) {
      throw new Error(`Failed to copy daily backup: ${(error as Error).message}`);
    }
  } else {
    result.daily = { path: dailyZipPath, created: false };
  }

  // 3. Weekly tier
  const weeklyFilename = `staticl10n-backup-${weekStr}.zip`;
  const weeklyZipPath = path.join(weeklyDir, weeklyFilename);
  if (!fs.existsSync(weeklyZipPath)) {
    try {
      fs.copyFileSync(hourlyZipPath, weeklyZipPath);
      result.weekly = { path: weeklyZipPath, created: true };
    } catch (error) {
      throw new Error(`Failed to copy weekly backup: ${(error as Error).message}`);
    }
  } else {
    result.weekly = { path: weeklyZipPath, created: false };
  }

  // 4. Monthly tier
  const monthlyFilename = `staticl10n-backup-${yyyy}-${mm}.zip`;
  const monthlyZipPath = path.join(monthlyDir, monthlyFilename);
  if (!fs.existsSync(monthlyZipPath)) {
    try {
      fs.copyFileSync(hourlyZipPath, monthlyZipPath);
      result.monthly = { path: monthlyZipPath, created: true };
    } catch (error) {
      throw new Error(`Failed to copy monthly backup: ${(error as Error).message}`);
    }
  } else {
    result.monthly = { path: monthlyZipPath, created: false };
  }

  // 5. Clean retention
  const globalConfig = readGlobalConfig();
  const retention = globalConfig.backup_retention;

  cleanRetention(hourlyDir, retention.hourly);
  cleanRetention(dailyDir, retention.daily);
  cleanRetention(weeklyDir, retention.weekly);
  cleanRetention(monthlyDir, retention.monthly);

  return result;
}
