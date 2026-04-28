#!/usr/bin/env bun
/**
 * archive-stale.ts — weekly lifecycle cron.
 *
 * Sweeps three classes of stale rows and flips metadata.status='archived':
 *   1. Tasks done > 30 days ago (where metadata.status='done').
 *   2. Memory notes (type='memory') with updated_at > 90 days ago.
 *   3. Context notes (type='context') with updated_at > 30 days ago.
 *
 * Archived rows stay queryable for audit (include_archived=true) but
 * disappear from default list/recall results so dashboards stop drowning
 * in stale state.
 *
 * Idempotent: re-running is safe — already-archived rows are skipped via
 * the `metadata.status != 'archived'` predicate.
 *
 * Triggered by launchd template `com.qoopia.archive-stale.plist` weekly
 * on Sunday 03:00 local time. Also runnable ad-hoc:
 *   bun run scripts/archive-stale.ts            # apply
 *   bun run scripts/archive-stale.ts --dry-run  # report what would change
 */
import { db } from "../src/db/connection.ts";
import { logger } from "../src/utils/logger.ts";

interface SweepRule {
  label: string;
  // SQL predicate that finds CANDIDATES for archiving. Should NOT include
  // the deleted_at / already-archived guards — those are added by the
  // wrapper below.
  candidateSql: string;
  candidateParams: unknown[];
}

const NOW = new Date();
function isoDaysAgo(days: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const rules: SweepRule[] = [
  {
    label: "tasks done > 30d",
    candidateSql: `
      type = 'task'
      AND json_extract(metadata, '$.status') = 'done'
      AND updated_at < ?
    `,
    candidateParams: [isoDaysAgo(30)],
  },
  {
    label: "memory notes updated > 90d",
    candidateSql: `
      type = 'memory'
      AND updated_at < ?
    `,
    candidateParams: [isoDaysAgo(90)],
  },
  {
    label: "context notes updated > 30d",
    candidateSql: `
      type = 'context'
      AND updated_at < ?
    `,
    candidateParams: [isoDaysAgo(30)],
  },
];

interface SweepReport {
  label: string;
  matched: number;
  archived: number;
  ids: string[];
}

function sweep(rule: SweepRule, dryRun: boolean): SweepReport {
  // Common guards: not already archived, not soft-deleted.
  const where = `
    deleted_at IS NULL
    AND (json_extract(metadata, '$.status') IS NULL
         OR json_extract(metadata, '$.status') != 'archived')
    AND (${rule.candidateSql})
  `;

  const candidates = db
    .prepare(`SELECT id FROM notes WHERE ${where}`)
    .all(...rule.candidateParams) as Array<{ id: string }>;

  if (dryRun || candidates.length === 0) {
    return {
      label: rule.label,
      matched: candidates.length,
      archived: 0,
      ids: candidates.map((c) => c.id),
    };
  }

  const archivedIds: string[] = [];
  const updateStmt = db.prepare(
    `UPDATE notes
       SET metadata = json_set(
             COALESCE(metadata, '{}'),
             '$.status', 'archived',
             '$.archived_at', ?,
             '$.archived_by', 'archive-stale.ts'
           ),
           updated_at = ?
     WHERE id = ?`,
  );

  const now = NOW.toISOString().replace(/\.\d{3}Z$/, "Z");

  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) {
      updateStmt.run(now, now, id);
      archivedIds.push(id);
    }
  });
  tx(candidates.map((c) => c.id));

  return {
    label: rule.label,
    matched: candidates.length,
    archived: archivedIds.length,
    ids: archivedIds,
  };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const startedAt = NOW.toISOString();

  logger.info(`archive-stale starting (dry_run=${dryRun}) at ${startedAt}`);

  const reports: SweepReport[] = [];
  for (const rule of rules) {
    const r = sweep(rule, dryRun);
    reports.push(r);
    logger.info(
      `  ${r.label}: matched=${r.matched} archived=${r.archived}` +
        (dryRun && r.ids.length > 0
          ? ` sample=${r.ids.slice(0, 3).join(",")}`
          : ""),
    );
  }

  const totalArchived = reports.reduce((s, r) => s + r.archived, 0);
  const totalMatched = reports.reduce((s, r) => s + r.matched, 0);
  logger.info(
    `archive-stale done: matched=${totalMatched} archived=${totalArchived} dry_run=${dryRun}`,
  );

  // Emit JSON to stdout so launchd logs are easily grep-able.
  console.log(
    JSON.stringify(
      {
        run_at: startedAt,
        dry_run: dryRun,
        total_matched: totalMatched,
        total_archived: totalArchived,
        rules: reports.map((r) => ({
          label: r.label,
          matched: r.matched,
          archived: r.archived,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  logger.error(`archive-stale failed: ${err}`);
  console.error(err);
  process.exit(1);
});
