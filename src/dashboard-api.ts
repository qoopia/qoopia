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
 * Routes (read GETs unless noted):
 *   POST /api/dashboard/login   — exchange Bearer for session cookie
 *   POST /api/dashboard/logout  — clear session cookie
 *   GET  /api/dashboard/agents
 *   GET  /api/dashboard/agents/:agent_id/sessions
 *   GET  /api/dashboard/sessions/:session_id/messages
 *   GET  /api/dashboard/agents/:agent_id/notes?type=...&limit=...
 *   GET  /api/dashboard/agents/:agent_id/search?q=...
 *
 * QDASH-COOKIE (Codex review 2026-04-26 follow-up):
 *   The browser dashboard no longer keeps the Bearer in JS storage. POST
 *   /login validates the Bearer and sets `qoopia_dash` as an HttpOnly +
 *   SameSite=Strict cookie scoped to /api/dashboard. Subsequent GETs are
 *   authenticated by the cookie automatically; if the Authorization header
 *   is also supplied (curl, scripts) it still wins. POST /logout clears
 *   the cookie.
 *
 *   The cookie value is a server-signed `{agent_id, exp}` payload —
 *   `base64url(JSON) "." base64url(HMAC-SHA256)` — NOT the raw Bearer.
 *   Cookie minting is restricted to static `api_key` Bearers (see
 *   loginHandler / QDASHCOOKIE-001 fix). OAuth access tokens are NOT
 *   accepted at /api/dashboard/login: an OAuth token's lifetime and
 *   revocation are managed in `oauth_tokens`, and minting a 24h dashboard
 *   cookie from a 1h OAuth token would silently extend its blast radius.
 *
 *   Cookie revocation in this PR is limited to:
 *     • agent deactivation (per-request `active=1` DB check),
 *     • rotation of `QOOPIA_SESSION_SECRET` (or process restart on the
 *       ephemeral fallback key),
 *     • cookie expiry (24h Max-Age + payload `exp`).
 *   Rotating the agent's `api_key` does NOT, on its own, revoke
 *   outstanding cookies — the cookie payload does not bind to api_key
 *   material. Instant revocation on key rotation is tracked as post-merge
 *   hardening (see ADR-015 §Consequences).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { db } from "./db/connection.ts";
import { authenticate, type AuthContext } from "./auth/middleware.ts";
import { env } from "./utils/env.ts";

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

/** Parse a Cookie header into a name→value map. Empty/missing → {}. */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** Cookie name for the dashboard session token. */
export const DASHBOARD_COOKIE = "qoopia_dash";

/** 24-hour cookie lifetime. */
const SESSION_TTL_SEC = 86400;

/** Constant-time string compare for the HMAC tag. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * HMAC-SHA256 signing key for dashboard session cookies.
 *
 * Resolution order:
 *   1. QOOPIA_SESSION_SECRET — explicit env, recommended for prod.
 *   2. QOOPIA_ADMIN_SECRET   — already lives in the LaunchAgent plist.
 *   3. Ephemeral random      — generated once per process; cookies invalidate
 *                              on restart (acceptable: dashboard is a tool,
 *                              not a multi-user product).
 *
 * The cookie value never embeds this key — it is HMAC-only, so leaking the
 * cookie does not leak the key.
 */
let _sessionKey: Buffer | null = null;
function sessionKey(): Buffer {
  if (_sessionKey) return _sessionKey;
  const explicit = process.env.QOOPIA_SESSION_SECRET || "";
  let key: Buffer;
  if (explicit) {
    key = Buffer.from(explicit, "utf8");
  } else if (env.ADMIN_SECRET) {
    // Domain-separate so the same secret can't be cross-used by other
    // signers in the future (defense-in-depth, not exploitable today).
    key = createHmac("sha256", env.ADMIN_SECRET)
      .update("qoopia-dashboard-session-v1")
      .digest();
  } else {
    key = randomBytes(32);
  }
  _sessionKey = key;
  return key;
}

function b64uEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function b64uDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

interface SessionPayload {
  agent_id: string;
  exp: number; // unix seconds
}

/**
 * Build a signed session cookie value for `agent_id`. Format:
 *   base64url(JSON({agent_id, exp})) "." base64url(HMAC-SHA256(payload))
 *
 * No raw Bearer token is ever stored in or derivable from this value.
 */
function signSession(agent_id: string, ttlSec = SESSION_TTL_SEC): string {
  const payload: SessionPayload = {
    agent_id,
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  };
  const payloadB64 = b64uEncode(JSON.stringify(payload));
  const tag = createHmac("sha256", sessionKey()).update(payloadB64).digest();
  const tagB64 = b64uEncode(tag);
  return `${payloadB64}.${tagB64}`;
}

