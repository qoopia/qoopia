import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./connection.ts";
import { logger } from "../utils/logger.ts";
import { env } from "../utils/env.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

/**
 * QSA-D / Codex QSA-003: list pending migrations without applying them.
 * The startup gate uses this to decide whether to refuse boot or to
 * proceed (with backup) under QOOPIA_AUTO_MIGRATE=true.
 *
 * Returns the migration filenames (e.g. "009-activity-fts.sql") that
 * exist on disk but have not yet been recorded in schema_versions.
 * Reads only the schema_versions table; safe on a fresh DB (creates
 * the table first) and idempotent.
 */
export function getPendingMigrations(): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`);

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const pending: string[] = [];
  for (const file of files) {
    const match = file.match(/^(\d+)/);
    if (!match) continue;
    const version = parseInt(match[1]!, 10);
    const applied = db
      .prepare("SELECT 1 FROM schema_versions WHERE version = ?")
      .get(version);
    if (!applied) pending.push(file);
  }
  return pending;
}

/**
 * QSA-D: take a hard-link / file-copy backup of the live SQLite DB into
 * BACKUP_DIR before applying migrations. The backup file name encodes
 * the UTC timestamp and the list of pending migrations so an operator
 * can restore it back-to-back if a migration goes wrong.
 *
 * Uses VACUUM INTO so the backup is a clean, consistent copy even if
 * other connections are mid-write. Returns the absolute backup path.
 *
 * Safe to call on an empty DB (still produces a snapshot file). Throws
 * if the backup cannot be written (e.g. disk full, perms) so the caller
 * can refuse to proceed with the migration.
 */
export function backupDbBeforeMigrate(pending: string[]): string {
  fs.mkdirSync(env.BACKUP_DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tag = pending
    .map((f) => f.replace(/\.sql$/, ""))
    .slice(0, 3)
    .join("_");
  const filename = `pre-migrate-${stamp}-${tag || "none"}.db`;
  const target = path.join(env.BACKUP_DIR, filename);

  // VACUUM INTO writes a fresh, consistent SQLite file at `target`.
  // SQLite quoting: single-quote and escape any embedded single quotes.
  const escaped = target.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  // Tighten perms; backups can contain sensitive note text and tokens.
  try {
    fs.chmodSync(target, 0o600);
  } catch (err) {
    // Don't leave a 0644 backup lying around — delete it and re-throw
    // so the caller refuses migrate.
    try {
      fs.unlinkSync(target);
    } catch {
      /* ignore */
    }
    throw new Error(
      `Failed to chmod backup ${target} to 0600: ${err}. Aborting migrate.`,
    );
  }
  logger.info(`Pre-migrate backup written to ${target}`);
  return target;
}

export function runMigrations() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`);

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const match = file.match(/^(\d+)/);
    if (!match) continue;
    const version = parseInt(match[1]!, 10);
    const applied = db
      .prepare("SELECT 1 FROM schema_versions WHERE version = ?")
      .get(version);
    if (applied) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    try {
      db.transaction(() => {
        db.exec(sql);
        // INSERT OR IGNORE: некоторые исторические migration-файлы (001) содержат
        // собственный INSERT INTO schema_versions. Wrapper не должен падать на
        // UNIQUE constraint, если запись уже существует — свежая установка иначе
        // зацикливается и БД неюзабельна.
        db.prepare(
          `INSERT OR IGNORE INTO schema_versions (version, description) VALUES (?, ?)`,
        ).run(version, file);
      })();
      logger.info(`Applied migration ${file}`);
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${err}`);
    }
  }
}
