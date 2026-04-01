import { Hono } from 'hono';
import { rawDb } from '../../db/connection.js';
import { logActivity } from '../../core/activity-log.js';
import { detectAndApplyStatusChanges } from '../../core/intelligence.js';
import { logger } from '../../core/logger.js';
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
  const likePatterns = [...new Set(extractKeywords(text))].map(keyword => `%${keyword}%`);

  if (likePatterns.length === 0) {
    return matched;
  }

  const likeClause = likePatterns.map(() => 'LOWER(name) LIKE ?').join(' OR ');
  const rows = rawDb.prepare(
    `SELECT entity_type, id, name
     FROM (
       SELECT 'task' AS entity_type, id, title AS name
       FROM tasks
       WHERE workspace_id = ? AND deleted_at IS NULL AND (${likeClause.replaceAll('name', 'title')})
       UNION ALL
       SELECT 'deal' AS entity_type, id, name
       FROM deals
       WHERE workspace_id = ? AND deleted_at IS NULL AND (${likeClause})
       UNION ALL
       SELECT 'contact' AS entity_type, id, name
       FROM contacts
       WHERE workspace_id = ? AND deleted_at IS NULL AND (${likeClause})
     )
     LIMIT 20`
  ).all(
    workspaceId,
    ...likePatterns,
    workspaceId,
    ...likePatterns,
    workspaceId,
    ...likePatterns,
  ) as Array<{ entity_type: string; id: string; name: string }>;

  for (const row of rows) {
    const key = `${row.entity_type}:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matched.push({ type: row.entity_type, id: row.id, name: row.name });
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
  const actorId = events[0]?.actor_id || agents[0] || 'observe';

  const matched = matchEntitiesFromText(combinedText, workspaceId);

  // Auto-status sync: detect and apply status changes from observed text
  const statusChanges = detectAndApplyStatusChanges(combinedText, workspaceId, actorId, 'observe');
  for (const upd of statusChanges.applied) {
    logActivity({
      workspace_id: workspaceId,
      actor: actorId,
      action: 'auto-update',
      entity_type: upd.type,
      entity_id: upd.id,
      summary: `Auto-updated ${upd.type} "${upd.name}": ${upd.previous_status} → ${upd.new_status} (from observe)`,
      details: { source: 'observe', event_count: events.length, agents },
    });
  }

  if (matched.length > 0) {
    for (const entity of matched) {
      logActivity({
        workspace_id: workspaceId,
        actor: agents[0] || 'system',
        action: 'observed',
        entity_type: entity.type,
        entity_id: entity.id,
        summary: `Observed activity from ${agents.join(', ')} mentioning ${entity.name}`,
        details: { source: 'observe', event_count: events.length, agents, auto_updated: statusChanges.applied.length },
      });
    }
  } else {
    logActivity({
      workspace_id: workspaceId,
      actor: agents[0] || 'system',
      action: 'observed',
      entity_type: 'activity',
      summary: `Observed ${events.length} event(s) from ${agents.join(', ')}`,
      details: { source: 'observe', event_count: events.length, agents, auto_updated: statusChanges.applied.length },
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

  const validTypes = ['message_sent', 'session_compact', 'session_end', 'agent_response'];
  if (!validTypes.includes(body.type)) {
    logger.warn({ receivedType: body.type, validTypes, path: '/api/v1/observe' },
      `Invalid observe event type: "${body.type}". Add it to validTypes if this is intentional.`);
    return c.json({ error: { code: 'VALIDATION_ERROR', message: `Invalid type. Must be one of: ${validTypes.join(', ')}` } }, 400);
  }

  // Derive agent name from auth context, not request body
  // Map sessions to correct agent by content/session heuristics
  const AGENT_MAP: Record<string, { name: string; id: string }> = {
    'aidan':  { name: 'Aidan',  id: '01KMKRVYF3YW28Q3P5EPSYC9M1' },
    'alan':   { name: 'Alan',   id: '01KMKRVYF3MJP5WRVWTFN8V83W' },
    'aizek':  { name: 'Aizek',  id: '01KMKRVYF38WSW95FCM6TH9WR3' },
    'dan':    { name: 'Dan',    id: '01DAN00AGENT0000000000001' },
    'claude': { name: 'Claude', id: '01CLAUDE0CODE0AGENT0000001' },
  };

  // Try to resolve agent from auth name first
  const authNameLower = (auth.name || '').toLowerCase();
  const sessionKey = body.session_key || '';
  const content = body.content || '';
  const combined = `${authNameLower} ${sessionKey} ${content}`.toLowerCase();

  let resolvedAgent = auth.name;
  let resolvedActorId = auth.id;

  // Direct match from auth name
  if (AGENT_MAP[authNameLower]) {
    resolvedAgent = AGENT_MAP[authNameLower].name;
    resolvedActorId = AGENT_MAP[authNameLower].id;
  }
  // Heuristic: check session_key and content for agent signatures
  else {
    for (const [key, val] of Object.entries(AGENT_MAP)) {
      const pattern = new RegExp(`\\b${key}\\b|agent[:\\-_]${key}|openclaw-${key}`, 'i');
      if (pattern.test(sessionKey) || pattern.test(content)) {
        resolvedAgent = val.name;
        resolvedActorId = val.id;
        break;
      }
    }
    // Fallback: claude code specific pattern
    if (resolvedAgent === auth.name && /claude[\s-]?code|coding[\s-]?agent/i.test(combined)) {
      resolvedAgent = AGENT_MAP['claude'].name;
      resolvedActorId = AGENT_MAP['claude'].id;
    }
  }
  const buffered: BufferedEvent = {
    ...body,
    agent: resolvedAgent,
    workspace_id: auth.workspace_id,
    actor_id: resolvedActorId,
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