/**
 * Verify a signed session cookie. Returns the agent_id on success, null on
 * any failure (malformed, bad HMAC, expired). Does NOT consult the DB — the
 * caller still resolves the agent record so a deactivated/deleted agent
 * cannot ride a stale-but-still-signed cookie.
 */
function verifySession(value: string): string | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const payloadB64 = value.slice(0, dot);
  const tagB64 = value.slice(dot + 1);
  const expectedTag = b64uEncode(
    createHmac("sha256", sessionKey()).update(payloadB64).digest(),
  );
  if (!timingSafeEqual(tagB64, expectedTag)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(b64uDecode(payloadB64).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.agent_id !== "string" || typeof payload.exp !== "number") {
    return null;
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload.agent_id;
}

/**
 * Determine whether the request reached us over HTTPS. Honors x-forwarded-proto
 * only when TRUST_PROXY is enabled and the upstream peer is in TRUSTED_PROXIES
 * — otherwise an attacker on a non-loopback interface could spoof the header
 * and trick us into setting cookies without the Secure flag.
 */
function isHttps(req: IncomingMessage): boolean {
  const sock = (req as unknown as { socket?: { encrypted?: boolean } }).socket;
  if (sock && sock.encrypted) return true;
  if (!env.TRUST_PROXY) return false;
  const peer = (req.socket?.remoteAddress || "").toLowerCase();
  if (!env.TRUSTED_PROXIES.includes(peer)) return false;
  const xfp = (req.headers["x-forwarded-proto"] as string | undefined) || "";
  return xfp.split(",")[0]?.trim().toLowerCase() === "https";
}

/** Build the Set-Cookie value for a freshly-signed dashboard session. */
function buildSessionCookie(req: IncomingMessage, signedValue: string): string {
  const parts = [
    `${DASHBOARD_COOKIE}=${signedValue}`,
    "Path=/api/dashboard",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_SEC}`,
  ];
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

/** Build the Set-Cookie value to clear the dashboard session. */
function buildClearCookie(req: IncomingMessage): string {
  const parts = [
    `${DASHBOARD_COOKIE}=`,
    "Path=/api/dashboard",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Resolve a session cookie to a live agent. Returns null if the signature is
 * bad, the cookie is expired, the agent no longer exists, the agent is
 * deactivated, or the agent's type is not dashboard-eligible.
 */
function authFromSessionCookie(req: IncomingMessage): DashboardAuth | null {
  const cookies = parseCookies(req.headers["cookie"] as string | undefined);
  const value = cookies[DASHBOARD_COOKIE];
  if (!value) return null;
  const agent_id = verifySession(value);
  if (!agent_id) return null;
  const row = db
    .prepare(
      `SELECT id, workspace_id, type, active FROM agents WHERE id = ?`,
    )
    .get(agent_id) as
    | {
        id: string;
        workspace_id: string;
        type: string;
        active: number;
      }
    | undefined;
  if (!row || !row.active) return null;
  if (!ALLOWED_TYPES.has(row.type)) return null;
  return {
    workspace_id: row.workspace_id,
    agent_id: row.id,
    type: row.type,
    isAdmin: ADMIN_TYPES.has(row.type),
  };
}

/**
 * Authenticate dashboard requests. Authorization: Bearer is the primary path
 * (curl, scripts, the login flow). The signed `qoopia_dash` cookie is the
 * fallback used only by the browser dashboard. Both go through the same
 * eligibility filter (steward/standard/claude-privileged).
 */
export function checkDashboardAuth(req: IncomingMessage): DashboardAuth | null {
  const header = (req.headers["authorization"] as string | undefined) || "";
  if (header) {
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
  // No Authorization header — fall back to the signed session cookie.
  return authFromSessionCookie(req);
}

/**
 * Origin guard for the POST endpoints (/login, /logout). If Origin or Referer
 * is present, it must match either env.PUBLIC_URL or the request's own Host
 * (for tests / local dev where PUBLIC_URL is set to a domain we aren't
 * actually serving from). If neither header is present (curl), we allow the
 * request — the Bearer in Authorization is itself proof of authenticity, and
 * forcing CSRF tokens on a non-browser caller would just push people back
 * onto the cookie path we are trying to harden.
 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = (req.headers["origin"] as string | undefined) || "";
  const referer = (req.headers["referer"] as string | undefined) || "";
  if (!origin && !referer) return true;
  const host = (req.headers["host"] as string | undefined) || "";
  const allowed: string[] = [];
  try {
    allowed.push(new URL(env.PUBLIC_URL).origin);
  } catch {
    /* PUBLIC_URL malformed — ignore */
  }
  if (host) {
    allowed.push(`http://${host}`);
    allowed.push(`https://${host}`);
  }
  const candidates = [origin, referer].filter(Boolean);
  for (const c of candidates) {
    let cOrigin: string;
    try {
      cOrigin = new URL(c).origin;
    } catch {
      return false;
    }
    if (!allowed.includes(cOrigin)) return false;
  }
  return true;
}

