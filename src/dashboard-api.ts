/**
 * Dashboard V4 — read-only HTTP API for the agent monitor dashboard.
 *
 * Authorization model (QSEC-001, Codex review 2026-04-25):
 *   - `steward` and `claude-privileged` agents see the whole workspace
 *     (this is the dashboard/admin view).
 *   - `standard` agents can ONLY see their own agent record, sessions,
 *     messages, notes, and search. Cross-agent access returns 403.
 *   - `ingest-daemon` and any other type get 403 from dashboard endpoints.
 *
 * Before this change, any valid agent Bearer token could read every other
 * agent's transcripts and memory in the same workspace. The new auth context
 * carries `isAdmin` and `agent_id` so each handler can enforce scope.
 *
 * Routes (all GET, JSON out):
 *   /api/dashboard/agents
 *   /api/dashboard/agents/:agent_id/sessions
 *   /api/dashboard/sessions/:session_id/messages
 *   /api/dashboard/agents/:agent_id/notes?type=...&limit=...
 *   /api/dashboard/agents/:agent_id/search?q=...
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { db } from "./db/connection.ts";
import { authenticate, type AuthContext } from "./auth/middleware.ts";

function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

const ADMIN_TYPES = new Set(["steward", "claude-privileged"]);
/** ingest-daemon and unknown types must NOT see dashboard data. */
const ALLOWED_TYPES = new Set(["steward", "claude-privileged", "standard"]);

export interface DashboardAuth {
  workspace_id: string;
  agent_id: string;
  type: string;
  isAdmin: boolean;
}

/**
 * Authenticate dashboard requests via Bearer token. Returns auth context with
 * agent_id and isAdmin flag, or null if the agent's type is not allowed on
 * the dashboard at all.
 */
export function checkDashboardAuth(req: IncomingMessage): DashboardAuth | null {
  const header = (req.headers["authorization"] as string | undefined) || "";
  if (!header) return null;
  const fetchReq = new Request("http://local/", {
    headers: { authorization: header },
  });
  const auth = authenticate(fetchReq);
  if (!auth) return null;
  if (!ALLOWED_TYPES.has(auth.type)) return null;
  return {
    workspace_id: auth.workspace_id,
    agent_id: auth.agent_id,
    type: auth.type,
    isAdmin: ADMIN_TYPES.has(auth.type),
  };
}

/**
 * Enforce per-agent scope for standard agents. Returns true if the request
 * should be denied (403 already written).
 */
function denyIfNotOwn(
  res: ServerResponse,
  auth: DashboardAuth,
  requestedAgentId: string,
): boolean {
  if (auth.isAdmin) return false;
  if (requestedAgentId === auth.agent_id) return false;
  json(res, 403, {
    error: "forbidden",
    error_description:
      "Standard agents can only read their own dashboard data; ask a steward for cross-agent visibility.",
  });
  return true;
}

// Re-export for any internal callers that imported the old AuthContext.
export type { AuthContext };

// ---- /api/dashboard/agents ----
function listAgents(res: ServerResponse, auth: DashboardAuth) {
  // Standard agents only see themselves; admins see the workspace.
  const sql = auth.isAdmin
    ? `SELECT id, workspace_id, name, type, active, last_seen, created_at
       FROM agents
       WHERE active = 1 AND workspace_id = ?
       ORDER BY name ASC`
    : `SELECT id, workspace_id, name, type, active, last_seen, created_at
       FROM agents
       WHERE active = 1 AND workspace_id = ? AND id = ?
       ORDER BY name ASC`;
  const args: string[] = auth.isAdmin
    ? [auth.workspace_id]
    : [auth.workspace_id, auth.agent_id];
  const rows = db.prepare(sql).all(...args) as Array<{
    id: string;
    workspace_id: string;
    name: string;
    type: string;
    active: number;
    last_seen: string | null;
    created_at: string;
  }>;

  const countSessions = db.prepare(
    `SELECT COUNT(*) as c FROM sessions WHERE agent_id = ?`,
  );
  const countNotes = db.prepare(
    `SELECT COUNT(*) as c FROM notes WHERE agent_id = ? AND deleted_at IS NULL`,
  );
  const countMessages = db.prepare(
    `SELECT COUNT(*) as c FROM session_messages WHERE agent_id = ?`,
  );
  const lastSession = db.prepare(
    `SELECT id, last_active FROM sessions
     WHERE agent_id = ?
     ORDER BY last_active DESC LIMIT 1`,
  );

  const items = rows.map((a) => {
    const s = countSessions.get(a.id) as { c: number };
    const n = countNotes.get(a.id) as { c: number };
    const m = countMessages.get(a.id) as { c: number };
    const last = lastSession.get(a.id) as
      | { id: string; last_active: string }
      | undefined;
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      workspace_id: a.workspace_id,
      created_at: a.created_at,
      last_seen: a.last_seen,
      sessions_count: s.c,
      notes_count: n.c,
      messages_count: m.c,
      last_session_id: last?.id ?? null,
      last_session_active: last?.last_active ?? null,
    };
  });

  return json(res, 200, { items, total: items.length });
}

