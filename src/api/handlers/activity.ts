import { Hono } from 'hono';
import { rawDb } from '../../db/connection.js';
import type { AuthContext } from '../../types/index.js';

const app = new Hono<{ Variables: { auth: AuthContext } }>();

// List activity (cursor-based pagination)
app.get('/', (c) => {
  const auth = c.get('auth');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const cursor = c.req.query('cursor');
  const actor = c.req.query('actor');
  const entityType = c.req.query('entity_type');
  const projectId = c.req.query('project_id');

  let query = 'SELECT * FROM activity WHERE workspace_id = ?';
  const params: unknown[] = [auth.workspace_id];

  if (cursor) { query += ' AND id < ?'; params.push(cursor); }
  if (actor) { query += ' AND actor = ?'; params.push(actor); }
  if (entityType) { query += ' AND entity_type = ?'; params.push(entityType); }
  if (projectId) { query += ' AND project_id = ?'; params.push(projectId); }

  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit + 1);

  const rows = rawDb.prepare(query).all(...params) as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit).map(row => ({
    ...row,
    details: safeJsonParse(row.details as string, {}),
  }));

  const lastId = hasMore && data.length > 0 ? (data[data.length - 1] as Record<string, unknown>).id : null;

  return c.json({
    data,
    pagination: {
      limit,
      next_cursor: lastId,
      has_more: hasMore,
    },
  });
});

function safeJsonParse(str: string | null | undefined, fallback: unknown) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

export default app;
