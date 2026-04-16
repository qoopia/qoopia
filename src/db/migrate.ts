import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./connection.ts";
import { logger } from "../utils/logger.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

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
        db.prepare(
          `INSERT INTO schema_versions (version, description) VALUES (?, ?)`,
        ).run(version, file);
      })();
      logger.info(`Applied migration ${file}`);
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${err}`);
    }
  }
}