// ---- /api/dashboard/agents/:agent_id/sessions ----
function listSessions(
  res: ServerResponse,
  auth: DashboardAuth,
  agentId: string,
  limit = 100,
) {
  if (denyIfNotOwn(res, auth, agentId)) return;
  const workspaceId = auth.workspace_id;
  const rows = db
    .prepare(
      `SELECT s.id, s.workspace_id, s.agent_id, s.title, s.metadata,
              s.created_at, s.last_active,
              (SELECT COUNT(*) FROM session_messages WHERE session_id = s.id) as message_count
       FROM sessions s
       WHERE s.agent_id = ? AND s.workspace_id = ?
       ORDER BY s.last_active DESC
       LIMIT ?`,
    )
    .all(agentId, workspaceId, Math.min(Math.max(limit, 1), 500)) as Array<{
    id: string;
    workspace_id: string;
    agent_id: string;
    title: string | null;
    metadata: string;
    created_at: string;
    last_active: string;
    message_count: number;
  }>;

  const items = rows.map((r) => ({
    id: r.id,
    title: r.title,
    metadata: safeJson(r.metadata),
    created_at: r.created_at,
    last_active: r.last_active,
    message_count: r.message_count,
  }));

  return json(res, 200, { items, total: items.length, agent_id: agentId });
}

