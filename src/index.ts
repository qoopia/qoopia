import { serve } from '@hono/node-server';
import { logger } from './core/logger.js';
import { runMigrations } from './db/migrate.js';
import { rawDb } from './db/connection.js';
import api from './api/router.js';

// Run migrations on startup
runMigrations();

const PORT = parseInt(process.env.PORT || '3000');

const server = serve({
  fetch: api.fetch,
  port: PORT,
}, (info) => {
  logger.info({ port: info.port }, `Qoopia V2 listening on port ${info.port}`);
});

// Graceful shutdown
function shutdown() {
  logger.info('Shutting down...');
  server.close(() => {
    rawDb.pragma('wal_checkpoint(TRUNCATE)');
    rawDb.close();
    logger.info('Database closed. Goodbye.');
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
