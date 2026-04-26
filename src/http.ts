import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp/server.ts";
import { handleDashboardApi } from "./dashboard-api.ts";
import { authenticate, type AuthContext } from "./auth/middleware.ts";
import { getAllowlist } from "./admin/claude-agents.ts";
import { saveMessage } from "./services/sessions.ts";
import {
  wellKnownAuthorizationServer,
  wellKnownProtectedResource,
  createAuthorizationCode,
  exchangeCodeForTokens,
  refreshTokens,
  revokeTokenForClient,
  registerClient,
  getClient,
  clientWorkspace,
} from "./auth/oauth.ts";
import { db } from "./db/connection.ts";
import { env } from "./utils/env.ts";
import { logger } from "./utils/logger.ts";
import {
  globalLimiter,
  mcpLimiter,
  ingestLimiter,
  dashboardLimiter,
  authLimiter,
  type RateLimiter,
} from "./utils/rate-limit.ts";
import { audit } from "./utils/audit.ts";

// --- OAuth consent nonces ---
// Server-generated one-time nonces for the consent form POST.
// Keyed by nonce string, value holds the pending authorization parameters.
interface ConsentNonce {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  scope: string;
  expires: number; // unix ms
}
const consentNonces = new Map<string, ConsentNonce>();
const NONCE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function pruneNonces() {
  const now = Date.now();
  for (const [k, v] of consentNonces) {
    if (v.expires < now) consentNonces.delete(k);
  }
}

// --- CORS allowlist ---
const ALLOWED_ORIGINS = new Set([
  "https://claude.ai",
  "https://www.claude.ai",
  "https://console.anthropic.com",
]);

function getAllowedOrigin(req: IncomingMessage): string {
  const origin = req.headers.origin;
  if (!origin) return "";
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return "";
}

// --- Auth context per-request (no module-level variable, no race condition) ---
const authStorage = new AsyncLocalStorage<AuthContext>();

export function getCurrentAuth(): AuthContext | null {
  return authStorage.getStore() ?? null;
}

// --- Client IP extraction ---
// Trust proxy-hop headers ONLY when TRUST_PROXY=true AND the connection arrives
// from one of TRUSTED_PROXIES (default: loopback). Иначе — socket address, чтобы
// предотвратить header spoofing от сетевого атакующего.
const TRUSTED_PROXIES_SET = new Set(env.TRUSTED_PROXIES);
function getClientIp(req: IncomingMessage): string {
  const remote = req.socket?.remoteAddress || "unknown";
  if (env.TRUST_PROXY && TRUSTED_PROXIES_SET.has(remote)) {
    return (
      (req.headers["cf-connecting-ip"] as string) ||
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      remote
    );
  }
  // Direct connection, untrusted source, or TRUST_PROXY=false — socket only
  return remote;
}

/**
 * Single Node http server hosts:
 *  - /mcp                                (Streamable HTTP MCP, stateless mode)
 *  - /health                             (health check)
 *  - /.well-known/oauth-authorization-server
 *  - /.well-known/oauth-protected-resource
 *  - /oauth/authorize                    (PKCE code flow)
 *  - /oauth/token
 *  - /oauth/revoke
 *
 * We use node:http (via Bun's Node compat) because the MCP SDK's
 * StreamableHTTPServerTransport is built around IncomingMessage/ServerResponse.
 * This keeps the transport layer tiny — we don't reimplement Streamable HTTP.
 */

interface NodeReqWithBody extends IncomingMessage {
  _body?: Buffer;
}

const MAX_BODY_BYTES = 1_048_576; // 1 MB

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      req.destroy();
      throw new Error("payload_too_large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, body: unknown, req?: IncomingMessage) {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
    "x-content-type-options": "nosniff",
  };
  if (req) {
    const origin = getAllowedOrigin(req);
    if (origin) {
      headers["access-control-allow-origin"] = origin;
      headers["vary"] = "Origin";
    }
  }
  res.writeHead(status, headers);
  res.end(payload);
}

function text(res: ServerResponse, status: number, body: string, req?: IncomingMessage) {
  const headers: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
  };
  if (req) {
    const origin = getAllowedOrigin(req);
    if (origin) {
      headers["access-control-allow-origin"] = origin;
      headers["vary"] = "Origin";
    }
  }
  res.writeHead(status, headers);
  res.end(body);
}

