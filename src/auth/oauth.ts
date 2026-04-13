import crypto from "node:crypto";
import { db } from "../db/connection.ts";
import { sha256Hex } from "./api-keys.ts";
import { nowIso } from "../utils/errors.ts";
import { env } from "../utils/env.ts";

/**
 * OAuth 2.1 PKCE code flow with opaque tokens.
 * Codes and tokens are stored in the same table `oauth_tokens` with
 * `token_type ∈ {code, access, refresh}`.
 *
 * Endpoints:
 *  - GET  /.well-known/oauth-authorization-server
 *  - GET  /.well-known/oauth-protected-resource
 *  - GET  /oauth/authorize
 *  - POST /oauth/token
 *  - POST /oauth/revoke
 */

const CODE_TTL_SEC = 600; // 10 minutes
const ACCESS_TTL_SEC = 60 * 60; // 1 hour
const REFRESH_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

function genOpaque(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
}

function plusSec(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface OAuthTokenRecord {
  token_hash: string;
  client_id: string;
  agent_id: string;
  workspace_id: string;
  token_type: "code" | "access" | "refresh";
  code_challenge: string | null;
  code_challenge_method: string | null;
  redirect_uri: string | null;
  expires_at: string;
  revoked: number;
  created_at: string;
}

export function findActiveToken(token: string): OAuthTokenRecord | null {
  const hash = sha256Hex(token);
  const row = db
    .prepare(
      `SELECT * FROM oauth_tokens WHERE token_hash = ? AND revoked = 0 LIMIT 1`,
    )
    .get(hash) as OAuthTokenRecord | undefined;
  if (!row) return null;
  if (row.expires_at <= nowIso()) return null;
  return row;
}

export function createAuthorizationCode(opts: {
  clientId: string;
  agentId: string;
  workspaceId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
}): string {
  const code = genOpaque("qc");
  const hash = sha256Hex(code);
  db.prepare(
    `INSERT INTO oauth_tokens
      (token_hash, client_id, agent_id, workspace_id, token_type, code_challenge, code_challenge_method, redirect_uri, expires_at, revoked, created_at)
     VALUES (?, ?, ?, ?, 'code', ?, ?, ?, ?, 0, ?)`,
  ).run(
    hash,
    opts.clientId,
    opts.agentId,
    opts.workspaceId,
    opts.codeChallenge,
    opts.codeChallengeMethod,
    opts.redirectUri,
    plusSec(CODE_TTL_SEC),
    nowIso(),
  );
  return code;
}

export function exchangeCodeForTokens(opts: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
}): { access: string; refresh: string; expiresInSec: number } {
  // Validate client_secret before entering the transaction (read-only check)
  const clientRow = getClient(opts.clientId);
  if (clientRow && clientRow.client_secret_hash) {
    if (!opts.clientSecret) throw new Error("invalid_client");
    if (sha256Hex(opts.clientSecret) !== clientRow.client_secret_hash) {
      throw new Error("invalid_client");
    }
  }

  return db.transaction(() => {
    const codeHash = sha256Hex(opts.code);
    // Atomically revoke the code — only succeeds if it exists and is still active
    const revokeInfo = db.prepare(
      `UPDATE oauth_tokens SET revoked = 1
       WHERE token_hash = ? AND revoked = 0 AND token_type = 'code'
         AND expires_at > ? AND client_id = ?`,
    ).run(codeHash, nowIso(), opts.clientId);

    if (revokeInfo.changes !== 1) throw new Error("invalid_grant");

    // Fetch the code row we just revoked (for PKCE & redirect verification)
    const codeRow = db.prepare(
      `SELECT * FROM oauth_tokens WHERE token_hash = ?`,
    ).get(codeHash) as OAuthTokenRecord | undefined;
    if (!codeRow) throw new Error("invalid_grant");
    if (codeRow.redirect_uri !== opts.redirectUri) throw new Error("invalid_grant");

    // PKCE verify
    const method = (codeRow.code_challenge_method || "S256").toUpperCase();
    let computed: string;
    if (method === "S256") {
      computed = crypto
        .createHash("sha256")
        .update(opts.codeVerifier)
        .digest("base64url");
    } else {
      computed = opts.codeVerifier;
    }
    if (computed !== codeRow.code_challenge) {
      throw new Error("invalid_grant");
    }

    // Issue tokens
    const access = genOpaque("qa");
    const refresh = genOpaque("qr");
    const now = nowIso();
    const stmt = db.prepare(
      `INSERT INTO oauth_tokens
        (token_hash, client_id, agent_id, workspace_id, token_type, expires_at, revoked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    stmt.run(
      sha256Hex(access),
      codeRow.client_id,
      codeRow.agent_id,
      codeRow.workspace_id,
      "access",
      plusSec(ACCESS_TTL_SEC),
      now,
    );
    stmt.run(
      sha256Hex(refresh),
      codeRow.client_id,
      codeRow.agent_id,
      codeRow.workspace_id,
      "refresh",
      plusSec(REFRESH_TTL_SEC),
      now,
    );
    return { access, refresh, expiresInSec: ACCESS_TTL_SEC };
  })();
}

export function refreshTokens(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
}): { access: string; refresh: string; expiresInSec: number } {
  // Validate client_secret before entering the transaction (read-only check)
  const clientRow = getClient(opts.clientId);
  if (clientRow && clientRow.client_secret_hash) {
    if (!opts.clientSecret) throw new Error("invalid_client");
    if (sha256Hex(opts.clientSecret) !== clientRow.client_secret_hash) {
      throw new Error("invalid_client");
    }
  }

  return db.transaction(() => {
    const refreshHash = sha256Hex(opts.refreshToken);
    // Atomically revoke the refresh token — only succeeds once
    const revokeInfo = db.prepare(
      `UPDATE oauth_tokens SET revoked = 1
       WHERE token_hash = ? AND revoked = 0 AND token_type = 'refresh'
         AND expires_at > ? AND client_id = ?`,
    ).run(refreshHash, nowIso(), opts.clientId);

    if (revokeInfo.changes !== 1) throw new Error("invalid_grant");

    // Fetch row for agent/workspace
    const row = db.prepare(
      `SELECT * FROM oauth_tokens WHERE token_hash = ?`,
    ).get(refreshHash) as OAuthTokenRecord | undefined;
    if (!row) throw new Error("invalid_grant");

    const access = genOpaque("qa");
    const refresh = genOpaque("qr");
    const now = nowIso();
    const stmt = db.prepare(
      `INSERT INTO oauth_tokens
        (token_hash, client_id, agent_id, workspace_id, token_type, expires_at, revoked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    stmt.run(
      sha256Hex(access),
      row.client_id,
      row.agent_id,
      row.workspace_id,
      "access",
      plusSec(ACCESS_TTL_SEC),
      now,
    );
    stmt.run(
      sha256Hex(refresh),
      row.client_id,
      row.agent_id,
      row.workspace_id,
      "refresh",
      plusSec(REFRESH_TTL_SEC),
      now,
    );
    return { access, refresh, expiresInSec: ACCESS_TTL_SEC };
  })();
}

export function revokeToken(token: string): boolean {
  const hash = sha256Hex(token);
  const info = db
    .prepare(`UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?`)
    .run(hash);
  return info.changes > 0;
}

/**
 * Revoke a token only if it belongs to the specified client.
 * Per RFC 7009: client must prove ownership before revocation.
 */
export function revokeTokenForClient(token: string, clientId: string): boolean {
  const hash = sha256Hex(token);
  const info = db
    .prepare(`UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ? AND client_id = ?`)
    .run(hash, clientId);
  return info.changes > 0;
}

/**
 * RFC 7591 dynamic client registration.
 * Single-user assumption: associates new client with the first active agent
 * (workspace owner). Public clients (token_endpoint_auth_method='none') get
 * no client_secret. Confidential clients get a generated client_secret.
 */
export function registerClient(input: {
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
}): {
  client_id: string;
  client_secret?: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
} {
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
    throw new Error("redirect_uris must be a non-empty array");
  }
  // C1 fix: restrict to agents in the default workspace (single-user assumption).
  // Prefer claude-privileged for Claude.ai connector; fall back to first active.
  const defaultWs = db
    .prepare(`SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1`)
    .get() as { id: string } | undefined;
  if (!defaultWs) throw new Error("No workspace configured");

  const agent = (db
    .prepare(
      `SELECT id, workspace_id FROM agents
       WHERE active = 1 AND workspace_id = ?
       ORDER BY (type = 'claude-privileged') DESC, created_at ASC
       LIMIT 1`,
    )
    .get(defaultWs.id) as { id: string; workspace_id: string } | undefined);
  if (!agent) throw new Error("No active agent available");

  const authMethod = input.token_endpoint_auth_method || "none";
  if (authMethod !== "none" && authMethod !== "client_secret_post") {
    throw new Error("token_endpoint_auth_method must be 'none' or 'client_secret_post'");
  }
  const isPublic = authMethod === "none";

  const client_id = `qc_${crypto.randomBytes(16).toString("base64url")}`;
  let client_secret: string | undefined;
  let secretHash = "";
  if (!isPublic) {
    client_secret = crypto.randomBytes(32).toString("base64url");
    secretHash = sha256Hex(client_secret);
  }

  db.prepare(
    `INSERT INTO oauth_clients (id, name, agent_id, client_secret_hash, redirect_uris, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    client_id,
    input.client_name || "Unnamed Client",
    agent.id,
    secretHash,
    JSON.stringify(input.redirect_uris),
    nowIso(),
  );

  return {
    client_id,
    ...(client_secret ? { client_secret } : {}),
    client_name: input.client_name || "Unnamed Client",
    redirect_uris: input.redirect_uris,
    grant_types: input.grant_types || ["authorization_code", "refresh_token"],
    response_types: input.response_types || ["code"],
    token_endpoint_auth_method: authMethod,
  };
}

/**
 * Look up a registered client by id. Returns the row or null.
 */
export function getClient(client_id: string): {
  id: string;
  name: string;
  agent_id: string;
  client_secret_hash: string;
  redirect_uris: string[];
} | null {
  const row = db
    .prepare(`SELECT * FROM oauth_clients WHERE id = ?`)
    .get(client_id) as
    | {
        id: string;
        name: string;
        agent_id: string;
        client_secret_hash: string;
        redirect_uris: string;
      }
    | undefined;
  if (!row) return null;
  let uris: string[] = [];
  try {
    uris = JSON.parse(row.redirect_uris);
  } catch {}
  return { ...row, redirect_uris: uris };
}

/**
 * Resolve a client to its associated agent + workspace (single-user
 * auto-approve path). Returns null if client unknown or agent gone.
 */
export function clientWorkspace(client_id: string): {
  agent_id: string;
  workspace_id: string;
} | null {
  const c = getClient(client_id);
  if (!c) return null;
  // C2 fix: only return workspace if agent is still active
  const a = db
    .prepare(`SELECT id, workspace_id FROM agents WHERE id = ? AND active = 1`)
    .get(c.agent_id) as { id: string; workspace_id: string } | undefined;
  if (!a) return null;
  return { agent_id: a.id, workspace_id: a.workspace_id };
}

/**
 * Revoke all OAuth tokens for an agent (call on deactivation).
 */
export function revokeAllAgentTokens(agentId: string): number {
  const info = db
    .prepare(`UPDATE oauth_tokens SET revoked = 1 WHERE agent_id = ? AND revoked = 0`)
    .run(agentId);
  return info.changes;
}

export function wellKnownAuthorizationServer() {
  return {
    issuer: env.OAUTH_ISSUER,
    authorization_endpoint: `${env.PUBLIC_URL}/oauth/authorize`,
    token_endpoint: `${env.PUBLIC_URL}/oauth/token`,
    revocation_endpoint: `${env.PUBLIC_URL}/oauth/revoke`,
    registration_endpoint: `${env.PUBLIC_URL}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
  };
}

export function wellKnownProtectedResource() {
  return {
    resource: `${env.PUBLIC_URL}/mcp`,
    authorization_servers: [env.OAUTH_ISSUER],
    bearer_methods_supported: ["header"],
  };
}
