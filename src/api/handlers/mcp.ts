import { Hono } from 'hono';
import { rawDb } from '../../db/connection.js';
import type { AuthContext } from '../../types/index.js';

const app = new Hono<{ Variables: { auth: AuthContext } }>();

// MCP Streamable HTTP endpoint
// Implements the Model Context Protocol for read-only access
// Supports: tools/list, tools/call for querying Qoopia data

interface McpRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

const TOOLS = [
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
    name: 'get_activity',
    description: 'Get recent activity log entries',
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', description: 'Filter by entity type (task, deal, contact, etc.)' },
        project_id: { type: 'string' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
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

function handleToolsList(): unknown {
  return { tools: TOOLS };
}

function handleToolCall(name: string, args: Record<string, unknown>, workspaceId: string): unknown {
  const limit = Math.min(Number(args.limit) || 50, 100);

  switch (name) {
    case 'list_projects': {
      let query = 'SELECT * FROM projects WHERE workspace_id = ? AND deleted_at IS NULL';
      const params: unknown[] = [workspaceId];
      if (args.status) { query += ' AND status = ?'; params.push(args.status); }
      query += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);
      const rows = rawDb.prepare(query).all(...params);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    }

    case 'list_tasks': {
      let query = 'SELECT * FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL';
      const params: unknown[] = [workspaceId];
      if (args.project_id) { query += ' AND project_id = ?'; params.push(args.project_id); }
      if (args.status) { query += ' AND status = ?'; params.push(args.status); }
      if (args.assignee) { query += ' AND assignee = ?'; params.push(args.assignee); }
      query += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);
      const rows = rawDb.prepare(query).all(...params);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    }

    case 'get_task': {
      const row = rawDb.prepare(
        'SELECT * FROM tasks WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
      ).get(args.id, workspaceId);
      if (!row) return { content: [{ type: 'text', text: 'Task not found' }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    }

    case 'list_deals': {
      let query = 'SELECT * FROM deals WHERE workspace_id = ? AND deleted_at IS NULL';
      const params: unknown[] = [workspaceId];
      if (args.project_id) { query += ' AND project_id = ?'; params.push(args.project_id); }
      if (args.status) { query += ' AND status = ?'; params.push(args.status); }
      query += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);
      const rows = rawDb.prepare(query).all(...params);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    }

    case 'list_contacts': {
      let query = 'SELECT * FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL';
      const params: unknown[] = [workspaceId];
      if (args.category) { query += ' AND category = ?'; params.push(args.category); }
      query += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);
      const rows = rawDb.prepare(query).all(...params);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    }

    case 'list_finances': {
      let query = 'SELECT * FROM finances WHERE workspace_id = ? AND deleted_at IS NULL';
      const params: unknown[] = [workspaceId];
      if (args.type) { query += ' AND type = ?'; params.push(args.type); }
      if (args.status) { query += ' AND status = ?'; params.push(args.status); }
      query += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);
      const rows = rawDb.prepare(query).all(...params);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    }

    case 'get_activity': {
      let query = 'SELECT * FROM activity WHERE workspace_id = ?';
      const params: unknown[] = [workspaceId];
      if (args.entity_type) { query += ' AND entity_type = ?'; params.push(args.entity_type); }
      if (args.project_id) { query += ' AND project_id = ?'; params.push(args.project_id); }
      query += ' ORDER BY id DESC LIMIT ?';
      params.push(Math.min(Number(args.limit) || 20, 100));
      const rows = rawDb.prepare(query).all(...params);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    }

    case 'search': {
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
              results.tasks = rawDb.prepare(
                `SELECT t.id, t.title, t.status, t.priority, rank FROM tasks_fts f JOIN tasks t ON t.rowid = f.rowid WHERE tasks_fts MATCH ? AND t.workspace_id = ? AND t.deleted_at IS NULL ORDER BY rank LIMIT 20`
              ).all(ftsQuery, workspaceId);
              break;
            case 'deals':
              results.deals = rawDb.prepare(
                `SELECT d.id, d.name, d.address, d.status, rank FROM deals_fts f JOIN deals d ON d.rowid = f.rowid WHERE deals_fts MATCH ? AND d.workspace_id = ? AND d.deleted_at IS NULL ORDER BY rank LIMIT 20`
              ).all(ftsQuery, workspaceId);
              break;
            case 'contacts':
              results.contacts = rawDb.prepare(
                `SELECT c.id, c.name, c.company, c.category, rank FROM contacts_fts f JOIN contacts c ON c.rowid = f.rowid WHERE contacts_fts MATCH ? AND c.workspace_id = ? AND c.deleted_at IS NULL ORDER BY rank LIMIT 20`
              ).all(ftsQuery, workspaceId);
              break;
            case 'activity':
              results.activity = rawDb.prepare(
                `SELECT a.id, a.summary, a.entity_type, a.action, a.timestamp, rank FROM activity_fts f JOIN activity a ON a.rowid = f.rowid WHERE activity_fts MATCH ? AND a.workspace_id = ? ORDER BY rank LIMIT 20`
              ).all(ftsQuery, workspaceId);
              break;
          }
        } catch {
          results[trimmed] = [];
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }

    default:
      return null;
  }
}

// MCP Streamable HTTP: POST /mcp
app.post('/', async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json() as McpRequest;

  if (body.jsonrpc !== '2.0' || !body.method) {
    return c.json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
  }

  let result: unknown;

  switch (body.method) {
    case 'initialize':
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'qoopia', version: '2.0.0' },
      };
      break;

    case 'notifications/initialized':
      // Acknowledgment, no response needed for notifications
      return c.json({ jsonrpc: '2.0', id: body.id, result: {} });

    case 'tools/list':
      result = handleToolsList();
      break;

    case 'tools/call': {
      const params = body.params as { name: string; arguments?: Record<string, unknown> } | undefined;
      if (!params?.name) {
        return c.json({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Missing tool name' } } satisfies McpResponse);
      }
      const toolResult = handleToolCall(params.name, params.arguments || {}, auth.workspace_id);
      if (toolResult === null) {
        return c.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Unknown tool: ${params.name}` } } satisfies McpResponse);
      }
      result = toolResult;
      break;
    }

    default:
      return c.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Method not found: ${body.method}` } } satisfies McpResponse);
  }

  return c.json({ jsonrpc: '2.0', id: body.id, result } satisfies McpResponse);
});

// GET /mcp — server info for discovery
app.get('/', (c) => {
  return c.json({
    name: 'qoopia',
    version: '2.0.0',
    protocol: 'mcp',
    description: 'Qoopia — Shared Truth Layer for AI Agents (read-only MCP access)',
    tools: TOOLS.map(t => t.name),
  });
});

export default app;
