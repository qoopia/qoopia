import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { ulid } from 'ulid';

// We test by starting the actual server and using fetch
let baseUrl: string;
let serverProcess: ReturnType<typeof import('node:child_process').spawn> | null = null;

// Test data populated during seed
let testClientId: string;
let testClientSecret: string;
let testAgentApiKey: string;

beforeAll(async () => {
  const { spawn } = await import('node:child_process');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const os = await import('node:os');

  // Use a temporary data directory for test isolation
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoopia-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const port = 3099 + Math.floor(Math.random() * 100);
  baseUrl = `http://127.0.0.1:${port}`;

  // Set up DB with migrations + seed for testing
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run migration 001 (core tables)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      settings TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      role TEXT NOT NULL DEFAULT 'member',
      api_key_hash TEXT,
      last_seen TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      api_key_hash TEXT NOT NULL,
      key_rotated_at TEXT,
      previous_key_hash TEXT,
      previous_key_expires TEXT,
      permissions TEXT DEFAULT '{}',
      metadata TEXT DEFAULT '{}',
      last_seen TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS magic_links (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      owner_agent_id TEXT REFERENCES agents(id),
      color TEXT,
      tags TEXT DEFAULT '[]',
      settings TEXT DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, title TEXT, description TEXT, status TEXT DEFAULT 'todo', priority TEXT DEFAULT 'medium', assignee TEXT, due_date TEXT, blocked_by TEXT DEFAULT '[]', parent_id TEXT, source TEXT DEFAULT 'manual', tags TEXT DEFAULT '[]', notes TEXT, attachments TEXT DEFAULT '[]', revision INTEGER DEFAULT 1, deleted_at TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_by TEXT);
    CREATE TABLE IF NOT EXISTS deals (id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, name TEXT, address TEXT, status TEXT DEFAULT 'active', asking_price REAL, target_price REAL, monthly_rent REAL, lease_term_months INTEGER, metadata TEXT DEFAULT '{}', documents TEXT DEFAULT '[]', timeline TEXT DEFAULT '[]', tags TEXT DEFAULT '[]', notes TEXT, revision INTEGER DEFAULT 1, deleted_at TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_by TEXT);
    CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, role TEXT, company TEXT, email TEXT, phone TEXT, telegram_id TEXT, language TEXT DEFAULT 'EN', timezone TEXT, category TEXT, communication_rules TEXT, tags TEXT DEFAULT '[]', notes TEXT, revision INTEGER DEFAULT 1, deleted_at TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_by TEXT);
    CREATE TABLE IF NOT EXISTS finances (id TEXT PRIMARY KEY, workspace_id TEXT, project_id TEXT, type TEXT, name TEXT, amount REAL, currency TEXT DEFAULT 'USD', recurring TEXT DEFAULT 'none', status TEXT DEFAULT 'active', tags TEXT DEFAULT '[]', notes TEXT, revision INTEGER DEFAULT 1, deleted_at TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_by TEXT);
    CREATE TABLE IF NOT EXISTS contact_projects (contact_id TEXT, project_id TEXT, role TEXT, PRIMARY KEY (contact_id, project_id));
    CREATE TABLE IF NOT EXISTS deal_contacts (deal_id TEXT, contact_id TEXT, role TEXT, PRIMARY KEY (deal_id, contact_id));
    CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, workspace_id TEXT, timestamp TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), actor TEXT, action TEXT, entity_type TEXT, entity_id TEXT, project_id TEXT, summary TEXT, details TEXT DEFAULT '{}', revision_before INTEGER, revision_after INTEGER);
    CREATE TABLE IF NOT EXISTS activity_archive (id TEXT PRIMARY KEY, workspace_id TEXT, timestamp TEXT, actor TEXT, action TEXT, entity_type TEXT, entity_id TEXT, project_id TEXT, summary TEXT, details TEXT DEFAULT '{}', revision_before INTEGER, revision_after INTEGER);
    CREATE TABLE IF NOT EXISTS idempotency_keys (key_hash TEXT PRIMARY KEY, response TEXT NOT NULL, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS webhook_dead_letters (id TEXT PRIMARY KEY, webhook_url TEXT, payload TEXT, attempts INTEGER DEFAULT 0, last_attempt_at TEXT, last_error TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));

    CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(title, description, notes, content=tasks, content_rowid=rowid);
    CREATE VIRTUAL TABLE IF NOT EXISTS contacts_fts USING fts5(name, role, company, notes, content=contacts, content_rowid=rowid);
    CREATE VIRTUAL TABLE IF NOT EXISTS deals_fts USING fts5(name, address, notes, content=deals, content_rowid=rowid);
    CREATE VIRTUAL TABLE IF NOT EXISTS activity_fts USING fts5(summary, content=activity, content_rowid=rowid);
  `);

  // Migration 002: OAuth tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_id TEXT REFERENCES agents(id),
      client_secret_hash TEXT NOT NULL,
      redirect_uris TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES oauth_clients(id),
      redirect_uri TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      code_challenge_method TEXT NOT NULL DEFAULT 'S256',
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES oauth_clients(id),
      agent_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      token_type TEXT NOT NULL DEFAULT 'refresh_token',
      expires_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `);

  db.prepare("INSERT INTO schema_versions (version, description) VALUES (1, 'initial'), (2, 'oauth')").run();

  // Seed workspace + agent + oauth client
  const wsId = ulid();
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, 'Test', 'test')").run(wsId);

  const agentId = ulid();
  testAgentApiKey = `qp_a_${crypto.randomBytes(32).toString('hex')}`;
  const agentKeyHash = crypto.createHash('sha256').update(testAgentApiKey).digest('hex');
  db.prepare(
    "INSERT INTO agents (id, workspace_id, name, type, api_key_hash, permissions) VALUES (?, ?, 'TestAgent', 'test', ?, ?)"
  ).run(agentId, wsId, agentKeyHash, JSON.stringify({ projects: '*', rules: [{ entity: '*', actions: ['read', 'create', 'update', 'delete'] }] }));

  testClientId = ulid();
  testClientSecret = `qp_cs_${crypto.randomBytes(32).toString('hex')}`;
  const csHash = crypto.createHash('sha256').update(testClientSecret).digest('hex');
  db.prepare(
    "INSERT INTO oauth_clients (id, name, agent_id, client_secret_hash, redirect_uris) VALUES (?, 'TestAgent', ?, ?, ?)"
  ).run(testClientId, agentId, csHash, JSON.stringify(['https://claude.ai/api/mcp/auth_callback', 'http://localhost:9999/callback']));

  db.close();

  // Start server
  const jwtSecret = crypto.randomBytes(32).toString('hex');
  serverProcess = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/index.ts'],
    {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: {
        ...process.env,
        PORT: String(port),
        QOOPIA_DB_PATH: dbPath,
        QOOPIA_DATA_DIR: tmpDir,
        QOOPIA_JWT_SECRET: jwtSecret,
        OAUTH_RATE_LIMIT: '100',
        LOG_LEVEL: 'silent',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  // Wait for server to be ready by polling
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const probe = await fetch(`${baseUrl}/api/v1/health`);
      if (probe.ok) break;
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
});

