import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
} from "./auth/oauth.ts";
import { db } from "./db/connection.ts";
import { env } from "./utils/env.ts";
import { logger } from "./utils/logger.ts";

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

function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
  });
  res.end(payload);
}

function text(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*",
  });
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

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, mcp-session-id",
      "access-control-max-age": "86400",
    });
    res.end();
    return;
  }

  // --- Health ---
  if (url === "/health") {
    return json(res, 200, {
      status: "ok",
      version: "3.0.0",
      uptime: Math.round(process.uptime()),
    });
  }

  if (url === "/") {
    return text(
      res,
      200,
      `Qoopia V3.0 MCP server\nMCP endpoint: ${env.PUBLIC_URL}/mcp\nHealth: ${env.PUBLIC_URL}/health\n`,
    );
  }

  // --- OAuth discovery ---
  if (url === "/.well-known/oauth-authorization-server") {
    return json(res, 200, wellKnownAuthorizationServer());
  }
  if (url.startsWith("/.well-known/oauth-protected-resource")) {
    return json(res, 200, wellKnownProtectedResource());
  }

  // --- OAuth endpoints ---
  if (url.startsWith("/oauth/authorize")) {
    return handleAuthorize(req, res);
  }
  if (url === "/oauth/token" && method === "POST") {
    const body = await readBody(req);
    return handleToken(body, res);
  }
  if (url === "/oauth/revoke" && method === "POST") {
    const body = await readBody(req);
    return handleRevoke(body, res);
  }

  // --- MCP endpoint ---
  if (url === "/mcp" || url.startsWith("/mcp?")) {
    return handleMcp(req, res);
  }

  return json(res, 404, { error: "not_found", path: url });
}

// ---------- MCP handler ----------

// We authenticate on the HTTP request, then stash the resolved context in a
// module-level ref that the tool handlers read back via the authProvider
// callback registered at tool registration. Because we create a fresh MCP
// server per request (stateless mode), there's no cross-request leakage.
let currentAuth: AuthContext | null = null;

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

  currentAuth = auth;

  try {
    // Stateless: new server + transport per request
    const server = createMcpServer(() => currentAuth);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // stateless mode: every request stands alone
    });
    // Clean up transport after request completes
    res.on("close", () => {
      try {
        transport.close();
      } catch {}
      try {
        server.close();
      } catch {}
    });

    await server.connect(transport);
    const parsedBody = body && body.length > 0 ? JSON.parse(body.toString("utf8")) : undefined;
    await transport.handleRequest(req, res, parsedBody);
  } finally {
    currentAuth = null;
  }
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

async function handleAuthorize(req: IncomingMessage, res: ServerResponse) {
  // Minimal PKCE authorize endpoint.
  // For Claude.ai connector flow: expects client_id, redirect_uri,
  // response_type=code, code_challenge, code_challenge_method, state.
  //
  // Since Qoopia has no login UI (single-user system), we resolve the agent
  // via a query-param `agent_key` (admin provides to connector) — this is NOT
  // user-facing browser login; it's a terminal-initiated flow where the
  // operator pastes the agent's API key into the URL once.
  const u = new URL(req.url || "/", env.PUBLIC_URL);
  const clientId = u.searchParams.get("client_id");
  const redirectUri = u.searchParams.get("redirect_uri");
  const responseType = u.searchParams.get("response_type");
  const codeChallenge = u.searchParams.get("code_challenge");
  const codeChallengeMethod = u.searchParams.get("code_challenge_method") || "S256";
  const state = u.searchParams.get("state") || "";
  const agentKey = u.searchParams.get("agent_key");

  if (!clientId || !redirectUri || responseType !== "code" || !codeChallenge) {
    return json(res, 400, { error: "invalid_request" });
  }
  if (!agentKey) {
    // Render a tiny form asking for the agent key.
    const html = `<!doctype html><html><body>
      <h1>Qoopia authorization</h1>
      <p>Paste the agent API key issued by the Qoopia operator:</p>
      <form method="GET" action="/oauth/authorize">
        <input type="hidden" name="client_id" value="${escapeHtml(clientId)}"/>
        <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}"/>
        <input type="hidden" name="response_type" value="code"/>
        <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}"/>
        <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}"/>
        <input type="hidden" name="state" value="${escapeHtml(state)}"/>
        <input name="agent_key" size="60" autofocus required/>
        <button type="submit">Authorize</button>
      </form>
    </body></html>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // Resolve agent by API key
  const agent = await import("./auth/api-keys.ts").then((m) =>
    m.verifyApiKey(agentKey),
  );
  if (!agent) {
    return json(res, 401, { error: "invalid_agent_key" });
  }

  // Ensure client exists (or auto-register on first use)
  let client = db
    .prepare(`SELECT id FROM oauth_clients WHERE id = ?`)
    .get(clientId) as { id: string } | undefined;
  if (!client) {
    const { sha256Hex } = await import("./auth/api-keys.ts");
    db.prepare(
      `INSERT INTO oauth_clients (id, name, agent_id, client_secret_hash, redirect_uris) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      clientId,
      clientId,
      agent.id,
      sha256Hex(clientId),
      JSON.stringify([redirectUri]),
    );
    client = { id: clientId };
  }

  const code = createAuthorizationCode({
    clientId,
    agentId: agent.id,
    workspaceId: agent.workspace_id,
    codeChallenge,
    codeChallengeMethod,
    redirectUri,
  });

  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);
  res.writeHead(302, { location: redirect.toString() });
  res.end();
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
