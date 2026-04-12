import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import { QoopiaError, nowIso, safeJsonParse } from "../utils/errors.ts";
import { logActivity } from "./activity.ts";

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
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

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
  const type = input.type || "note";

  // Validate project_id references an existing project note
  if (input.project_id) {
    const p = db
      .prepare(
        `SELECT id, type FROM notes WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      )
      .get(input.project_id, input.workspace_id) as
      | { id: string; type: string }
      | undefined;
    if (!p) throw new QoopiaError("NOT_FOUND", "project_id not found");
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
  db.prepare(
    `INSERT INTO notes
      (id, workspace_id, agent_id, type, text, metadata, project_id, task_bound_id, session_id, source, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    now,
    now,
  );

  logActivity({
    workspace_id: input.workspace_id,
    agent_id: input.agent_id,
    action: "created",
    entity_type: "note",
    entity_id: id,
    project_id: input.project_id || null,
    summary: `Created ${type}: ${input.text.slice(0, 80)}`,
  });

  return { created: true, id, type, workspace_id: input.workspace_id, created_at: now };
}

export function getNote(workspace_id: string, id: string) {
  const r = db
    .prepare(
      `SELECT * FROM notes WHERE id = ? AND workspace_id = ? LIMIT 1`,
    )
    .get(id, workspace_id) as NoteRow | undefined;
  if (!r) throw new QoopiaError("NOT_FOUND", `note ${id} not found`);
  return toNote(r);
}

export interface NoteListParams {
  workspace_id: string;
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
      `agent_id IN (SELECT id FROM agents WHERE name = ? AND workspace_id = ?)`,
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
  id: string;
  text?: string;
  metadata?: Record<string, unknown>;
  metadata_replace?: Record<string, unknown>;
  project_id?: string | null;
  task_bound_id?: string | null;
  tags?: string[];
}

export function updateNote(input: NoteUpdateInput) {
  const existing = db
    .prepare(
      `SELECT * FROM notes WHERE id = ? AND workspace_id = ? LIMIT 1`,
    )
    .get(input.id, input.workspace_id) as NoteRow | undefined;
  if (!existing)
    throw new QoopiaError("NOT_FOUND", `note ${input.id} not found`);

  if (input.metadata && input.metadata_replace) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "metadata and metadata_replace are mutually exclusive",
    );
  }
  if (input.text !== undefined && input.text.length > MAX_TEXT) {
    throw new QoopiaError("SIZE_LIMIT", `text exceeds ${MAX_TEXT} chars`);
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

  db.prepare(
    `UPDATE notes SET ${fields.join(", ")} WHERE id = ? AND workspace_id = ?`,
  ).run(...values, input.id, input.workspace_id);

  logActivity({
    workspace_id: input.workspace_id,
    agent_id: input.agent_id,
    action: "updated",
    entity_type: "note",
    entity_id: input.id,
    project_id: existing.project_id,
    summary: `Updated ${existing.type}: ${updated.join(", ")}`,
    details: { fields_updated: updated },
  });

  return { updated: true, id: input.id, fields_updated: updated, updated_at: now };
}

export function deleteNote(workspace_id: string, agent_id: string, id: string) {
  const existing = db
    .prepare(
      `SELECT id, type, project_id FROM notes WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(id, workspace_id) as
    | { id: string; type: string; project_id: string | null }
    | undefined;
  if (!existing) throw new QoopiaError("NOT_FOUND", `note ${id} not found`);

  const now = nowIso();
  db.prepare(
    `UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
  ).run(now, now, id, workspace_id);

  logActivity({
    workspace_id,
    agent_id,
    action: "deleted",
    entity_type: "note",
    entity_id: id,
    project_id: existing.project_id,
    summary: `Deleted ${existing.type} ${id}`,
  });

  return { deleted: true, id };
}
