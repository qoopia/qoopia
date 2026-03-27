import { createMiddleware } from 'hono/factory';
import crypto from 'node:crypto';
import { rawDb } from '../../db/connection.js';
import { verifyAccessToken } from '../handlers/oauth.js';
import type { AuthContext } from '../../types/index.js';

const publicUrl = process.env.QOOPIA_PUBLIC_URL || 'http://localhost:3737';
const wwwAuth = `Bearer resource_metadata_uri="${publicUrl}/.well-known/oauth-protected-resource"`;

export const authMiddleware = createMiddleware<{ Variables: { auth: AuthContext } }>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    c.header('WWW-Authenticate', wwwAuth);
    return c.json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid Authorization header. Expected: Bearer <token>',
      }
    }, 401);
  }

  const token = authHeader.slice(7);

  // ── Priority 1: API Key (SHA-256 lookup) ──────────────────
  if (!token.startsWith('eyJ')) {
    const hash = crypto.createHash('sha256').update(token).digest('hex');

    // Check agents (current key)
    let record = rawDb.prepare(
      'SELECT id, workspace_id, name FROM agents WHERE api_key_hash = ? AND active = 1'
    ).get(hash) as { id: string; workspace_id: string; name: string } | undefined;

    if (record) {
      rawDb.prepare("UPDATE agents SET last_seen = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(record.id);
      c.set('auth', { type: 'agent', id: record.id, workspace_id: record.workspace_id, name: record.name });
      return next();
    }

    // Check agents (previous key, grace period)
    record = rawDb.prepare(
      "SELECT id, workspace_id, name FROM agents WHERE previous_key_hash = ? AND previous_key_expires > strftime('%Y-%m-%dT%H:%M:%SZ', 'now') AND active = 1"
    ).get(hash) as { id: string; workspace_id: string; name: string } | undefined;

    if (record) {
      rawDb.prepare("UPDATE agents SET last_seen = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(record.id);
      c.set('auth', { type: 'agent', id: record.id, workspace_id: record.workspace_id, name: record.name });
      return next();
    }

    // Check users
    const user = rawDb.prepare(
      'SELECT id, workspace_id, name, role, session_expires_at FROM users WHERE api_key_hash = ?'
    ).get(hash) as { id: string; workspace_id: string; name: string; role: string; session_expires_at: string | null } | undefined;

    if (user) {
      // HIGH #6: enforce server-side session expiry
      if (user.session_expires_at && user.session_expires_at < new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        c.header('WWW-Authenticate', wwwAuth);
        return c.json({
          error: { code: 'UNAUTHORIZED', message: 'Session expired. Please re-authenticate.' }
        }, 401);
      }
      rawDb.prepare("UPDATE users SET last_seen = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(user.id);
      c.set('auth', { type: 'user', id: user.id, workspace_id: user.workspace_id, name: user.name, role: user.role });
      return next();
    }

    c.header('WWW-Authenticate', wwwAuth);
    return c.json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid API key',
      }
    }, 401);
  }

  // ── Priority 2: JWT (starts with eyJ) ─────────────────────
  try {
    const payload = await verifyAccessToken(token);

    // Get agent/user name for context
    const agentRecord = rawDb.prepare('SELECT name FROM agents WHERE id = ?').get(payload.sub) as { name: string } | undefined;

    c.set('auth', {
      type: payload.type || 'agent',
      id: payload.sub,
      workspace_id: payload.workspace_id,
      name: agentRecord?.name || payload.sub,
    });
    return next();
  } catch {
    c.header('WWW-Authenticate', wwwAuth);
    return c.json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or expired JWT',
      }
    }, 401);
  }
});
