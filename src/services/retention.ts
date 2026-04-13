import fs from "node:fs";
import path from "node:path";
import { db } from "../db/connection.ts";
import { env } from "../utils/env.ts";
import { logger } from "../utils/logger.ts";
import { nowIso } from "../utils/errors.ts";

/**
 * Daily maintenance job:
 *  1. Task-bound purge (notes/sessions/messages bound to closed tasks > 1h old)
 *  2. Expired idempotency keys
 *  3. Old activity (> N days)
 *  4. Expired oauth codes/access tokens
 *  5. Daily backup via VACUUM INTO
 *  6. Rotate backups (keep N latest)
 */

export function runMaintenance(): { ok: boolean; report: Record<string, unknown> } {
  const report: Record<string, unknown> = { started_at: nowIso() };
  try {
    // 1. Task-bound purge
    const closed = db
      .prepare(
        `SELECT id FROM notes
         WHERE type = 'task'
           AND deleted_at IS NULL
           AND json_extract(metadata, '$.status') IN ('done', 'cancelled')
           AND datetime(updated_at) <= datetime('now', '-1 hour')`,
      )
      .all() as Array<{ id: string }>;

    let notesPurged = 0;
    let sessionsPurged = 0;
    let messagesPurged = 0;
    // Use db.transaction() (Bun-native) instead of manual BEGIN/COMMIT
    const purgeTaskBound = db.transaction(() => {
      for (const t of closed) {
        const delNotes = db
          .prepare(`DELETE FROM notes WHERE task_bound_id = ?`)
          .run(t.id);
        notesPurged += delNotes.changes;

        const sessIds = db
          .prepare(`SELECT id FROM sessions WHERE task_bound_id = ?`)
          .all(t.id) as Array<{ id: string }>;
        for (const s of sessIds) {
          const delMsgs = db
            .prepare(`DELETE FROM session_messages WHERE session_id = ?`)
            .run(s.id);
          messagesPurged += delMsgs.changes;
          db.prepare(`DELETE FROM summaries WHERE session_id = ?`).run(s.id);
        }
        const delSess = db
          .prepare(`DELETE FROM sessions WHERE task_bound_id = ?`)
          .run(t.id);
        sessionsPurged += delSess.changes;
      }
    });
    purgeTaskBound();
    report.task_bound_closed = closed.length;
    report.notes_purged = notesPurged;
    report.sessions_purged = sessionsPurged;
    report.messages_purged = messagesPurged;

    // 2. Idempotency keys
    // H3 fix: normalize both sides to datetime() to avoid ISO-8601 vs SQLite format mismatch
    const idemp = db
      .prepare(`DELETE FROM idempotency_keys WHERE datetime(expires_at) < datetime('now')`)
      .run();
    report.idempotency_keys_deleted = idemp.changes;

    // 3. Old activity — use datetime() on both sides for consistent comparison
    const activityDeleted = db
      .prepare(
        `DELETE FROM activity WHERE datetime(created_at) < datetime('now', ?)`,
      )
      .run(`-${env.RETENTION_ACTIVITY_DAYS} days`);
    report.activity_deleted = activityDeleted.changes;

    // 4. Expired oauth tokens (codes, access, AND refresh) + revoked tokens older than 7 days
    // H3 fix: normalize expires_at comparison via datetime()
    const oauthExpired = db
      .prepare(`DELETE FROM oauth_tokens WHERE datetime(expires_at) < datetime('now')`)
      .run();
    const oauthRevoked = db
      .prepare(
        `DELETE FROM oauth_tokens WHERE revoked = 1 AND datetime(created_at) < datetime('now', '-7 days')`,
      )
      .run();
    report.oauth_expired_deleted = oauthExpired.changes;
    report.oauth_revoked_deleted = oauthRevoked.changes;

    // 5. Backup
    const backupName = `qoopia-${new Date().toISOString().slice(0, 10)}.db`;
    const backupPath = path.join(env.BACKUP_DIR, backupName);
    try {
      fs.mkdirSync(env.BACKUP_DIR, { recursive: true });
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      db.prepare(`VACUUM INTO ?`).run(backupPath);
      report.backup = backupPath;

      // 6. Rotate
      const backups = fs
        .readdirSync(env.BACKUP_DIR)
        .filter((f) => /^qoopia-\d{4}-\d{2}-\d{2}\.db$/.test(f))
        .sort()
        .reverse();
      const toDelete = backups.slice(env.BACKUP_KEEP);
      for (const b of toDelete) {
        try {
          fs.unlinkSync(path.join(env.BACKUP_DIR, b));
        } catch {}
      }
      report.backups_kept = Math.min(backups.length, env.BACKUP_KEEP);
      report.backups_deleted = toDelete.length;
    } catch (e) {
      logger.error("Backup failed", { error: String(e) });
      report.backup_error = String(e);
    }

    report.ok = true;
    report.finished_at = nowIso();
    logger.info("Maintenance complete", report);
    return { ok: true, report };
  } catch (err) {
    logger.error("Maintenance failed", { error: String(err) });
    report.ok = false;
    report.error = String(err);
    return { ok: false, report };
  }
}

let maintenanceTimer: ReturnType<typeof setTimeout> | null = null;

function msUntilNextMaintenance(): number {
  const next = new Date();
  next.setHours(env.MAINTENANCE_HOUR, 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next.getTime() - Date.now();
}

// Minimum grace period after boot before triggering maintenance (5 minutes).
// Prevents hammering the DB on rapid restarts while still respecting the window.
const BOOT_GRACE_MS = 5 * 60 * 1000;

export function startMaintenance() {
  // Schedule the first run at the next configured maintenance window (MAINTENANCE_HOUR:00),
  // but never sooner than BOOT_GRACE_MS from now. This prevents repeated restarts from
  // postponing cleanup indefinitely (the old "1 hour from boot" approach had that problem).
  const msToWindow = msUntilNextMaintenance();
  const firstRun = Math.max(msToWindow, BOOT_GRACE_MS);

  maintenanceTimer = setTimeout(() => {
    runMaintenance();
    scheduleDaily();
  }, firstRun);
  // Fire-and-forget: don't block event loop shutdown
  if (maintenanceTimer && typeof (maintenanceTimer as any).unref === "function") {
    (maintenanceTimer as any).unref();
  }
  const hoursUntil = Math.round(firstRun / 1000 / 60);
  logger.info(`Maintenance scheduled: first run in ~${hoursUntil}m (window=${env.MAINTENANCE_HOUR}:00)`);
}

function scheduleDaily() {
  const ms = msUntilNextMaintenance();
  maintenanceTimer = setTimeout(() => {
    runMaintenance();
    scheduleDaily();
  }, ms);
  if (maintenanceTimer && typeof (maintenanceTimer as any).unref === "function") {
    (maintenanceTimer as any).unref();
  }
}

export function stopMaintenance() {
  if (maintenanceTimer) {
    clearTimeout(maintenanceTimer);
    maintenanceTimer = null;
  }
}
