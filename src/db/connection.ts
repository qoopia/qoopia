import { Database } from "bun:sqlite";
import path from "node:path";
import { env } from "../utils/env.ts";
import { auditDirMode, ensureSafeDir } from "../utils/fs-perms.ts";

// QSEC-003: data, logs, backups all hold sensitive material — DB rows, audit
// logs with workspace/agent ids, backup .db files. All three must be 0700.
ensureSafeDir(env.DATA_DIR);
ensureSafeDir(env.LOG_DIR);
ensureSafeDir(env.BACKUP_DIR);
// Audit pre-existing installs in case dirs were created before this hardening
// (e.g., upgrades from earlier versions where LOG_DIR/BACKUP_DIR inherited umask).
auditDirMode(env.DATA_DIR);
auditDirMode(env.LOG_DIR);
auditDirMode(env.BACKUP_DIR);

export const DB_PATH = path.join(env.DATA_DIR, "qoopia.db");

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA foreign_keys = ON");

// Removed unsafe manual BEGIN/COMMIT runInTransaction.
// Use db.transaction(fn)() directly — it is Bun-native and handles nesting correctly.

export function closeDb() {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {}
  db.close();
}
