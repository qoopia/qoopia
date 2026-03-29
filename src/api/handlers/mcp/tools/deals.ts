import { ulid } from 'ulid';
import { rawDb } from '../../../../db/connection.js';
import { logActivity } from '../../../../core/activity-log.js';
import { now, jsonStr } from '../utils.js';
import type { ToolDefinition } from '../utils.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'list_deals',
    description: 'List deals, optionally filtered by project or status',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'create_deal',
    description: 'Create a new deal',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Deal name' },
        project_id: { type: 'string', description: 'Project ID' },
        address: { type: 'string' },
        status: { type: 'string', enum: ['active', 'paused', 'archived'], description: 'Default: active' },
        asking_price: { type: 'number' },
        target_price: { type: 'number' },
        monthly_rent: { type: 'number' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        metadata: { type: 'object', description: 'Additional structured data' },
        timeline: { type: 'array', items: { type: 'object' }, description: 'Array of {date, event} objects' },
      },
      required: ['name', 'project_id'],
    },
  },
  {
    name: 'update_deal',
    description: 'Update an existing deal',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Deal ID' },
        name: { type: 'string' },
        address: { type: 'string' },
        status: { type: 'string', enum: ['active', 'paused', 'archived'] },
        asking_price: { type: 'number' },
        target_price: { type: 'number' },
        monthly_rent: { type: 'number' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        metadata: { type: 'object' },
        timeline: { type: 'array', items: { type: 'object' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_deal',
    description: 'Soft-delete a deal',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Deal ID' } },
      required: ['id'],
    },
  },
];

export async function handleTool(name: string, args: Record<string, unknown>, workspaceId: string, actorId: string): Promise<unknown | null> {
  const limit = Math.min(Number(args.limit) || 50, 100);

  switch (name) {
    case 'list_deals': {
      let query = 'SELECT id, name, status, asking_price, target_price, updated_at FROM deals WHERE workspace_id = ? AND deleted_at IS NULL';
      const params: unknown[] = [workspaceId];
      if (args.project_id) { query += ' AND project_id = ?'; params.push(args.project_id); }
      if (args.status) { query += ' AND status = ?'; params.push(args.status); }
      query += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);
      const deals = rawDb.prepare(query).all(...params);

      // Smart context
      const context: string[] = [];
      const activeDealsCount = (rawDb.prepare("SELECT COUNT(*) as c FROM deals WHERE workspace_id = ? AND deleted_at IS NULL AND status IN ('negotiation', 'due_diligence', 'active')").get(workspaceId) as { c: number }).c;
      if (activeDealsCount > 0) context.push(`${activeDealsCount} active deal${activeDealsCount > 1 ? 's' : ''}. Use note to record deal updates — statuses update automatically.`);

      const result: Record<string, unknown> = { deals };
      if (context.length > 0) result.context = context.join(' ');
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'create_deal': {
      const id = ulid();
      const t = now();
      rawDb.prepare(`INSERT INTO deals (id, project_id, workspace_id, name, address, status, asking_price, target_price, monthly_rent, metadata, timeline, tags, notes, revision, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`).run(
        id, args.project_id, workspaceId, args.name, args.address ?? null,
        args.status ?? 'active', args.asking_price ?? null, args.target_price ?? null,
        args.monthly_rent ?? null, jsonStr(args.metadata || {}), jsonStr(args.timeline),
        jsonStr(args.tags), args.notes ?? null, t, t, actorId
      );
      logActivity({ workspace_id: workspaceId, actor: actorId, action: 'created', entity_type: 'deal', entity_id: id, project_id: args.project_id as string, summary: `Created deal: ${args.name}`, revision_after: 1 });
      const row = rawDb.prepare('SELECT * FROM deals WHERE id = ?').get(id);
      return { content: [{ type: 'text', text: JSON.stringify(row) }] };
    }

    case 'update_deal': {
      const existing = rawDb.prepare('SELECT * FROM deals WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(args.id, workspaceId) as Record<string, unknown> | undefined;
      if (!existing) return { content: [{ type: 'text', text: 'Deal not found' }], isError: true };
      const fields: string[] = [];
      const vals: unknown[] = [];
      for (const f of ['name', 'address', 'status', 'asking_price', 'target_price', 'monthly_rent', 'notes']) {
        if (args[f] !== undefined) { fields.push(`${f} = ?`); vals.push(args[f]); }
      }
      if (args.tags !== undefined) { fields.push('tags = ?'); vals.push(jsonStr(args.tags)); }
      if (args.metadata !== undefined) { fields.push('metadata = ?'); vals.push(jsonStr(args.metadata)); }
      if (args.timeline !== undefined) { fields.push('timeline = ?'); vals.push(jsonStr(args.timeline)); }
      if (fields.length === 0) return { content: [{ type: 'text', text: 'No fields to update' }], isError: true };
      const newRev = (existing.revision as number) + 1;
      fields.push('revision = ?', 'updated_at = ?', 'updated_by = ?');
      vals.push(newRev, now(), actorId, args.id, workspaceId);
      rawDb.prepare(`UPDATE deals SET ${fields.join(', ')} WHERE id = ? AND workspace_id = ?`).run(...vals);
      logActivity({ workspace_id: workspaceId, actor: actorId, action: 'updated', entity_type: 'deal', entity_id: args.id as string, project_id: existing.project_id as string, summary: `Updated deal: ${existing.name}`, revision_before: existing.revision as number, revision_after: newRev });
      const row = rawDb.prepare('SELECT * FROM deals WHERE id = ?').get(args.id);
      return { content: [{ type: 'text', text: JSON.stringify(row) }] };
    }

    case 'delete_deal': {
      const existing = rawDb.prepare('SELECT * FROM deals WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(args.id, workspaceId) as Record<string, unknown> | undefined;
      if (!existing) return { content: [{ type: 'text', text: 'Deal not found' }], isError: true };
      const newRev = (existing.revision as number) + 1;
      rawDb.prepare('UPDATE deals SET deleted_at = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(now(), newRev, now(), actorId, args.id);
      logActivity({ workspace_id: workspaceId, actor: actorId, action: 'deleted', entity_type: 'deal', entity_id: args.id as string, project_id: existing.project_id as string, summary: `Deleted deal: ${existing.name}`, revision_before: existing.revision as number, revision_after: newRev });
      return { content: [{ type: 'text', text: `Deleted deal: ${existing.name}` }] };
    }

    default:
      return null;
  }
}
