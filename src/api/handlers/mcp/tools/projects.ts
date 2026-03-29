import { rawDb } from '../../../../db/connection.js';
import { logActivity } from '../../../../core/activity-log.js';
import { now, jsonStr } from '../utils.js';
import type { ToolDefinition } from '../utils.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'list_projects',
    description: 'List all projects in the workspace',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'paused', 'archived'], description: 'Filter by status' },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
    },
  },
  {
    name: 'update_project',
    description: 'Update a project (description, status, tags, color)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Project ID' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['active', 'paused', 'archived'] },
        tags: { type: 'array', items: { type: 'string' } },
        color: { type: 'string' },
      },
      required: ['id'],
    },
  },
];

export async function handleTool(name: string, args: Record<string, unknown>, workspaceId: string, actorId: string): Promise<unknown | null> {
  const limit = Math.min(Number(args.limit) || 50, 100);

  switch (name) {
    case 'list_projects': {
      let query = 'SELECT id, name, description, status, updated_at FROM projects WHERE workspace_id = ? AND deleted_at IS NULL';
      const params: unknown[] = [workspaceId];
      if (args.status) { query += ' AND status = ?'; params.push(args.status); }
      query += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);
      return { content: [{ type: 'text', text: JSON.stringify(rawDb.prepare(query).all(...params)) }] };
    }

    case 'update_project': {
      const existing = rawDb.prepare('SELECT * FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(args.id, workspaceId) as Record<string, unknown> | undefined;
      if (!existing) return { content: [{ type: 'text', text: 'Project not found' }], isError: true };
      const fields: string[] = [];
      const vals: unknown[] = [];
      for (const f of ['description', 'status', 'color']) {
        if (args[f] !== undefined) { fields.push(`${f} = ?`); vals.push(args[f]); }
      }
      if (args.tags !== undefined) { fields.push('tags = ?'); vals.push(jsonStr(args.tags)); }
      if (fields.length === 0) return { content: [{ type: 'text', text: 'No fields to update' }], isError: true };
      const newRev = (existing.revision as number) + 1;
      fields.push('revision = ?', 'updated_at = ?', 'updated_by = ?');
      vals.push(newRev, now(), actorId, args.id, workspaceId);
      rawDb.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ? AND workspace_id = ?`).run(...vals);
      logActivity({ workspace_id: workspaceId, actor: actorId, action: 'updated', entity_type: 'project', entity_id: args.id as string, summary: `Updated project: ${existing.name}`, revision_before: existing.revision as number, revision_after: newRev });
      const row = rawDb.prepare('SELECT * FROM projects WHERE id = ?').get(args.id);
      return { content: [{ type: 'text', text: JSON.stringify(row) }] };
    }

    default:
      return null;
  }
}