// ---- /api/dashboard/sessions/:session_id/messages ----
function sessionMessages(
  res: ServerResponse,
  auth: DashboardAuth,
  sessionId: string,
  limit = 500,
) {
  const workspaceId = auth.workspace_id;
  const sess = db
    .prepare(
      `SELECT id, agent_id, workspace_id, title, created_at, last_active
       FROM sessions WHERE id = ? AND workspace_id = ?`,
    )
    .get(sessionId, workspaceId) as
    | {
        id: string;
        agent_id: string;
        workspace_id: string;
        title: string | null;
        created_at: string;
        last_active: string;
      }
    | undefined;
  if (!sess) return json(res, 404, { error: "session_not_found" });
  // Non-admin: session must belong to the authenticated agent.
  if (denyIfNotOwn(res, auth, sess.agent_id)) return;

  const rows = db
    .prepare(
      `SELECT id, role, content, metadata, token_count, created_at
       FROM session_messages
       WHERE session_id = ?
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(sessionId, Math.min(Math.max(limit, 1), 2000)) as Array<{
    id: number;
    role: string;
    content: string;
    metadata: string;
    token_count: number | null;
    created_at: string;
  }>;

  const summaries = db
    .prepare(
      `SELECT id, content, msg_start_id, msg_end_id, level, created_at
       FROM summaries WHERE session_id = ?
       ORDER BY msg_start_id ASC`,
    )
    .all(sessionId);

  return json(res, 200, {
    session: sess,
    messages: rows.map((r) => ({
      ...r,
      metadata: safeJson(r.metadata),
    })),
    summaries,
    total: rows.length,
  });
}

// ---- /api/dashboard/agents/:agent_id/notes ----
function listNotesByAgent(
  res: ServerResponse,
  auth: DashboardAuth,
  agentId: string,
  type: string | null,
  limit = 200,
) {
  if (denyIfNotOwn(res, auth, agentId)) return;
  const workspaceId = auth.workspace_id;
  const where: string[] = [`agent_id = ?`, `workspace_id = ?`, `deleted_at IS NULL`];
  const params: any[] = [agentId, workspaceId];
  if (type) {
    where.push(`type = ?`);
    params.push(type);
  }
  const rows = db
    .prepare(
      `SELECT id, workspace_id, agent_id, type, text, metadata, tags,
              project_id, task_bound_id, session_id, source,
              created_at, updated_at
       FROM notes
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(...params, Math.min(Math.max(limit, 1), 1000)) as Array<{
    id: string;
    workspace_id: string;
    agent_id: string;
    type: string;
    text: string;
    metadata: string;
    tags: string;
    project_id: string | null;
    task_bound_id: string | null;
    session_id: string | null;
    source: string;
    created_at: string;
    updated_at: string;
  }>;

  // Breakdown by type (all types, not filtered by `type`)
  const typeBreakdown = db
    .prepare(
      `SELECT type, COUNT(*) as c
       FROM notes WHERE agent_id = ? AND workspace_id = ? AND deleted_at IS NULL
       GROUP BY type ORDER BY c DESC`,
    )
    .all(agentId, workspaceId) as Array<{ type: string; c: number }>;

  return json(res, 200, {
    items: rows.map((r) => ({
      ...r,
      metadata: safeJson(r.metadata),
      tags: safeJson(r.tags) ?? [],
    })),
    total: rows.length,
    type_breakdown: typeBreakdown,
    agent_id: agentId,
    filter_type: type,
  });
}

// ---- /api/dashboard/agents/:agent_id/search?q=... ----
function searchMessages(
  res: ServerResponse,
  auth: DashboardAuth,
  agentId: string,
  query: string,
  limit = 50,
) {
  if (denyIfNotOwn(res, auth, agentId)) return;
  const workspaceId = auth.workspace_id;
  // Sanitize FTS query: strip characters SQLite FTS5 treats as operators
  // and just quote the bare tokens. This matches the simple-search UX users expect.
  const cleaned = query
    .replace(/[-\"\'`():*^~]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`)
    .join(" AND ");
  if (!cleaned) {
    return json(res, 200, { items: [], total: 0, query });
  }
  try {
    const rows = db
      .prepare(
        `SELECT m.id, m.session_id, m.role, m.content, m.created_at,
                s.title as session_title
         FROM session_messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.rowid IN (
           SELECT rowid FROM session_messages_fts
           WHERE session_messages_fts MATCH ?
         )
         AND m.agent_id = ? AND m.workspace_id = ?
         ORDER BY m.id DESC
         LIMIT ?`,
      )
      .all(cleaned, agentId, workspaceId, Math.min(Math.max(limit, 1), 200)) as Array<{
      id: number;
      session_id: string;
      role: string;
      content: string;
      created_at: string;
      session_title: string | null;
    }>;
    return json(res, 200, {
      items: rows.map((r) => ({
        ...r,
        // Truncate content to keep response light
        content: r.content.length > 400 ? r.content.slice(0, 400) + "…" : r.content,
      })),
      total: rows.length,
      query,
    });
  } catch (e) {
    return json(res, 400, {
      error: "invalid_query",
      error_description: (e as Error).message,
    });
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Route dispatcher — called from http.ts before the generic 404.
 * Returns true if the request was handled (response sent).
 */
export function handleDashboardApi(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const url = req.url || "/";
  if (!url.startsWith("/api/dashboard")) return false;
  if ((req.method || "GET").toUpperCase() !== "GET") {
    json(res, 405, { error: "method_not_allowed" });
    return true;
  }
  const auth = checkDashboardAuth(req);
  if (!auth) {
    json(res, 401, {
      error: "unauthorized",
      error_description:
        "Valid agent Bearer token required (steward/standard/claude-privileged)",
    });
    return true;
  }

  const u = new URL(url, "http://local");
  const path = u.pathname;

  // /api/dashboard/agents
  if (path === "/api/dashboard/agents") {
    listAgents(res, auth);
    return true;
  }

  // /api/dashboard/agents/:agent_id/sessions
  let m = path.match(/^\/api\/dashboard\/agents\/([^/]+)\/sessions$/);
  if (m) {
    const limit = parseInt(u.searchParams.get("limit") || "100", 10);
    listSessions(res, auth, decodeURIComponent(m[1]!), limit);
    return true;
  }

  // /api/dashboard/agents/:agent_id/notes
  m = path.match(/^\/api\/dashboard\/agents\/([^/]+)\/notes$/);
  if (m) {
    const type = u.searchParams.get("type");
    const limit = parseInt(u.searchParams.get("limit") || "200", 10);
    listNotesByAgent(res, auth, decodeURIComponent(m[1]!), type, limit);
    return true;
  }

  // /api/dashboard/sessions/:session_id/messages
  m = path.match(/^\/api\/dashboard\/sessions\/([^/]+)\/messages$/);
  if (m) {
    const limit = parseInt(u.searchParams.get("limit") || "500", 10);
    sessionMessages(res, auth, decodeURIComponent(m[1]!), limit);
    return true;
  }

  // /api/dashboard/agents/:agent_id/search?q=...
  m = path.match(/^\/api\/dashboard\/agents\/([^/]+)\/search$/);
  if (m) {
    const q = u.searchParams.get("q") || "";
    const limit = parseInt(u.searchParams.get("limit") || "50", 10);
    searchMessages(res, auth, decodeURIComponent(m[1]!), q, limit);
    return true;
  }

  json(res, 404, { error: "not_found", path });
  return true;
}
