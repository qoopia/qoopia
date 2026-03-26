import { createMiddleware } from 'hono/factory';
import crypto from 'node:crypto';
import { rawDb } from '../../db/connection.js';
import type { AuthContext } from '../../types/index.js';

export const authMiddleware = createMiddleware<{ Variables: { auth: AuthContext } }>(async (c, next) => {
  // Try Authorization header first
  let rawKey = '';
  const authHeader = c.req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    rawKey = authHeader.slice(7);
  }

  // Fallback to session cookie
  if (!rawKey) {
    const cookie = c.req.header('Cookie') || '';
    const match = cookie.match(/qp_session=([^;]+)/);
    if (match) {
      rawKey = match[1];
    }
  }

  if (!rawKey) {
    return c.json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid Authorization header. Expected: Bearer qp_xxx',
      }
    }, 401);
  }

  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');

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
    'SELECT id, workspace_id, name FROM users WHERE api_key_hash = ?'
  ).get(hash) as { id: string; workspace_id: string; name: string } | undefined;

  if (user) {
    rawDb.prepare("UPDATE users SET last_seen = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(user.id);
    c.set('auth', { type: 'user', id: user.id, workspace_id: user.workspace_id, name: user.name });
    return next();
  }

  return c.json({
    error: {
      code: 'UNAUTHORIZED',
      message: 'Invalid API key',
    }
  }, 401);
});