function nodeReqToFetchRequest(req: IncomingMessage, body?: Buffer): Request {
  const url = `http://local${req.url || "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) headers.set(k, v.join(", "));
    else if (typeof v === "string") headers.set(k, v);
  }
  const init: RequestInit = {
    method: req.method || "GET",
    headers,
  };
  if (body && body.length > 0 && req.method !== "GET" && req.method !== "HEAD") {
    init.body = body;
  }
  return new Request(url, init);
}

export function startHttpServer() {
  const httpServer = createServer(async (req, res) => {
    try {
      await handleRequest(req as NodeReqWithBody, res);
    } catch (err) {
      const msg = (err as Error).message || "";
      if (!res.headersSent) {
        if (msg === "payload_too_large") {
          json(res, 413, { error: "payload_too_large", max_bytes: MAX_BODY_BYTES });
        } else {
          logger.error("Request handler failed", { error: String(err) });
          json(res, 500, { error: "internal_error" });
        }
      }
    }
  });

  httpServer.listen(env.PORT, env.HOST, () => {
    const addr = httpServer.address();
    const boundPort =
      addr && typeof addr === "object" ? addr.port : env.PORT;
    logger.info(`Qoopia V3.0 listening on http://${env.HOST}:${boundPort}`);
    if (env.HOST !== "127.0.0.1" && env.HOST !== "::1" && env.HOST !== "localhost") {
      logger.warn(
        `QOOPIA_HOST=${env.HOST} — server is reachable beyond loopback. ` +
          `Ensure firewall/tunnel ACLs are in place; OAuth + Bearer endpoints assume trusted network.`,
      );
    }
  });

  return httpServer;
}

/**
 * Per-route rate-limit guard. Returns true если лимит превышен и 429 уже
 * отправлен — вызывающий должен сразу return.
 */
function rateLimit429(
  limiter: RateLimiter,
  scope: string,
  clientIp: string,
  res: ServerResponse,
): boolean {
  if (limiter.allow(clientIp)) return false;
  audit({ event: "rate_limit_trigger", result: "deny", ip: clientIp, scope });
  res.writeHead(429, {
    "content-type": "application/json",
    "retry-after": String(limiter.retryAfterSec(clientIp)),
  });
  res.end(JSON.stringify({ error: "too_many_requests", scope }));
  return true;
}

