import { Hono } from 'hono';
import { ulid } from 'ulid';
import { rawDb } from '../../db/connection.js';
import { createFinanceSchema, updateFinanceSchema } from '../../core/validator.js';
import { logActivity } from '../../core/activity-log.js';
import { resolveActorName } from '../utils/resolve-actor.js';
import type { AuthContext } from '../../types/index.js';

const app = new Hono<{ Variables: { auth: AuthContext } }>();

// List finances
app.get('/', (c) => {
  const auth = c.get('auth');
  const offset = parseInt(c.req.query('offset') || '0');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const projectId = c.req.query('project_id');
  const type = c.req.query('type');
  const status = c.req.query('status');
  const updatedSince = c.req.query('updated_since');

  let query = 'SELECT * FROM finances WHERE workspace_id = ? AND deleted_at IS NULL';
  const params: unknown[] = [auth.workspace_id];

  if (projectId) { query += ' AND project_id = ?'; params.push(projectId); }
  if (type) { query += ' AND type = ?'; params.push(type); }
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (updatedSince) { query += ' AND updated_at > ?'; params.push(updatedSince); }

  const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total');
  const total = (rawDb.prepare(countQuery).get(...params) as { total: number }).total;

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = rawDb.prepare(query).all(...params) as Record<string, unknown>[];
  const data = rows.map(formatFinance);

  return c.json({
    data,
    pagination: { total, limit, offset, has_more: offset + limit < total },
  });
});

// Get one finance
app.get('/:id', (c) => {
  const auth = c.get('auth');
  const row = rawDb.prepare(
    'SELECT * FROM finances WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
  ).get(c.req.param('id'), auth.workspace_id) as Record<string, unknown> | undefined;

  if (!row) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Finance record not found' } }, 404);
  }

  return c.json({ data: formatFinance(row) });
});

// Create finance
app.post('/', async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json();
  const parsed = createFinanceSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid finance data', details: parsed.error.flatten() }
    }, 400);
  }

  const data = parsed.data;

  if (data.project_id) {
    const project = rawDb.prepare(
      'SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
    ).get(data.project_id, auth.workspace_id);
    if (!project) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: `Project ${data.project_id} not found` }
      }, 400);
    }
  }

  const id = ulid();

  rawDb.prepare(`
    INSERT INTO finances (id, workspace_id, project_id, type, name, amount, currency, recurring, status, tags, notes, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, auth.workspace_id, data.project_id ?? null,
    data.type, data.name, data.amount, data.currency, data.recurring,
    data.status, JSON.stringify(data.tags), data.notes ?? null, auth.id,
  );

  logActivity({
    workspace_id: auth.workspace_id, actor: resolveActorName(auth), action: 'created',
    entity_type: 'finance', entity_id: id, project_id: data.project_id ?? undefined,
    summary: `Created finance: ${data.name} (${data.type}, ${data.amount} ${data.currency})`,
    revision_after: 1,
  });

  const row = rawDb.prepare('SELECT * FROM finances WHERE id = ?').get(id) as Record<string, unknown>;
  return c.json({ data: formatFinance(row) }, 201);
});

// Update finance (PATCH)
app.patch('/:id', async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json();
  const parsed = updateFinanceSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid update data', details: parsed.error.flatten() }
    }, 400);
  }

  const { revision, ...updates } = parsed.data;
  const financeId = c.req.param('id');

  const current = rawDb.prepare(
    'SELECT * FROM finances WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
  ).get(financeId, auth.workspace_id) as Record<string, unknown> | undefined;

  if (!current) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Finance record not found' } }, 404);
  }

  if ((current.revision as number) !== revision) {
    return c.json({
      error: {
        code: 'REVISION_CONFLICT',
        message: `Entity was modified by ${current.updated_by} at ${current.updated_at}`,
        details: { your_revision: revision, current_revision: current.revision },
        current: formatFinance(current),
      }
    }, 409);
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      setClauses.push(`${key} = ?`);
      values.push(key === 'tags' ? JSON.stringify(value) : value);
    }
  }

  setClauses.push("revision = revision + 1");
  setClauses.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')");
  setClauses.push("updated_by = ?");
  values.push(auth.id);
  values.push(financeId, auth.workspace_id);

  rawDb.prepare(
    `UPDATE finances SET ${setClauses.join(', ')} WHERE id = ? AND workspace_id = ?`
  ).run(...values);

  const changed = Object.keys(updates).filter(k => updates[k as keyof typeof updates] !== undefined);
  logActivity({
    workspace_id: auth.workspace_id, actor: resolveActorName(auth), action: 'updated',
    entity_type: 'finance', entity_id: financeId,
    project_id: (updates.project_id ?? current.project_id) as string | undefined,
    summary: `Updated finance fields: ${changed.join(', ')}`,
    details: { changes: updates },
    revision_before: revision, revision_after: revision + 1,
  });

  const updated = rawDb.prepare('SELECT * FROM finances WHERE id = ?').get(financeId) as Record<string, unknown>;
  return c.json({ data: formatFinance(updated) });
});

// Delete finance (soft delete)
app.delete('/:id', (c) => {
  const auth = c.get('auth');
  const financeId = c.req.param('id');

  const current = rawDb.prepare(
    'SELECT * FROM finances WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
  ).get(financeId, auth.workspace_id) as Record<string, unknown> | undefined;

  if (!current) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Finance record not found' } }, 404);
  }

  rawDb.prepare("UPDATE finances SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(financeId);

  logActivity({
    workspace_id: auth.workspace_id, actor: resolveActorName(auth), action: 'deleted',
    entity_type: 'finance', entity_id: financeId,
    summary: `Deleted finance: ${current.name}`, revision_before: current.revision as number,
  });

  return c.body(null, 204);
});

function formatFinance(row: Record<string, unknown>) {
  return {
    ...row,
    tags: safeJsonParse(row.tags as string, []),
  };
}

function safeJsonParse(str: string | null | undefined, fallback: unknown) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

export default app;
