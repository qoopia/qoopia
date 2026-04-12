import { runMigrations } from "./db/migrate.ts";
import { closeDb } from "./db/connection.ts";
import { startMaintenance, stopMaintenance } from "./services/retention.ts";
import { startHttpServer } from "./http.ts";
import { logger } from "./utils/logger.ts";

runMigrations();
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
