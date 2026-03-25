import { Hono } from 'hono';
import { ulid } from 'ulid';
import { rawDb } from '../../db/connection.js';
import { createDealSchema, updateDealSchema } from '../../core/validator.js';
import { logActivity } from '../../core/activity-log.js';
import type { AuthContext } from '../../types/index.js';

const app = new Hono<{ Variables: { auth: AuthContext } }>();

// List deals
app.get('/', (c) => {
  const auth = c.get('auth');
  const offset = parseInt(c.req.query('offset') || '0');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const projectId = c.req.query('project_id');
  const status = c.req.query('status');
  const updatedSince = c.req.query('updated_since');

  let query = 'SELECT * FROM deals WHERE workspace_id = ? AND deleted_at IS NULL';
  const params: unknown[] = [auth.workspace_id];

  if (projectId) { query += ' AND project_id = ?'; params.push(projectId); }
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (updatedSince) { query += ' AND updated_at > ?'; params.push(updatedSince); }

  const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total');
  const total = (rawDb.prepare(countQuery).get(...params) as { total: number }).total;

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = rawDb.prepare(query).all(...params) as Record<string, unknown>[];
  const data = rows.map(formatDeal);

  return c.json({
    data,
    pagination: { total, limit, offset, has_more: offset + limit < total },
  });
});

// Get one deal (includes contacts via deal_contacts)
app.get('/:id', (c) => {
  const auth = c.get('auth');
  const row = rawDb.prepare(
    'SELECT * FROM deals WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
  ).get(c.req.param('id'), auth.workspace_id) as Record<string, unknown> | undefined;

  if (!row) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Deal not found' } }, 404);
  }

  const contacts = rawDb.prepare(
    'SELECT c.*, dc.role as deal_role FROM contacts c JOIN deal_contacts dc ON dc.contact_id = c.id WHERE dc.deal_id = ? AND c.deleted_at IS NULL'
  ).all(c.req.param('id')) as Record<string, unknown>[];

  const formatted = formatDeal(row);
  return c.json({ data: { ...formatted, contacts: contacts.map(formatContact) } });
});

// Create deal
app.post('/', async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json();
  const parsed = createDealSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid deal data', details: parsed.error.flatten() }
    }, 400);
  }

  const { contact_ids, ...data } = parsed.data;

  const project = rawDb.prepare(
    'SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
  ).get(data.project_id, auth.workspace_id);

  if (!project) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: `Project ${data.project_id} not found` }
    }, 400);
  }

  const id = ulid();

  const insertDeal = rawDb.transaction(() => {
    rawDb.prepare(`
      INSERT INTO deals (id, project_id, workspace_id, name, address, status, asking_price, target_price, monthly_rent, lease_term_months, metadata, documents, timeline, tags, notes, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, data.project_id, auth.workspace_id, data.name,
      data.address ?? null, data.status,
      data.asking_price ?? null, data.target_price ?? null,
      data.monthly_rent ?? null, data.lease_term_months ?? null,
      JSON.stringify(data.metadata), JSON.stringify(data.documents),
      JSON.stringify(data.timeline), JSON.stringify(data.tags),
      data.notes ?? null, auth.id,
    );

    if (contact_ids?.length) {
      const stmt = rawDb.prepare('INSERT INTO deal_contacts (deal_id, contact_id) VALUES (?, ?)');
      for (const cid of contact_ids) stmt.run(id, cid);
    }
  });

  insertDeal();

  logActivity({
    workspace_id: auth.workspace_id, actor: auth.id, action: 'created',
    entity_type: 'deal', entity_id: id, project_id: data.project_id,
    summary: `Created deal: ${data.name}`, revision_after: 1,
  });

  const row = rawDb.prepare('SELECT * FROM deals WHERE id = ?').get(id) as Record<string, unknown>;
  return c.json({ data: formatDeal(row) }, 201);
});

// Update deal (PATCH)
app.patch('/:id', async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json();
  const parsed = updateDealSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid update data', details: parsed.error.flatten() }
    }, 400);
  }

  const { revision, contact_ids, ...updates } = parsed.data;
  const dealId = c.req.param('id');

  const current = rawDb.prepare(
    'SELECT * FROM deals WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
  ).get(dealId, auth.workspace_id) as Record<string, unknown> | undefined;

  if (!current) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Deal not found' } }, 404);
  }

  if ((current.revision as number) !== revision) {
    return c.json({
      error: {
        code: 'REVISION_CONFLICT',
        message: `Entity was modified by ${current.updated_by} at ${current.updated_at}`,
        details: { your_revision: revision, current_revision: current.revision },
        current: formatDeal(current),
      }
    }, 409);
  }

  const jsonFields = new Set(['metadata', 'documents', 'timeline', 'tags']);
  const setClauses: string[] = [];
  const values: unknown[] = [];

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
  values.push(dealId, auth.workspace_id);

  const updateDeal = rawDb.transaction(() => {
    rawDb.prepare(
      `UPDATE deals SET ${setClauses.join(', ')} WHERE id = ? AND workspace_id = ?`
    ).run(...values);

    if (contact_ids !== undefined) {
      rawDb.prepare('DELETE FROM deal_contacts WHERE deal_id = ?').run(dealId);
      const stmt = rawDb.prepare('INSERT INTO deal_contacts (deal_id, contact_id) VALUES (?, ?)');
      for (const cid of contact_ids) stmt.run(dealId, cid);
    }
  });

  updateDeal();

  const changed = Object.keys(updates).filter(k => updates[k as keyof typeof updates] !== undefined);
  logActivity({
    workspace_id: auth.workspace_id, actor: auth.id, action: 'updated',
    entity_type: 'deal', entity_id: dealId, project_id: current.project_id as string,
    summary: `Updated deal fields: ${changed.join(', ')}`,
    details: { changes: updates },
    revision_before: revision, revision_after: revision + 1,
  });

  const updated = rawDb.prepare('SELECT * FROM deals WHERE id = ?').get(dealId) as Record<string, unknown>;
  return c.json({ data: formatDeal(updated) });
});

// Delete deal (soft delete)
app.delete('/:id', (c) => {
  const auth = c.get('auth');
  const dealId = c.req.param('id');

  const current = rawDb.prepare(
    'SELECT * FROM deals WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
  ).get(dealId, auth.workspace_id) as Record<string, unknown> | undefined;

  if (!current) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Deal not found' } }, 404);
  }

  rawDb.prepare("UPDATE deals SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(dealId);

  logActivity({
    workspace_id: auth.workspace_id, actor: auth.id, action: 'deleted',
    entity_type: 'deal', entity_id: dealId, project_id: current.project_id as string,
    summary: `Deleted deal: ${current.name}`, revision_before: current.revision as number,
  });

  return c.body(null, 204);
});

function formatDeal(row: Record<string, unknown>) {
  return {
    ...row,
    metadata: safeJsonParse(row.metadata as string, {}),
    documents: safeJsonParse(row.documents as string, []),
    timeline: safeJsonParse(row.timeline as string, []),
    tags: safeJsonParse(row.tags as string, []),
  };
}

function formatContact(row: Record<string, unknown>) {
  return { ...row, tags: safeJsonParse(row.tags as string, []) };
}

function safeJsonParse(str: string | null | undefined, fallback: unknown) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

export default app;
