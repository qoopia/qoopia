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
 *   The cookie value is a server-signed `{agent_id, sv, exp}` payload —
 *   `base64url(JSON) "." base64url(HMAC-SHA256)` — NOT the raw Bearer.
 *   `sv` is the agent's `session_version` snapshot at login.
 *   Cookie minting is restricted to static `api_key` Bearers (see
 *   loginHandler / QDASHCOOKIE-001 fix). OAuth access tokens are NOT
 *   accepted at /api/dashboard/login: an OAuth token's lifetime and
 *   revocation are managed in `oauth_tokens`, and minting a 24h dashboard
 *   cookie from a 1h OAuth token would silently extend its blast radius.
 *
 *   Cookie revocation surface (post-#34):
 *     • agent deactivation (per-request `active=1` DB check + sv bump),
 *     • api_key rotation (`rotateAgentKey()` increments
 *       `agents.session_version`; outstanding cookies fail the sv check),
 *     • rotation of `QOOPIA_SESSION_SECRET` (or process restart on the
 *       ephemeral fallback key) — invalidates every outstanding cookie,
 *     • cookie expiry (24h Max-Age + payload `exp`).
 *
 *   Tag comparison uses `crypto.timingSafeEqual` over fixed-length raw
 *   HMAC buffers (32 bytes); tags that don't decode to exactly 32 bytes
 *   are rejected before the compare runs (QDASHCOOKIE-003).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, randomBytes, timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import { db } from "./db/connection.ts";
import { authenticate, type AuthContext } from "./auth/middleware.ts";
import { sha256Hex } from "./auth/api-keys.ts";
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
  /**
   * Codex QSA-H (2026-04-28): how this dashboard auth was established.
   * - "api-key": static Bearer api_* (curl, scripts, login flow, tests)
   * - "oauth": OAuth access token reaching the dashboard via the Bearer fallback
   * - "cookie": signed qoopia_dash session (the browser dashboard)
   *
   * The OAuth bridge consent surface uses this to fail closed on OAuth tokens —
   * otherwise an OAuth bearer could fetch the consent page, read the nonce, and
   * self-approve new tickets, defeating the whole bridge pattern.
   */
  source: "api-key" | "oauth" | "cookie";
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

/**
 * Length of the HMAC-SHA256 tag in bytes. Pinned so a malformed cookie
 * (truncated/extended tag) is rejected before reaching `timingSafeEqual`,
 * which throws on length mismatch.
 */
const HMAC_TAG_BYTES = 32;

/**
 * Constant-time buffer compare wrapper. Returns false for any size
 * mismatch (instead of throwing, which `crypto.timingSafeEqual` does)
 * and otherwise delegates to the platform implementation. Length check
 * is intentionally branch-on-length-only so we don't leak content via
 * differential timing once we're past it.
 */
function buffersEqualConstantTime(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return cryptoTimingSafeEqual(a, b);
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
  /** Agent the cookie was minted for. */
  agent_id: string;
  /** session_version snapshot at login. Bumped by rotateAgentKey() and
   *  deleteAgent(). Mismatch with the live row → 401 (QDASHCOOKIE-002). */
  sv: number;
  /** Expiry (unix seconds). Validated against system clock. */
  exp: number;
}

/**
 * Build a signed session cookie value. Format:
 *   base64url(JSON({agent_id, sv, exp})) "." base64url(HMAC-SHA256(payload))
 *
 * The HMAC is computed over the base64url-encoded payload (not the raw
 * JSON), so a verifier never has to re-canonicalise JSON before comparing.
 * No raw Bearer token is ever stored in or derivable from this value.
 */
function signSession(
  agent_id: string,
  session_version: number,
  ttlSec = SESSION_TTL_SEC,
): string {
  const payload: SessionPayload = {
    agent_id,
    sv: session_version,
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  };
  const payloadB64 = b64uEncode(JSON.stringify(payload));
  const tag = createHmac("sha256", sessionKey()).update(payloadB64).digest();
  const tagB64 = b64uEncode(tag);
  return `${payloadB64}.${tagB64}`;
}

/**
 * Verify a signed session cookie. Returns the parsed payload on success,
 * null on any failure (malformed, bad HMAC, expired, bad shape). Does NOT
 * consult the DB — the caller still resolves the agent row so a
 * deactivated/deleted/rotated agent cannot ride a stale-but-signed cookie.
 *
 * QDASHCOOKIE-003: tag comparison goes through `crypto.timingSafeEqual`
 * over fixed-length raw HMAC buffers, not a hand-rolled string compare.
 * Tags that don't decode to exactly 32 bytes are rejected before the
 * compare runs.
 */
function verifySession(value: string): { agent_id: string; sv: number } | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const payloadB64 = value.slice(0, dot);
  const tagB64 = value.slice(dot + 1);

  // Decode the supplied tag; reject anything that is not exactly 32 bytes.
  let actualTag: Buffer;
  try {
    actualTag = b64uDecode(tagB64);
  } catch {
    return null;
  }
  if (actualTag.length !== HMAC_TAG_BYTES) return null;

  // Recompute the expected tag and compare in constant time.
  const expectedTag = createHmac("sha256", sessionKey())
    .update(payloadB64)
    .digest();
  if (!buffersEqualConstantTime(expectedTag, actualTag)) return null;

  // Signature is valid — now decode and shape-check the payload.
  let payload: SessionPayload;
  try {
    payload = JSON.parse(b64uDecode(payloadB64).toString("utf8"));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.agent_id !== "string" ||
    typeof payload.sv !== "number" ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    !Number.isFinite(payload.sv) ||
    !Number.isInteger(payload.sv) ||
    payload.sv < 0
  ) {
    return null;
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return { agent_id: payload.agent_id, sv: payload.sv };
}

/**
 * Determine whether the request reached us over HTTPS. Honors x-forwarded-proto
 * only when TRUST_PROXY is enabled and the upstream peer is in TRUSTED_PROXIES
 * — otherwise an attacker on a non-loopback interface could spoof the header
 * and trick us into setting cookies without the Secure flag.
 */
// Exported so http.ts can decide whether to emit HSTS on dashboard /
// /oauth/authorize HTML responses (QSA-G).
export function isHttps(req: IncomingMessage): boolean {
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
  const verified = verifySession(value);
  if (!verified) return null;
  const row = db
    .prepare(
      `SELECT id, workspace_id, type, active, session_version
         FROM agents
        WHERE id = ?`,
    )
    .get(verified.agent_id) as
    | {
        id: string;
        workspace_id: string;
        type: string;
        active: number;
        session_version: number;
      }
    | undefined;
  if (!row || !row.active) return null;
  if (!ALLOWED_TYPES.has(row.type)) return null;
  // QDASHCOOKIE-002: cookie's session_version snapshot must still match
  // the live row. rotateAgentKey() and deleteAgent() bump this, so
  // outstanding cookies fail closed on the next request.
  if (row.session_version !== verified.sv) return null;
  return {
    workspace_id: row.workspace_id,
    agent_id: row.id,
    type: row.type,
    isAdmin: ADMIN_TYPES.has(row.type),
    source: "cookie",
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
      // QSA-H: propagate underlying source so OAuth-sensitive surfaces
      // (the consent bridge) can fail closed on OAuth bearers.
      source: auth.source,
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
export function originAllowed(req: IncomingMessage): boolean {
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
    source: auth.source,
  };
  // QDASHCOOKIE-005: read api_key_hash AND session_version in one SELECT,
  // then constant-time-compare the row's hash to sha256(presented bearer).
  // This binds the cookie's `sv` snapshot to the *exact* api_key_hash the
  // client just proved possession of. If rotateAgentKey() commits between
  // authenticate() above and this read, the row will carry the new hash and
  // the new sv together — the hash compare fails and we 401, instead of
  // signing a cookie with the post-rotation sv from a pre-rotation auth.
  const bearer = header.trim().replace(/^Bearer\s+/i, "").trim();
  const presentedHashHex = sha256Hex(bearer);
  const presentedHashBuf = Buffer.from(presentedHashHex, "hex");
  const snapshotRow = db
    .prepare(
      `SELECT api_key_hash, session_version
         FROM agents
        WHERE id = ? AND active = 1`,
    )
    .get(dashAuth.agent_id) as
    | { api_key_hash: string; session_version: number }
    | undefined;
  if (!snapshotRow) {
    json(res, 401, {
      error: "unauthorized",
      error_description: "Agent record disappeared between auth and login.",
    });
    return;
  }
  const rowHashBuf = Buffer.from(snapshotRow.api_key_hash, "hex");
  if (
    presentedHashBuf.length !== 32 ||
    rowHashBuf.length !== 32 ||
    !buffersEqualConstantTime(presentedHashBuf, rowHashBuf)
  ) {
    // The api_key was rotated mid-flight (row.api_key_hash changed between
    // authenticate() and this re-check). Refuse to mint the cookie — the
    // client must re-login with the new key. The bumped session_version
    // would also kill any cookie we did mint, but we'd rather not mint
    // one at all than rely on the second-line defense.
    json(res, 401, {
      error: "unauthorized",
      error_description:
        "Bearer token rejected (unknown, inactive, or wrong agent type).",
    });
    return;
  }
  const cookie = buildSessionCookie(
    req,
    signSession(dashAuth.agent_id, snapshotRow.session_version),
  );
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
 * POST /api/dashboard/logout — clears the session cookie AND, when the
 * caller presented a verifiable cookie, bumps that agent's
 * `session_version` so any pre-logout copy of the cookie fails the sv
 * check on its next request (server-side revocation).
 *
 * QSA-E / Codex QSA-005 (2026-04-28): the prior implementation only
 * cleared the browser's cookie copy. A copy of the cookie made before
 * logout (e.g. exfiltrated via XSS or a malicious extension) remained
 * valid until expiry / api_key rotation / agent deactivation /
 * session-secret rotation. With this change, a single logout call
 * revokes every outstanding cookie for that agent immediately.
 *
 * Behavior:
 *   - Origin guard still applies (cross-site form submission blocked).
 *   - If the request carries a cookie that we can verify
 *     (signature ok, agent active, sv matches), bump session_version.
 *     The bumped value invalidates the cookie we just verified, plus
 *     any other copy in flight.
 *   - If the cookie is missing, tampered, expired, or already revoked,
 *     we cannot identify the agent and skip the bump. The browser
 *     cookie is still cleared — logout remains idempotent and a 200.
 *   - Unauthenticated by design: an attacker who can replay a valid
 *     cookie to /logout can log the owner out, but that was already
 *     true and is the whole point of revocation.
 */
function logoutHandler(req: IncomingMessage, res: ServerResponse) {
  if (!originAllowed(req)) {
    json(res, 403, {
      error: "forbidden",
      error_description: "Origin not allowed for /api/dashboard/logout.",
    });
    return;
  }

  const auth = authFromSessionCookie(req);
  if (auth) {
    db.prepare(
      `UPDATE agents SET session_version = session_version + 1 WHERE id = ?`,
    ).run(auth.agent_id);
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
