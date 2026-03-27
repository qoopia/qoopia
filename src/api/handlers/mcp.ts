import { Hono } from 'hono';
import { ulid } from 'ulid';
import { rawDb } from '../../db/connection.js';
import { logActivity } from '../../core/activity-log.js';
import type { AuthContext } from '../../types/index.js';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync, realpathSync } from 'fs';
import { resolve, join, relative, basename } from 'path';
import { matchFromNote, semanticSearch, getCapabilities, storeEmbedding } from '../../core/intelligence.js';

const app = new Hono<{ Variables: { auth: AuthContext } }>();

// MCP Streamable HTTP endpoint — full CRUD access to Qoopia data

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
  // ── READ TOOLS ──
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
  {
    name: 'read_file',
    description: 'Read a file from the workspace',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: 'List files/directories in a workspace path',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root (default "/")' },
        recursive: { type: 'boolean', description: 'List recursively (default false)' },
      },
    },
  },
  {
    name: 'write_file',
    description: 'Write/update a file in the workspace',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
  },

  // ── CRUD TOOLS ──
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
  {
    name: 'create_activity',
    description: 'Log an activity entry',
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', description: 'Entity type (task, deal, contact, finance, project)' },
        entity_id: { type: 'string', description: 'Entity ID' },
        action: { type: 'string', description: 'Action performed (created, updated, deleted, etc.)' },
        summary: { type: 'string', description: 'Human-readable summary' },
        details: { type: 'object', description: 'Additional structured details' },
        project_id: { type: 'string' },
      },
      required: ['entity_type', 'action', 'summary'],
    },
  },
  {
    name: 'report_activity',
    description: 'REQUIRED after completing any work. Describe what you did in natural language. Qoopia extracts facts and updates tasks/deals/contacts automatically. Call this after finishing a task, closing a deal, updating a contact, or any meaningful action.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Natural language description of what was done' },
        agent_name: { type: 'string', description: 'Name of the agent reporting (e.g., "aidan", "alan")' },
        session_id: { type: 'string', description: 'Session identifier for grouping activities' },
        entities_hint: { type: 'array', items: { type: 'string' }, description: 'Entity IDs that may be affected (helps accuracy)' },
      },
      required: ['summary'],
    },
  },

  // ── ACTIVITY-FIRST MEMORY TOOLS ──
  {
    name: 'note',
    description: 'Record what you did, learned, or decided. Your memory persists here — next session, use recall or brief to remember. Qoopia automatically links your note to relevant tasks and deals, updating statuses when work is completed.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What happened, in your own words' },
        project: { type: 'string', description: 'Project name or ID (optional, helps accuracy)' },
        agent_name: { type: 'string', description: 'Your name (e.g. aidan, alan, claude)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'recall',
    description: 'Search your memory. Ask anything about past work, decisions, contacts, or deals. Returns relevant notes and structured data.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to remember — natural language question' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'brief',
    description: 'Get full context for a project or your workload. Open tasks, active deals, recent notes, key contacts. Call at the start of each session to restore your memory.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID. Omit for full workload.' },
        agent_name: { type: 'string', description: 'Your name — to show your recent notes' },
      },
    },
  },
];

const WORKSPACE_ROOT = process.env.QOOPIA_WORKSPACE_ROOT || resolve(process.cwd(), 'workspace');
const MAX_FILE_SIZE = 100 * 1024;

const DENIED_PATTERNS = [
  /^\.env$/,
  /^credentials/i,
  /^token.*\.json$/i,
  /\.key$/,
  /\.pem$/,
  /secret/i,
];

function isDeniedPath(filePath: string): boolean {
  const name = basename(filePath);
  if (filePath.split('/').includes('node_modules')) return true;
  return DENIED_PATTERNS.some(re => re.test(name));
}

