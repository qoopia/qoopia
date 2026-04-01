import { Hono } from 'hono';
import { ulid } from 'ulid';
import { PROJECT_COLUMNS } from '../../db/columns.js';
import { rawDb } from '../../db/connection.js';
import { createProjectSchema, updateProjectSchema } from '../../core/validator.js';
import { logActivity } from '../../core/activity-log.js';
import { resolveActorName } from '../utils/resolve-actor.js';
import type { AuthContext } from '../../types/index.js';

const app = new Hono<{ Variables: { auth: AuthContext } }>();

// List projects
app.get('/', (c) => {
  const auth = c.get('auth');
  const offset = parseInt(c.req.query('offset') || '0');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const updatedSince = c.req.query('updated_since');

  let query = `SELECT ${PROJECT_COLUMNS} FROM projects WHERE workspace_id = ? AND deleted_at IS NULL`;
  const params: unknown[] = [auth.workspace_id];

  if (updatedSince) {
    query += ' AND updated_at > ?';
    params.push(updatedSince);
  }

  const countQuery = query.replace(`SELECT ${PROJECT_COLUMNS}`, 'SELECT COUNT(*) as total');
  const total = (rawDb.prepare(countQuery).get(...params) as { total: number }).total;

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = rawDb.prepare(query).all(...params) as Record<string, unknown>[];
  const data = rows.map(formatProject);

  return c.json({
    data,
    pagination: { total, limit, offset, has_more: offset + limit < total },
  });
});

// Get one project
app.get('/:id', (c) => {
  const auth = c.get('auth');
  const row = rawDb.prepare(
    `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
  ).get(c.req.param('id'), auth.workspace_id) as Record<string, unknown> | undefined;

  if (!row) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  return c.json({ data: formatProject(row) });
});

// Create project
app.post('/', async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json();
  const parsed = createProjectSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid project data',
        details: parsed.error.flatten(),
      }
    }, 400);
  }

  const id = ulid();
  const data = parsed.data;

  rawDb.prepare(`
    INSERT INTO projects (id, workspace_id, name, description, status, owner_agent_id, color, tags, settings, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    auth.workspace_id,
    data.name,
    data.description ?? null,
    data.status,
    data.owner_agent_id ?? null,
    data.color ?? null,
    JSON.stringify(data.tags),
    JSON.stringify(data.settings),
    auth.id,
  );

  logActivity({
    workspace_id: auth.workspace_id,
    actor: resolveActorName(auth),
    action: 'created',
    entity_type: 'project',
    entity_id: id,
    summary: `Created project: ${data.name}`,
    revision_after: 1,
  });

  const row = rawDb.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`).get(id) as Record<string, unknown>;
  return c.json({ data: formatProject(row) }, 201);
});

// Update project (PATCH)
app.patch('/:id', async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json();
  const parsed = updateProjectSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid update data',
        details: parsed.error.flatten(),
      }
    }, 400);
  }

  const { revision, ...updates } = parsed.data;
  const projectId = c.req.param('id');

  const current = rawDb.prepare(
    `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
  ).get(projectId, auth.workspace_id) as Record<string, unknown> | undefined;

  if (!current) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  if ((current.revision as number) !== revision) {
    return c.json({
      error: {
        code: 'REVISION_CONFLICT',
        message: `Entity was modified by ${current.updated_by} at ${current.updated_at}`,
        details: { your_revision: revision, current_revision: current.revision },
        current: formatProject(current),
      }
    }, 409);
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      setClauses.push(`${key} = ?`);
      values.push(key === 'tags' || key === 'settings' ? JSON.stringify(value) : value);
    }
  }

  setClauses.push("revision = revision + 1");
  setClauses.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')");
  setClauses.push("updated_by = ?");
  values.push(auth.id);
  values.push(projectId, auth.workspace_id);

  rawDb.prepare(
    `UPDATE projects SET ${setClauses.join(', ')} WHERE id = ? AND workspace_id = ?`
  ).run(...values);

  const changed = Object.keys(updates).filter(k => updates[k as keyof typeof updates] !== undefined);
  logActivity({
    workspace_id: auth.workspace_id,
    actor: resolveActorName(auth),
    action: 'updated',
    entity_type: 'project',
    entity_id: projectId,
    summary: `Updated project fields: ${changed.join(', ')}`,
    details: { before: formatProject(current), changes: updates },
    revision_before: revision,
    revision_after: revision + 1,
  });

  const updated = rawDb.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`).get(projectId) as Record<string, unknown>;
  return c.json({ data: formatProject(updated) });
});

// Delete project (soft delete)
app.delete('/:id', (c) => {
  const auth = c.get('auth');
  const projectId = c.req.param('id');

  const current = rawDb.prepare(
    `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
  ).get(projectId, auth.workspace_id) as Record<string, unknown> | undefined;

  if (!current) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  rawDb.prepare(
    "UPDATE projects SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
  ).run(projectId);

  logActivity({
    workspace_id: auth.workspace_id,
    actor: resolveActorName(auth),
    action: 'deleted',
    entity_type: 'project',
    entity_id: projectId,
    summary: `Deleted project: ${current.name}`,
    revision_before: current.revision as number,
  });

  return c.body(null, 204);
});

function formatProject(row: Record<string, unknown>) {
  return {
    ...row,
    tags: safeJsonParse(row.tags as string, []),
    settings: safeJsonParse(row.settings as string, {}),
  };
}

function safeJsonParse(str: string | null | undefined, fallback: unknown) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

export default app;
