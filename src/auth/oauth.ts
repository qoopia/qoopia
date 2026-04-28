import crypto from "node:crypto";
import { db } from "../db/connection.ts";
import { sha256Hex } from "./api-keys.ts";
import { nowIso, QoopiaError } from "../utils/errors.ts";
import { env } from "../utils/env.ts";
import type { AuthContext } from "./middleware.ts";

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
 * Per RFC 7009: confidential clients must authenticate with client_secret before revocation.
 * Public clients (no client_secret_hash) may revoke without a secret.
 */
export function revokeTokenForClient(
  token: string,
  clientId: string,
  clientSecret?: string,
): boolean {
  const client = getClient(clientId);
  if (!client) {
    // Unknown client — return false (RFC 7009: don't reveal token existence)
    return false;
  }
  // Confidential client: require and verify client_secret
  if (client.client_secret_hash) {
    if (!clientSecret) {
      throw new Error("invalid_client");
    }
    if (sha256Hex(clientSecret) !== client.client_secret_hash) {
      throw new Error("invalid_client");
    }
  }
  const hash = sha256Hex(token);
  const info = db
    .prepare(`UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ? AND client_id = ?`)
    .run(hash, clientId);
  return info.changes > 0;
}

/**
 * ADR-017 §1: only steward and claude-privileged agents may register OAuth
 * clients. Standard-agent-creates-connector is a quiet privilege escalation:
 * a compromised standard agent could mint an OAuth surface targeting its own
 * workspace data.
 *
 * Codex QSA-H (2026-04-28): registration must also be unreachable via OAuth
 * access tokens. Otherwise a single approved connector becomes a self-replicating
 * surface — the bearer can /oauth/register a new client, never expiring as long
 * as the original token lives. /oauth/register is api-key-only.
 */
export function assertCanRegisterOAuth(auth: AuthContext): void {
  if (auth.source !== "api-key") {
    throw new QoopiaError(
      "FORBIDDEN",
      "OAuth client registration requires a static API key (Bearer api_*); OAuth access tokens are not accepted on /oauth/register.",
    );
  }
  if (auth.type !== "steward" && auth.type !== "claude-privileged") {
    throw new QoopiaError(
      "FORBIDDEN",
      "Only steward or claude-privileged agents may register OAuth clients.",
    );
  }
}

/**
 * RFC 7591 dynamic client registration (ADR-017 multi-tenant variant).
 *
 * The new client is bound to the calling agent's `agent_id` and to that
 * agent's `workspace_id` (snapshotted into oauth_clients.workspace_id by
 * migration 011). The legacy "first active agent in the default workspace"
 * inference is gone, as is the wsCount > 1 guard — multi-tenant is the
 * supported shape now.
 *
 * Caller must pre-authenticate the AuthContext and run
 * `assertCanRegisterOAuth(auth)` (the HTTP handler does this).
 */
