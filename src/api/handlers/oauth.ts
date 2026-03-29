import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { ulid } from 'ulid';
import { rawDb } from '../../db/connection.js';
import { logger } from '../../core/logger.js';
import type { AuthContext } from '../../types/index.js';

// ── JWT Secret Management ───────────────────────────────────

const DATA_DIR = process.env.QOOPIA_DATA_DIR || path.join(process.cwd(), 'data');
const JWT_SECRET_PATH = path.join(DATA_DIR, '.jwt-secret');

function loadOrCreateJwtSecret(): Uint8Array {
  const envSecret = process.env.QOOPIA_JWT_SECRET;
  if (envSecret) {
    return new TextEncoder().encode(envSecret);
  }

  try {
    const hex = fs.readFileSync(JWT_SECRET_PATH, 'utf-8').trim();
    return Buffer.from(hex, 'hex');
  } catch {
    const secret = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(JWT_SECRET_PATH), { recursive: true });
    fs.writeFileSync(JWT_SECRET_PATH, secret.toString('hex'), { mode: 0o600 });
    logger.info('Generated new JWT secret');
    return secret;
  }
}

const JWT_SECRET = loadOrCreateJwtSecret();
const JWT_ALG = 'HS256' as const;
const ACCESS_TOKEN_TTL = 3600; // 1 hour
const REFRESH_TOKEN_TTL = 30 * 24 * 3600; // 30 days
const AUTH_CODE_TTL = 600; // 10 minutes

// ── Helpers ─────────────────────────────────────────────────

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isoFuture(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function oauthError(code: string, description: string, status: ContentfulStatusCode = 400) {
  return { body: { error: code, error_description: description }, status };
}

// PKCE S256: BASE64URL(SHA256(code_verifier))
function computeS256Challenge(verifier: string): string {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return hash.toString('base64url');
}

export interface QoopiaJwtPayload extends JWTPayload {
  sub: string;
  workspace_id: string;
  client_id: string;
  type: 'agent' | 'user';
}

export async function signAccessToken(payload: {
  sub: string;
  workspace_id: string;
  client_id: string;
  type: 'agent' | 'user';
}): Promise<string> {
  return new SignJWT({
    workspace_id: payload.workspace_id,
    client_id: payload.client_id,
    type: payload.type,
  })
    .setProtectedHeader({ alg: JWT_ALG })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL}s`)
    .sign(JWT_SECRET);
}

export async function verifyAccessToken(token: string): Promise<QoopiaJwtPayload> {
  const { payload } = await jwtVerify(token, JWT_SECRET, {
    algorithms: [JWT_ALG],
  });
  return payload as QoopiaJwtPayload;
}

// ── Rate Limiter (10 req/min per IP for /oauth/*) ───────────

const oauthRateWindows = new Map<string, number[]>();
const OAUTH_RATE_LIMIT = parseInt(process.env.OAUTH_RATE_LIMIT || '10', 10);
const OAUTH_RATE_WINDOW = 60_000;

export function checkOAuthRateLimit(ip: string): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  const cutoff = now - OAUTH_RATE_WINDOW;
  let timestamps = oauthRateWindows.get(ip) || [];
  timestamps = timestamps.filter(t => t > cutoff);

  if (timestamps.length >= OAUTH_RATE_LIMIT) {
    const retryAfterMs = (timestamps[0] + OAUTH_RATE_WINDOW) - now;
    oauthRateWindows.set(ip, timestamps);
    return { allowed: false, retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  timestamps.push(now);
  oauthRateWindows.set(ip, timestamps);
  return { allowed: true, retryAfter: 0 };
}

// ── Hono App ────────────────────────────────────────────────

const oauth = new Hono<{ Variables: { auth: AuthContext } }>();

// Rate limit middleware for token/revoke endpoints
const oauthRateLimitMiddleware = async (c: Parameters<Parameters<typeof oauth.use>[1]>[0], next: Parameters<Parameters<typeof oauth.use>[1]>[1]) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('x-real-ip')
    || 'unknown';

  const { allowed, retryAfter } = checkOAuthRateLimit(ip);
  if (!allowed) {
    c.header('Retry-After', String(retryAfter));
    return c.json(
      { error: 'rate_limit_exceeded', error_description: `Rate limit exceeded. Try again in ${retryAfter}s.` },
      429,
    );
  }
  return next();
};

oauth.use('/oauth/token', oauthRateLimitMiddleware);
oauth.use('/oauth/revoke', oauthRateLimitMiddleware);

// ── 1. GET /.well-known/oauth-authorization-server ──────────

oauth.get('/.well-known/oauth-authorization-server', (c) => {
  // HIGH #10: Use QOOPIA_PUBLIC_URL exclusively, never derive from request headers
  const baseUrl = (process.env.QOOPIA_PUBLIC_URL || `http://localhost:${process.env.PORT || '3000'}`).replace(/\/$/, '');

  return c.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    grant_types_supported: ['client_credentials', 'authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    response_types_supported: ['code'],
    registration_endpoint: `${baseUrl}/oauth/register`,
  });
});

