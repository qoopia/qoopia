/**
 * Dashboard V4 — read-only HTTP API for the agent monitor dashboard.
 *
 * All endpoints are workspace-wide (no agent ownership filtering) — intended for
 * the single-workspace owner's eyes only. Protected by ADMIN_SECRET via
 * Authorization: Bearer <secret> OR X-Admin-Secret header.
 *
 * Routes (all GET, JSON out):
 *   /api/dashboard/agents
 *   /api/dashboard/agents/:agent_id/sessions
 *   /api/dashboard/sessions/:session_id/messages
 *   /api/dashboard/agents/:agent_id/notes?type=...&limit=...
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { db } from "./db/connection.ts";
import { authenticate } from "./auth/middleware.ts";

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

/**
 * Authenticate dashboard requests via any valid workspace agent Bearer token.
 * Returns the workspace_id of the authenticated agent, or null if unauth.
 * All 4 agents share one workspace, so any valid agent key sees all data.
 */
export function checkDashboardAuth(req: IncomingMessage): string | null {
  const header = (req.headers["authorization"] as string | undefined) || "";
  if (!header) return null;
  const fetchReq = new Request("http://local/", {
    headers: { authorization: header },
  });
  const auth = authenticate(fetchReq);
  return auth?.workspace_id ?? null;
}

// ---- /api/dashboard/agents ----
function listAgents(res: ServerResponse, workspaceId: string) {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, name, type, active, last_seen, created_at
       FROM agents
       WHERE active = 1 AND workspace_id = ?
       ORDER BY name ASC`,
    )
    .all(workspaceId) as Array<{
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
function listSessions(res: ServerResponse, workspaceId: string, agentId: string, limit = 100) {
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
  workspaceId: string,
  sessionId: string,
  limit = 500,
) {
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
  workspaceId: string,
  agentId: string,
  type: string | null,
  limit = 200,
) {
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
  const workspaceId = checkDashboardAuth(req);
  if (!workspaceId) {
    json(res, 401, {
      error: "unauthorized",
      error_description: "Valid agent Bearer token required",
    });
    return true;
  }

  const u = new URL(url, "http://local");
  const path = u.pathname;

  // /api/dashboard/agents
  if (path === "/api/dashboard/agents") {
    listAgents(res, workspaceId);
    return true;
  }

  // /api/dashboard/agents/:agent_id/sessions
  let m = path.match(/^\/api\/dashboard\/agents\/([^/]+)\/sessions$/);
  if (m) {
    const limit = parseInt(u.searchParams.get("limit") || "100", 10);
    listSessions(res, workspaceId, decodeURIComponent(m[1]!), limit);
    return true;
  }

  // /api/dashboard/agents/:agent_id/notes
  m = path.match(/^\/api\/dashboard\/agents\/([^/]+)\/notes$/);
  if (m) {
    const type = u.searchParams.get("type");
    const limit = parseInt(u.searchParams.get("limit") || "200", 10);
    listNotesByAgent(res, workspaceId, decodeURIComponent(m[1]!), type, limit);
    return true;
  }

  // /api/dashboard/sessions/:session_id/messages
  m = path.match(/^\/api\/dashboard\/sessions\/([^/]+)\/messages$/);
  if (m) {
    const limit = parseInt(u.searchParams.get("limit") || "500", 10);
    sessionMessages(res, workspaceId, decodeURIComponent(m[1]!), limit);
    return true;
  }

  json(res, 404, { error: "not_found", path });
  return true;
}
