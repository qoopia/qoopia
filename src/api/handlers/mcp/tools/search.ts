import { rawDb } from '../../../../db/connection.js';
import type { ToolDefinition } from '../utils.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'search',
    description: 'Full-text search across tasks, deals, contacts, and activity',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        entities: { type: 'string', description: 'Comma-separated entity types to search' },
      },
      required: ['query'],
    },
  },
];

export async function handleTool(name: string, args: Record<string, unknown>, workspaceId: string, actorId: string): Promise<unknown | null> {
  if (name !== 'search') return null;

  const q = String(args.query || '').trim();
  if (!q) return { content: [{ type: 'text', text: 'Empty search query' }], isError: true };
  const ftsQuery = q.split(/\s+/).map(t => `"${t}"*`).join(' ');
  const results: Record<string, unknown[]> = {};
  const entities = (args.entities as string || 'tasks,deals,contacts,activity').split(',');
  for (const entity of entities) {
    const trimmed = entity.trim();
    try {
      switch (trimmed) {
        case 'tasks':
          results.tasks = rawDb.prepare(`SELECT t.id, t.title, t.status, t.priority, rank FROM tasks_fts f JOIN tasks t ON t.rowid = f.rowid WHERE tasks_fts MATCH ? AND t.workspace_id = ? AND t.deleted_at IS NULL ORDER BY rank LIMIT 20`).all(ftsQuery, workspaceId);
          break;
        case 'deals':
          results.deals = rawDb.prepare(`SELECT d.id, d.name, d.address, d.status, rank FROM deals_fts f JOIN deals d ON d.rowid = f.rowid WHERE deals_fts MATCH ? AND d.workspace_id = ? AND d.deleted_at IS NULL ORDER BY rank LIMIT 20`).all(ftsQuery, workspaceId);
          break;
        case 'contacts':
          results.contacts = rawDb.prepare(`SELECT c.id, c.name, c.company, c.category, rank FROM contacts_fts f JOIN contacts c ON c.rowid = f.rowid WHERE contacts_fts MATCH ? AND c.workspace_id = ? AND c.deleted_at IS NULL ORDER BY rank LIMIT 20`).all(ftsQuery, workspaceId);
          break;
        case 'activity':
          results.activity = rawDb.prepare(`SELECT a.id, a.summary, a.entity_type, a.action, a.timestamp, rank FROM activity_fts f JOIN activity a ON a.rowid = f.rowid WHERE activity_fts MATCH ? AND a.workspace_id = ? ORDER BY rank LIMIT 20`).all(ftsQuery, workspaceId);
          break;
      }
    } catch { results[trimmed] = []; }
  }
  return { content: [{ type: 'text', text: JSON.stringify(results) }] };
}
