import { ulid } from 'ulid';
import { rawDb } from '../../../../db/connection.js';
import { logActivity } from '../../../../core/activity-log.js';
import { now, jsonStr } from '../utils.js';
import type { ToolDefinition } from '../utils.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'list_contacts',
    description: 'List contacts, optionally filtered by category',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'create_contact',
    description: 'Create a new contact',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full name' },
        role: { type: 'string' },
        company: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        telegram_id: { type: 'string' },
        language: { type: 'string', description: 'Default: EN' },
        timezone: { type: 'string' },
        category: { type: 'string' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_contact',
    description: 'Update an existing contact',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Contact ID' },
        name: { type: 'string' },
        role: { type: 'string' },
        company: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        telegram_id: { type: 'string' },
        language: { type: 'string' },
        timezone: { type: 'string' },
        category: { type: 'string' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_contact',
    description: 'Soft-delete a contact',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Contact ID' } },
      required: ['id'],
    },
  },
];

export async function handleTool(name: string, args: Record<string, unknown>, workspaceId: string, actorId: string): Promise<unknown | null> {
  const limit = Math.min(Number(args.limit) || 50, 100);

  switch (name) {
    case 'list_contacts': {
      let query = 'SELECT id, name, email, phone, role, company, updated_at FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL';
      const params: unknown[] = [workspaceId];
      if (args.category) { query += ' AND category = ?'; params.push(args.category); }
      query += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);
      return { content: [{ type: 'text', text: JSON.stringify(rawDb.prepare(query).all(...params)) }] };
    }

    case 'create_contact': {
      const id = ulid();
      const t = now();
      rawDb.prepare(`INSERT INTO contacts (id, workspace_id, name, role, company, email, phone, telegram_id, language, timezone, category, notes, tags, revision, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`).run(
        id, workspaceId, args.name, args.role ?? null, args.company ?? null,
        args.email ?? null, args.phone ?? null, args.telegram_id ?? null,
        args.language ?? 'EN', args.timezone ?? null, args.category ?? null,
        args.notes ?? null, jsonStr(args.tags), t, t, actorId
      );
      logActivity({ workspace_id: workspaceId, actor: actorId, action: 'created', entity_type: 'contact', entity_id: id, summary: `Created contact: ${args.name}`, revision_after: 1 });
      const row = rawDb.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
      return { content: [{ type: 'text', text: JSON.stringify(row) }] };
    }

    case 'update_contact': {
      const existing = rawDb.prepare('SELECT * FROM contacts WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(args.id, workspaceId) as Record<string, unknown> | undefined;
      if (!existing) return { content: [{ type: 'text', text: 'Contact not found' }], isError: true };
      const fields: string[] = [];
      const vals: unknown[] = [];
      for (const f of ['name', 'role', 'company', 'email', 'phone', 'telegram_id', 'language', 'timezone', 'category', 'notes']) {
        if (args[f] !== undefined) { fields.push(`${f} = ?`); vals.push(args[f]); }
      }
      if (args.tags !== undefined) { fields.push('tags = ?'); vals.push(jsonStr(args.tags)); }
      if (fields.length === 0) return { content: [{ type: 'text', text: 'No fields to update' }], isError: true };
      const newRev = (existing.revision as number) + 1;
      fields.push('revision = ?', 'updated_at = ?', 'updated_by = ?');
      vals.push(newRev, now(), actorId, args.id, workspaceId);
      rawDb.prepare(`UPDATE contacts SET ${fields.join(', ')} WHERE id = ? AND workspace_id = ?`).run(...vals);
      logActivity({ workspace_id: workspaceId, actor: actorId, action: 'updated', entity_type: 'contact', entity_id: args.id as string, summary: `Updated contact: ${existing.name}`, revision_before: existing.revision as number, revision_after: newRev });
      const row = rawDb.prepare('SELECT * FROM contacts WHERE id = ?').get(args.id);
      return { content: [{ type: 'text', text: JSON.stringify(row) }] };
    }

    case 'delete_contact': {
      const existing = rawDb.prepare('SELECT * FROM contacts WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(args.id, workspaceId) as Record<string, unknown> | undefined;
      if (!existing) return { content: [{ type: 'text', text: 'Contact not found' }], isError: true };
      const newRev = (existing.revision as number) + 1;
      rawDb.prepare('UPDATE contacts SET deleted_at = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(now(), newRev, now(), actorId, args.id);
      logActivity({ workspace_id: workspaceId, actor: actorId, action: 'deleted', entity_type: 'contact', entity_id: args.id as string, summary: `Deleted contact: ${existing.name}`, revision_before: existing.revision as number, revision_after: newRev });
      return { content: [{ type: 'text', text: `Deleted contact: ${existing.name}` }] };
    }

    default:
      return null;
  }
}
