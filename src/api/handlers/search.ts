import { Hono } from 'hono';
import { rawDb } from '../../db/connection.js';
import type { AuthContext } from '../../types/index.js';

const app = new Hono<{ Variables: { auth: AuthContext } }>();

// FTS5 search across entities
app.get('/', (c) => {
  const auth = c.get('auth');
  const q = c.req.query('q');
  const entities = (c.req.query('entities') || 'tasks,deals,contacts,activity').split(',');
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '10', 10) || 10, 1), 100);

  if (!q || q.trim().length === 0) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'Query parameter "q" is required' }
    }, 400);
  }

  // Sanitize FTS5 query: strip special chars, keep only alphanumeric words
  const ftsQuery = q.replace(/[^\w\s]/g, '').trim() + '*';
  const result: Record<string, unknown[]> = {};

  try {
    if (entities.includes('tasks')) {
      result.tasks = rawDb.prepare(`
        SELECT t.id, t.title, t.status, t.priority, t.project_id,
               rank
        FROM tasks_fts
        JOIN tasks t ON tasks_fts.rowid = t.rowid
        WHERE tasks_fts MATCH ? AND t.workspace_id = ? AND t.deleted_at IS NULL
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, auth.workspace_id, limit);
    }

    if (entities.includes('deals')) {
      result.deals = rawDb.prepare(`
        SELECT d.id, d.name, d.address, d.status, d.project_id,
               rank
        FROM deals_fts
        JOIN deals d ON deals_fts.rowid = d.rowid
        WHERE deals_fts MATCH ? AND d.workspace_id = ? AND d.deleted_at IS NULL
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, auth.workspace_id, limit);
    }

    if (entities.includes('contacts')) {
      result.contacts = rawDb.prepare(`
        SELECT c.id, c.name, c.role, c.company, c.category,
               rank
        FROM contacts_fts
        JOIN contacts c ON contacts_fts.rowid = c.rowid
        WHERE contacts_fts MATCH ? AND c.workspace_id = ? AND c.deleted_at IS NULL
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, auth.workspace_id, limit);
    }

    if (entities.includes('activity')) {
      result.activity = rawDb.prepare(`
        SELECT a.id, a.summary, a.action, a.entity_type, a.timestamp,
               rank
        FROM activity_fts
        JOIN activity a ON activity_fts.rowid = a.rowid
        WHERE activity_fts MATCH ? AND a.workspace_id = ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, auth.workspace_id, limit);
    }
  } catch {
    return c.json({
      error: { code: 'INVALID_QUERY', message: 'Invalid search syntax' }
    }, 400);
  }

  return c.json({ data: result, limit });
});

export default app;
