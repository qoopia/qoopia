import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { logger } from '../core/logger.js';
import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = process.env.QOOPIA_DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = process.env.QOOPIA_DB_PATH || path.join(DATA_DIR, 'qoopia.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);

// SQLite Pragmas (spec §3)
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 10000');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('cache_size = -64000');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('journal_size_limit = 67108864');
sqlite.pragma('wal_autocheckpoint = 1000');

logger.info({ db: DB_PATH }, 'SQLite connected with WAL mode');

export const db = drizzle(sqlite, { schema });
export const rawDb: DatabaseType = sqlite;
