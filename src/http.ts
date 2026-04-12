import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp/server.ts";
import { authenticate, type AuthContext } from "./auth/middleware.ts";
import {
  wellKnownAuthorizationServer,
  wellKnownProtectedResource,
  createAuthorizationCode,
  exchangeCodeForTokens,
  refreshTokens,
  revokeToken,
  registerClient,
  getClient,
  clientWorkspace,
} from "./auth/oauth.ts";
import { db } from "./db/connection.ts";
import { env } from "./utils/env.ts";
import { logger } from "./utils/logger.ts";
import { apiLimiter, authLimiter } from "./utils/rate-limit.ts";

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
function getClientIp(req: IncomingMessage): string {
  return (
    (req.headers["cf-connecting-ip"] as string) ||
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
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

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
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
      logger.error("Request handler failed", { error: String(err) });
      if (!res.headersSent) {
        json(res, 500, { error: "internal_error" });
      }
    }
  });

  httpServer.listen(env.PORT, () => {
    logger.info(`Qoopia V3.0 listening on http://localhost:${env.PORT}`);
  });

  return httpServer;
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

  // --- Rate limiting (general: 100 req/min per IP) ---
  if (!apiLimiter.allow(clientIp)) {
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": String(apiLimiter.retryAfterSec(clientIp)),
    });
    res.end(JSON.stringify({ error: "too_many_requests" }));
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
      `Qoopia V3.0 MCP server\nMCP endpoint: ${env.PUBLIC_URL}/mcp\nHealth: ${env.PUBLIC_URL}/health\n`,
      req,
    );
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
    if (!authLimiter.allow(clientIp)) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(authLimiter.retryAfterSec(clientIp)) });
      res.end(JSON.stringify({ error: "too_many_requests" }));
      return;
    }
    return handleAuthorizeGet(req, res);
  }
  if (url === "/oauth/authorize" && method === "POST") {
    if (!authLimiter.allow(clientIp)) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(authLimiter.retryAfterSec(clientIp)) });
      res.end(JSON.stringify({ error: "too_many_requests" }));
      return;
    }
    const body = await readBody(req);
    return handleAuthorizePost(body, res);
  }
  if (url === "/oauth/token" && method === "POST") {
    if (!authLimiter.allow(clientIp)) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(authLimiter.retryAfterSec(clientIp)) });
      res.end(JSON.stringify({ error: "too_many_requests" }));
      return;
    }
    const body = await readBody(req);
    return handleToken(body, res);
  }
  if (url === "/oauth/register" && method === "POST") {
    if (!authLimiter.allow(clientIp)) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(authLimiter.retryAfterSec(clientIp)) });
      res.end(JSON.stringify({ error: "too_many_requests" }));
      return;
    }
    const body = await readBody(req);
    return handleRegister(body, res);
  }
  if (url === "/oauth/revoke" && method === "POST") {
    const body = await readBody(req);
    return handleRevoke(body, res);
  }

  // --- MCP endpoint ---
  if (url === "/mcp" || url.startsWith("/mcp?")) {
    return handleMcp(req, res);
  }

  return json(res, 404, { error: "not_found" }, req);
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
    const server = createMcpServer(() => getCurrentAuth());
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      try { transport.close(); } catch {}
      try { server.close(); } catch {}
    });

    await server.connect(transport);
    const parsedBody = body && body.length > 0 ? JSON.parse(body.toString("utf8")) : undefined;
    await transport.handleRequest(req, res, parsedBody);
  });
}

// ---------- OAuth handlers ----------

function parseForm(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  const s = body.toString("utf8");
  for (const pair of s.split("&")) {
    const [k, v = ""] = pair.split("=");
    if (!k) continue;
    out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "));
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

  const safeName = escapeHtml(client.name || "Unknown Client");
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
    <p class="info">This will grant access to your notes, tasks, deals, contacts, finances, and session memory.</p>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}">
      <input type="hidden" name="scope" value="${escapeHtml(scope)}">
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

function handleAuthorizePost(body: Buffer, res: ServerResponse) {
  const form = parseForm(body);
  const action = form.action || "approve";
  const clientId = form.client_id;
  const redirectUri = form.redirect_uri;
  const codeChallenge = form.code_challenge;
  const codeChallengeMethod = form.code_challenge_method || "S256";
  const state = form.state || "";

  if (!clientId || !redirectUri || !codeChallenge) {
    return json(res, 400, { error: "invalid_request" });
  }

  if (action === "deny") {
    const url = new URL(redirectUri);
    url.searchParams.set("error", "access_denied");
    if (state) url.searchParams.set("state", state);
    res.writeHead(302, { location: url.toString() });
    return res.end();
  }

  // Auto-approve: resolve client → agent → workspace, issue code
  const client = getClient(clientId);
  if (!client) {
    return json(res, 400, { error: "invalid_client" });
  }
  if (!client.redirect_uris.includes(redirectUri)) {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "redirect_uri not registered",
    });
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

function handleToken(body: Buffer, res: ServerResponse) {
  const form = parseForm(body);
  const grantType = form.grant_type;
  try {
    if (grantType === "authorization_code") {
      if (!form.code || !form.code_verifier || !form.redirect_uri || !form.client_id) {
        return json(res, 400, { error: "invalid_request" });
      }
      const out = exchangeCodeForTokens({
        code: form.code,
        codeVerifier: form.code_verifier,
        redirectUri: form.redirect_uri,
        clientId: form.client_id,
      });
      return json(res, 200, {
        access_token: out.access,
        refresh_token: out.refresh,
        token_type: "Bearer",
        expires_in: out.expiresInSec,
      });
    }
    if (grantType === "refresh_token") {
      if (!form.refresh_token || !form.client_id) {
        return json(res, 400, { error: "invalid_request" });
      }
      const out = refreshTokens({
        refreshToken: form.refresh_token,
        clientId: form.client_id,
      });
      return json(res, 200, {
        access_token: out.access,
        refresh_token: out.refresh,
        token_type: "Bearer",
        expires_in: out.expiresInSec,
      });
    }
    return json(res, 400, { error: "unsupported_grant_type" });
  } catch (err) {
    return json(res, 400, { error: (err as Error).message || "invalid_grant" });
  }
}

function handleRevoke(body: Buffer, res: ServerResponse) {
  const form = parseForm(body);
  const token = form.token;
  if (!token) return json(res, 400, { error: "invalid_request" });
  revokeToken(token);
  return json(res, 200, { revoked: true });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
