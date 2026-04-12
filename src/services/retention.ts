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
    db.exec("BEGIN");
    try {
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
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    report.task_bound_closed = closed.length;
    report.notes_purged = notesPurged;
    report.sessions_purged = sessionsPurged;
    report.messages_purged = messagesPurged;

    // 2. Idempotency keys
    const now = nowIso();
    const idemp = db
      .prepare(`DELETE FROM idempotency_keys WHERE expires_at < ?`)
      .run(now);
    report.idempotency_keys_deleted = idemp.changes;

    // 3. Old activity
    const activityDeleted = db
      .prepare(
        `DELETE FROM activity WHERE created_at < datetime('now', ?)`,
      )
      .run(`-${env.RETENTION_ACTIVITY_DAYS} days`);
    report.activity_deleted = activityDeleted.changes;

    // 4. Expired oauth codes + access tokens
    const oauthDeleted = db
      .prepare(
        `DELETE FROM oauth_tokens WHERE expires_at < ? AND token_type IN ('code','access')`,
      )
      .run(now);
    report.oauth_expired_deleted = oauthDeleted.changes;

    // 5. Backup
    const backupName = `qoopia-${new Date().toISOString().slice(0, 10)}.db`;
    const backupPath = path.join(env.BACKUP_DIR, backupName);
    try {
      fs.mkdirSync(env.BACKUP_DIR, { recursive: true });
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
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

export function startMaintenance() {
  // First run: 1 hour after start (per docs/20-to-be/01-schema.md)
  const firstRun = 60 * 60 * 1000;
  maintenanceTimer = setTimeout(() => {
    runMaintenance();
    scheduleDaily();
  }, firstRun);
  // Fire-and-forget: don't block event loop shutdown
  if (maintenanceTimer && typeof (maintenanceTimer as any).unref === "function") {
    (maintenanceTimer as any).unref();
  }
  logger.info(`Maintenance scheduled: first run in ${firstRun / 1000}s`);
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