function resolveWorkspacePath(inputPath: string): { resolved: string; error?: string } {
  const rel = String(inputPath || '/').replace(/^\/+/, '');
  const resolved = resolve(join(WORKSPACE_ROOT, rel));
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    return { resolved: '', error: 'Access denied: path traversal detected' };
  }
  if (isDeniedPath(resolved)) {
    return { resolved: '', error: 'Access denied: file matches security filter' };
  }
  // Resolve symlinks to prevent escape
  try {
    const real = realpathSync(resolved);
    if (!real.startsWith(realpathSync(WORKSPACE_ROOT))) {
      return { resolved: '', error: 'Access denied: symlink escape detected' };
    }
    return { resolved: real };
  } catch {
    // Path doesn't exist yet (write case) — verify parent
    const parent = resolve(resolved, '..');
    try {
      const realParent = realpathSync(parent);
      if (!realParent.startsWith(realpathSync(WORKSPACE_ROOT))) {
        return { resolved: '', error: 'Access denied: symlink escape detected' };
      }
    } catch {
      // Parent doesn't exist — prefix check already passed
    }
    return { resolved };
  }
}

function listFilesRecursive(dir: string): Array<{ name: string; type: 'file' | 'directory'; size: number; modified: string }> {
  const entries: Array<{ name: string; type: 'file' | 'directory'; size: number; modified: string }> = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (isDeniedPath(full)) continue;
    const stat = statSync(full);
    const rel = relative(WORKSPACE_ROOT, full);
    if (stat.isDirectory()) {
      entries.push({ name: rel, type: 'directory', size: 0, modified: stat.mtime.toISOString() });
      entries.push(...listFilesRecursive(full));
    } else {
      entries.push({ name: rel, type: 'file', size: stat.size, modified: stat.mtime.toISOString() });
    }
  }
  return entries;
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z/, 'Z');
const jsonStr = (v: unknown) => JSON.stringify(v ?? []);

// ── Activity-First: Entity matching from natural language ──

interface MatchedEntity {
  type: 'task' | 'deal' | 'contact';
  id: string;
  name: string;
  confidence: 'high' | 'medium';
  auto_updated?: boolean;
}

const STATUS_PATTERNS: Array<{ pattern: RegExp; status: string }> = [
  { pattern: /\b(?:completed|finished|done with|done)\b/i, status: 'done' },
  { pattern: /\b(?:cancelled|canceled|abandoned|dropped)\b/i, status: 'cancelled' },
  { pattern: /\b(?:started|working on|began|beginning|in progress)\b/i, status: 'in_progress' },
];

function extractKeywords(summary: string): string[] {
  // Remove common stop words and short words, return meaningful keywords
  const stopWords = new Set(['the', 'a', 'an', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'or', 'if', 'while', 'that', 'this', 'these', 'those', 'it', 'its', 'i', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'his', 'her', 'task', 'deal', 'contact', 'completed', 'finished', 'started', 'cancelled', 'done', 'report', 'activity']);
  return summary
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()))
    .map(w => w.toLowerCase());
}

