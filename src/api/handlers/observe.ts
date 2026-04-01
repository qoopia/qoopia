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
// Auto-status detection only: match entities, detect status transitions, drop if none found.

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
  const wsId = auth.workspace_id;
  const actorId = resolvedAgent.actorId;
  const content = body.content;

  // Match entities mentioned in the event
  const matched = matchEntitiesFromText(content, wsId);

  // Detect status transitions
  const statusChanges = detectAndApplyStatusChanges(content, wsId, actorId, 'observe');

  // If no status transitions detected — drop the event silently
  if (statusChanges.applied.length === 0) {
    return c.json({ accepted: true, status_changes: 0 }, 202);
  }

  // Status transition found — log ONE activity entry per update
  for (const upd of statusChanges.applied) {
    logActivity({
      workspace_id: wsId,
      actor: actorId,
      action: 'auto-update',
      entity_type: upd.type,
      entity_id: upd.id,
      summary: `Auto-updated ${upd.type} "${upd.name}": ${upd.previous_status} → ${upd.new_status} (from observe)`,
      details: { source: 'observe', agent: resolvedAgent.agentName },
    });
  }

  return c.json({
    accepted: true,
    status_changes: statusChanges.applied.length,
    applied: statusChanges.applied.map(u => ({ type: u.type, id: u.id, name: u.name, new_status: u.new_status })),
  }, 200);
});

export default app;
