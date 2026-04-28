import {
  backupDbBeforeMigrate,
  getPendingMigrations,
  runMigrations,
} from "./db/migrate.ts";
import { closeDb } from "./db/connection.ts";
import { startMaintenance, stopMaintenance } from "./services/retention.ts";
import { startHttpServer } from "./http.ts";
import { logger } from "./utils/logger.ts";

// QSA-D / Codex QSA-003 (2026-04-28): production startup must not silently
// apply pending migrations. Two reasons:
//   1) A bad migration mutates prod schema/data before any operator-approved
//      backup snapshot is taken. Recovery becomes painful.
//   2) An accidental restart during partial deployment may apply migrations
//      from a half-deployed code revision, leaving an inconsistent state.
//
// Behavior:
//   - On boot, list pending migrations.
//   - If none → proceed (no-op).
//   - If pending and QOOPIA_AUTO_MIGRATE=true → take VACUUM INTO backup
//     into BACKUP_DIR with chmod 0600, then apply migrations.
//   - If pending and QOOPIA_AUTO_MIGRATE!=true → log clearly and exit 1.
//
// The standalone command `bun run migrate` (scripts/migrate.ts) sets
// QOOPIA_AUTO_MIGRATE=true internally so an operator can run migrations
// explicitly outside the service boot path.
const pending = getPendingMigrations();
if (pending.length > 0) {
  const autoMigrate = (process.env.QOOPIA_AUTO_MIGRATE ?? "false") === "true";
  if (!autoMigrate) {
    logger.error(
      `Refusing to start: ${pending.length} pending migration(s): ${pending.join(", ")}`,
    );
    logger.error(
      "Run `bun run migrate` to apply them with a pre-migrate backup, or " +
        "set QOOPIA_AUTO_MIGRATE=true in the environment if you have " +
        "already taken a backup yourself.",
    );
    process.exit(1);
  }
  const backupPath = backupDbBeforeMigrate(pending);
  logger.info(
    `QOOPIA_AUTO_MIGRATE=true; applied pre-migrate backup at ${backupPath}, proceeding`,
  );
  runMigrations();
}

startMaintenance();
const server = startHttpServer();

function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down...`);
  stopMaintenance();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Fallback in case close hangs
  setTimeout(() => {
    closeDb();
    process.exit(0);
  }, 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
