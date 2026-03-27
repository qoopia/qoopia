import { Hono } from 'hono';
import { rawDb } from '../../db/connection.js';
import { logActivity } from '../../core/activity-log.js';
import type { AuthContext } from '../../types/index.js';

const app = new Hono<{ Variables: { auth: AuthContext } }>();

// ── Types ──

interface ObserveEvent {
  type: 'message_sent' | 'session_compact' | 'session_end';
  agent: string;
  content: string;
  session_key?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

interface BufferedEvent extends ObserveEvent {
  workspace_id: string;
  actor_id: string;
  received_at: string;
}

// ── Buffer/Flush mechanism (per-workspace) ──

const workspaceBuffers = new Map<string, BufferedEvent[]>();
const workspaceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const FLUSH_INTERVAL = 60_000; // 60 seconds
const FLUSH_THRESHOLD = 20;    // flush after 20 events
const MAX_BUFFER = 100;        // hard cap per workspace

function extractKeywords(text: string): string[] {
  const stopWords = new Set(['the', 'a', 'an', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'then', 'when', 'where', 'why', 'how', 'all', 'each', 'some', 'no', 'not', 'only', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'or', 'if', 'while', 'that', 'this', 'it', 'its', 'i', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them']);
  return text
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()))
    .map(w => w.toLowerCase());
}

function matchEntitiesFromText(text: string, workspaceId: string): Array<{ type: string; id: string; name: string }> {
  const matched: Array<{ type: string; id: string; name: string }> = [];
  const seen = new Set<string>();
  const keywords = extractKeywords(text);

  for (const kw of keywords) {
    const likePattern = `%${kw}%`;
    const tasks = rawDb.prepare('SELECT id, title FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL AND LOWER(title) LIKE ? LIMIT 3').all(workspaceId, likePattern) as Array<{ id: string; title: string }>;
    for (const t of tasks) {
      if (!seen.has(t.id)) { seen.add(t.id); matched.push({ type: 'task', id: t.id, name: t.title }); }
    }
    const deals = rawDb.prepare('SELECT id, name FROM deals WHERE workspace_id = ? AND deleted_at IS NULL AND LOWER(name) LIKE ? LIMIT 3').all(workspaceId, likePattern) as Array<{ id: string; name: string }>;
    for (const d of deals) {
      if (!seen.has(d.id)) { seen.add(d.id); matched.push({ type: 'deal', id: d.id, name: d.name }); }
    }
    const contacts = rawDb.prepare('SELECT id, name FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL AND LOWER(name) LIKE ? LIMIT 3').all(workspaceId, likePattern) as Array<{ id: string; name: string }>;
    for (const ct of contacts) {
      if (!seen.has(ct.id)) { seen.add(ct.id); matched.push({ type: 'contact', id: ct.id, name: ct.name }); }
    }
  }

  return matched.slice(0, 20);
}

function flushWorkspaceBuffer(workspaceId: string): { processed: number; matched: number } {
  const buffer = workspaceBuffers.get(workspaceId);
  if (!buffer || buffer.length === 0) return { processed: 0, matched: 0 };

  const events = buffer.splice(0);
  const timer = workspaceTimers.get(workspaceId);
  if (timer) { clearTimeout(timer); workspaceTimers.delete(workspaceId); }
  if (events.length === 0) { workspaceBuffers.delete(workspaceId); return { processed: 0, matched: 0 }; }

  const combinedText = events.map(e => `[${e.agent}] ${e.content}`).join('\n');
  const agents = [...new Set(events.map(e => e.agent))];

  const matched = matchEntitiesFromText(combinedText, workspaceId);

  if (matched.length > 0) {
    for (const entity of matched) {
      logActivity({
        workspace_id: workspaceId,
        actor: agents.join(', '),
        action: 'observed',
        entity_type: entity.type,
        entity_id: entity.id,
        summary: `Observed activity from ${agents.join(', ')} mentioning ${entity.name}`,
        details: { source: 'observe', event_count: events.length, agents },
      });
    }
  } else {
    logActivity({
      workspace_id: workspaceId,
      actor: agents.join(', '),
      action: 'observed',
      entity_type: 'activity',
      summary: `Observed ${events.length} event(s) from ${agents.join(', ')}`,
      details: { source: 'observe', event_count: events.length, agents },
    });
  }

  if (buffer.length === 0) workspaceBuffers.delete(workspaceId);
  return { processed: events.length, matched: matched.length };
}

export function flushBuffer(): { processed: number; matched: number } {
  let totalProcessed = 0;
  let totalMatched = 0;
  for (const wsId of [...workspaceBuffers.keys()]) {
    const r = flushWorkspaceBuffer(wsId);
    totalProcessed += r.processed;
    totalMatched += r.matched;
  }
  return { processed: totalProcessed, matched: totalMatched };
}

function scheduleFlush(workspaceId: string): void {
  if (!workspaceTimers.has(workspaceId)) {
    workspaceTimers.set(workspaceId, setTimeout(() => {
      workspaceTimers.delete(workspaceId);
      flushWorkspaceBuffer(workspaceId);
    }, FLUSH_INTERVAL));
  }
}

// ── POST /api/v1/observe ──

app.post('/', async (c) => {
  const auth = c.get('auth');
  let body: ObserveEvent;

  try {
    body = await c.req.json() as ObserveEvent;
  } catch {
    return c.json({ error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400);
  }

  // Validate required fields
  if (!body.type || !body.content) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Missing required fields: type, content' } }, 400);
  }

  const validTypes = ['message_sent', 'session_compact', 'session_end'];
  if (!validTypes.includes(body.type)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: `Invalid type. Must be one of: ${validTypes.join(', ')}` } }, 400);
  }

  // Derive agent name from auth context, not request body
  const buffered: BufferedEvent = {
    ...body,
    agent: auth.name,
    workspace_id: auth.workspace_id,
    actor_id: auth.id,
    received_at: new Date().toISOString(),
  };

  const wsId = auth.workspace_id;
  let buffer = workspaceBuffers.get(wsId);
  if (!buffer) { buffer = []; workspaceBuffers.set(wsId, buffer); }

  // Enforce max buffer size per workspace
  if (buffer.length >= MAX_BUFFER) {
    flushWorkspaceBuffer(wsId);
    buffer = workspaceBuffers.get(wsId) || [];
    if (!workspaceBuffers.has(wsId)) { workspaceBuffers.set(wsId, buffer); }
  }

  buffer.push(buffered);

  // Flush if threshold reached, otherwise schedule timer
  if (buffer.length >= FLUSH_THRESHOLD) {
    flushWorkspaceBuffer(wsId);
  } else {
    scheduleFlush(wsId);
  }

  return c.json({ accepted: true, buffered: (workspaceBuffers.get(wsId) || []).length }, 202);
});

export default app;
