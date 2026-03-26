import { rawDb } from '../db/connection.js';
import { logger } from './logger.js';

// Archive activity records older than 90 days
export function archiveOldActivity(): number {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z/, 'Z');

  const insertResult = rawDb.prepare(`
    INSERT INTO activity_archive
    SELECT * FROM activity
    WHERE timestamp < ?
  `).run(cutoff);

  const moved = insertResult.changes;

  if (moved > 0) {
    rawDb.prepare(`
      DELETE FROM activity
      WHERE timestamp < ?
    `).run(cutoff);

    logger.info({ moved, cutoff }, 'Archived old activity records');
  }

  return moved;
}

// Purge expired idempotency keys
export function purgeExpiredIdempotencyKeys(): number {
  const now = new Date().toISOString().replace(/\.\d{3}Z/, 'Z');
  const result = rawDb.prepare(`
    DELETE FROM idempotency_keys
    WHERE expires_at < ?
  `).run(now);

  if (result.changes > 0) {
    logger.info({ purged: result.changes }, 'Purged expired idempotency keys');
  }

  return result.changes;
}

// Purge old dead letters (>30 days)
export function purgeOldDeadLetters(): number {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z/, 'Z');

  const result = rawDb.prepare(`
    DELETE FROM webhook_dead_letters
    WHERE created_at < ?
  `).run(cutoff);

  if (result.changes > 0) {
    logger.info({ purged: result.changes, cutoff }, 'Purged old dead letters');
  }

  return result.changes;
}

// Run all maintenance tasks
export function runMaintenance(): void {
  logger.info('Running scheduled maintenance...');
  const archived = archiveOldActivity();
  const keysCleared = purgeExpiredIdempotencyKeys();
  const deadLettersCleared = purgeOldDeadLetters();
  logger.info(
    { archived, keysCleared, deadLettersCleared },
    'Maintenance complete'
  );
}

let maintenanceInterval: ReturnType<typeof setInterval> | null = null;

// Schedule daily maintenance (runs every 24h, first run 1h after startup)
export function startMaintenanceSchedule(): void {
  // Run first maintenance 1 hour after startup
  const firstRunDelay = 60 * 60 * 1000; // 1 hour
  const dailyInterval = 24 * 60 * 60 * 1000; // 24 hours

  setTimeout(() => {
    runMaintenance();
    maintenanceInterval = setInterval(runMaintenance, dailyInterval);
  }, firstRunDelay);

  logger.info('Maintenance scheduled: first run in 1h, then every 24h');
}

export function stopMaintenanceSchedule(): void {
  if (maintenanceInterval) {
    clearInterval(maintenanceInterval);
    maintenanceInterval = null;
  }
}
