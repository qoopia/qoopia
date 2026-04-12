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
}): { access: string; refresh: string; expiresInSec: number } {
  const codeRow = findActiveToken(opts.code);
  if (!codeRow || codeRow.token_type !== "code") {
    throw new Error("invalid_grant");
  }
  if (codeRow.client_id !== opts.clientId) throw new Error("invalid_client");
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

  // Burn code
  db.prepare(
    `UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?`,
  ).run(codeRow.token_hash);

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
}

export function refreshTokens(opts: {
  refreshToken: string;
  clientId: string;
}): { access: string; refresh: string; expiresInSec: number } {
  const row = findActiveToken(opts.refreshToken);
  if (!row || row.token_type !== "refresh") throw new Error("invalid_grant");
  if (row.client_id !== opts.clientId) throw new Error("invalid_client");

  // Issue a fresh access token; reuse refresh (simpler) OR rotate it.
  // We rotate for security — revoke old refresh.
  db.prepare(`UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?`).run(
    row.token_hash,
  );

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
}

export function revokeToken(token: string): boolean {
  const hash = sha256Hex(token);
  const info = db
    .prepare(`UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?`)
    .run(hash);
  return info.changes > 0;
}

export function wellKnownAuthorizationServer() {
  return {
    issuer: env.OAUTH_ISSUER,
    authorization_endpoint: `${env.PUBLIC_URL}/oauth/authorize`,
    token_endpoint: `${env.PUBLIC_URL}/oauth/token`,
    revocation_endpoint: `${env.PUBLIC_URL}/oauth/revoke`,
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
