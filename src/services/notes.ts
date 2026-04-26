import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import { QoopiaError, nowIso, safeJsonParse } from "../utils/errors.ts";
import { logActivity } from "./activity.ts";
import { assertNoSecrets } from "../utils/secret-guard.ts";

const MAX_TEXT = 100_000;

export const NOTE_TYPES = [
  "note",
  "task",
  "deal",
  "contact",
  "finance",
  "project",
  "memory",
  "rule",
  "knowledge",
  "context",
  "decision",
] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export interface NoteRow {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  type: string;
  text: string;
  metadata: string;
  project_id: string | null;
  task_bound_id: string | null;
  session_id: string | null;
  source: string;
  tags: string;
  visibility: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export type NoteVisibility = "workspace" | "private";

export interface NoteCreateInput {
  workspace_id: string;
  agent_id: string;
  text: string;
  type?: string;
  metadata?: Record<string, unknown>;
  project_id?: string | null;
  task_bound_id?: string | null;
  session_id?: string | null;
  tags?: string[];
  source?: string;
  /**
   * QRERUN-003 / ADR-014: 'workspace' (default) shares the note across all
   * agents in this workspace via MCP recall/brief/note_get/note_list.
   * 'private' restricts reads to the owning agent_id and admin agent
   * types (steward, claude-privileged).
   */
  visibility?: NoteVisibility;
}

function toNote(r: NoteRow) {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    agent_id: r.agent_id,
    type: r.type,
    text: r.text,
    metadata: safeJsonParse(r.metadata, {} as Record<string, unknown>),
    project_id: r.project_id,
    task_bound_id: r.task_bound_id,
    session_id: r.session_id,
    source: r.source,
    tags: safeJsonParse(r.tags, [] as string[]),
    visibility: (r.visibility || "workspace") as NoteVisibility,
    deleted_at: r.deleted_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function createNote(input: NoteCreateInput) {
  if (!input.text || input.text.length === 0) {
    throw new QoopiaError("INVALID_INPUT", "text is required");
  }
  if (input.text.length > MAX_TEXT) {
    throw new QoopiaError(
      "SIZE_LIMIT",
      `text exceeds ${MAX_TEXT} chars — split into multiple notes`,
    );
  }
  assertNoSecrets(input.text, "note.text");
  if (input.metadata) {
    assertNoSecrets(JSON.stringify(input.metadata), "note.metadata");
  }

  const type = input.type || "note";
  const visibility: NoteVisibility = input.visibility === "private" ? "private" : "workspace";

  // Validate project_id references an existing project note (M1 fix: enforce type='project')
  if (input.project_id) {
    const p = db
      .prepare(
        `SELECT id, type FROM notes WHERE id = ? AND workspace_id = ? AND type = 'project' AND deleted_at IS NULL`,
      )
      .get(input.project_id, input.workspace_id) as
      | { id: string; type: string }
      | undefined;
    if (!p) throw new QoopiaError("NOT_FOUND", "project_id not found or not a project");
  }
  if (input.task_bound_id) {
    const t = db
      .prepare(
        `SELECT id, type FROM notes WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      )
      .get(input.task_bound_id, input.workspace_id) as
      | { id: string; type: string }
      | undefined;
    if (!t) throw new QoopiaError("NOT_FOUND", "task_bound_id not found");
    if (t.type !== "task")
      throw new QoopiaError("INVALID_INPUT", "task_bound_id must reference a task");
  }

  const id = ulid();
  const now = nowIso();

  // H6 fix: wrap insert + logActivity in a single transaction so partial failure
  // never leaves the note created without an audit entry or vice versa.
  const result = db.transaction(() => {
    db.prepare(
      `INSERT INTO notes
        (id, workspace_id, agent_id, type, text, metadata, project_id, task_bound_id, session_id, source, tags, visibility, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.workspace_id,
      input.agent_id,
      type,
      input.text,
      JSON.stringify(input.metadata || {}),
      input.project_id || null,
      input.task_bound_id || null,
      input.session_id || null,
      input.source || "mcp",
      JSON.stringify(input.tags || []),
      visibility,
      now,
      now,
    );

    // QTHIRD-001: never embed the text of a private note into the
    // shared activity log. Workspace-visibility notes keep the 80-char
    // preview so existing dashboards stay informative; private rows
    // record only the type, and the row itself is stamped 'private'
    // so listActivity / recall(scope='activity'|'all') filter it out
    // for non-owner non-admin callers.
    const summary =
      visibility === "private"
        ? `Created ${type} (private)`
        : `Created ${type}: ${input.text.slice(0, 80)}`;
    logActivity({
      workspace_id: input.workspace_id,
      agent_id: input.agent_id,
      action: "created",
      entity_type: "note",
      entity_id: id,
      project_id: input.project_id || null,
      summary,
      visibility,
    });

    return {
      created: true,
      id,
      type,
      workspace_id: input.workspace_id,
      visibility,
      created_at: now,
    };
  })();

  return result;
}

/**
 * QRERUN-003 / ADR-014: getNote enforces the visibility boundary.
 * - 'workspace' notes — visible to any caller in the same workspace.
 * - 'private' notes — only the owning agent_id can read; admin types
 *   (steward, claude-privileged) bypass via isAdmin=true.
 */
export function getNote(
  workspace_id: string,
  id: string,
  caller_agent_id: string,
  isAdmin: boolean,
) {
  // H3 fix: exclude soft-deleted notes
  const r = db
    .prepare(
      `SELECT * FROM notes
        WHERE id = ?
          AND workspace_id = ?
          AND deleted_at IS NULL
          AND (visibility = 'workspace' OR agent_id = ? OR ? = 1)
        LIMIT 1`,
    )
    .get(id, workspace_id, caller_agent_id, isAdmin ? 1 : 0) as NoteRow | undefined;
  if (!r) throw new QoopiaError("NOT_FOUND", `note ${id} not found`);
  return toNote(r);
}

export interface NoteListParams {
  workspace_id: string;
  /** QRERUN-003 / ADR-014: agent_id of the caller — needed to surface
   *  their own private notes alongside workspace-visibility ones. */
  caller_agent_id: string;
  /** QRERUN-003 / ADR-014: true for steward/claude-privileged — bypass
   *  the private filter and see all notes for ops/audit. */
  is_admin: boolean;
  type?: string;
  project_id?: string;
  agent?: string;
  status?: string;
  tags?: string[];
  since?: string;
  until?: string;
  session_id?: string;
  task_bound_id?: string;
  include_deleted?: boolean;
  limit?: number;
  offset?: number;
  order?: "created_desc" | "created_asc" | "updated_desc";
}

export function listNotes(p: NoteListParams) {
  const where: string[] = [`workspace_id = ?`];
  const params: any[] = [p.workspace_id];
  if (!p.include_deleted) where.push(`deleted_at IS NULL`);
  // QRERUN-003 / ADR-014: hide private notes from non-owners (admins exempt).
  where.push(`(visibility = 'workspace' OR agent_id = ? OR ? = 1)`);
  params.push(p.caller_agent_id, p.is_admin ? 1 : 0);
  if (p.type) {
    where.push(`type = ?`);
    params.push(p.type);
  }
  if (p.project_id) {
    where.push(`project_id = ?`);
    params.push(p.project_id);
  }
  if (p.session_id) {
    where.push(`session_id = ?`);
    params.push(p.session_id);
  }
  if (p.task_bound_id) {
    where.push(`task_bound_id = ?`);
    params.push(p.task_bound_id);
  }
  if (p.agent) {
    where.push(
      `agent_id IN (SELECT id FROM agents WHERE name = ? AND workspace_id = ? AND active = 1)`,
    );
    params.push(p.agent, p.workspace_id);
  }
  if (p.status) {
    where.push(`json_extract(metadata, '$.status') = ?`);
    params.push(p.status);
  }
  if (p.tags && p.tags.length > 0) {
    for (const tag of p.tags) {
      where.push(
        `EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE json_each.value = ?)`,
      );
      params.push(tag);
    }
  }
  if (p.since) {
    where.push(`created_at >= ?`);
    params.push(p.since);
  }
  if (p.until) {
    where.push(`created_at <= ?`);
    params.push(p.until);
  }

  const orderSql =
    p.order === "created_asc"
      ? "created_at ASC"
      : p.order === "updated_desc"
        ? "updated_at DESC"
        : "created_at DESC";
  const limit = Math.min(Math.max(p.limit || 50, 1), 500);
  const offset = Math.max(p.offset || 0, 0);

  const rows = db
    .prepare(
      `SELECT * FROM notes
       WHERE ${where.join(" AND ")}
       ORDER BY ${orderSql}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as NoteRow[];

  const totalRow = db
    .prepare(`SELECT COUNT(*) as c FROM notes WHERE ${where.join(" AND ")}`)
    .get(...params) as { c: number };

  const items = rows.map((r) => {
    const full = toNote(r);
    // List view: cap text_preview to 500 chars so responses stay light.
    const text_preview = full.text.length > 500 ? full.text.slice(0, 500) : full.text;
    return { ...full, text_preview, text_preview_only: full.text.length > 500 ? true : false };
  });

  return {
    items,
    total: totalRow.c,
    limit,
    offset,
    has_more: offset + items.length < totalRow.c,
  };
}

export interface NoteUpdateInput {
  workspace_id: string;
  agent_id: string;
  /**
   * QTHIRD-001: true for steward / claude-privileged. Required to
   * mutate another agent's `private` note. Standard agents can only
   * update notes they own or notes with workspace visibility.
   */
  is_admin: boolean;
  id: string;
  text?: string;
  metadata?: Record<string, unknown>;
  metadata_replace?: Record<string, unknown>;
  project_id?: string | null;
  task_bound_id?: string | null;
  tags?: string[];
}

export function updateNote(input: NoteUpdateInput) {
  // H2 fix: exclude soft-deleted notes, consistent with getNote
  const existing = db
    .prepare(
      `SELECT * FROM notes WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(input.id, input.workspace_id) as NoteRow | undefined;
  if (!existing)
    throw new QoopiaError("NOT_FOUND", `note ${input.id} not found`);

  // QTHIRD-001: refuse non-owner non-admin mutation of a private note.
  // Throw NOT_FOUND (not FORBIDDEN) so the caller cannot probe for
  // existence of private notes belonging to siblings.
  const existingVisibility = (existing.visibility || "workspace") as NoteVisibility;
  if (
    existingVisibility === "private" &&
    existing.agent_id !== input.agent_id &&
    !input.is_admin
  ) {
    throw new QoopiaError("NOT_FOUND", `note ${input.id} not found`);
  }

  if (input.metadata && input.metadata_replace) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "metadata and metadata_replace are mutually exclusive",
    );
  }
  if (input.text !== undefined && input.text.length > MAX_TEXT) {
    throw new QoopiaError("SIZE_LIMIT", `text exceeds ${MAX_TEXT} chars`);
  }
  if (input.text !== undefined) {
    assertNoSecrets(input.text, "note.text");
  }
  if (input.metadata) {
    assertNoSecrets(JSON.stringify(input.metadata), "note.metadata");
  }
  if (input.metadata_replace) {
    assertNoSecrets(JSON.stringify(input.metadata_replace), "note.metadata");
  }

  // H2 fix: re-validate project_id and task_bound_id on update (same as create)
  if (input.project_id !== undefined && input.project_id !== null) {
    const p = db
      .prepare(
        `SELECT id, type FROM notes WHERE id = ? AND workspace_id = ? AND type = 'project' AND deleted_at IS NULL`,
      )
      .get(input.project_id, input.workspace_id) as
      | { id: string; type: string }
      | undefined;
    if (!p) throw new QoopiaError("NOT_FOUND", "project_id not found or not a project");
  }
  if (input.task_bound_id !== undefined && input.task_bound_id !== null) {
    const t = db
      .prepare(
        `SELECT id, type FROM notes WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      )
      .get(input.task_bound_id, input.workspace_id) as
      | { id: string; type: string }
      | undefined;
    if (!t) throw new QoopiaError("NOT_FOUND", "task_bound_id not found");
    if (t.type !== "task")
      throw new QoopiaError("INVALID_INPUT", "task_bound_id must reference a task");
  }

  const fields: string[] = [];
  const values: any[] = [];
  const updated: string[] = [];

  if (input.text !== undefined) {
    fields.push(`text = ?`);
    values.push(input.text);
    updated.push("text");
  }
  if (input.metadata_replace !== undefined) {
    fields.push(`metadata = ?`);
    values.push(JSON.stringify(input.metadata_replace));
    updated.push("metadata");
  } else if (input.metadata !== undefined) {
    const merged = {
      ...safeJsonParse(existing.metadata, {} as Record<string, unknown>),
      ...input.metadata,
    };
    fields.push(`metadata = ?`);
    values.push(JSON.stringify(merged));
    for (const k of Object.keys(input.metadata)) updated.push(`metadata.${k}`);
  }
  if (input.project_id !== undefined) {
    fields.push(`project_id = ?`);
    values.push(input.project_id);
    updated.push("project_id");
  }
  if (input.task_bound_id !== undefined) {
    fields.push(`task_bound_id = ?`);
    values.push(input.task_bound_id);
    updated.push("task_bound_id");
  }
  if (input.tags !== undefined) {
    fields.push(`tags = ?`);
    values.push(JSON.stringify(input.tags));
    updated.push("tags");
  }

  if (fields.length === 0) {
    return { updated: false, id: input.id, fields_updated: [], updated_at: existing.updated_at };
  }

  const now = nowIso();
  fields.push(`updated_at = ?`);
  values.push(now);

  // H6 fix: wrap update + logActivity atomically
  const result = db.transaction(() => {
    db.prepare(
      `UPDATE notes SET ${fields.join(", ")} WHERE id = ? AND workspace_id = ?`,
    ).run(...values, input.id, input.workspace_id);

    // Use the new project_id if it was changed, otherwise keep the existing one
    const effectiveProjectId =
      input.project_id !== undefined ? input.project_id : existing.project_id;
    // QTHIRD-001: inherit the note's visibility for the activity row so a
    // private note's update history isn't surfaced to non-owner non-admin
    // callers via listActivity / recall(scope='activity').
    const summaryUpd =
      existingVisibility === "private"
        ? `Updated ${existing.type} (private): ${updated.join(", ")}`
        : `Updated ${existing.type}: ${updated.join(", ")}`;
    logActivity({
      workspace_id: input.workspace_id,
      agent_id: input.agent_id,
      action: "updated",
      entity_type: "note",
      entity_id: input.id,
      project_id: effectiveProjectId,
      summary: summaryUpd,
      details: { fields_updated: updated },
      visibility: existingVisibility,
    });

    return { updated: true, id: input.id, fields_updated: updated, updated_at: now };
  })();

  return result;
}

/**
 * QTHIRD-001: deleteNote enforces the visibility boundary.
 * Non-owner non-admin callers cannot delete a private note; the call
 * surfaces NOT_FOUND (not FORBIDDEN) to avoid leaking existence.
 */
export function deleteNote(
  workspace_id: string,
  agent_id: string,
  id: string,
  isAdmin: boolean,
) {
  const existing = db
    .prepare(
      `SELECT id, type, project_id, agent_id, visibility FROM notes
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL
        LIMIT 1`,
    )
    .get(id, workspace_id) as
    | {
        id: string;
        type: string;
        project_id: string | null;
        agent_id: string | null;
        visibility: string | null;
      }
    | undefined;
  if (!existing) throw new QoopiaError("NOT_FOUND", `note ${id} not found`);

  const existingVisibility = (existing.visibility || "workspace") as NoteVisibility;
  if (
    existingVisibility === "private" &&
    existing.agent_id !== agent_id &&
    !isAdmin
  ) {
    // Match the read-side error to avoid leaking existence.
    throw new QoopiaError("NOT_FOUND", `note ${id} not found`);
  }

  const now = nowIso();

  // H6 fix: wrap soft-delete + logActivity atomically
  // M12 fix: remove from FTS index on soft-delete to prevent monotonic index growth
  const result = db.transaction(() => {
    db.prepare(
      `UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    ).run(now, now, id, workspace_id);

    // Remove from FTS index — find rowid via the notes row we just soft-deleted
    db.prepare(
      `DELETE FROM notes_fts WHERE rowid = (SELECT rowid FROM notes WHERE id = ?)`,
    ).run(id);

    // QTHIRD-001: inherit the note's visibility for the deletion activity
    // row, and never embed any text — the row already only carried `id`,
    // but we also drop the id from the summary for private notes so the
    // workspace-wide audit can't even reveal the ID.
    const summaryDel =
      existingVisibility === "private"
        ? `Deleted ${existing.type} (private)`
        : `Deleted ${existing.type} ${id}`;
    logActivity({
      workspace_id,
      agent_id,
      action: "deleted",
      entity_type: "note",
      entity_id: id,
      project_id: existing.project_id,
      summary: summaryDel,
      visibility: existingVisibility,
    });

    return { deleted: true, id };
  })();

  return result;
}
