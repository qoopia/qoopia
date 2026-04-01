import { Hono } from 'hono';
import { rawDb } from '../../db/connection.js';
import { logActivity } from '../../core/activity-log.js';
import { detectAndApplyStatusChanges } from '../../core/intelligence.js';
import { extractKeywords } from '../../core/keywords.js';
import { logger } from '../../core/logger.js';
import type { AuthContext } from '../../types/index.js';

const app = new Hono<{ Variables: { auth: AuthContext } }>();

// ── Types ──

interface ObserveEvent {
  type: 'message_sent' | 'session_compact' | 'session_end';
  agent: string;
  content: string;
  actor_id?: string;
  agent_id?: string;
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

function resolveObservedAgent(
  auth: AuthContext,
  body: ObserveEvent,
): { actorId: string; agentName: string } {
  if (auth.type === 'agent') {
    const agent = rawDb.prepare(
      'SELECT id, name FROM agents WHERE id = ? AND workspace_id = ? AND active = 1'
    ).get(auth.id, auth.workspace_id) as { id: string; name: string } | undefined;
    if (agent) {
      return { actorId: agent.id, agentName: agent.name };
    }
  }

  const requestedAgentId = [body.actor_id, body.agent_id]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);

  if (requestedAgentId) {
    const agent = rawDb.prepare(
      'SELECT id, name FROM agents WHERE id = ? AND workspace_id = ? AND active = 1'
    ).get(requestedAgentId, auth.workspace_id) as { id: string; name: string } | undefined;
    if (agent) {
      return { actorId: agent.id, agentName: agent.name };
    }
  }

  return { actorId: 'unknown', agentName: 'unknown' };
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

  const resolvedAgent = resolveObservedAgent(auth, body);
  const buffered: BufferedEvent = {
    ...body,
    agent: resolvedAgent.agentName,
    workspace_id: auth.workspace_id,
    actor_id: resolvedAgent.actorId,
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