export function registerClient(
  input: {
    client_name?: string;
    redirect_uris: string[];
    token_endpoint_auth_method?: string;
    grant_types?: string[];
    response_types?: string[];
  },
  auth: AuthContext,
): {
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
  for (const uri of input.redirect_uris) {
    if (typeof uri !== "string") {
      throw new Error(`Invalid redirect URI: must be a string`);
    }
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new Error(`Invalid redirect URI: ${uri}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`Invalid redirect URI scheme: ${uri} (only http/https allowed)`);
    }
  }

  const authMethod = input.token_endpoint_auth_method || "none";
  if (authMethod !== "none" && authMethod !== "client_secret_post") {
    throw new Error("token_endpoint_auth_method must be 'none' or 'client_secret_post'");
  }
  const isPublic = authMethod === "none";

  const client_id = `qc_${crypto.randomBytes(16).toString("base64url")}`;
  let client_secret: string | undefined;
  let secretHash = "";
  if (!isPublic) {
    client_secret = `qcs_${crypto.randomBytes(32).toString("base64url")}`;
    secretHash = sha256Hex(client_secret);
  }

  db.prepare(
    `INSERT INTO oauth_clients
       (id, name, agent_id, workspace_id, client_secret_hash, redirect_uris, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    client_id,
    input.client_name || "Unnamed Client",
    auth.agent_id,
    auth.workspace_id,
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
 *
 * `workspace_id` was added by migration 011 (ADR-017) and may be NULL for
 * pre-existing rows that were created by older code paths and somehow
 * escaped the migration's backfill (e.g. an orphan agent_id). Callers that
 * need workspace-isolation checks must treat NULL as "wrong workspace" /
 * fail closed.
 */
export function getClient(client_id: string): {
  id: string;
  name: string;
  agent_id: string;
  workspace_id: string | null;
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
        workspace_id: string | null;
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

// ---------- Consent tickets (ADR-017 cookie-bridge) ----------
//
// Each /oauth/authorize hit lands an in-flight ticket here. The ticket is the
// only state the dashboard side has to honor when finalizing — the OAuth
// surface itself never reads the dashboard cookie. The ticket id IS the
// browser-carried state; everything else is server-side.

const CONSENT_TICKET_TTL_SEC = 600; // 10 minutes (ADR-017 §2 "TTL")
/** Hard-delete grace window for finalized/expired/denied tickets. */
const CONSENT_TICKET_PRUNE_AFTER_SEC = 60 * 60; // 1h

export interface ConsentTicket {
  id: string;
  client_id: string;
  workspace_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  state: string;
  approved_by_agent_id: string | null;
  denied: number;
  redeemed: number;
  approve_nonce: string;
  created_at: string;
  expires_at: string;
}

/**
 * Create a fresh consent ticket. Caller is responsible for having validated
 * the OAuth params + client + redirect_uri allowlist before reaching here —
 * this function does not re-validate. `workspace_id` MUST be passed in and
 * MUST equal the client's workspace_id; the http handler reads it from
 * `getClient()` so that a NULL `oauth_clients.workspace_id` (legacy row)
 * still requires the caller to make a deliberate choice.
 */
export function createConsentTicket(opts: {
  clientId: string;
  workspaceId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  state: string;
}): ConsentTicket {
  const id = `qct_${crypto.randomBytes(16).toString("base64url")}`;
  const approve_nonce = `qcn_${crypto.randomBytes(16).toString("base64url")}`;
  const created_at = nowIso();
  const expires_at = plusSec(CONSENT_TICKET_TTL_SEC);
  db.prepare(
    `INSERT INTO consent_tickets
      (id, client_id, workspace_id, redirect_uri, code_challenge,
       code_challenge_method, scope, state, approve_nonce, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.clientId,
    opts.workspaceId,
    opts.redirectUri,
    opts.codeChallenge,
    opts.codeChallengeMethod,
    opts.scope,
    opts.state,
    approve_nonce,
    created_at,
    expires_at,
  );
  return {
    id,
    client_id: opts.clientId,
    workspace_id: opts.workspaceId,
    redirect_uri: opts.redirectUri,
    code_challenge: opts.codeChallenge,
    code_challenge_method: opts.codeChallengeMethod,
    scope: opts.scope,
    state: opts.state,
    approved_by_agent_id: null,
    denied: 0,
    redeemed: 0,
    approve_nonce,
    created_at,
    expires_at,
  };
}

export function getConsentTicket(id: string): ConsentTicket | null {
  const row = db
    .prepare(`SELECT * FROM consent_tickets WHERE id = ?`)
    .get(id) as ConsentTicket | undefined;
  return row || null;
}

export type ConsentTicketState =
  | "ok"
  | "not_found"
  | "expired"
  | "redeemed"
  | "denied"
  | "already_finalized";

/**
 * Returns a string describing the ticket's terminal status, or "ok" if the
 * ticket is still in-flight (whether or not approved). Expiry is checked
 * against system clock.
 */
export function consentTicketStatus(t: ConsentTicket | null): ConsentTicketState {
  if (!t) return "not_found";
  if (t.redeemed) return "redeemed";
  if (t.denied) return "denied";
  if (t.expires_at <= nowIso()) return "expired";
  return "ok";
}

/**
 * Mark the ticket approved by the supplied agent. Atomic: only succeeds if
 * the ticket exists, is not already approved/denied/redeemed, and is not
 * expired. Callers SHOULD also have already verified the approve_nonce and
 * (defense-in-depth) that the agent's workspace matches the ticket.
 *
 * Returns true on success, false on any not-found / wrong-state / expired
 * condition.
 */
export function approveConsentTicket(
  ticketId: string,
  agentId: string,
): boolean {
  const info = db
    .prepare(
      `UPDATE consent_tickets
          SET approved_by_agent_id = ?
        WHERE id = ?
          AND approved_by_agent_id IS NULL
          AND denied = 0
          AND redeemed = 0
          AND expires_at > ?`,
    )
    .run(agentId, ticketId, nowIso());
  return info.changes === 1;
}

/**
 * Atomically rotate the approve_nonce on a still-in-flight ticket. Used by
 * the dashboard consent GET handler so each render of the consent UI hands
 * the operator a fresh, single-use nonce. Returns the new nonce on success
 * or null if the ticket is missing / expired / already finalized.
 */
export function rotateConsentNonce(ticketId: string): string | null {
  const fresh = `qcn_${crypto.randomBytes(16).toString("base64url")}`;
  const info = db
    .prepare(
      `UPDATE consent_tickets
          SET approve_nonce = ?
        WHERE id = ?
          AND approved_by_agent_id IS NULL
          AND denied = 0
          AND redeemed = 0
          AND expires_at > ?`,
    )
    .run(fresh, ticketId, nowIso());
  return info.changes === 1 ? fresh : null;
}

/**
 * Atomically consume a ticket's approve_nonce. Single-use: the row's
 * approve_nonce is rotated to a fresh random string after a successful
 * compare so the same nonce cannot be replayed even if it leaks.
 *
 * Note: this is purely best-effort defense-in-depth. The dashboard handler
 * still has to verify the cookie, the Origin, and the workspace match.
 */
export function consumeConsentNonce(ticketId: string, nonce: string): boolean {
  const replacement = `qcn_${crypto.randomBytes(16).toString("base64url")}`;
  const info = db
    .prepare(
      `UPDATE consent_tickets
          SET approve_nonce = ?
        WHERE id = ?
          AND approve_nonce = ?
          AND approved_by_agent_id IS NULL
          AND denied = 0
          AND redeemed = 0
          AND expires_at > ?`,
    )
    .run(replacement, ticketId, nonce, nowIso());
  return info.changes === 1;
}

/**
 * Mark the ticket denied. Atomic: only succeeds for an in-flight ticket
 * (not already approved/denied/redeemed/expired).
 */
export function denyConsentTicket(ticketId: string): boolean {
  const info = db
    .prepare(
      `UPDATE consent_tickets
          SET denied = 1
        WHERE id = ?
          AND approved_by_agent_id IS NULL
          AND denied = 0
          AND redeemed = 0
          AND expires_at > ?`,
    )
    .run(ticketId, nowIso());
  return info.changes === 1;
}

/**
 * Single-use redeem on the finalize path. Atomic: only succeeds if the
 * ticket has been approved, has not been redeemed yet, has not been denied,
 * and has not expired. Replay attempts return false.
 */
export function redeemConsentTicket(ticketId: string): boolean {
  const info = db
    .prepare(
      `UPDATE consent_tickets
          SET redeemed = 1
        WHERE id = ?
          AND approved_by_agent_id IS NOT NULL
          AND denied = 0
          AND redeemed = 0
          AND expires_at > ?`,
    )
    .run(ticketId, nowIso());
  return info.changes === 1;
}

/**
 * Hard-delete tickets whose audit retention window has elapsed.
 *
 * Codex MED #6 (2026-04-28): the prior version anchored the grace window on
 * `created_at`, so redeemed/denied tickets could be deleted only `grace - δ`
 * after the terminal event (where δ = "how long approval took"). Retention
 * effectively varied with operator latency, weakening the audit trail.
 *
 * Schema-light fix: anchor on `expires_at` instead. Every ticket — pending,
 * redeemed, denied, or expired — is retained for at least `expires_at +
 * CONSENT_TICKET_PRUNE_AFTER_SEC`. That gives:
 *   - predictable retention (TTL + grace from creation, deterministic),
 *   - no tightening of the window when an operator approves quickly,
 *   - no schema churn (no `redeemed_at`/`denied_at` columns needed).
 *
 * The `redeemed = 1 OR denied = 1` branch is dropped — we already wait for
 * `expires_at < cutoff`, which is a strict superset (TTL is always finite).
 */
export function pruneConsentTickets(): number {
  const cutoffIso = new Date(Date.now() - CONSENT_TICKET_PRUNE_AFTER_SEC * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const info = db
    .prepare(
      `DELETE FROM consent_tickets
        WHERE expires_at < ?`,
    )
    .run(cutoffIso);
  return info.changes;
}