/**
 * POST /api/dashboard/login — validates the Bearer in the Authorization
 * header, then replies 200 with Set-Cookie carrying a signed session payload
 * (NOT the Bearer itself). The cookie payload is `{agent_id, exp}` HMAC'd
 * with the server-side session key; verification on later requests resolves
 * the agent_id back to a live DB row, so deactivating the agent invalidates
 * any outstanding cookie immediately.
 *
 * QDASHCOOKIE-001: cookie minting is restricted to static `api_key`
 * Bearers. Accepting OAuth access tokens here would let a 1h OAuth token
 * be exchanged for a 24h dashboard cookie that survives OAuth token
 * revocation (the cookie does not carry a back-pointer to the token row).
 * Mixing OAuth into dashboard sessions is a separate auth-semantics
 * decision that requires explicit TTL/revocation binding; not in this PR.
 */
function loginHandler(req: IncomingMessage, res: ServerResponse) {
  if (!originAllowed(req)) {
    json(res, 403, {
      error: "forbidden",
      error_description: "Origin not allowed for /api/dashboard/login.",
    });
    return;
  }
  const header = (req.headers["authorization"] as string | undefined) || "";
  if (!header) {
    json(res, 401, {
      error: "unauthorized",
      error_description:
        "Login requires Authorization: Bearer <agent_api_key> with steward/standard/claude-privileged scope.",
    });
    return;
  }

  // Resolve the Bearer directly so we can inspect `auth.source`.
  // checkDashboardAuth() collapses source down to a DashboardAuth, which
  // would let an OAuth access token mint a 24h cookie — explicitly
  // rejected here.
  const fetchReq = new Request("http://local/", {
    headers: { authorization: header },
  });
  const auth = authenticate(fetchReq);
  if (!auth) {
    json(res, 401, {
      error: "unauthorized",
      error_description:
        "Bearer token rejected (unknown, inactive, or wrong agent type).",
    });
    return;
  }
  if (auth.source !== "api-key") {
    // Do NOT issue Set-Cookie. Do NOT echo the source back in the body
    // either (don't help an attacker fingerprint the token type).
    json(res, 401, {
      error: "unauthorized",
      error_description:
        "Dashboard cookie can only be minted from a static agent api_key. OAuth access tokens are not accepted at this endpoint.",
    });
    return;
  }
  if (!ALLOWED_TYPES.has(auth.type)) {
    json(res, 401, {
      error: "unauthorized",
      error_description:
        "Bearer token rejected (unknown, inactive, or wrong agent type).",
    });
    return;
  }
  const dashAuth: DashboardAuth = {
    workspace_id: auth.workspace_id,
    agent_id: auth.agent_id,
    type: auth.type,
    isAdmin: ADMIN_TYPES.has(auth.type),
  };
  const cookie = buildSessionCookie(req, signSession(dashAuth.agent_id));
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "set-cookie": cookie,
  });
  res.end(
    JSON.stringify({
      ok: true,
      agent_id: dashAuth.agent_id,
      type: dashAuth.type,
      isAdmin: dashAuth.isAdmin,
      expires_in: SESSION_TTL_SEC,
    }),
  );
}

/**
 * POST /api/dashboard/logout — unconditionally clears the session cookie.
 * Idempotent and unauthenticated by design (worst case is an attacker logs
 * the user out — annoyance, not breach). Origin guard still applies so a
 * cross-site form submission cannot trigger it silently.
 */
function logoutHandler(req: IncomingMessage, res: ServerResponse) {
  if (!originAllowed(req)) {
    json(res, 403, {
      error: "forbidden",
      error_description: "Origin not allowed for /api/dashboard/logout.",
    });
    return;
  }
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "set-cookie": buildClearCookie(req),
  });
  res.end(JSON.stringify({ ok: true }));
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
  const method = (req.method || "GET").toUpperCase();
  const u = new URL(url, "http://local");
  const path = u.pathname;

  // Auth POST endpoints — handled before the GET-only gate. They must NOT
  // require a valid session (login is what produces one; logout is idempotent
  // and unauthenticated by design). Origin checks live inside each handler.
  if (path === "/api/dashboard/login") {
    if (method !== "POST") {
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }
    loginHandler(req, res);
    return true;
  }
  if (path === "/api/dashboard/logout") {
    if (method !== "POST") {
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }
    logoutHandler(req, res);
    return true;
  }

  if (method !== "GET") {
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
