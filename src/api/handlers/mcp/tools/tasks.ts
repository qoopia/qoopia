import { ulid } from 'ulid';
import { rawDb } from '../../../../db/connection.js';
import { logActivity } from '../../../../core/activity-log.js';
import { now, jsonStr } from '../utils.js';
import type { ToolDefinition } from '../utils.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'list_tasks',
    description: 'List tasks, optionally filtered by project or status',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Filter by project ID' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'waiting', 'done', 'cancelled'] },
        assignee: { type: 'string', description: 'Filter by assignee ID' },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
    },
  },
  {
    name: 'get_task',
    description: 'Get a specific task by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task ID' } },
      required: ['id'],
    },
  },
  {
    name: 'create_task',
    description: 'Create a new task',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        project_id: { type: 'string', description: 'Project ID' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'waiting', 'done', 'cancelled'], description: 'Default: todo' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Default: medium' },
        assignee: { type: 'string', description: 'Assignee agent ID' },
        due_date: { type: 'string', description: 'Due date (YYYY-MM-DD)' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        description: { type: 'string' },
      },
      required: ['title', 'project_id'],
    },
  },
  {
    name: 'update_task',
    description: 'Update an existing task',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'waiting', 'done', 'cancelled'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        assignee: { type: 'string' },
        due_date: { type: 'string' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        description: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_task',
    description: 'Soft-delete a task',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task ID' } },
      required: ['id'],
    },
  },
];

export async function handleTool(name: string, args: Record<string, unknown>, workspaceId: string, actorId: string): Promise<unknown | null> {
  const limit = Math.min(Number(args.limit) || 50, 100);

  switch (name) {
    case 'list_tasks': {
      let query = 'SELECT id, title, status, priority, assignee, due_date, project_id, updated_at FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL';
      const params: unknown[] = [workspaceId];
      if (args.project_id) { query += ' AND project_id = ?'; params.push(args.project_id); }
      if (args.status) { query += ' AND status = ?'; params.push(args.status); }
      if (args.assignee) { query += ' AND assignee = ?'; params.push(args.assignee); }
      query += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);
      const tasks = rawDb.prepare(query).all(...params);

      // Smart context
      const context: string[] = [];
      const overdueCount = (rawDb.prepare("SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL AND due_date < date('now') AND status NOT IN ('done', 'cancelled')").get(workspaceId) as { c: number }).c;
      if (overdueCount > 0) context.push(`${overdueCount} task${overdueCount > 1 ? 's are' : ' is'} overdue. Use the note tool to record completed work — statuses update automatically.`);
      const inProgressCount = (rawDb.prepare("SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL AND status = 'in_progress'").get(workspaceId) as { c: number }).c;
      if (inProgressCount > 0) context.push(`${inProgressCount} task${inProgressCount > 1 ? 's' : ''} in progress. Use note to record completions, or brief for full context.`);

      const result: Record<string, unknown> = { tasks };
      if (context.length > 0) result.context = context.join(' ');
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'get_task': {
      const row = rawDb.prepare('SELECT id, project_id, title, description, status, priority, assignee, due_date, tags, notes, source, revision, created_at, updated_at, updated_by FROM tasks WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(args.id, workspaceId);
      if (!row) return { content: [{ type: 'text', text: 'Task not found' }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(row) }] };
    }

    case 'create_task': {
      const id = ulid();
      const t = now();
      rawDb.prepare(`INSERT INTO tasks (id, project_id, workspace_id, title, description, status, priority, assignee, due_date, tags, notes, source, revision, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`).run(
        id, args.project_id, workspaceId, args.title, args.description ?? null,
        args.status ?? 'todo', args.priority ?? 'medium', args.assignee ?? null,
        args.due_date ?? null, jsonStr(args.tags), args.notes ?? null, 'mcp', t, t, actorId
      );
      logActivity({ workspace_id: workspaceId, actor: actorId, action: 'created', entity_type: 'task', entity_id: id, project_id: args.project_id as string, summary: `Created task: ${args.title}`, revision_after: 1 });
      const row = rawDb.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      return { content: [{ type: 'text', text: JSON.stringify(row) }] };
    }

    case 'update_task': {
      const existing = rawDb.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(args.id, workspaceId) as Record<string, unknown> | undefined;
      if (!existing) return { content: [{ type: 'text', text: 'Task not found' }], isError: true };
      const fields: string[] = [];
      const vals: unknown[] = [];
      for (const f of ['title', 'description', 'status', 'priority', 'assignee', 'due_date', 'notes']) {
        if (args[f] !== undefined) { fields.push(`${f} = ?`); vals.push(args[f]); }
      }
      if (args.tags !== undefined) { fields.push('tags = ?'); vals.push(jsonStr(args.tags)); }
      if (fields.length === 0) return { content: [{ type: 'text', text: 'No fields to update' }], isError: true };
      const newRev = (existing.revision as number) + 1;
      fields.push('revision = ?', 'updated_at = ?', 'updated_by = ?');
      vals.push(newRev, now(), actorId, args.id, workspaceId);
      rawDb.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ? AND workspace_id = ?`).run(...vals);
      logActivity({ workspace_id: workspaceId, actor: actorId, action: 'updated', entity_type: 'task', entity_id: args.id as string, project_id: existing.project_id as string, summary: `Updated task: ${existing.title} [${fields.filter(f => !f.startsWith('revision') && !f.startsWith('updated')).map(f => f.split(' ')[0]).join(', ')}]`, revision_before: existing.revision as number, revision_after: newRev });
      const row = rawDb.prepare('SELECT * FROM tasks WHERE id = ?').get(args.id);
      return { content: [{ type: 'text', text: JSON.stringify(row) }] };
    }

    case 'delete_task': {
      const existing = rawDb.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(args.id, workspaceId) as Record<string, unknown> | undefined;
      if (!existing) return { content: [{ type: 'text', text: 'Task not found' }], isError: true };
      const newRev = (existing.revision as number) + 1;
      rawDb.prepare('UPDATE tasks SET deleted_at = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(now(), newRev, now(), actorId, args.id);
      logActivity({ workspace_id: workspaceId, actor: actorId, action: 'deleted', entity_type: 'task', entity_id: args.id as string, project_id: existing.project_id as string, summary: `Deleted task: ${existing.title}`, revision_before: existing.revision as number, revision_after: newRev });
      return { content: [{ type: 'text', text: `Deleted task: ${existing.title}` }] };
    }

    default:
      return null;
  }
}
