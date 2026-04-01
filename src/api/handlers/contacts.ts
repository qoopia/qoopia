import { Hono } from 'hono';
import { ulid } from 'ulid';
import { CONTACT_COLUMNS } from '../../db/columns.js';
import { rawDb } from '../../db/connection.js';
import { createContactSchema, updateContactSchema } from '../../core/validator.js';
import { logActivity } from '../../core/activity-log.js';
import { resolveActorName } from '../utils/resolve-actor.js';
import type { AuthContext } from '../../types/index.js';

const app = new Hono<{ Variables: { auth: AuthContext } }>();

// List contacts
app.get('/', (c) => {
  const auth = c.get('auth');
  const offset = parseInt(c.req.query('offset') || '0');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const category = c.req.query('category');
  const projectId = c.req.query('project_id');
  const updatedSince = c.req.query('updated_since');

  let query = `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL`;
  const params: unknown[] = [auth.workspace_id];

  if (category) { query += ' AND category = ?'; params.push(category); }
  if (projectId) {
    query += ' AND id IN (SELECT contact_id FROM contact_projects WHERE project_id = ?)';
    params.push(projectId);
  }
  if (updatedSince) { query += ' AND updated_at > ?'; params.push(updatedSince); }

  const countQuery = query.replace(`SELECT ${CONTACT_COLUMNS}`, 'SELECT COUNT(*) as total');
  const total = (rawDb.prepare(countQuery).get(...params) as { total: number }).total;

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = rawDb.prepare(query).all(...params) as Record<string, unknown>[];
  const data = rows.map(formatContact);

  return c.json({
    data,
    pagination: { total, limit, offset, has_more: offset + limit < total },
  });
});

// Get one contact (includes projects via contact_projects)
app.get('/:id', (c) => {
  const auth = c.get('auth');
  const row = rawDb.prepare(
    `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
  ).get(c.req.param('id'), auth.workspace_id) as Record<string, unknown> | undefined;

  if (!row) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Contact not found' } }, 404);
  }

  const projects = rawDb.prepare(
    'SELECT p.id, p.name, p.status, cp.role as contact_role FROM projects p JOIN contact_projects cp ON cp.project_id = p.id WHERE cp.contact_id = ? AND p.deleted_at IS NULL'
  ).all(c.req.param('id')) as Record<string, unknown>[];

  const formatted = formatContact(row);
  return c.json({ data: { ...formatted, projects } });
});

// Create contact
app.post('/', async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json();
  const parsed = createContactSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid contact data', details: parsed.error.flatten() }
    }, 400);
  }

  const { project_ids, ...data } = parsed.data;
  const id = ulid();

  const insertContact = rawDb.transaction(() => {
    rawDb.prepare(`
      INSERT INTO contacts (id, workspace_id, name, role, company, email, phone, telegram_id, language, timezone, category, communication_rules, tags, notes, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, auth.workspace_id, data.name,
      data.role ?? null, data.company ?? null, data.email ?? null,
      data.phone ?? null, data.telegram_id ?? null, data.language,
      data.timezone ?? null, data.category ?? null,
      data.communication_rules ?? null,
      JSON.stringify(data.tags), data.notes ?? null, auth.id,
    );

    if (project_ids?.length) {
      const stmt = rawDb.prepare('INSERT INTO contact_projects (contact_id, project_id) VALUES (?, ?)');
      for (const pid of project_ids) stmt.run(id, pid);
    }
  });

  insertContact();

  logActivity({
    workspace_id: auth.workspace_id, actor: resolveActorName(auth), action: 'created',
    entity_type: 'contact', entity_id: id,
    summary: `Created contact: ${data.name}`, revision_after: 1,
  });

  const row = rawDb.prepare(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = ?`).get(id) as Record<string, unknown>;
  return c.json({ data: formatContact(row) }, 201);
});

// Update contact (PATCH)
app.patch('/:id', async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json();
  const parsed = updateContactSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid update data', details: parsed.error.flatten() }
    }, 400);
  }

  const { revision, project_ids, ...updates } = parsed.data;
  const contactId = c.req.param('id');

  const current = rawDb.prepare(
    `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
  ).get(contactId, auth.workspace_id) as Record<string, unknown> | undefined;

  if (!current) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Contact not found' } }, 404);
  }

  if ((current.revision as number) !== revision) {
    return c.json({
      error: {
        code: 'REVISION_CONFLICT',
        message: `Entity was modified by ${current.updated_by} at ${current.updated_at}`,
        details: { your_revision: revision, current_revision: current.revision },
        current: formatContact(current),
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
  values.push(contactId, auth.workspace_id);

  const updateContact = rawDb.transaction(() => {
    rawDb.prepare(
      `UPDATE contacts SET ${setClauses.join(', ')} WHERE id = ? AND workspace_id = ?`
    ).run(...values);

    if (project_ids !== undefined) {
      rawDb.prepare('DELETE FROM contact_projects WHERE contact_id = ?').run(contactId);
      const stmt = rawDb.prepare('INSERT INTO contact_projects (contact_id, project_id) VALUES (?, ?)');
      for (const pid of project_ids) stmt.run(contactId, pid);
    }
  });

  updateContact();

  const changed = Object.keys(updates).filter(k => updates[k as keyof typeof updates] !== undefined);
  logActivity({
    workspace_id: auth.workspace_id, actor: resolveActorName(auth), action: 'updated',
    entity_type: 'contact', entity_id: contactId,
    summary: `Updated contact fields: ${changed.join(', ')}`,
    details: { changes: updates },
    revision_before: revision, revision_after: revision + 1,
  });

  const updated = rawDb.prepare(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = ?`).get(contactId) as Record<string, unknown>;
  return c.json({ data: formatContact(updated) });
});

// Delete contact (soft delete)
app.delete('/:id', (c) => {
  const auth = c.get('auth');
  const contactId = c.req.param('id');

  const current = rawDb.prepare(
    `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
  ).get(contactId, auth.workspace_id) as Record<string, unknown> | undefined;

  if (!current) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Contact not found' } }, 404);
  }

  rawDb.prepare("UPDATE contacts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(contactId);

  logActivity({
    workspace_id: auth.workspace_id, actor: resolveActorName(auth), action: 'deleted',
    entity_type: 'contact', entity_id: contactId,
    summary: `Deleted contact: ${current.name}`, revision_before: current.revision as number,
  });

  return c.body(null, 204);
});

function formatContact(row: Record<string, unknown>) {
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