async function handleRequest(req: NodeReqWithBody, res: ServerResponse) {
  const url = req.url || "/";
  const method = (req.method || "GET").toUpperCase();
  const clientIp = getClientIp(req);

  // CORS preflight
  if (method === "OPTIONS") {
    const origin = getAllowedOrigin(req);
    const headers: Record<string, string> = {
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, mcp-session-id",
      "access-control-max-age": "86400",
    };
    if (origin) {
      headers["access-control-allow-origin"] = origin;
      headers["vary"] = "Origin";
    }
    res.writeHead(204, headers);
    res.end();
    return;
  }

  // --- Global safety-net rate limit (1000 req/min per IP) ---
  // Per-route limiters (mcp/ingest/dashboard/auth) срабатывают в своих хэндлерах.
  if (!globalLimiter.allow(clientIp)) {
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": String(globalLimiter.retryAfterSec(clientIp)),
    });
    res.end(JSON.stringify({ error: "too_many_requests", scope: "global" }));
    return;
  }

  // --- Health ---
  if (url === "/health") {
    return json(res, 200, {
      status: "ok",
      version: "3.0.0",
      uptime: Math.round(process.uptime()),
    }, req);
  }

  if (url === "/") {
    return text(
      res,
      200,
      `Qoopia V3.0 MCP server\nMCP endpoint: ${env.PUBLIC_URL}/mcp\nHealth: ${env.PUBLIC_URL}/health\nDashboard: ${env.PUBLIC_URL}/dashboard\n`,
      req,
    );
  }

  // --- Dashboard ---
  if (url === "/dashboard") {
    return serveDashboard(res);
  }

  // --- OAuth discovery ---
  if (url === "/.well-known/oauth-authorization-server") {
    return json(res, 200, wellKnownAuthorizationServer(), req);
  }
  if (url.startsWith("/.well-known/oauth-protected-resource")) {
    return json(res, 200, wellKnownProtectedResource(), req);
  }

  // --- OAuth endpoints (stricter: 20 req/min per IP) ---
  if (url.startsWith("/oauth/authorize") && method === "GET") {
    if (rateLimit429(authLimiter, "auth", clientIp, res)) return;
    return handleAuthorizeGet(req, res);
  }
  if (url === "/oauth/authorize" && method === "POST") {
    if (rateLimit429(authLimiter, "auth", clientIp, res)) return;
    const body = await readBody(req);
    return handleAuthorizePost(req, body, res, clientIp);
  }
  if (url === "/oauth/token" && method === "POST") {
    if (rateLimit429(authLimiter, "auth", clientIp, res)) return;
    const body = await readBody(req);
    return handleToken(body, res);
  }
  if (url === "/oauth/register" && method === "POST") {
    if (rateLimit429(authLimiter, "auth", clientIp, res)) return;
    // Require admin secret for client registration (prevents anonymous self-service)
    if (!checkAdminSecret(req)) {
      audit({ event: "admin_secret_fail", result: "deny", ip: clientIp, scope: "/oauth/register" });
      return json(res, 401, { error: "unauthorized", error_description: "Admin secret required for client registration" });
    }
    audit({ event: "oauth_register", result: "allow", ip: clientIp });
    const body = await readBody(req);
    return handleRegister(body, res);
  }
  if (url === "/oauth/revoke" && method === "POST") {
    const body = await readBody(req);
    return handleRevoke(body, res);
  }

  // --- Ingest endpoints (ingest-daemon only, 500 req/min per IP) ---
  if (url === "/ingest/allowlist" && method === "GET") {
    if (rateLimit429(ingestLimiter, "ingest", clientIp, res)) return;
    const fetchReq = nodeReqToFetchRequest(req);
    const auth = authenticate(fetchReq);
    if (!auth || auth.type !== "ingest-daemon") {
      audit({ event: "ingest_forbidden", result: "deny", ip: clientIp, scope: "/ingest/allowlist", detail: auth ? `wrong type: ${auth.type}` : "no auth" });
      return json(res, 403, { error: "forbidden", error_description: "ingest-daemon credentials required" }, req);
    }
    // Hard-isolation: каждый tailer получает allowlist только своего workspace.
    return json(res, 200, getAllowlist(auth.workspace_id), req);
  }

  if (url === "/ingest/session" && method === "POST") {
    if (rateLimit429(ingestLimiter, "ingest", clientIp, res)) return;
    const rawBody = await readBody(req);
    const fetchReq = nodeReqToFetchRequest(req, rawBody);
    const auth = authenticate(fetchReq);
    if (!auth || auth.type !== "ingest-daemon") {
      audit({ event: "ingest_forbidden", result: "deny", ip: clientIp, scope: "/ingest/session", detail: auth ? `wrong type: ${auth.type}` : "no auth" });
      return json(res, 403, { error: "forbidden", error_description: "ingest-daemon credentials required" }, req);
    }
    let payload: {
      attributed_agent_id?: string;
      session_id?: string;
      uuid?: string;
      role?: string;
      content?: string;
      timestamp?: string;
      cwd?: string;
      metadata?: Record<string, unknown>;
    };
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return json(res, 400, { error: "invalid_json" }, req);
    }

    const { attributed_agent_id, session_id, uuid, role, content } = payload;
    if (!attributed_agent_id || !session_id || !uuid || !role || !content) {
      return json(res, 400, { error: "missing_fields", required: ["attributed_agent_id", "session_id", "uuid", "role", "content"] }, req);
    }
    if (role !== "user" && role !== "assistant") {
      return json(res, 400, { error: "invalid_role", allowed: ["user", "assistant"] }, req);
    }

    // Resolve the target agent's workspace
    const { db: dbConn } = await import("./db/connection.ts");
    const targetAgent = dbConn
      .prepare(`SELECT workspace_id FROM agents WHERE id = ? AND active = 1`)
      .get(attributed_agent_id) as { workspace_id: string } | undefined;
    if (!targetAgent) {
      return json(res, 404, { error: "agent_not_found", agent_id: attributed_agent_id }, req);
    }

    // Hard-isolation guard: ingest-daemon token привязан к своему workspace,
    // запись в чужой workspace запрещена даже если attacker угадал чужой agent ULID.
    if (targetAgent.workspace_id !== auth.workspace_id) {
      audit({
        event: "workspace_mismatch",
        result: "deny",
        ip: clientIp,
        workspace_id: auth.workspace_id,
        agent_id: attributed_agent_id,
        detail: `caller workspace ${auth.workspace_id} tried to write to agent's workspace ${targetAgent.workspace_id}`,
      });
      return json(res, 403, { error: "workspace_mismatch", error_description: "ingest token workspace does not match target agent workspace" }, req);
    }

    try {
      const result = saveMessage({
        workspace_id: targetAgent.workspace_id,
        agent_id: attributed_agent_id,
        session_id,
        role: role as "user" | "assistant",
        content,
        ingest_uuid: uuid,
        metadata: { ingest_cwd: payload.cwd ?? "", ingest_ts: payload.timestamp ?? "", ...(payload.metadata ?? {}) },
      });
      return json(res, 200, result, req);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "FORBIDDEN") return json(res, 409, { error: "session_conflict", detail: e.message }, req);
      if (e.code === "INVALID_INPUT") return json(res, 400, { error: "invalid_input", detail: e.message }, req);
      throw err;
    }
  }

  // --- Dashboard API (read-only, 200 req/min per IP) ---
  if (url.startsWith("/api/dashboard")) {
    if (rateLimit429(dashboardLimiter, "dashboard", clientIp, res)) return;
    if (handleDashboardApi(req, res)) return;
  }

  // --- MCP endpoint (300 req/min per IP) ---
  if (url === "/mcp" || url.startsWith("/mcp?")) {
    if (rateLimit429(mcpLimiter, "mcp", clientIp, res)) return;
    return handleMcp(req, res);
  }

  return json(res, 404, { error: "not_found" }, req);
}

