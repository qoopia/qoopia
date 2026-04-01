import { Hono } from 'hono';
import {
  ACTIVITY_COLUMNS,
  CONTACT_COLUMNS,
  DEAL_COLUMNS,
  FINANCE_COLUMNS,
  PROJECT_COLUMNS,
  TASK_COLUMNS,
  WORKSPACE_COLUMNS,
} from '../../db/columns.js';
import { rawDb } from '../../db/connection.js';
import type { AuthContext } from '../../types/index.js';

const app = new Hono<{ Variables: { auth: AuthContext } }>();

// GET /api/v1/export — full workspace JSON dump (admin/owner only)
app.get('/', (c) => {
  const auth = c.get('auth');

  // Only users can export (agents cannot)
  if (auth.type !== 'user') {
    return c.json({
      error: { code: 'FORBIDDEN', message: 'Only users can export workspace data' }
    }, 403);
  }

  // Check user role
  const user = rawDb.prepare(
    'SELECT role FROM users WHERE id = ?'
  ).get(auth.id) as { role: string } | undefined;

  if (!user || !['owner', 'admin'].includes(user.role)) {
    return c.json({
      error: { code: 'FORBIDDEN', message: 'Admin or owner role required for export' }
    }, 403);
  }

  const wsId = auth.workspace_id;

  const workspace = rawDb.prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?`).get(wsId);
  const projects = rawDb.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE workspace_id = ? AND deleted_at IS NULL`).all(wsId);
  const tasks = rawDb.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL`).all(wsId);
  const deals = rawDb.prepare(`SELECT ${DEAL_COLUMNS} FROM deals WHERE workspace_id = ? AND deleted_at IS NULL`).all(wsId);
  const contacts = rawDb.prepare(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL`).all(wsId);
  const finances = rawDb.prepare(`SELECT ${FINANCE_COLUMNS} FROM finances WHERE workspace_id = ? AND deleted_at IS NULL`).all(wsId);
  const agents = rawDb.prepare('SELECT id, workspace_id, name, type, permissions, metadata, last_seen, active, created_at FROM agents WHERE workspace_id = ?').all(wsId);
  const users = rawDb.prepare('SELECT id, workspace_id, name, email, role, last_seen, created_at FROM users WHERE workspace_id = ?').all(wsId);
  const contactProjects = rawDb.prepare(`
    SELECT cp.* FROM contact_projects cp
    JOIN contacts c ON c.id = cp.contact_id
    WHERE c.workspace_id = ? AND c.deleted_at IS NULL
  `).all(wsId);
  const dealContacts = rawDb.prepare(`
    SELECT dc.* FROM deal_contacts dc
    JOIN deals d ON d.id = dc.deal_id
    WHERE d.workspace_id = ? AND d.deleted_at IS NULL
  `).all(wsId);

  // Recent activity (last 1000 entries)
  const activity = rawDb.prepare(
    `SELECT ${ACTIVITY_COLUMNS} FROM activity WHERE workspace_id = ? ORDER BY id DESC LIMIT 1000`
  ).all(wsId);

  const exported = {
    exported_at: new Date().toISOString().replace(/\.\d{3}Z/, 'Z'),
    version: '2.0.0',
    workspace,
    users,
    agents: (agents as Record<string, unknown>[]).map(a => ({
      ...a,
      permissions: safeJsonParse(a.permissions as string, {}),
      metadata: safeJsonParse(a.metadata as string, {}),
    })),
    projects: (projects as Record<string, unknown>[]).map(p => ({
      ...p,
      tags: safeJsonParse(p.tags as string, []),
      settings: safeJsonParse(p.settings as string, {}),
    })),
    tasks: (tasks as Record<string, unknown>[]).map(t => ({
      ...t,
      blocked_by: safeJsonParse(t.blocked_by as string, []),
      tags: safeJsonParse(t.tags as string, []),
      attachments: safeJsonParse(t.attachments as string, []),
    })),
    deals: (deals as Record<string, unknown>[]).map(d => ({
      ...d,
      metadata: safeJsonParse(d.metadata as string, {}),
      documents: safeJsonParse(d.documents as string, []),
      timeline: safeJsonParse(d.timeline as string, []),
      tags: safeJsonParse(d.tags as string, []),
    })),
    contacts: (contacts as Record<string, unknown>[]).map(co => ({
      ...co,
      tags: safeJsonParse(co.tags as string, []),
    })),
    finances: (finances as Record<string, unknown>[]).map(f => ({
      ...f,
      tags: safeJsonParse(f.tags as string, []),
    })),
    contact_projects: contactProjects,
    deal_contacts: dealContacts,
    activity: (activity as Record<string, unknown>[]).map(a => ({
      ...a,
      details: safeJsonParse(a.details as string, {}),
    })),
    stats: {
      projects: (projects as unknown[]).length,
      tasks: (tasks as unknown[]).length,
      deals: (deals as unknown[]).length,
      contacts: (contacts as unknown[]).length,
      finances: (finances as unknown[]).length,
      agents: (agents as unknown[]).length,
      users: (users as unknown[]).length,
      activity: (activity as unknown[]).length,
    },
  };

  c.header('Content-Disposition', `attachment; filename="qoopia-export-${wsId}.json"`);
  return c.json(exported);
});

function safeJsonParse(str: string | null | undefined, fallback: unknown) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

export default app;
