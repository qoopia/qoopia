import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { env } from "../utils/env.ts";

fs.mkdirSync(env.DATA_DIR, { recursive: true });
fs.mkdirSync(env.LOG_DIR, { recursive: true });
fs.mkdirSync(env.BACKUP_DIR, { recursive: true });

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