// ---------- Dashboard ----------

let dashboardHtml: string | null = null;

function serveDashboard(res: ServerResponse) {
  if (!dashboardHtml) {
    try {
      // Resolve path relative to this source file
      const thisDir = typeof __dirname !== "undefined"
        ? __dirname
        : dirname(fileURLToPath(import.meta.url));
      dashboardHtml = readFileSync(join(thisDir, "public", "dashboard.html"), "utf8");
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Dashboard not found");
      return;
    }
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
  });
  res.end(dashboardHtml);
}

// ---------- MCP handler ----------

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  const method = (req.method || "GET").toUpperCase();

  // Authenticate
  const body = method === "GET" || method === "DELETE" ? undefined : await readBody(req);
  const fetchReq = nodeReqToFetchRequest(req, body);
  const auth = authenticate(fetchReq);
  if (!auth) {
    res.writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": `Bearer realm="qoopia", resource_metadata="${env.PUBLIC_URL}/.well-known/oauth-protected-resource"`,
    });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  // Access log: parse JSON-RPC method/tool name from body for debugging.
  if (body && body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      const rpcMethod = parsed.method;
      let detail = "";
      if (rpcMethod === "tools/call" && parsed.params?.name) {
        detail = ` tool=${parsed.params.name}`;
      }
      logger.info(
        `MCP ${rpcMethod || "?"}${detail} agent=${auth.agent_name} (${auth.source})`,
      );
    } catch {
      // ignore — body may be batched or non-json
    }
  }

  // Run inside AsyncLocalStorage so concurrent requests never share auth context
  await authStorage.run(auth, async () => {
    const server = createMcpServer(() => getCurrentAuth(), "full", {
      isSteward: auth.type === "steward",
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      try { transport.close(); } catch {}
      try { server.close(); } catch {}
    });

    await server.connect(transport);
    let parsedBody: unknown;
    if (body && body.length > 0) {
      try {
        parsedBody = JSON.parse(body.toString("utf8"));
      } catch {
        return json(res, 400, { error: "invalid_json", message: "Request body is not valid JSON" }, req);
      }
    }
    await transport.handleRequest(req, res, parsedBody);
  });
}

// ---------- OAuth handlers ----------

/**
 * Check that the request carries the admin secret (Bearer or X-Admin-Secret header).
 * If ADMIN_SECRET is not configured, returns false (deny-by-default).
 */
function checkAdminSecret(req: IncomingMessage): boolean {
  if (!env.ADMIN_SECRET) return false;
  const expected = Buffer.from(env.ADMIN_SECRET);
  const authHeader = req.headers["authorization"] as string | undefined;
  if (authHeader) {
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (bearer) {
      const provided = Buffer.from(bearer);
      if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) return true;
    }
  }
  const xSecret = req.headers["x-admin-secret"] as string | undefined;
  if (xSecret) {
    const provided = Buffer.from(xSecret);
    if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) return true;
  }
  return false;
}

