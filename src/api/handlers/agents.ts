import { Hono } from 'hono';
import crypto from 'node:crypto';
import { ulid } from 'ulid';
import { rawDb } from '../../db/connection.js';
import { logActivity } from '../../core/activity-log.js';
import { resolveActorName } from '../utils/resolve-actor.js';
import type { AuthContext } from '../../types/index.js';

const app = new Hono<{ Variables: { auth: AuthContext } }>();

// List agents
app.get('/', (c) => {
  const auth = c.get('auth');
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10) || 50, 1), 100);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);

  const total = (rawDb.prepare(
    'SELECT COUNT(*) as total FROM agents WHERE workspace_id = ?'
  ).get(auth.workspace_id) as { total: number }).total;

  const rows = rawDb.prepare(
    'SELECT id, workspace_id, name, type, key_rotated_at, permissions, metadata, last_seen, active, created_at FROM agents WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(auth.workspace_id, limit, offset) as Record<string, unknown>[];

  const data = rows.map(formatAgent);
  return c.json({ data, total, limit, offset });
});

// Register new agent
app.post('/', async (c) => {
  const auth = c.get('auth');

  // HIGH #5: Only admin/owner users can manage agents
  if (auth.type !== 'user' || !['admin', 'owner'].includes(auth.role ?? '')) {
    return c.json({
      error: { code: 'FORBIDDEN', message: 'Only admin or owner users can register agents' }
    }, 403);
  }

  const body = await c.req.json();
  const { name, type, permissions, metadata } = body;

  if (!name || !type) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'name and type are required' }
    }, 400);
  }

  const id = ulid();
  const rawKey = `qp_a_${crypto.randomBytes(32).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');

  rawDb.prepare(`
    INSERT INTO agents (id, workspace_id, name, type, api_key_hash, permissions, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    auth.workspace_id,
    name,
    type,
    hash,
    JSON.stringify(permissions || {}),
    JSON.stringify(metadata || {}),
  );

  logActivity({
    workspace_id: auth.workspace_id,
    actor: resolveActorName(auth),
    action: 'created',
    entity_type: 'agent',
    entity_id: id,
    summary: `Registered agent: ${name} (${type})`,
  });

  return c.json({
    data: {
      id,
      name,
      type,
      api_key: rawKey,
      message: 'Save this API key — it will not be shown again.',
    }
  }, 201);
});

// Update agent permissions/metadata
app.patch('/:id', async (c) => {
  const auth = c.get('auth');
  const agentId = c.req.param('id');

  // HIGH #5: Only admin/owner users can manage agents
  if (auth.type !== 'user' || !['admin', 'owner'].includes(auth.role ?? '')) {
    return c.json({
      error: { code: 'FORBIDDEN', message: 'Only admin or owner users can update agents' }
    }, 403);
  }

  const current = rawDb.prepare(
    'SELECT * FROM agents WHERE id = ? AND workspace_id = ?'
  ).get(agentId, auth.workspace_id) as Record<string, unknown> | undefined;

  if (!current) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Agent not found' } }, 404);
  }

  const body = await c.req.json();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) {
    setClauses.push('name = ?');
    values.push(body.name);
  }
  if (body.type !== undefined) {
    setClauses.push('type = ?');
    values.push(body.type);
  }
  if (body.permissions !== undefined) {
    setClauses.push('permissions = ?');
    values.push(JSON.stringify(body.permissions));
  }
  if (body.metadata !== undefined) {
    setClauses.push('metadata = ?');
    values.push(JSON.stringify(body.metadata));
  }
  if (body.active !== undefined) {
    setClauses.push('active = ?');
    values.push(body.active ? 1 : 0);
  }

  if (setClauses.length === 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'No fields to update' } }, 400);
  }

  values.push(agentId, auth.workspace_id);
  rawDb.prepare(
    `UPDATE agents SET ${setClauses.join(', ')} WHERE id = ? AND workspace_id = ?`
  ).run(...values);

  const details: Record<string, unknown> = {};
  if (body.permissions !== undefined) {
    details.before = safeJsonParse(current.permissions as string, {});
    details.after = body.permissions;
  }

  logActivity({
    workspace_id: auth.workspace_id,
    actor: resolveActorName(auth),
    action: 'updated',
    entity_type: 'agent',
    entity_id: agentId,
    summary: `Updated agent: ${current.name} — fields: ${Object.keys(body).join(', ')}`,
    details,
  });

  const updated = rawDb.prepare(
    'SELECT id, workspace_id, name, type, key_rotated_at, permissions, metadata, last_seen, active, created_at FROM agents WHERE id = ?'
  ).get(agentId) as Record<string, unknown>;

  return c.json({ data: formatAgent(updated) });
});

