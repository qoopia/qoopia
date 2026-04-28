import { db } from "../db/connection.ts";
import { QoopiaError, safeJsonParse } from "../utils/errors.ts";

const MAX_QUERY_CHARS = 1000;

/**
 * Sanitize a free-text query into an FTS5 MATCH expression.
 * Rules:
 *  - Strip FTS5 operators that confuse users (AND/OR/NOT/NEAR when not in quotes)
 *  - Escape double quotes
 *  - Each term gets prefix match (word*)
 *  - Truncate to MAX_QUERY_CHARS
 */
export function sanitizeFtsQuery(query: string): string {
  if (!query || !query.trim()) {
    throw new QoopiaError("INVALID_INPUT", "query is required");
  }
  let raw = query.slice(0, MAX_QUERY_CHARS).trim();

  // Remove characters that break FTS5 parsing
  raw = raw.replace(/["`]/g, " ");
  raw = raw.replace(/[()[\]{}]/g, " ");

  // Drop boolean operators (uppercase) so plain typing works
  const terms = raw
    .split(/\s+/)
    .filter((tok) => tok.length > 0)
    .filter((tok) => !/^(AND|OR|NOT|NEAR)$/i.test(tok))
    .map((tok) => tok.toLowerCase())
    .filter((t) => t.length >= 2);

  if (terms.length === 0) {
    throw new QoopiaError("INVALID_INPUT", "query has no usable terms");
  }

  // Prefix match each term, join with implicit AND
  return terms.map((t) => `"${t}"*`).join(" ");
}

export interface RecallParams {
  workspace_id: string;
  /** QRERUN-003 / ADR-014: agent_id of the caller — needed to surface
   *  their own private notes alongside workspace-visibility ones. */
  caller_agent_id: string;
  /** QRERUN-003 / ADR-014: true for steward/claude-privileged; bypasses
   *  the private-note filter. Distinct from `privileged` below, which
   *  controls cross-workspace search. */
  is_admin: boolean;
  query: string;
  limit?: number;
  scope?: "notes" | "activity" | "sessions" | "all";
  type?: string;
  project_id?: string;
  cross_workspace?: boolean;
  privileged?: boolean;
  /** Include notes whose metadata.status = 'archived'. Default false — archived
   *  rows are hidden from recall to keep results focused on live state. */
  include_archived?: boolean;
}

export function recall(p: RecallParams) {
  const limit = Math.min(Math.max(p.limit || 10, 1), 50);
  const sanitized = sanitizeFtsQuery(p.query);
  const scope = p.scope || "notes";
  const canCrossWorkspace = !!(p.cross_workspace && p.privileged);
  const includeArchived = !!p.include_archived;

  const results: Array<{
    id: string;
    type: string;
    text: string;
    metadata: unknown;
    project_id: string | null;
    created_at: string;
    workspace_id: string;
    rank: number;
    source?: "notes" | "activity" | "sessions";
  }> = [];

  let tokensReturned = 0;

  if (scope === "notes" || scope === "all") {
    const where: string[] = [`notes_fts MATCH ?`, `n.deleted_at IS NULL`];
    const params: any[] = [sanitized];
    if (!canCrossWorkspace) {
      where.push(`n.workspace_id = ?`);
      params.push(p.workspace_id);
    }
    // QRERUN-003 / ADR-014: filter out private notes that don't belong
    // to the caller (admins exempt).
    where.push(`(n.visibility = 'workspace' OR n.agent_id = ? OR ? = 1)`);
    params.push(p.caller_agent_id, p.is_admin ? 1 : 0);
    if (p.type) {
      where.push(`n.type = ?`);
      params.push(p.type);
    }
    if (p.project_id) {
      where.push(`n.project_id = ?`);
      params.push(p.project_id);
    }
    if (!includeArchived) {
      // Default: hide archived notes from recall. Caller can opt back in
      // via include_archived=true (used by audit/cleanup tooling).
      where.push(`(json_extract(n.metadata, '$.status') IS NULL OR json_extract(n.metadata, '$.status') != 'archived')`);
    }

    const sql = `
      SELECT n.id, n.type, n.text, n.metadata, n.project_id, n.created_at, n.workspace_id, rank
      FROM notes_fts f
      JOIN notes n ON n.rowid = f.rowid
      WHERE ${where.join(" AND ")}
      ORDER BY rank
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(...params, limit) as Array<{
      id: string;
      type: string;
      text: string;
      metadata: string;
      project_id: string | null;
      created_at: string;
      workspace_id: string;
      rank: number;
    }>;

    for (const r of rows) {
      const metadata = safeJsonParse(r.metadata, {} as Record<string, unknown>);
      results.push({
        id: r.id,
        type: r.type,
        text: r.text,
        metadata,
        project_id: r.project_id,
        created_at: r.created_at,
        workspace_id: r.workspace_id,
        rank: r.rank,
        source: "notes",
      });
      tokensReturned += Math.ceil(r.text.length / 4);
    }
  }

  if (scope === "activity" || scope === "all") {
    // Migration 009 added activity_fts (mirrors notes_fts pattern).
    // FTS5 MATCH replaces the old `summary LIKE ?` fallback that
    // started to slow down past ~2k rows.
    const where: string[] = [`activity_fts MATCH ?`];
    const params: any[] = [sanitized];
    if (!canCrossWorkspace) {
      where.push(`a.workspace_id = ?`);
      params.push(p.workspace_id);
    }
    // QTHIRD-001: hide activity rows tied to sibling private notes.
    // Admin types and the owner agent still see them.
    where.push(`(a.visibility = 'workspace' OR a.agent_id = ? OR ? = 1)`);
    params.push(p.caller_agent_id, p.is_admin ? 1 : 0);
    const sql = `
      SELECT a.id, 'activity' as type, a.summary as text, a.details as metadata,
             a.project_id, a.created_at, a.workspace_id, rank
      FROM activity_fts f
      JOIN activity a ON a.rowid = f.rowid
      WHERE ${where.join(" AND ")}
      ORDER BY rank
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(...params, limit) as Array<{
      id: string;
      type: string;
      text: string;
      metadata: string;
      project_id: string | null;
      created_at: string;
      workspace_id: string;
      rank: number;
    }>;
    for (const r of rows) {
      results.push({
        id: r.id,
        type: r.type,
        text: r.text,
        metadata: safeJsonParse(r.metadata, {} as Record<string, unknown>),
        project_id: r.project_id,
        created_at: r.created_at,
        workspace_id: r.workspace_id,
        rank: r.rank,
        source: "activity",
      });
      tokensReturned += Math.ceil(r.text.length / 4);
    }
  }

  if (scope === "sessions" || scope === "all") {
    // session_messages_fts has existed since 001-initial-schema.sql but
    // was not previously wired into recall(). Closes the "shared memory
    // layer" gap where conversation content was findable only via the
    // dashboard / session_search and not from agent recall().
    //
    // Visibility: messages are tied to sessions (workspace-scoped) and
    // tagged with agent_id. We surface only the caller's own messages
    // unless is_admin (steward/audit). This matches the private-note
    // boundary policy.
    const where: string[] = [`session_messages_fts MATCH ?`];
    const params: any[] = [sanitized];
    if (!canCrossWorkspace) {
      where.push(`m.workspace_id = ?`);
      params.push(p.workspace_id);
    }
    where.push(`(m.agent_id = ? OR ? = 1)`);
    params.push(p.caller_agent_id, p.is_admin ? 1 : 0);
    const sql = `
      SELECT m.id, m.role as type, m.content as text, m.metadata, NULL as project_id,
             m.created_at, m.workspace_id, m.session_id, rank
      FROM session_messages_fts f
      JOIN session_messages m ON m.id = f.rowid
      WHERE ${where.join(" AND ")}
      ORDER BY rank
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(...params, limit) as Array<{
      id: number;
      type: string;
      text: string;
      metadata: string;
      project_id: null;
      created_at: string;
      workspace_id: string;
      session_id: string;
      rank: number;
    }>;
    for (const r of rows) {
      const metadata = safeJsonParse(r.metadata, {} as Record<string, unknown>);
      // Surface session_id alongside the message so callers can drill in.
      (metadata as Record<string, unknown>).session_id = r.session_id;
      results.push({
        id: String(r.id),
        type: `session_message:${r.type}`,
        text: r.text,
        metadata,
        project_id: null,
        created_at: r.created_at,
        workspace_id: r.workspace_id,
        rank: r.rank,
        source: "sessions",
      });
      tokensReturned += Math.ceil(r.text.length / 4);
    }
  }

  // Rough cost metric: compare to a naive full scan estimate (avg note 200
  // chars × rows). Good enough to demonstrate savings to the agent.
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) as c, COALESCE(SUM(length(text)),0) as total_chars FROM notes WHERE workspace_id = ? AND deleted_at IS NULL`,
    )
    .get(p.workspace_id) as { c: number; total_chars: number };
  const fullScanTokens = Math.ceil(totalRow.total_chars / 4);
  const savings =
    fullScanTokens > 0 ? 1 - tokensReturned / fullScanTokens : 0;

  return {
    results,
    total_found: results.length,
    query: p.query,
    sanitized_query: sanitized,
    cost: {
      tokens_returned: tokensReturned,
      tokens_full_scan_estimate: fullScanTokens,
      savings_ratio: Math.max(0, Math.min(1, Number(savings.toFixed(3)))),
    },
  };
}