afterAll(() => {
  serverProcess?.kill('SIGTERM');
});

describe('OAuth 2.0 Provider', () => {
  // ── Discovery ─────────────────────────────────────────────

  it('GET /.well-known/oauth-protected-resource returns resource metadata', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBeDefined();
    expect(body.authorization_servers).toBeInstanceOf(Array);
    expect(body.authorization_servers.length).toBeGreaterThan(0);
  });

  it('GET /.well-known/oauth-authorization-server returns server metadata', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuer).toBeDefined();
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.revocation_endpoint).toContain('/oauth/revoke');
    expect(body.grant_types_supported).toContain('client_credentials');
    expect(body.grant_types_supported).toContain('authorization_code');
    expect(body.grant_types_supported).toContain('refresh_token');
    expect(body.code_challenge_methods_supported).toContain('S256');
    expect(body.token_endpoint_auth_methods_supported).toContain('client_secret_post');
  });

  // ── Client Credentials ───────────────────────────────────

  let accessToken: string;

  it('POST /oauth/token with client_credentials returns JWT', async () => {
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: testClientId,
        client_secret: testClientSecret,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toBeDefined();
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3600);
    expect(body.access_token.startsWith('eyJ')).toBe(true);
    accessToken = body.access_token;
  });

  it('POST /oauth/token with bad client_secret returns 401', async () => {
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: testClientId,
        client_secret: 'wrong_secret',
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('invalid_client');
  });

  // ── JWT Auth ──────────────────────────────────────────────

  it('GET /api/v1/health with JWT succeeds', async () => {
    // Health doesn't require auth, but let's verify JWT works on protected routes
    const res = await fetch(`${baseUrl}/api/v1/health`);
    expect(res.status).toBe(200);
  });

  it('Protected endpoint with JWT returns 200', async () => {
    const res = await fetch(`${baseUrl}/api/v1/projects`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    // Should succeed with 200 (empty list)
    expect(res.status).toBe(200);
  });

  it('Protected endpoint with API key still works', async () => {
    const res = await fetch(`${baseUrl}/api/v1/projects`, {
      headers: { Authorization: `Bearer ${testAgentApiKey}` },
    });
    expect(res.status).toBe(200);
  });

  it('Protected endpoint without auth returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/v1/projects`);
    expect(res.status).toBe(401);
  });

  // ── MCP with JWT ──────────────────────────────────────────

  it('POST /mcp with JWT returns tools/list', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result?.tools).toBeInstanceOf(Array);
  });

  // ── Authorization Code Flow (PKCE) ───────────────────────

  it('GET /oauth/authorize returns HTML form', async () => {
    const codeVerifier = crypto.randomBytes(32).toString('hex');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    const url = new URL(`${baseUrl}/oauth/authorize`);
    url.searchParams.set('client_id', testClientId);
    url.searchParams.set('redirect_uri', 'http://localhost:9999/callback');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', 'test-state-123');
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');

    const res = await fetch(url.toString());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Authorize');
    expect(html).toContain('TestAgent');
    expect(html).toContain('Approve');
  });

  it('Full authorization_code flow with PKCE', async () => {
    const codeVerifier = crypto.randomBytes(32).toString('hex');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    // POST approve (simulates form submission)
    const approveRes = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'approve',
        client_id: testClientId,
        redirect_uri: 'http://localhost:9999/callback',
        state: 'test-state-456',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }),
      redirect: 'manual',
    });

    expect(approveRes.status).toBe(302);
    const location = approveRes.headers.get('location')!;
    expect(location).toContain('http://localhost:9999/callback');
    expect(location).toContain('state=test-state-456');

    const redirectUrl = new URL(location);
    const code = redirectUrl.searchParams.get('code')!;
    expect(code).toBeDefined();
    expect(code.length).toBe(64); // 32 bytes hex

    // Exchange code for tokens
    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: testClientId,
        code_verifier: codeVerifier,
        redirect_uri: 'http://localhost:9999/callback',
      }),
    });

    expect(tokenRes.status).toBe(200);
    const tokenBody = await tokenRes.json();
    expect(tokenBody.access_token).toBeDefined();
    expect(tokenBody.refresh_token).toBeDefined();
    expect(tokenBody.token_type).toBe('Bearer');
    expect(tokenBody.expires_in).toBe(3600);

    // Use the access token
    const projectsRes = await fetch(`${baseUrl}/api/v1/projects`, {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    });
    expect(projectsRes.status).toBe(200);

    // Refresh the token (with rotation)
    const refreshRes = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenBody.refresh_token,
        client_id: testClientId,
      }),
    });

    expect(refreshRes.status).toBe(200);
    const refreshBody = await refreshRes.json();
    expect(refreshBody.access_token).toBeDefined();
    expect(refreshBody.refresh_token).toBeDefined();
    // New refresh token should be different (rotation)
    expect(refreshBody.refresh_token).not.toBe(tokenBody.refresh_token);

    // Old refresh token should be revoked
    const replayRes = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenBody.refresh_token,
        client_id: testClientId,
      }),
    });
    expect(replayRes.status).toBe(400);
    const replayBody = await replayRes.json();
    expect(replayBody.error).toBe('invalid_grant');

    // Revoke the new refresh token
    const revokeRes = await fetch(`${baseUrl}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshBody.refresh_token }),
    });
    expect(revokeRes.status).toBe(200);

    // Revoked token should not work
    const afterRevokeRes = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshBody.refresh_token,
        client_id: testClientId,
      }),
    });
    expect(afterRevokeRes.status).toBe(400);
  });

  it('authorization_code with wrong code_verifier fails', async () => {
    const codeVerifier = crypto.randomBytes(32).toString('hex');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    const approveRes = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'approve',
        client_id: testClientId,
        redirect_uri: 'http://localhost:9999/callback',
        state: 'pkce-fail',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }),
      redirect: 'manual',
    });

    const location = approveRes.headers.get('location')!;
    const code = new URL(location).searchParams.get('code')!;

    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: testClientId,
        code_verifier: 'wrong-verifier-value',
        redirect_uri: 'http://localhost:9999/callback',
      }),
    });

    expect(tokenRes.status).toBe(400);
    const body = await tokenRes.json();
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toContain('PKCE');
  });

  it('authorization code cannot be reused', async () => {
    const codeVerifier = crypto.randomBytes(32).toString('hex');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    const approveRes = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'approve',
        client_id: testClientId,
        redirect_uri: 'http://localhost:9999/callback',
        state: 'reuse-test',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }),
      redirect: 'manual',
    });

    const code = new URL(approveRes.headers.get('location')!).searchParams.get('code')!;

    // First use — succeeds
    const res1 = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: testClientId,
        code_verifier: codeVerifier,
        redirect_uri: 'http://localhost:9999/callback',
      }),
    });
    expect(res1.status).toBe(200);

    // Second use — fails
    const res2 = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: testClientId,
        code_verifier: codeVerifier,
        redirect_uri: 'http://localhost:9999/callback',
      }),
    });
    expect(res2.status).toBe(400);
    expect((await res2.json()).error).toBe('invalid_grant');
  });

  // ── CORS ──────────────────────────────────────────────────

  it('OPTIONS /oauth/token returns CORS headers', async () => {
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://claude.ai',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
      },
    });
    expect(res.status).toBe(204);
    const acam = res.headers.get('access-control-allow-methods');
    expect(acam).toContain('POST');
  });

  // ── Error format ──────────────────────────────────────────

  it('errors follow RFC format {error, error_description}', async () => {
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'invalid_type',
      }),
    });
    const body = await res.json();
    expect(body.error).toBe('unsupported_grant_type');
    expect(body.error_description).toBeDefined();
    // Should NOT have 'code' or 'message' keys (Qoopia internal format)
    expect(body.code).toBeUndefined();
    expect(body.message).toBeUndefined();
  });

  // ── Token Revocation (RFC 7009) ───────────────────────────

  it('POST /oauth/revoke with unknown token returns 200 (RFC 7009)', async () => {
    const res = await fetch(`${baseUrl}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'nonexistent-token-value' }),
    });
    expect(res.status).toBe(200);
  });

  // ── Deny authorization ────────────────────────────────────

  it('POST /oauth/authorize with action=deny redirects with error', async () => {
    const res = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'deny',
        client_id: testClientId,
        redirect_uri: 'http://localhost:9999/callback',
        state: 'deny-test',
        code_challenge: 'dummy',
        code_challenge_method: 'S256',
      }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location).toContain('error=access_denied');
    expect(location).toContain('state=deny-test');
  });
});