function matchEntities(summary: string, workspaceId: string, hintsIds?: string[]): MatchedEntity[] {
  const matched: MatchedEntity[] = [];
  const seen = new Set<string>();

  // 1. Match by hint IDs directly
  if (hintsIds && hintsIds.length > 0) {
    for (const hintId of hintsIds) {
      const task = rawDb.prepare('SELECT id, title FROM tasks WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(hintId, workspaceId) as { id: string; title: string } | undefined;
      if (task && !seen.has(task.id)) { seen.add(task.id); matched.push({ type: 'task', id: task.id, name: task.title, confidence: 'high' }); continue; }
      const deal = rawDb.prepare('SELECT id, name FROM deals WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(hintId, workspaceId) as { id: string; name: string } | undefined;
      if (deal && !seen.has(deal.id)) { seen.add(deal.id); matched.push({ type: 'deal', id: deal.id, name: deal.name, confidence: 'high' }); continue; }
      const contact = rawDb.prepare('SELECT id, name FROM contacts WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(hintId, workspaceId) as { id: string; name: string } | undefined;
      if (contact && !seen.has(contact.id)) { seen.add(contact.id); matched.push({ type: 'contact', id: contact.id, name: contact.name, confidence: 'high' }); continue; }
    }
  }

  // 2. Keyword-based matching
  const keywords = extractKeywords(summary);
  if (keywords.length === 0) return matched;

  for (const kw of keywords) {
    const likePattern = `%${kw}%`;
    // Search tasks
    const tasks = rawDb.prepare('SELECT id, title FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL AND LOWER(title) LIKE ? LIMIT 3').all(workspaceId, likePattern) as Array<{ id: string; title: string }>;
    for (const t of tasks) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const titleLower = t.title.toLowerCase();
      const conf = titleLower === summary.toLowerCase() || keywords.some(k => titleLower === k) ? 'high' : 'medium';
      matched.push({ type: 'task', id: t.id, name: t.title, confidence: conf });
    }
    // Search deals
    const deals = rawDb.prepare('SELECT id, name FROM deals WHERE workspace_id = ? AND deleted_at IS NULL AND LOWER(name) LIKE ? LIMIT 3').all(workspaceId, likePattern) as Array<{ id: string; name: string }>;
    for (const d of deals) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      matched.push({ type: 'deal', id: d.id, name: d.name, confidence: d.name.toLowerCase().includes(kw) ? 'medium' : 'medium' });
    }
    // Search contacts
    const contacts = rawDb.prepare('SELECT id, name FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL AND LOWER(name) LIKE ? LIMIT 3').all(workspaceId, likePattern) as Array<{ id: string; name: string }>;
    for (const ct of contacts) {
      if (seen.has(ct.id)) continue;
      seen.add(ct.id);
      matched.push({ type: 'contact', id: ct.id, name: ct.name, confidence: 'medium' });
    }
  }

  return matched.slice(0, 20); // Cap at 20 matches
}

function autoUpdateStatuses(summary: string, matched: MatchedEntity[], workspaceId: string, actorId: string): void {
  for (const statusPattern of STATUS_PATTERNS) {
    if (!statusPattern.pattern.test(summary)) continue;

    for (const entity of matched) {
      if (entity.type === 'task') {
        const existing = rawDb.prepare('SELECT status, revision FROM tasks WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(entity.id, workspaceId) as { status: string; revision: number } | undefined;
        if (!existing || existing.status === statusPattern.status) continue;
        const newRev = existing.revision + 1;
        rawDb.prepare('UPDATE tasks SET status = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ? AND workspace_id = ?').run(statusPattern.status, newRev, now(), actorId, entity.id, workspaceId);
        entity.auto_updated = true;
      } else if (entity.type === 'deal') {
        const existing = rawDb.prepare('SELECT status, revision FROM deals WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(entity.id, workspaceId) as { status: string; revision: number } | undefined;
        if (!existing || existing.status === statusPattern.status) continue;
        const newRev = existing.revision + 1;
        rawDb.prepare('UPDATE deals SET status = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ? AND workspace_id = ?').run(statusPattern.status, newRev, now(), actorId, entity.id, workspaceId);
        entity.auto_updated = true;
      }
    }
    break; // Only apply first matching status pattern
  }
}

function handleToolsList(): unknown {
  return { tools: TOOLS };
}

async function handleToolCall(name: string, args: Record<string, unknown>, workspaceId: string, actorId: string): Promise<unknown> {
  const limit = Math.min(Number(args.limit) || 50, 100);

  switch (name) {

    // ══════════════ READ TOOLS ══════════════

    case 'list_projects': {
      let query = 'SELECT * FROM projects WHERE workspace_id = ? AND deleted_at IS NULL';
      const params: unknown[] = [workspaceId];
      if (args.status) { query += ' AND status = ?'; params.push(args.status); }
      query += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);
      return { content: [{ type: 'text', text: JSON.stringify(rawDb.prepare(query).all(...params), null, 2) }] };
    }

    case 'list_tasks': {
      let query = 'SELECT * FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL';
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
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'get_task': {
      const row = rawDb.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(args.id, workspaceId);
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
      const deals = rawDb.prepare(query).all(...params);

      // Smart context
      const context: string[] = [];
      const activeDealsCount = (rawDb.prepare("SELECT COUNT(*) as c FROM deals WHERE workspace_id = ? AND deleted_at IS NULL AND status IN ('negotiation', 'due_diligence', 'active')").get(workspaceId) as { c: number }).c;
      if (activeDealsCount > 0) context.push(`${activeDealsCount} active deal${activeDealsCount > 1 ? 's' : ''}. Use note to record deal updates — statuses update automatically.`);

      const result: Record<string, unknown> = { deals };
      if (context.length > 0) result.context = context.join(' ');
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'list_contacts': {
      let query = 'SELECT * FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL';
      const params: unknown[] = [workspaceId];
      if (args.category) { query += ' AND category = ?'; params.push(args.category); }
      query += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);
      return { content: [{ type: 'text', text: JSON.stringify(rawDb.prepare(query).all(...params), null, 2) }] };
    }

    case 'list_finances': {
      let query = 'SELECT * FROM finances WHERE workspace_id = ? AND deleted_at IS NULL';
      const params: unknown[] = [workspaceId];
      if (args.type) { query += ' AND type = ?'; params.push(args.type); }
      if (args.status) { query += ' AND status = ?'; params.push(args.status); }
      query += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);
      return { content: [{ type: 'text', text: JSON.stringify(rawDb.prepare(query).all(...params), null, 2) }] };
    }

    case 'get_activity': {
      let query = 'SELECT * FROM activity WHERE workspace_id = ?';
      const params: unknown[] = [workspaceId];
      if (args.entity_type) { query += ' AND entity_type = ?'; params.push(args.entity_type); }
      if (args.project_id) { query += ' AND project_id = ?'; params.push(args.project_id); }
      query += ' ORDER BY id DESC LIMIT ?';
      params.push(Math.min(Number(args.limit) || 20, 100));
      return { content: [{ type: 'text', text: JSON.stringify(rawDb.prepare(query).all(...params), null, 2) }] };
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
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }

    // ── File tools ──

    case 'read_file': {
      const { resolved, error } = resolveWorkspacePath(String(args.path || ''));
      if (error) return { content: [{ type: 'text', text: error }], isError: true };
      if (!existsSync(resolved)) return { content: [{ type: 'text', text: 'File not found' }], isError: true };
      const stat = statSync(resolved);
      if (stat.isDirectory()) return { content: [{ type: 'text', text: 'Path is a directory' }], isError: true };
      if (stat.size > MAX_FILE_SIZE) return { content: [{ type: 'text', text: `File too large (${stat.size} bytes, max 100KB)` }], isError: true };
      return { content: [{ type: 'text', text: readFileSync(resolved, 'utf-8') }] };
    }

    case 'list_files': {
      const inputPath = args.path ? String(args.path) : '/';
      const { resolved, error } = resolveWorkspacePath(inputPath);
      if (error) return { content: [{ type: 'text', text: error }], isError: true };
      const targetDir = existsSync(resolved) ? resolved : WORKSPACE_ROOT;
      const recursive = Boolean(args.recursive);
      const entries = recursive
        ? listFilesRecursive(targetDir)
        : readdirSync(targetDir).filter(e => !isDeniedPath(join(targetDir, e))).map(entry => {
            const full = join(targetDir, entry);
            const s = statSync(full);
            return { name: relative(WORKSPACE_ROOT, full), type: (s.isDirectory() ? 'directory' : 'file') as 'file' | 'directory', size: s.isDirectory() ? 0 : s.size, modified: s.mtime.toISOString() };
          });
      return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] };
    }

    case 'write_file': {
      const { resolved, error } = resolveWorkspacePath(String(args.path || ''));
      if (error) return { content: [{ type: 'text', text: error }], isError: true };
      const dir = resolve(join(resolved, '..'));
      if (!dir.startsWith(WORKSPACE_ROOT)) return { content: [{ type: 'text', text: 'Access denied' }], isError: true };
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolved, String(args.content ?? ''), 'utf-8');
      return { content: [{ type: 'text', text: `Written: ${relative(WORKSPACE_ROOT, resolved)}` }] };
    }

    // ══════════════ CRUD TOOLS ══════════════

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
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
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
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    }

    case 'delete_task': {
      const existing = rawDb.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(args.id, workspaceId) as Record<string, unknown> | undefined;
      if (!existing) return { content: [{ type: 'text', text: 'Task not found' }], isError: true };
      const newRev = (existing.revision as number) + 1;
      rawDb.prepare('UPDATE tasks SET deleted_at = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(now(), newRev, now(), actorId, args.id);
      logActivity({ workspace_id: workspaceId, actor: actorId, action: 'deleted', entity_type: 'task', entity_id: args.id as string, project_id: existing.project_id as string, summary: `Deleted task: ${existing.title}`, revision_before: existing.revision as number, revision_after: newRev });
      return { content: [{ type: 'text', text: `Deleted task: ${existing.title}` }] };
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
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
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
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    }

    case 'delete_deal': {
      const existing = rawDb.prepare('SELECT * FROM deals WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(args.id, workspaceId) as Record<string, unknown> | undefined;
      if (!existing) return { content: [{ type: 'text', text: 'Deal not found' }], isError: true };
      const newRev = (existing.revision as number) + 1;
      rawDb.prepare('UPDATE deals SET deleted_at = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(now(), newRev, now(), actorId, args.id);
      logActivity({ workspace_id: workspaceId, actor: actorId, action: 'deleted', entity_type: 'deal', entity_id: args.id as string, project_id: existing.project_id as string, summary: `Deleted deal: ${existing.name}`, revision_before: existing.revision as number, revision_after: newRev });
      return { content: [{ type: 'text', text: `Deleted deal: ${existing.name}` }] };
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
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
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
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
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
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    }

    case 'delete_contact': {
      const existing = rawDb.prepare('SELECT * FROM contacts WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(args.id, workspaceId) as Record<string, unknown> | undefined;
      if (!existing) return { content: [{ type: 'text', text: 'Contact not found' }], isError: true };
      const newRev = (existing.revision as number) + 1;
      rawDb.prepare('UPDATE contacts SET deleted_at = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(now(), newRev, now(), actorId, args.id);
      logActivity({ workspace_id: workspaceId, actor: actorId, action: 'deleted', entity_type: 'contact', entity_id: args.id as string, summary: `Deleted contact: ${existing.name}`, revision_before: existing.revision as number, revision_after: newRev });
      return { content: [{ type: 'text', text: `Deleted contact: ${existing.name}` }] };
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
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
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
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    }

    case 'delete_finance': {
      const existing = rawDb.prepare('SELECT * FROM finances WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(args.id, workspaceId) as Record<string, unknown> | undefined;
      if (!existing) return { content: [{ type: 'text', text: 'Finance record not found' }], isError: true };
      const newRev = (existing.revision as number) + 1;
      rawDb.prepare('UPDATE finances SET deleted_at = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(now(), newRev, now(), actorId, args.id);
      logActivity({ workspace_id: workspaceId, actor: actorId, action: 'deleted', entity_type: 'finance', entity_id: args.id as string, summary: `Deleted finance: ${existing.name}`, revision_before: existing.revision as number, revision_after: newRev });
      return { content: [{ type: 'text', text: `Deleted finance: ${existing.name}` }] };
    }

    case 'create_activity': {
      const actId = logActivity({
        workspace_id: workspaceId,
        actor: actorId,
        action: args.action as string,
        entity_type: args.entity_type as string,
        entity_id: args.entity_id as string ?? undefined,
        project_id: args.project_id as string ?? undefined,
        summary: args.summary as string || `${args.action} on ${args.entity_type}`,
        details: args.details as Record<string, unknown> ?? undefined,
      });
      return { content: [{ type: 'text', text: `Activity logged: ${actId}` }] };
    }

    // ══════════════ ACTIVITY-FIRST MEMORY TOOLS ══════════════

    case 'note': {
      const text = String(args.text || '').trim();
      if (!text) return { content: [{ type: 'text', text: 'Text is required' }], isError: true };

      const agentName = args.agent_name ? String(args.agent_name) : undefined;

      // Resolve project
      let projectId: string | null = null;
      if (args.project) {
        const projArg = String(args.project);
        // Check if it's a ULID (26 chars uppercase alphanumeric)
        if (/^[0-9A-Z]{26}$/.test(projArg)) {
          projectId = projArg;
        } else {
          const proj = rawDb.prepare("SELECT id FROM projects WHERE workspace_id = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?) LIMIT 1").get(workspaceId, projArg) as { id: string } | undefined;
          if (proj) projectId = proj.id;
        }
      }

      // Match entities from note text
      const matchResult = await matchFromNote(text, workspaceId);
      const autoUpdates: Array<{ type: string; id: string; name: string; previous_status?: string; new_status?: string }> = [];

      // Auto-update entities with detected status changes
      for (const entity of matchResult.matched_entities) {
        if (entity.new_status && entity.previous_status) {
          if (entity.type === 'task') {
            const existing = rawDb.prepare('SELECT revision FROM tasks WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(entity.id, workspaceId) as { revision: number } | undefined;
            if (existing) {
              const newRev = existing.revision + 1;
              rawDb.prepare('UPDATE tasks SET status = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ? AND workspace_id = ?')
                .run(entity.new_status, newRev, now(), actorId, entity.id, workspaceId);
              entity.auto_updated = true;
              autoUpdates.push({ type: 'task', id: entity.id, name: entity.name, previous_status: entity.previous_status, new_status: entity.new_status });
              logActivity({ workspace_id: workspaceId, actor: agentName || actorId, action: 'auto_updated', entity_type: 'task', entity_id: entity.id, summary: `Auto-updated task "${entity.name}": ${entity.previous_status} → ${entity.new_status} (from note)` });
            }
          } else if (entity.type === 'deal') {
            const existing = rawDb.prepare('SELECT revision FROM deals WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(entity.id, workspaceId) as { revision: number } | undefined;
            if (existing) {
              const newRev = existing.revision + 1;
              rawDb.prepare('UPDATE deals SET status = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ? AND workspace_id = ?')
                .run(entity.new_status, newRev, now(), actorId, entity.id, workspaceId);
              entity.auto_updated = true;
              autoUpdates.push({ type: 'deal', id: entity.id, name: entity.name, previous_status: entity.previous_status, new_status: entity.new_status });
              logActivity({ workspace_id: workspaceId, actor: agentName || actorId, action: 'auto_updated', entity_type: 'deal', entity_id: entity.id, summary: `Auto-updated deal "${entity.name}": ${entity.previous_status} → ${entity.new_status} (from note)` });
            }
          }
        }
      }

      // Insert note
      const noteId = ulid();
      rawDb.prepare(
        `INSERT INTO notes (id, workspace_id, agent_id, agent_name, text, project_id, source, matched_entities, auto_updates, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(
        noteId, workspaceId, actorId, agentName || null, text, projectId,
        'mcp', JSON.stringify(matchResult.matched_entities), JSON.stringify(autoUpdates), now()
      );

      // Generate embedding in background (fire and forget)
      if (getCapabilities().embeddings) {
        storeEmbedding(noteId, text).catch(() => {});
      }

      // Get remaining open tasks in same project(s)
      const remaining: Array<{ title: string; status: string; due: string | null }> = [];
      if (projectId) {
        const openTasks = rawDb.prepare(
          "SELECT title, status, due_date FROM tasks WHERE workspace_id = ? AND project_id = ? AND deleted_at IS NULL AND status NOT IN ('done', 'cancelled') ORDER BY due_date ASC LIMIT 10"
        ).all(workspaceId, projectId) as Array<{ title: string; status: string; due_date: string | null }>;
        for (const t of openTasks) {
          remaining.push({ title: t.title, status: t.status, due: t.due_date });
        }
      }

      // Build matched summary
      const matchedSummary = matchResult.matched_entities
        .filter(e => e.auto_updated)
        .map(e => `${e.name} → ${e.new_status}`);

      let message = 'Recorded.';
      if (matchedSummary.length > 0) message += ` ${matchedSummary.join(', ')}.`;
      if (remaining.length > 0) message += ` ${remaining.length} task${remaining.length > 1 ? 's' : ''} remaining${projectId ? '' : ''}.`;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            recorded: true,
            note_id: noteId,
            matched: matchResult.matched_entities.filter(e => e.auto_updated).map(e => ({
              type: e.type, name: e.name, action: `→ ${e.new_status}`,
            })),
            remaining,
            capabilities: getCapabilities(),
            message,
          }, null, 2),
        }],
      };
    }

    case 'recall': {
      const query = String(args.query || '').trim();
      if (!query) return { content: [{ type: 'text', text: 'Query is required' }], isError: true };

      const searchLimit = Math.min(Number(args.limit) || 10, 50);
      const searchResult = await semanticSearch(query, workspaceId, searchLimit);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            results: searchResult.results,
            method: searchResult.method,
            message: `Found ${searchResult.results.length} relevant item${searchResult.results.length !== 1 ? 's' : ''} using ${searchResult.method} search.`,
          }, null, 2),
        }],
      };
    }

    case 'brief': {
      // Resolve project
      let projectId: string | null = null;
      let projectName: string | null = null;
      if (args.project) {
        const projArg = String(args.project);
        if (/^[0-9A-Z]{26}$/.test(projArg)) {
          const proj = rawDb.prepare("SELECT id, name FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL").get(projArg, workspaceId) as { id: string; name: string } | undefined;
          if (proj) { projectId = proj.id; projectName = proj.name; }
        } else {
          const proj = rawDb.prepare("SELECT id, name FROM projects WHERE workspace_id = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?) LIMIT 1").get(workspaceId, projArg) as { id: string; name: string } | undefined;
          if (proj) { projectId = proj.id; projectName = proj.name; }
        }
      }

      const agentName = args.agent_name ? String(args.agent_name) : undefined;

      // Open/in_progress tasks
      let taskQuery = "SELECT id, title, status, priority, due_date, assignee FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL AND status NOT IN ('done', 'cancelled')";
      const taskParams: unknown[] = [workspaceId];
      if (projectId) { taskQuery += ' AND project_id = ?'; taskParams.push(projectId); }
      taskQuery += ' ORDER BY due_date ASC NULLS LAST LIMIT 20';
      const taskItems = rawDb.prepare(taskQuery).all(...taskParams) as Array<{ id: string; title: string; status: string; priority: string; due_date: string | null; assignee: string | null }>;

      // Overdue count
      let overdueQuery = "SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL AND due_date < date('now') AND status NOT IN ('done', 'cancelled')";
      const overdueParams: unknown[] = [workspaceId];
      if (projectId) { overdueQuery += ' AND project_id = ?'; overdueParams.push(projectId); }
      const overdueCount = (rawDb.prepare(overdueQuery).get(...overdueParams) as { c: number }).c;

      // Active deals
      let dealQuery = "SELECT id, name, status, asking_price, target_price FROM deals WHERE workspace_id = ? AND deleted_at IS NULL AND status NOT IN ('closed', 'rejected', 'cancelled')";
      const dealParams: unknown[] = [workspaceId];
      if (projectId) { dealQuery += ' AND project_id = ?'; dealParams.push(projectId); }
      dealQuery += ' ORDER BY updated_at DESC LIMIT 10';
      const dealItems = rawDb.prepare(dealQuery).all(...dealParams) as Array<Record<string, unknown>>;

      // Recent notes
      let notesQuery = 'SELECT id, text, agent_name, created_at FROM notes WHERE workspace_id = ?';
      const notesParams: unknown[] = [workspaceId];
      if (agentName) { notesQuery += ' AND agent_name = ?'; notesParams.push(agentName); }
      if (projectId) { notesQuery += ' AND project_id = ?'; notesParams.push(projectId); }
      notesQuery += ' ORDER BY created_at DESC LIMIT 10';
      const noteItems = rawDb.prepare(notesQuery).all(...notesParams) as Array<{ id: string; text: string; agent_name: string | null; created_at: string }>;

      // Contacts linked to project
      let contactItems: Array<Record<string, unknown>> = [];
      if (projectId) {
        contactItems = rawDb.prepare(
          "SELECT c.id, c.name, c.role, c.company, cp.role as project_role FROM contact_projects cp JOIN contacts c ON c.id = cp.contact_id WHERE cp.project_id = ? AND c.workspace_id = ? AND c.deleted_at IS NULL LIMIT 10"
        ).all(projectId, workspaceId) as Array<Record<string, unknown>>;
      }

      // Agent health: last note per agent
      const agentHealth = rawDb.prepare(
        'SELECT agent_name, MAX(created_at) as last_note FROM notes WHERE workspace_id = ? AND agent_name IS NOT NULL GROUP BY agent_name'
      ).all(workspaceId) as Array<{ agent_name: string; last_note: string }>;

      const nowMs = Date.now();
      const health: Record<string, { last_note: string; hours_ago: number }> = {};
      for (const ah of agentHealth) {
        const hoursAgo = Math.round((nowMs - new Date(ah.last_note).getTime()) / 3600000 * 10) / 10;
        health[ah.agent_name] = { last_note: ah.last_note, hours_ago: hoursAgo };
      }

      const message = `${projectName || 'Workload'}: ${taskItems.length} open task${taskItems.length !== 1 ? 's' : ''} (${overdueCount} overdue), ${dealItems.length} active deal${dealItems.length !== 1 ? 's' : ''}, ${noteItems.length} recent note${noteItems.length !== 1 ? 's' : ''}.`;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            project: projectName,
            tasks: { total: taskItems.length, overdue: overdueCount, items: taskItems },
            deals: { total: dealItems.length, items: dealItems },
            notes: {
              total: noteItems.length,
              items: noteItems.map(n => ({ text: n.text, created_at: n.created_at, agent: n.agent_name })),
            },
            contacts: contactItems,
            health: { last_note_from: health },
            message,
          }, null, 2),
        }],
      };
    }

    case 'report_activity': {
      const summary = String(args.summary || '').trim();
      if (!summary) return { content: [{ type: 'text', text: 'Summary is required' }], isError: true };

      const agentName = String(args.agent_name || actorId);
      const sessionId = args.session_id ? String(args.session_id) : undefined;
      const hintsIds = Array.isArray(args.entities_hint) ? args.entities_hint.map(String) : undefined;

      // Match entities from summary text
      const matched = matchEntities(summary, workspaceId, hintsIds);

      // Auto-update statuses for explicit status indicators
      autoUpdateStatuses(summary, matched, workspaceId, actorId);

      // Log the activity
      const activityId = logActivity({
        workspace_id: workspaceId,
        actor: agentName,
        action: 'report',
        entity_type: 'activity',
        summary,
        details: {
          agent_name: agentName,
          session_id: sessionId,
          matched_entities: matched,
          entities_hint: hintsIds,
        },
      });

      const autoUpdated = matched.filter(m => m.auto_updated);
      let message = `Activity recorded. ${matched.length} entit${matched.length === 1 ? 'y' : 'ies'} identified for review.`;
      if (autoUpdated.length > 0) {
        message += ` ${autoUpdated.length} entit${autoUpdated.length === 1 ? 'y' : 'ies'} auto-updated.`;
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            recorded: true,
            activity_id: activityId,
            matched_entities: matched,
            message,
          }, null, 2),
        }],
      };
    }

    default:
      return null;
  }
}

// MCP Streamable HTTP: POST /mcp
app.post('/', async (c) => {
  const auth = c.get('auth');

  let body: McpRequest;
  try {
    body = await c.req.json() as McpRequest;
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }

  if (body.jsonrpc !== '2.0' || !body.method) {
    return c.json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
  }

  // Notifications have no id — do not send a response (MCP spec)
  if (body.method.startsWith('notifications/')) {
    return c.body(null, 204);
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

    case 'tools/list':
      result = handleToolsList();
      break;

    case 'tools/call': {
      const params = body.params as { name: string; arguments?: Record<string, unknown> } | undefined;
      if (!params?.name) {
        return c.json({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Missing tool name' } } satisfies McpResponse);
      }
      const toolResult = await handleToolCall(params.name, params.arguments || {}, auth.workspace_id, auth.id || 'mcp-user');
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
    description: 'Qoopia — Shared Truth Layer for AI Agents (full CRUD MCP access)',
    tools: TOOLS.map(t => t.name),
  });
});

export default app;
