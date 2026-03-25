import { Hono } from 'hono';
import { ulid } from 'ulid';
import { rawDb } from '../../db/connection.js';
import { createTaskSchema, updateTaskSchema } from '../../core/validator.js';
import { logActivity } from '../../core/activity-log.js';
import type { AuthContext } from '../../types/index.js';

const app = new Hono<{ Variables: { auth: AuthContext } }>();

// List tasks
app.get('/', (c) => {
  const auth = c.get('auth');
  const offset = parseInt(c.req.query('offset') || '0');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const projectId = c.req.query('project_id');
  const status = c.req.query('status');
  const assignee = c.req.query('assignee');
  const priority = c.req.query('priority');
  const updatedSince = c.req.query('updated_since');

  let query = 'SELECT * FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL';
  const params: unknown[] = [auth.workspace_id];

  if (projectId) { query += ' AND project_id = ?'; params.push(projectId); }
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (assignee) { query += ' AND assignee = ?'; params.push(assignee); }
  if (priority) { query += ' AND priority = ?'; params.push(priority); }
  if (updatedSince) { query += ' AND updated_at > ?'; params.push(updatedSince); }

  const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total');
  const total = (rawDb.prepare(countQuery).get(...params) as { total: number }).total;

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = rawDb.prepare(query).all(...params) as Record<string, unknown>[];
  const data = rows.map(formatTask);

  return c.json({
    data,
    pagination: { total, limit, offset, has_more: offset + limit < total },
  });
});

// Get one task
app.get('/:id', (c) => {
  const auth = c.get('auth');
  const row = rawDb.prepare(
    'SELECT * FROM tasks WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
  ).get(c.req.param('id'), auth.workspace_id) as Record<string, unknown> | undefined;

  if (!row) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
  }

  return c.json({ data: formatTask(row) });
});

// Create task
app.post('/', async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json();
  const parsed = createTaskSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid task data',
        details: parsed.error.flatten(),
      }
    }, 400);
  }

  const data = parsed.data;

  // Verify project exists and belongs to workspace
  const project = rawDb.prepare(
    'SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
  ).get(data.project_id, auth.workspace_id);

  if (!project) {
    return c.json({
      error: {
        code: 'VALIDATION_ERROR',
        message: `Project ${data.project_id} not found in this workspace`,
      }
    }, 400);
  }

  const id = ulid();

  rawDb.prepare(`
    INSERT INTO tasks (id, project_id, workspace_id, title, description, status, priority, assignee, due_date, blocked_by, parent_id, source, tags, notes, attachments, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.project_id,
    auth.workspace_id,
    data.title,
    data.description ?? null,
    data.status,
    data.priority,
    data.assignee ?? null,
    data.due_date ?? null,
    JSON.stringify(data.blocked_by),
    data.parent_id ?? null,
    data.source,
    JSON.stringify(data.tags),
    data.notes ?? null,
    JSON.stringify(data.attachments),
    auth.id,
  );

  logActivity({
    workspace_id: auth.workspace_id,
    actor: auth.id,
    action: 'created',
    entity_type: 'task',
    entity_id: id,
    project_id: data.project_id,
    summary: `Created task: ${data.title}`,
    revision_after: 1,
  });

  const row = rawDb.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>;
  return c.json({ data: formatTask(row) }, 201);
});

// Update task (PATCH)
app.patch('/:id', async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json();
  const parsed = updateTaskSchema.safeParse(body);

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
  const taskId = c.req.param('id');

  const current = rawDb.prepare(
    'SELECT * FROM tasks WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
  ).get(taskId, auth.workspace_id) as Record<string, unknown> | undefined;

  if (!current) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
  }

  if ((current.revision as number) !== revision) {
    return c.json({
      error: {
        code: 'REVISION_CONFLICT',
        message: `Entity was modified by ${current.updated_by} at ${current.updated_at}`,
        details: { your_revision: revision, current_revision: current.revision },
        current: formatTask(current),
      }
    }, 409);
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  const jsonFields = new Set(['blocked_by', 'tags', 'attachments']);

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      setClauses.push(`${key} = ?`);
      values.push(jsonFields.has(key) ? JSON.stringify(value) : value);
    }
  }

  setClauses.push("revision = revision + 1");
  setClauses.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')");
  setClauses.push("updated_by = ?");
  values.push(auth.id);
  values.push(taskId, auth.workspace_id);

  rawDb.prepare(
    `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ? AND workspace_id = ?`
  ).run(...values);

  const changed = Object.keys(updates).filter(k => updates[k as keyof typeof updates] !== undefined);
  const summaryParts = changed.map(k => {
    if (k === 'status') return `status: ${current.status} → ${updates.status}`;
    return k;
  });

  logActivity({
    workspace_id: auth.workspace_id,
    actor: auth.id,
    action: 'updated',
    entity_type: 'task',
    entity_id: taskId,
    project_id: current.project_id as string,
    summary: `Updated task: ${summaryParts.join(', ')}`,
    details: { before: formatTask(current), changes: updates },
    revision_before: revision,
    revision_after: revision + 1,
  });

  const updated = rawDb.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>;
  return c.json({ data: formatTask(updated) });
});

// Delete task (soft delete)
app.delete('/:id', (c) => {
  const auth = c.get('auth');
  const taskId = c.req.param('id');

  const current = rawDb.prepare(
    'SELECT * FROM tasks WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
  ).get(taskId, auth.workspace_id) as Record<string, unknown> | undefined;

  if (!current) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
  }

  rawDb.prepare(
    "UPDATE tasks SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
  ).run(taskId);

  logActivity({
    workspace_id: auth.workspace_id,
    actor: auth.id,
    action: 'deleted',
    entity_type: 'task',
    entity_id: taskId,
    project_id: current.project_id as string,
    summary: `Deleted task: ${current.title}`,
    revision_before: current.revision as number,
  });

  return c.body(null, 204);
});

function formatTask(row: Record<string, unknown>) {
  return {
    ...row,
    blocked_by: safeJsonParse(row.blocked_by as string, []),
    tags: safeJsonParse(row.tags as string, []),
    attachments: safeJsonParse(row.attachments as string, []),
  };
}

function safeJsonParse(str: string | null | undefined, fallback: unknown) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

export default app;