// Deactivate agent
app.delete('/:id', (c) => {
  const auth = c.get('auth');
  const agentId = c.req.param('id');

  // HIGH #5: Only admin/owner users can manage agents
  if (auth.type !== 'user' || !['admin', 'owner'].includes(auth.role ?? '')) {
    return c.json({
      error: { code: 'FORBIDDEN', message: 'Only admin or owner users can deactivate agents' }
    }, 403);
  }

  const current = rawDb.prepare(
    'SELECT * FROM agents WHERE id = ? AND workspace_id = ?'
  ).get(agentId, auth.workspace_id) as Record<string, unknown> | undefined;

  if (!current) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Agent not found' } }, 404);
  }

  rawDb.prepare('UPDATE agents SET active = 0 WHERE id = ?').run(agentId);

  logActivity({
    workspace_id: auth.workspace_id,
    actor: resolveActorName(auth),
    action: 'deleted',
    entity_type: 'agent',
    entity_id: agentId,
    summary: `Deactivated agent: ${current.name}`,
  });

  return c.body(null, 204);
});

// Rotate API key (24h grace period)
app.post('/:id/rotate-key', (c) => {
  const auth = c.get('auth');
  const agentId = c.req.param('id');

  // HIGH #5: Only admin/owner users can manage agents
  if (auth.type !== 'user' || !['admin', 'owner'].includes(auth.role ?? '')) {
    return c.json({
      error: { code: 'FORBIDDEN', message: 'Only admin or owner users can rotate agent keys' }
    }, 403);
  }

  const current = rawDb.prepare(
    'SELECT * FROM agents WHERE id = ? AND workspace_id = ? AND active = 1'
  ).get(agentId, auth.workspace_id) as Record<string, unknown> | undefined;

  if (!current) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Agent not found or inactive' } }, 404);
  }

  const newRawKey = `qp_a_${crypto.randomBytes(32).toString('hex')}`;
  const newHash = crypto.createHash('sha256').update(newRawKey).digest('hex');
  const now = new Date().toISOString().replace(/\.\d{3}Z/, 'Z');
  const gracePeriodEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z/, 'Z');

  rawDb.prepare(`
    UPDATE agents SET
      previous_key_hash = api_key_hash,
      previous_key_expires = ?,
      api_key_hash = ?,
      key_rotated_at = ?
    WHERE id = ?
  `).run(gracePeriodEnd, newHash, now, agentId);

  logActivity({
    workspace_id: auth.workspace_id,
    actor: resolveActorName(auth),
    action: 'rotated_key',
    entity_type: 'agent',
    entity_id: agentId,
    summary: `Rotated API key for agent: ${current.name}`,
    details: { previous_key_expires: gracePeriodEnd },
  });

  return c.json({
    api_key: newRawKey,
    message: `New key active. Old key valid until ${gracePeriodEnd}`,
    previous_key_expires: gracePeriodEnd,
  });
});

function formatAgent(row: Record<string, unknown>) {
  return {
    ...row,
    permissions: safeJsonParse(row.permissions as string, {}),
    metadata: safeJsonParse(row.metadata as string, {}),
  };
}

function safeJsonParse(str: string | null | undefined, fallback: unknown) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

export default app;