function parseForm(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  const s = body.toString("utf8");
  for (const pair of s.split("&")) {
    const [k, v = ""] = pair.split("=");
    if (!k) continue;
    let key: string;
    let val: string;
    try {
      key = decodeURIComponent(k);
      val = decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      // Malformed percent-encoding — throw controlled 400 (caught by callers)
      throw Object.assign(new Error("invalid_request"), { statusCode: 400 });
    }
    out[key] = val;
  }
  return out;
}

/**
 * Single-user OAuth flow:
 *  GET /oauth/authorize  →  validate params + show consent HTML.
 *  POST /oauth/authorize →  on approve, issue code (auto-approve since
 *                           the only "user" of this server is the workspace
 *                           owner — no login UI).
 *
 * No agent_key needed: the client must be registered first via
 * POST /oauth/register (RFC 7591). On consent we look up which agent the
 * client belongs to and issue tokens for that agent's workspace.
 */
async function handleAuthorizeGet(req: IncomingMessage, res: ServerResponse) {
  const u = new URL(req.url || "/", env.PUBLIC_URL);
  const clientId = u.searchParams.get("client_id");
  const redirectUri = u.searchParams.get("redirect_uri");
  const responseType = u.searchParams.get("response_type");
  const codeChallenge = u.searchParams.get("code_challenge");
  const codeChallengeMethod = u.searchParams.get("code_challenge_method") || "S256";
  const state = u.searchParams.get("state") || "";
  const scope = u.searchParams.get("scope") || "";

  if (!clientId || !redirectUri || responseType !== "code" || !codeChallenge) {
    return json(res, 400, {
      error: "invalid_request",
      error_description:
        "Missing required: client_id, redirect_uri, response_type=code, code_challenge",
    });
  }
  if (codeChallengeMethod !== "S256") {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "Only S256 code_challenge_method is supported",
    });
  }

  const client = getClient(clientId);
  if (!client) {
    return json(res, 400, {
      error: "invalid_client",
      error_description: "Unknown client_id — register first via /oauth/register",
    });
  }
  if (!client.redirect_uris.includes(redirectUri)) {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "redirect_uri not registered for this client",
    });
  }

  // Generate a one-time nonce that authenticates the consent POST without
  // requiring the admin secret in the browser form (fix for audit issue #1).
  pruneNonces();
  const nonce = crypto.randomUUID();
  consentNonces.set(nonce, {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    state,
    scope,
    expires: Date.now() + NONCE_TTL_MS,
  });

  const safeName = escapeHtml(client.name || "Unknown Client");
  // QSEC-002: when ADMIN_SECRET is configured we require the owner to type
  // it in before issuing a code. This protects against an attacker who
  // discovers a registered client_id+redirect_uri and walks the consent
  // page anonymously.
  const requireOwnerSecret = !!env.ADMIN_SECRET;
  const ownerSecretField = requireOwnerSecret
    ? `
      <div class="secret">
        <label for="admin_secret">Admin secret</label>
        <input type="password" id="admin_secret" name="admin_secret" autocomplete="current-password" required>
      </div>`
    : "";
  const ownerSecretNote = requireOwnerSecret
    ? `<p class="info">Enter the workspace ADMIN_SECRET to confirm you are the owner.</p>`
    : `<p class="info warn">QOOPIA_ADMIN_SECRET is not set; consent is gated by loopback origin only. Set the secret before exposing OAuth via tunnel/LAN.</p>`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize — Qoopia</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0f; color: #e0e0e0; }
    .card { background: #1a1a2e; border-radius: 16px; padding: 40px; max-width: 420px; width: 90%; text-align: center; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
    .logo { font-size: 32px; margin-bottom: 16px; }
    h1 { font-size: 20px; margin: 0 0 8px; }
    .client { color: #7c8aff; font-weight: 600; }
    .info { color: #888; font-size: 14px; margin: 16px 0 24px; }
    .info.warn { color: #ffb37c; }
    .secret { margin: 0 0 20px; text-align: left; }
    .secret label { display:block; font-size: 12px; color:#888; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 1px; }
    .secret input { width: 100%; padding: 10px 12px; box-sizing: border-box; border-radius: 8px; border: 1px solid #2a2a3e; background: #0f0f1c; color: #e0e0e0; font-size: 14px; }
    .actions { display: flex; gap: 12px; justify-content: center; }
    button { padding: 12px 32px; border-radius: 8px; border: none; font-size: 16px; font-weight: 600; cursor: pointer; }
    button:hover { opacity: 0.85; }
    .approve { background: #7c8aff; color: #fff; }
    .deny { background: #2a2a3e; color: #888; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🔑</div>
    <h1>Authorize access</h1>
    <p><span class="client">${safeName}</span> wants to connect to Qoopia</p>
    ${ownerSecretNote}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="nonce" value="${escapeHtml(nonce)}">${ownerSecretField}
      <div class="actions">
        <button type="submit" name="action" value="deny" class="deny">Deny</button>
        <button type="submit" name="action" value="approve" class="approve">Approve</button>
      </div>
    </form>
  </div>
</body>
</html>`;
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

/**
 * QSEC-002: ensure the consent POST is coming from the workspace owner.
 * Two acceptable proofs:
 *   1. Form field `admin_secret` matches env.ADMIN_SECRET (constant-time).
 *   2. ADMIN_SECRET is unset AND the request originates from a loopback
 *      socket (single-machine dev install with no tunnel/LAN exposure).
 *
 * Note: when running behind cloudflared the socket is always 127.0.0.1, so
 * tunnel deployments MUST set QOOPIA_ADMIN_SECRET. This is intentional —
 * we want failure-loud rather than silent auto-approval.
 */
function isLoopbackSocket(req: IncomingMessage): boolean {
  const ra = req.socket.remoteAddress || "";
  return ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
}

function verifyConsentSecret(formSecret: string | undefined): boolean {
  if (!env.ADMIN_SECRET) return false;
  if (!formSecret) return false;
  const expected = Buffer.from(env.ADMIN_SECRET);
  const provided = Buffer.from(formSecret);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

function handleAuthorizePost(
  req: IncomingMessage,
  body: Buffer,
  res: ServerResponse,
  clientIp: string,
) {
  let form: Record<string, string>;
  try {
    form = parseForm(body);
  } catch {
    return json(res, 400, { error: "invalid_request", error_description: "malformed form body" });
  }
  const action = form.action || "approve";
  const nonce = form.nonce;

  // Validate one-time nonce — protects against CSRF on the consent form.
  if (!nonce) {
    return json(res, 400, { error: "invalid_request", error_description: "Missing nonce" });
  }
  pruneNonces();
  const pending = consentNonces.get(nonce);
  if (!pending) {
    return json(res, 400, { error: "invalid_request", error_description: "Invalid or expired nonce" });
  }
  // Consume nonce immediately (one-time use)
  consentNonces.delete(nonce);

  const { clientId, redirectUri, codeChallenge, codeChallengeMethod, state } = pending;

  if (action === "deny") {
    audit({
      event: "oauth_consent",
      result: "deny",
      ip: clientIp,
      detail: `client=${clientId} action=deny`,
    });
    const url = new URL(redirectUri);
    url.searchParams.set("error", "access_denied");
    if (state) url.searchParams.set("state", state);
    res.writeHead(302, { location: url.toString() });
    return res.end();
  }

  // QSEC-002: gate the approve path on owner proof.
  const secretOk = verifyConsentSecret(form.admin_secret);
  const loopbackOk = !env.ADMIN_SECRET && isLoopbackSocket(req);
  if (!secretOk && !loopbackOk) {
    audit({
      event: "oauth_consent",
      result: "deny",
      ip: clientIp,
      detail: env.ADMIN_SECRET
        ? `client=${clientId} reason=admin_secret_missing_or_invalid`
        : `client=${clientId} reason=non_loopback_no_admin_secret`,
    });
    return json(res, 401, {
      error: "access_denied",
      error_description: env.ADMIN_SECRET
        ? "Owner consent required: admin_secret missing or invalid."
        : "Owner consent required: set QOOPIA_ADMIN_SECRET when serving OAuth from tunnel/LAN.",
    });
  }

  // Resolve client → agent → workspace, issue code
  const client = getClient(clientId);
  if (!client) {
    return json(res, 400, { error: "invalid_client" });
  }
  const ws = clientWorkspace(clientId);
  if (!ws) {
    return json(res, 500, {
      error: "server_error",
      error_description: "Client has no associated agent",
    });
  }

  const code = createAuthorizationCode({
    clientId,
    agentId: ws.agent_id,
    workspaceId: ws.workspace_id,
    codeChallenge,
    codeChallengeMethod,
    redirectUri,
  });
  audit({
    event: "oauth_consent",
    result: "allow",
    ip: clientIp,
    workspace_id: ws.workspace_id,
    agent_id: ws.agent_id,
    detail: `client=${clientId} via=${secretOk ? "admin_secret" : "loopback"}`,
  });
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.writeHead(302, {
    location: url.toString(),
    "cache-control": "no-store",
  });
  res.end();
}

function handleRegister(body: Buffer, res: ServerResponse) {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "Body must be JSON",
    });
  }
  try {
    const out = registerClient({
      client_name: parsed.client_name as string | undefined,
      redirect_uris: parsed.redirect_uris as string[],
      token_endpoint_auth_method:
        parsed.token_endpoint_auth_method as string | undefined,
      grant_types: parsed.grant_types as string[] | undefined,
      response_types: parsed.response_types as string[] | undefined,
    });
    logger.info(
      `OAuth register client_id=${out.client_id} name="${out.client_name}" auth=${out.token_endpoint_auth_method}`,
    );
    res.writeHead(201, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(
      JSON.stringify({
        ...out,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        ...(out.client_secret ? { client_secret_expires_at: 0 } : {}),
      }),
    );
  } catch (err) {
    return json(res, 400, {
      error: "invalid_request",
      error_description: err instanceof Error ? err.message : String(err),
    });
  }
}

function jsonToken(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
    "cache-control": "no-store",
    "pragma": "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function handleToken(body: Buffer, res: ServerResponse) {
  let form: Record<string, string>;
  try {
    form = parseForm(body);
  } catch {
    return jsonToken(res, 400, { error: "invalid_request" });
  }
  const grantType = form.grant_type;
  try {
    if (grantType === "authorization_code") {
      if (!form.code || !form.code_verifier || !form.redirect_uri || !form.client_id) {
        return jsonToken(res, 400, { error: "invalid_request" });
      }
      const out = exchangeCodeForTokens({
        code: form.code,
        codeVerifier: form.code_verifier,
        redirectUri: form.redirect_uri,
        clientId: form.client_id,
        clientSecret: form.client_secret,
      });
      return jsonToken(res, 200, {
        access_token: out.access,
        refresh_token: out.refresh,
        token_type: "Bearer",
        expires_in: out.expiresInSec,
      });
    }
    if (grantType === "refresh_token") {
      if (!form.refresh_token || !form.client_id) {
        return jsonToken(res, 400, { error: "invalid_request" });
      }
      const out = refreshTokens({
        refreshToken: form.refresh_token,
        clientId: form.client_id,
        clientSecret: form.client_secret,
      });
      return jsonToken(res, 200, {
        access_token: out.access,
        refresh_token: out.refresh,
        token_type: "Bearer",
        expires_in: out.expiresInSec,
      });
    }
    return jsonToken(res, 400, { error: "unsupported_grant_type" });
  } catch (err) {
    return jsonToken(res, 400, { error: (err as Error).message || "invalid_grant" });
  }
}

function handleRevoke(body: Buffer, res: ServerResponse) {
  let form: Record<string, string>;
  try {
    form = parseForm(body);
  } catch {
    return json(res, 400, { error: "invalid_request", error_description: "malformed form body" });
  }
  const token = form.token;
  const clientId = form.client_id;
  if (!token) return json(res, 400, { error: "invalid_request", error_description: "token is required" });
  if (!clientId) return json(res, 400, { error: "invalid_request", error_description: "client_id is required" });
  // Per RFC 7009: confidential clients must supply client_secret.
  // revokeTokenForClient validates the secret and throws "invalid_client" if wrong.
  try {
    const revoked = revokeTokenForClient(token, clientId, form.client_secret);
    // RFC 7009 §2.2: always return 200 even if token was not found (avoid enumeration)
    return json(res, 200, { revoked });
  } catch (err) {
    const msg = (err as Error).message || "";
    if (msg === "invalid_client") {
      return json(res, 401, { error: "invalid_client", error_description: "Client authentication failed" });
    }
    return json(res, 500, { error: "server_error" });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
