import { ulid } from 'ulid';
import { rawDb } from '../../../../db/connection.js';
import { logActivity } from '../../../../core/activity-log.js';
import { now, jsonStr } from '../utils.js';
import type { ToolDefinition } from '../utils.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'list_finances',
    description: 'List financial records',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['subscription', 'credit', 'investment', 'budget', 'purchase', 'acquisition'] },
        status: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'create_finance',
    description: 'Create a financial record',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['subscription', 'credit', 'investment', 'budget', 'purchase', 'acquisition'] },
        name: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string', description: 'Default: USD' },
        recurring: { type: 'string', enum: ['none', 'monthly', 'annual', 'biennial'] },
        status: { type: 'string', enum: ['active', 'trial', 'paused', 'cancelled'], description: 'Default: active' },
        project_id: { type: 'string' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['type', 'name', 'amount'],
    },
  },
  {
    name: 'update_finance',
    description: 'Update a financial record',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Finance ID' },
        type: { type: 'string', enum: ['subscription', 'credit', 'investment', 'budget', 'purchase', 'acquisition'] },
        name: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string' },
        recurring: { type: 'string', enum: ['none', 'monthly', 'annual', 'biennial'] },
        status: { type: 'string', enum: ['active', 'trial', 'paused', 'cancelled'] },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_finance',
    description: 'Soft-delete a financial record',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Finance ID' } },
      required: ['id'],
    },
  },
];

export async function handleTool(name: string, args: Record<string, unknown>, workspaceId: string, actorId: string): Promise<unknown | null> {
  const limit = Math.min(Number(args.limit) || 50, 100);

  switch (name) {
    case 'list_finances': {
      let query = 'SELECT id, name, amount, type, currency, status, updated_at FROM finances WHERE workspace_id = ? AND deleted_at IS NULL';
      const params: unknown[] = [workspaceId];
      if (args.type) { query += ' AND type = ?'; params.push(args.type); }
      if (args.status) { query += ' AND status = ?'; params.push(args.status); }
      query += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);
      return { content: [{ type: 'text', text: JSON.stringify(rawDb.prepare(query).all(...params)) }] };
    }

    case 'create_finance': {
      const id = ulid();
      const t = now();
      rawDb.prepare(`INSERT INTO finances (id, workspace_id, project_id, type, name, amount, currency, recurring, status, tags, notes, revision, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`).run(
        id, workspaceId, args.project_id ?? null, args.type, args.name, args.amount,
        args.currency ?? 'USD', args.recurring ?? 'none', args.status ?? 'active',
        jsonStr(args.tags), args.notes ?? null, t, t, actorId
      );
      logActivity({ workspace_id: workspaceId, actor: actorId, action: 'created', entity_type: 'finance', entity_id: id, project_id: args.project_id as string ?? undefined, summary: `Created finance: ${args.name} ($${args.amount})`, revision_after: 1 });
      const row = rawDb.prepare('SELECT * FROM finances WHERE id = ?').get(id);
      return { content: [{ type: 'text', text: JSON.stringify(row) }] };
    }

    case 'update_finance': {
      const existing = rawDb.prepare('SELECT * FROM finances WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(args.id, workspaceId) as Record<string, unknown> | undefined;
      if (!existing) return { content: [{ type: 'text', text: 'Finance record not found' }], isError: true };
      const fields: string[] = [];
      const vals: unknown[] = [];
      for (const f of ['type', 'name', 'amount', 'currency', 'recurring', 'status', 'notes']) {
        if (args[f] !== undefined) { fields.push(`${f} = ?`); vals.push(args[f]); }
      }
      if (args.tags !== undefined) { fields.push('tags = ?'); vals.push(jsonStr(args.tags)); }
      if (fields.length === 0) return { content: [{ type: 'text', text: 'No fields to update' }], isError: true };
      const newRev = (existing.revision as number) + 1;
      fields.push('revision = ?', 'updated_at = ?', 'updated_by = ?');
      vals.push(newRev, now(), actorId, args.id, workspaceId);
      rawDb.prepare(`UPDATE finances SET ${fields.join(', ')} WHERE id = ? AND workspace_id = ?`).run(...vals);
      logActivity({ workspace_id: workspaceId, actor: actorId, action: 'updated', entity_type: 'finance', entity_id: args.id as string, summary: `Updated finance: ${existing.name}`, revision_before: existing.revision as number, revision_after: newRev });
      const row = rawDb.prepare('SELECT * FROM finances WHERE id = ?').get(args.id);
      return { content: [{ type: 'text', text: JSON.stringify(row) }] };
    }

    case 'delete_finance': {
      const existing = rawDb.prepare('SELECT * FROM finances WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(args.id, workspaceId) as Record<string, unknown> | undefined;
      if (!existing) return { content: [{ type: 'text', text: 'Finance record not found' }], isError: true };
      const newRev = (existing.revision as number) + 1;
      rawDb.prepare('UPDATE finances SET deleted_at = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(now(), newRev, now(), actorId, args.id);
      logActivity({ workspace_id: workspaceId, actor: actorId, action: 'deleted', entity_type: 'finance', entity_id: args.id as string, summary: `Deleted finance: ${existing.name}`, revision_before: existing.revision as number, revision_after: newRev });
      return { content: [{ type: 'text', text: `Deleted finance: ${existing.name}` }] };
    }

    default:
      return null;
  }
}
