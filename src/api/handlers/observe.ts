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

// ── Buffer/Flush mechanism ──

let eventBuffer: BufferedEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL = 60_000; // 60 seconds
const FLUSH_THRESHOLD = 20;    // flush after 20 events
const MAX_BUFFER = 100;        // hard cap

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

export function flushBuffer(): { processed: number; matched: number } {
  if (eventBuffer.length === 0) return { processed: 0, matched: 0 };

  const events = eventBuffer.splice(0);
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

  // Group events by workspace
  const byWorkspace = new Map<string, BufferedEvent[]>();
  for (const ev of events) {
    const arr = byWorkspace.get(ev.workspace_id) || [];
    arr.push(ev);
    byWorkspace.set(ev.workspace_id, arr);
  }

  let totalMatched = 0;

  for (const [workspaceId, wsEvents] of byWorkspace) {
    // Combine all event content into one blob
    const combinedText = wsEvents.map(e => `[${e.agent}] ${e.content}`).join('\n');
    const agents = [...new Set(wsEvents.map(e => e.agent))];

    // Find affected entities
    const matched = matchEntitiesFromText(combinedText, workspaceId);
    totalMatched += matched.length;

    // Log activity for each matched entity
    if (matched.length > 0) {
      for (const entity of matched) {
        logActivity({
          workspace_id: workspaceId,
          actor: agents.join(', '),
          action: 'observed',
          entity_type: entity.type,
          entity_id: entity.id,
          summary: `Observed activity from ${agents.join(', ')} mentioning ${entity.name}`,
          details: { source: 'observe', event_count: wsEvents.length, agents },
        });
      }
    } else {
      // Log a general observation even with no matches
      logActivity({
        workspace_id: workspaceId,
        actor: agents.join(', '),
        action: 'observed',
        entity_type: 'activity',
        summary: `Observed ${wsEvents.length} event(s) from ${agents.join(', ')}`,
        details: { source: 'observe', event_count: wsEvents.length, agents },
      });
    }
  }

  return { processed: events.length, matched: totalMatched };
}

function scheduleFlush(): void {
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushBuffer();
    }, FLUSH_INTERVAL);
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
  if (!body.type || !body.agent || !body.content) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Missing required fields: type, agent, content' } }, 400);
  }

  const validTypes = ['message_sent', 'session_compact', 'session_end'];
  if (!validTypes.includes(body.type)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: `Invalid type. Must be one of: ${validTypes.join(', ')}` } }, 400);
  }

  // Buffer the event
  const buffered: BufferedEvent = {
    ...body,
    workspace_id: auth.workspace_id,
    actor_id: auth.id,
    received_at: new Date().toISOString(),
  };

  // Enforce max buffer size
  if (eventBuffer.length >= MAX_BUFFER) {
    flushBuffer();
  }

  eventBuffer.push(buffered);

  // Flush if threshold reached, otherwise schedule timer
  if (eventBuffer.length >= FLUSH_THRESHOLD) {
    flushBuffer();
  } else {
    scheduleFlush();
  }

  return c.json({ accepted: true, buffered: eventBuffer.length }, 202);
});

export default app;