// ── 2. GET /.well-known/oauth-protected-resource ────────────

oauth.get('/.well-known/oauth-protected-resource', (c) => {
  // HIGH #10: Use QOOPIA_PUBLIC_URL exclusively, never derive from request headers
  const baseUrl = (process.env.QOOPIA_PUBLIC_URL || `http://localhost:${process.env.PORT || '3000'}`).replace(/\/$/, '');

  return c.json({
    resource: baseUrl,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: [],
  });
});

// ── 3. GET /oauth/authorize ─────────────────────────────────
// Claude.ai opens this in a popup — MUST return an HTML page (not instant 302).
// An instant redirect can cause Claude.ai's popup to close before capturing the code.

oauth.get('/oauth/authorize', (c) => {
  const clientId = c.req.query('client_id');
  const redirectUri = c.req.query('redirect_uri');
  const state = c.req.query('state');
  const responseType = c.req.query('response_type');
  const codeChallenge = c.req.query('code_challenge');
  const codeChallengeMethod = c.req.query('code_challenge_method');
  const scope = c.req.query('scope') || '';

  if (!clientId || !redirectUri || !responseType || !codeChallenge) {
    return c.json(oauthError('invalid_request', 'Missing required parameters: client_id, redirect_uri, response_type, code_challenge').body, 400);
  }

  if (responseType !== 'code') {
    return c.json(oauthError('unsupported_response_type', 'Only response_type=code is supported').body, 400);
  }

  if (codeChallengeMethod && codeChallengeMethod !== 'S256') {
    return c.json(oauthError('invalid_request', 'Only S256 code_challenge_method is supported').body, 400);
  }

  // Validate client
  const client = rawDb.prepare(
    'SELECT id, name, agent_id, redirect_uris FROM oauth_clients WHERE id = ?'
  ).get(clientId) as { id: string; name: string; agent_id: string; redirect_uris: string } | undefined;

  if (!client) {
    return c.json(oauthError('invalid_client', 'Unknown client_id').body, 400);
  }

  const allowedUris: string[] = JSON.parse(client.redirect_uris);
  if (!allowedUris.includes(redirectUri)) {
    return c.json(oauthError('invalid_request', 'redirect_uri not registered for this client').body, 400);
  }

  // Single-user MCP server: show consent page that auto-submits.
  // Claude.ai popup needs an HTML page to properly capture the redirect.
  const safeClientName = escapeHtml(client.name || 'Unknown Client');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize — Qoopia</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0f; color: #e0e0e0; }
    .card { background: #1a1a2e; border-radius: 16px; padding: 40px; max-width: 400px; width: 90%; text-align: center; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
    .logo { font-size: 32px; margin-bottom: 16px; }
    h1 { font-size: 20px; margin: 0 0 8px; }
    .client { color: #7c8aff; font-weight: 600; }
    .info { color: #888; font-size: 14px; margin: 16px 0 24px; }
    .actions { display: flex; gap: 12px; justify-content: center; }
    button { padding: 12px 32px; border-radius: 8px; border: none; font-size: 16px; font-weight: 600; cursor: pointer; transition: opacity .15s; }
    button:hover { opacity: 0.85; }
    .approve { background: #7c8aff; color: #fff; }
    .deny { background: #2a2a3e; color: #888; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🔑</div>
    <h1>Authorize access</h1>
    <p><span class="client">${safeClientName}</span> wants to connect to Qoopia</p>
    <p class="info">This will grant access to your projects, tasks, deals, and notes.</p>
    <form method="POST" action="/oauth/authorize" id="authForm">
      <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(state || '')}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod || 'S256')}">
      <input type="hidden" name="scope" value="${escapeHtml(scope)}">
      <input type="hidden" name="action" value="approve">
      <div class="actions">
        <button type="submit" name="action" value="deny" class="deny">Deny</button>
        <button type="submit" name="action" value="approve" class="approve">Approve</button>
      </div>
    </form>
  </div>
  <script>
    // Auto-approve after 500ms for single-user server (user can click Deny to cancel)
    setTimeout(() => { document.getElementById('authForm').submit(); }, 500);
  </script>
</body>
</html>`;

  logger.info({ client_id: clientId, client_name: client.name }, 'Consent page shown');
  return c.html(html);
});

// ── 3b. POST /oauth/authorize (form submit) ─────────────────

oauth.post('/oauth/authorize', async (c) => {
  // Single-user MCP server: auto-approve without auth check
  // Owner identity is implicit (only one workspace)
  let auth = c.get('auth');
  if (!auth) {
    // Get the first (and only) workspace for auto-approve
    const ws = rawDb.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string } | undefined;
    auth = { type: 'user' as const, id: 'owner', workspace_id: ws?.id || 'default', name: 'owner' };
  }

  const body = await c.req.parseBody();
  const action = body['action'] as string;
  const clientId = body['client_id'] as string;
  const redirectUri = body['redirect_uri'] as string;
  const state = body['state'] as string;
  const codeChallenge = body['code_challenge'] as string;
  const codeChallengeMethod = (body['code_challenge_method'] as string) || 'S256';

  if (action === 'deny') {
    const url = new URL(redirectUri);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'User denied the authorization request');
    if (state) url.searchParams.set('state', state);
    return c.redirect(url.toString());
  }

  // Validate client
  const client = rawDb.prepare(
    'SELECT id, name, agent_id, redirect_uris FROM oauth_clients WHERE id = ?'
  ).get(clientId) as { id: string; name: string; agent_id: string; redirect_uris: string } | undefined;

  if (!client) {
    return c.json(oauthError('invalid_client', 'Unknown client_id').body, 400);
  }

  const allowedUris: string[] = JSON.parse(client.redirect_uris);
  if (!allowedUris.includes(redirectUri)) {
    return c.json(oauthError('invalid_request', 'redirect_uri not registered').body, 400);
  }

  // Verify the authenticated user belongs to the same workspace as the client's agent
  const agent = rawDb.prepare('SELECT workspace_id FROM agents WHERE id = ?').get(client.agent_id) as { workspace_id: string } | undefined;
  if (!agent) {
    return c.json(oauthError('server_error', 'Agent not found for client').body, 500);
  }

  if (agent.workspace_id !== auth.workspace_id) {
    return c.json(oauthError('access_denied', 'Client does not belong to your workspace').body, 403);
  }

  // Generate authorization code
  const code = crypto.randomBytes(32).toString('hex');
  const codeHash = sha256(code);

  rawDb.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, workspace_id, agent_id, code_challenge, code_challenge_method, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(codeHash, clientId, redirectUri, agent.workspace_id, client.agent_id, codeChallenge, codeChallengeMethod, isoFuture(AUTH_CODE_TTL));

  logger.info({ client_id: clientId, agent_id: client.agent_id, authorized_by: auth.id }, 'Authorization code issued');

  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  return c.redirect(url.toString());
});

// ── 4. POST /oauth/token ────────────────────────────────────

oauth.post('/oauth/token', async (c) => {
  let params: Record<string, string>;
  const contentType = c.req.header('content-type') || '';

  if (contentType.includes('application/json')) {
    params = await c.req.json();
  } else {
    const formData = await c.req.parseBody();
    params = {} as Record<string, string>;
    for (const [k, v] of Object.entries(formData)) {
      if (typeof v === 'string') params[k] = v;
    }
  }

  const grantType = params.grant_type;

  if (!grantType) {
    const { body, status } = oauthError('invalid_request', 'Missing grant_type');
    return c.json(body, status);
  }

  // ── 4a. client_credentials ──────────────────────────────
  if (grantType === 'client_credentials') {
    const clientId = params.client_id;
    const clientSecret = params.client_secret;

    if (!clientId || !clientSecret) {
      const { body, status } = oauthError('invalid_request', 'Missing client_id or client_secret');
      return c.json(body, status);
    }

    const secretHash = sha256(clientSecret);
    const client = rawDb.prepare(
      'SELECT id, agent_id FROM oauth_clients WHERE id = ? AND client_secret_hash = ?'
    ).get(clientId, secretHash) as { id: string; agent_id: string } | undefined;

    if (!client) {
      const { body, status } = oauthError('invalid_client', 'Invalid client credentials', 401);
      return c.json(body, status);
    }

    const agent = rawDb.prepare('SELECT workspace_id FROM agents WHERE id = ? AND active = 1').get(client.agent_id) as { workspace_id: string } | undefined;
    if (!agent) {
      const { body, status } = oauthError('invalid_client', 'Agent not active', 401);
      return c.json(body, status);
    }

    const accessToken = await signAccessToken({
      sub: client.agent_id,
      workspace_id: agent.workspace_id,
      client_id: clientId,
      type: 'agent',
    });

    logger.info({ client_id: clientId, agent_id: client.agent_id, grant: 'client_credentials' }, 'Access token issued');

    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL,
    });
  }

  // ── 4b. authorization_code ──────────────────────────────
  if (grantType === 'authorization_code') {
    const code = params.code;
    const clientId = params.client_id;
    const codeVerifier = params.code_verifier;
    const redirectUri = params.redirect_uri;

    if (!code || !clientId || !codeVerifier) {
      const { body, status } = oauthError('invalid_request', 'Missing code, client_id, or code_verifier');
      return c.json(body, status);
    }

    const codeHash = sha256(code);
    const codeRecord = rawDb.prepare(
      `SELECT code_hash, client_id, redirect_uri, workspace_id, agent_id, code_challenge, code_challenge_method, expires_at, used
       FROM oauth_codes WHERE code_hash = ?`
    ).get(codeHash) as {
      code_hash: string; client_id: string; redirect_uri: string; workspace_id: string;
      agent_id: string; code_challenge: string; code_challenge_method: string;
      expires_at: string; used: number;
    } | undefined;

    if (!codeRecord) {
      const { body, status } = oauthError('invalid_grant', 'Invalid authorization code');
      return c.json(body, status);
    }

    if (codeRecord.used) {
      const { body, status } = oauthError('invalid_grant', 'Authorization code already used');
      return c.json(body, status);
    }

    if (new Date(codeRecord.expires_at) < new Date()) {
      const { body, status } = oauthError('invalid_grant', 'Authorization code expired');
      return c.json(body, status);
    }

    if (codeRecord.client_id !== clientId) {
      const { body, status } = oauthError('invalid_grant', 'client_id mismatch');
      return c.json(body, status);
    }

    if (redirectUri && codeRecord.redirect_uri !== redirectUri) {
      const { body, status } = oauthError('invalid_grant', 'redirect_uri mismatch');
      return c.json(body, status);
    }

    // PKCE verification
    const computedChallenge = computeS256Challenge(codeVerifier);
    if (computedChallenge !== codeRecord.code_challenge) {
      const { body, status } = oauthError('invalid_grant', 'PKCE code_verifier verification failed');
      return c.json(body, status);
    }

    // Mark code as used
    rawDb.prepare('UPDATE oauth_codes SET used = 1 WHERE code_hash = ?').run(codeHash);

    const accessToken = await signAccessToken({
      sub: codeRecord.agent_id,
      workspace_id: codeRecord.workspace_id,
      client_id: clientId,
      type: 'agent',
    });

    // Generate refresh token
    const refreshToken = crypto.randomBytes(48).toString('hex');
    const refreshHash = sha256(refreshToken);
    rawDb.prepare(
      `INSERT INTO oauth_tokens (token_hash, client_id, agent_id, workspace_id, token_type, expires_at)
       VALUES (?, ?, ?, ?, 'refresh_token', ?)`
    ).run(refreshHash, clientId, codeRecord.agent_id, codeRecord.workspace_id, isoFuture(REFRESH_TOKEN_TTL));

    logger.info({ client_id: clientId, agent_id: codeRecord.agent_id, grant: 'authorization_code' }, 'Token pair issued');

    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: refreshToken,
    });
  }

  // ── 4c. refresh_token ───────────────────────────────────
  if (grantType === 'refresh_token') {
    const refreshToken = params.refresh_token;
    const clientId = params.client_id;

    if (!refreshToken || !clientId) {
      const { body, status } = oauthError('invalid_request', 'Missing refresh_token or client_id');
      return c.json(body, status);
    }

    const refreshHash = sha256(refreshToken);
    const tokenRecord = rawDb.prepare(
      `SELECT token_hash, client_id, agent_id, workspace_id, expires_at, revoked
       FROM oauth_tokens WHERE token_hash = ? AND token_type = 'refresh_token'`
    ).get(refreshHash) as {
      token_hash: string; client_id: string; agent_id: string;
      workspace_id: string; expires_at: string; revoked: number;
    } | undefined;

    if (!tokenRecord) {
      const { body, status } = oauthError('invalid_grant', 'Invalid refresh token');
      return c.json(body, status);
    }

    if (tokenRecord.revoked) {
      const { body, status } = oauthError('invalid_grant', 'Refresh token has been revoked');
      return c.json(body, status);
    }

    if (new Date(tokenRecord.expires_at) < new Date()) {
      const { body, status } = oauthError('invalid_grant', 'Refresh token expired');
      return c.json(body, status);
    }

    if (tokenRecord.client_id !== clientId) {
      const { body, status } = oauthError('invalid_grant', 'client_id mismatch');
      return c.json(body, status);
    }

    // HIGH #8: Require client authentication for confidential clients on refresh
    const refreshClient = rawDb.prepare(
      'SELECT id, client_secret_hash FROM oauth_clients WHERE id = ?'
    ).get(clientId) as { id: string; client_secret_hash: string | null } | undefined;

    if (refreshClient?.client_secret_hash) {
      // Confidential client — must provide valid client_secret
      const providedSecret = params.client_secret;
      if (!providedSecret || sha256(providedSecret) !== refreshClient.client_secret_hash) {
        const { body, status } = oauthError('invalid_client', 'Client authentication required for confidential clients');
        return c.json(body, status);
      }
    }

    // Rotation: revoke old refresh token
    rawDb.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?').run(refreshHash);

    // Issue new tokens
    const accessToken = await signAccessToken({
      sub: tokenRecord.agent_id,
      workspace_id: tokenRecord.workspace_id,
      client_id: clientId,
      type: 'agent',
    });

    const newRefreshToken = crypto.randomBytes(48).toString('hex');
    const newRefreshHash = sha256(newRefreshToken);
    rawDb.prepare(
      `INSERT INTO oauth_tokens (token_hash, client_id, agent_id, workspace_id, token_type, expires_at)
       VALUES (?, ?, ?, ?, 'refresh_token', ?)`
    ).run(newRefreshHash, clientId, tokenRecord.agent_id, tokenRecord.workspace_id, isoFuture(REFRESH_TOKEN_TTL));

    logger.info({ client_id: clientId, agent_id: tokenRecord.agent_id, grant: 'refresh_token' }, 'Token pair refreshed (rotation)');

    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: newRefreshToken,
    });
  }

  const { body, status } = oauthError('unsupported_grant_type', `Grant type '${grantType}' is not supported`);
  return c.json(body, status);
});

// ── 5. POST /oauth/revoke (RFC 7009) ────────────────────────

oauth.post('/oauth/revoke', async (c) => {
  let params: Record<string, string>;
  const contentType = c.req.header('content-type') || '';

  if (contentType.includes('application/json')) {
    params = await c.req.json();
  } else {
    const formData = await c.req.parseBody();
    params = {} as Record<string, string>;
    for (const [k, v] of Object.entries(formData)) {
      if (typeof v === 'string') params[k] = v;
    }
  }

  const token = params.token;
  if (!token) {
    const { body, status } = oauthError('invalid_request', 'Missing token parameter');
    return c.json(body, status);
  }

  const tokenHash = sha256(token);

  // Try to revoke as refresh token
  const result = rawDb.prepare(
    'UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ? AND revoked = 0'
  ).run(tokenHash);

  if (result.changes > 0) {
    logger.info({ token_hash_prefix: tokenHash.slice(0, 8) }, 'Token revoked');
  }

  // RFC 7009: always return 200, even if token was not found
  return c.json({}, 200);
});

// ── 6. POST /oauth/register (RFC 7591 Dynamic Client Registration) ──

oauth.post('/oauth/register', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    const { body: errBody, status } = oauthError('invalid_request', 'Request body must be JSON');
    return c.json(errBody, status);
  }

  const clientName = (typeof body.client_name === 'string' && body.client_name) ? body.client_name : 'Unnamed Client';
  const redirectUris = body.redirect_uris;

  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(u => typeof u === 'string')) {
    const { body: errBody, status } = oauthError('invalid_request', 'redirect_uris must be a non-empty array of strings');
    return c.json(errBody, status);
  }

  // Find the first active agent (and its workspace) to associate with this client
  const agent = rawDb.prepare(
    'SELECT id, workspace_id FROM agents WHERE active = 1 ORDER BY created_at ASC LIMIT 1'
  ).get() as { id: string; workspace_id: string } | undefined;

  if (!agent) {
    const { body: errBody, status } = oauthError('server_error', 'No active agent available', 500);
    return c.json(errBody, status);
  }

  const authMethod = (body.token_endpoint_auth_method as string) || 'client_secret_post';
  if (authMethod !== 'client_secret_post' && authMethod !== 'none') {
    const { body: errBody, status } = oauthError('invalid_request', 'token_endpoint_auth_method must be "client_secret_post" or "none"');
    return c.json(errBody, status);
  }

  const isPublic = authMethod === 'none';
  const clientId = ulid();

  let clientSecret: string | undefined;
  let secretHash: string;

  if (isPublic) {
    secretHash = '';
  } else {
    clientSecret = crypto.randomBytes(32).toString('hex');
    secretHash = sha256(clientSecret);
  }

  rawDb.prepare(
    'INSERT INTO oauth_clients (id, name, agent_id, client_secret_hash, redirect_uris) VALUES (?, ?, ?, ?, ?)'
  ).run(clientId, clientName, agent.id, secretHash, JSON.stringify(redirectUris));

  logger.info({ client_id: clientId, client_name: clientName, public: isPublic }, 'Dynamic client registered (RFC 7591)');

  // Determine grant_types: use client-requested values, or default based on auth method
  const defaultGrants = isPublic
    ? ['authorization_code', 'refresh_token']
    : ['authorization_code', 'refresh_token', 'client_credentials'];
  const grantTypes = (Array.isArray(body.grant_types) && body.grant_types.every((g: unknown) => typeof g === 'string'))
    ? body.grant_types as string[]
    : defaultGrants;

  const responseTypes = (Array.isArray(body.response_types) && body.response_types.every((r: unknown) => typeof r === 'string'))
    ? body.response_types as string[]
    : ['code'];

  const response: Record<string, unknown> = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: authMethod,
  };
  if (clientSecret) {
    response.client_secret = clientSecret;
  }

  return c.json(response, 201);
});

// ── HTML Escape Helper ──────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default oauth;
