import { rawDb } from '../../../../db/connection.js';
import { logActivity } from '../../../../core/activity-log.js';
import { detectAndApplyStatusChanges } from '../../../../core/intelligence.js';
import { matchEntities } from '../utils.js';
import type { ToolDefinition } from '../utils.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
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
];

export async function handleTool(name: string, args: Record<string, unknown>, workspaceId: string, actorId: string): Promise<unknown | null> {
  switch (name) {
    case 'get_activity': {
      let query = 'SELECT id, actor, action, entity_type, summary, timestamp FROM activity WHERE workspace_id = ?';
      const params: unknown[] = [workspaceId];
      if (args.entity_type) { query += ' AND entity_type = ?'; params.push(args.entity_type); }
      if (args.project_id) { query += ' AND project_id = ?'; params.push(args.project_id); }
      query += ' ORDER BY id DESC LIMIT ?';
      params.push(Math.min(Number(args.limit) || 20, 100));
      return { content: [{ type: 'text', text: JSON.stringify(rawDb.prepare(query).all(...params)) }] };
    }

    case 'create_activity': {
      const summaryText = args.summary as string || `${args.action} on ${args.entity_type}`;
      const actId = logActivity({
        workspace_id: workspaceId,
        actor: actorId,
        action: args.action as string,
        entity_type: args.entity_type as string,
        entity_id: args.entity_id as string ?? undefined,
        project_id: args.project_id as string ?? undefined,
        summary: summaryText,
        details: args.details as Record<string, unknown> ?? undefined,
      });

      // Auto-status sync on activity creation
      const actStatusChanges = detectAndApplyStatusChanges(summaryText, workspaceId, actorId, args.action as string);
      for (const upd of actStatusChanges.applied) {
        logActivity({ workspace_id: workspaceId, actor: actorId, action: 'auto-update', entity_type: upd.type, entity_id: upd.id, summary: `Auto-updated ${upd.type} "${upd.name}": ${upd.previous_status} → ${upd.new_status} (from activity)` });
      }

      let actMsg = `Activity logged: ${actId}`;
      if (actStatusChanges.applied.length > 0) actMsg += `. Auto-updated: ${actStatusChanges.applied.map(u => `${u.name} → ${u.new_status}`).join(', ')}`;

      return { content: [{ type: 'text', text: actMsg }] };
    }

    case 'report_activity': {
      const summary = String(args.summary || '').trim();
      if (!summary) return { content: [{ type: 'text', text: 'Summary is required' }], isError: true };

      const agentName = String(args.agent_name || actorId);
      const sessionId = args.session_id ? String(args.session_id) : undefined;
      const hintsIds = Array.isArray(args.entities_hint) ? args.entities_hint.map(String) : undefined;

      // Match entities from summary text
      const matched = matchEntities(summary, workspaceId, hintsIds);

      // Auto-status sync with confidence gating (replaces old autoUpdateStatuses)
      const reportStatusChanges = detectAndApplyStatusChanges(summary, workspaceId, actorId, 'report');
      for (const upd of reportStatusChanges.applied) {
        logActivity({ workspace_id: workspaceId, actor: agentName, action: 'auto-update', entity_type: upd.type, entity_id: upd.id, summary: `Auto-updated ${upd.type} "${upd.name}": ${upd.previous_status} → ${upd.new_status} (from report)` });
        // Mark matching entity as auto_updated for backwards compat
        const matchedEntity = matched.find(m => m.id === upd.id);
        if (matchedEntity) matchedEntity.auto_updated = true;
      }

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

      const autoUpdated = reportStatusChanges.applied;
      let message = `Activity recorded. ${matched.length} entit${matched.length === 1 ? 'y' : 'ies'} identified for review.`;
      if (autoUpdated.length > 0) {
        message += ` ${autoUpdated.length} entit${autoUpdated.length === 1 ? 'y' : 'ies'} auto-updated.`;
      }
      if (reportStatusChanges.suggested.length > 0) {
        message += ` ${reportStatusChanges.suggested.length} suggested status change(s).`;
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            recorded: true,
            activity_id: activityId,
            matched_entities: matched,
            auto_updated: autoUpdated.length > 0 ? autoUpdated : undefined,
            suggested: reportStatusChanges.suggested.length > 0 ? reportStatusChanges.suggested : undefined,
            message,
          }),
        }],
      };
    }

    default:
      return null;
  }
}
