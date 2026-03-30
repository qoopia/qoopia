import { ulid } from 'ulid';
import { rawDb } from '../../../../db/connection.js';
import { logActivity } from '../../../../core/activity-log.js';
import { matchFromNote, semanticSearch, getCapabilities, storeEmbedding, detectAndApplyStatusChanges, detectStaleTasks } from '../../../../core/intelligence.js';
import { now, jsonStr } from '../utils.js';
import type { ToolDefinition } from '../utils.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'note',
    description: 'Record what you did, learned, or decided. Your memory persists here — next session, use recall or brief to remember. Qoopia automatically links your note to relevant tasks and deals, updating statuses when work is completed.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What happened, in your own words' },
        project: { type: 'string', description: 'Project name or ID (optional, helps accuracy)' },
        agent_name: { type: 'string', description: 'Your name (e.g. aidan, alan, claude)' },
        type: { type: 'string', enum: ['rule', 'memory', 'knowledge', 'context'], description: 'Note type: rule=instructions/constraints, memory=events/facts, knowledge=reference info, context=current project/task status. Default: memory' },
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
        type: { type: 'string', enum: ['rule', 'memory', 'knowledge', 'context'], description: 'Filter by note type' },
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
        agent: { type: 'string', description: 'Filter tasks and notes by agent name (e.g. dan, aidan, alan). If omitted, returns all.' },
      },
    },
  },
];

export async function handleTool(name: string, args: Record<string, unknown>, workspaceId: string, actorId: string): Promise<unknown | null> {
  switch (name) {
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

      // Auto-status sync: detect and apply status changes with confidence gating
      const statusChanges = detectAndApplyStatusChanges(text, workspaceId, actorId, 'note', matchResult);

      // Log auto-updates as activity (source=auto-update to prevent recursion)
      for (const upd of statusChanges.applied) {
        logActivity({ workspace_id: workspaceId, actor: agentName || actorId, action: 'auto-update', entity_type: upd.type, entity_id: upd.id, summary: `Auto-updated ${upd.type} "${upd.name}": ${upd.previous_status} → ${upd.new_status} (from note)` });
      }

      const autoUpdates = statusChanges.applied.map(u => ({ type: u.type, id: u.id, name: u.name, previous_status: u.previous_status, new_status: u.new_status }));

      // Insert note
      const noteId = ulid();
      const noteType = (args.type as string) || 'memory';
      rawDb.prepare(
        `INSERT INTO notes (id, workspace_id, agent_id, agent_name, text, project_id, source, matched_entities, auto_updates, type, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        noteId, workspaceId, actorId, agentName || null, text, projectId,
        'mcp', JSON.stringify(matchResult.matched_entities), JSON.stringify(autoUpdates), noteType, now()
      );

      // Log note creation as activity
      logActivity({
        workspace_id: workspaceId,
        actor: agentName || actorId,
        action: 'noted',
        entity_type: 'note',
        entity_id: noteId,
        project_id: projectId || undefined,
        summary: text.length > 200 ? text.substring(0, 200) + '...' : text,
      });

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
      const matchedSummary = statusChanges.applied.map(u => `${u.name} → ${u.new_status}`);

      let message = 'Recorded.';
      if (matchedSummary.length > 0) message += ` ${matchedSummary.join(', ')}.`;
      if (statusChanges.suggested.length > 0) message += ` ${statusChanges.suggested.length} suggested status change(s) (medium confidence).`;
      if (remaining.length > 0) message += ` ${remaining.length} task${remaining.length > 1 ? 's' : ''} remaining.`;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            recorded: true,
            note_id: noteId,
            matched: statusChanges.applied.map(u => ({
              type: u.type, name: u.name, action: `→ ${u.new_status}`,
            })),
            suggested: statusChanges.suggested.length > 0 ? statusChanges.suggested : undefined,
            remaining,
            capabilities: getCapabilities(),
            message,
          }),
        }],
      };
    }

    case 'recall': {
      const query = String(args.query || '').trim();
      if (!query) return { content: [{ type: 'text', text: 'Query is required' }], isError: true };

      const typeFilter = args.type ? String(args.type) : undefined;
      const searchLimit = Math.min(Number(args.limit) || 10, 50);
      // Fetch extra results if filtering by type to compensate for post-filter reduction
      const fetchLimit = typeFilter ? searchLimit * 3 : searchLimit;
      const searchResult = await semanticSearch(query, workspaceId, fetchLimit);

      // Apply type filter if provided (only affects notes — other entity types pass through)
      let filteredResults = searchResult.results;
      if (typeFilter) {
        // For note results, check type column; non-note results pass through
        const noteIds = filteredResults.filter(r => r.type === 'note').map(r => r.id);
        const typedNoteIds = new Set<string>();
        if (noteIds.length > 0) {
          const placeholders = noteIds.map(() => '?').join(',');
          const rows = rawDb.prepare(
            `SELECT id FROM notes WHERE id IN (${placeholders}) AND type = ?`
          ).all(...noteIds, typeFilter) as Array<{ id: string }>;
          for (const row of rows) typedNoteIds.add(row.id);
        }
        filteredResults = filteredResults.filter(r =>
          r.type !== 'note' || typedNoteIds.has(r.id)
        ).slice(0, searchLimit);
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            results: filteredResults.map((r: any) => ({ ...r, text: r.text ? String(r.text).substring(0, 300) : r.text })),
            method: searchResult.method,
            message: `Found ${filteredResults.length} relevant item${filteredResults.length !== 1 ? 's' : ''} using ${searchResult.method} search.`,
          }),
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
      const agentFilter = args.agent ? String(args.agent) : undefined;

      // Open/in_progress tasks
      let taskQuery = "SELECT id, title, status, priority, due_date, assignee, updated_at FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL AND status NOT IN ('done', 'cancelled')";
      const taskParams: unknown[] = [workspaceId];
      if (projectId) { taskQuery += ' AND project_id = ?'; taskParams.push(projectId); }
      if (agentFilter) {
        taskQuery += ' AND assignee = (SELECT id FROM agents WHERE LOWER(name) = LOWER(?) AND workspace_id = ? LIMIT 1)';
        taskParams.push(agentFilter, workspaceId);
      }
      taskQuery += ' ORDER BY due_date ASC NULLS LAST LIMIT 20';
      const taskItems = rawDb.prepare(taskQuery).all(...taskParams) as Array<{ id: string; title: string; status: string; priority: string; due_date: string | null; assignee: string | null; updated_at: string }>;

      // Overdue count
      let overdueQuery = "SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL AND due_date < date('now') AND status NOT IN ('done', 'cancelled')";
      const overdueParams: unknown[] = [workspaceId];
      if (projectId) { overdueQuery += ' AND project_id = ?'; overdueParams.push(projectId); }
      if (agentFilter) {
        overdueQuery += ' AND assignee = (SELECT id FROM agents WHERE LOWER(name) = LOWER(?) AND workspace_id = ? LIMIT 1)';
        overdueParams.push(agentFilter, workspaceId);
      }
      const overdueCount = (rawDb.prepare(overdueQuery).get(...overdueParams) as { c: number }).c;

      // Active deals
      let dealQuery = "SELECT id, name, status, asking_price, target_price FROM deals WHERE workspace_id = ? AND deleted_at IS NULL AND status NOT IN ('closed', 'rejected', 'cancelled')";
      const dealParams: unknown[] = [workspaceId];
      if (projectId) { dealQuery += ' AND project_id = ?'; dealParams.push(projectId); }
      dealQuery += ' ORDER BY updated_at DESC LIMIT 10';
      const dealItems = rawDb.prepare(dealQuery).all(...dealParams) as Array<Record<string, unknown>>;

      // Recent notes
      let notesQuery = 'SELECT id, substr(text,1,200) as text, created_at, agent_id, agent_name FROM notes WHERE workspace_id = ?';
      const notesParams: unknown[] = [workspaceId];
      if (agentFilter) {
        notesQuery += ' AND (agent_id = (SELECT id FROM agents WHERE LOWER(name) = LOWER(?) AND workspace_id = ? LIMIT 1) OR LOWER(agent_name) = LOWER(?))';
        notesParams.push(agentFilter, workspaceId, agentFilter);
      } else if (agentName) {
        notesQuery += ' AND agent_name = ?'; notesParams.push(agentName);
      }
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

      // Detect stale tasks: open tasks where recent notes/activity suggest completion
      const staleWarnings = detectStaleTasks(taskItems, workspaceId);
      const staleTaskIds = new Set(staleWarnings.map(w => w.task_id));

      // Annotate task items with stale_warning if detected
      const annotatedTasks = taskItems.map(t => {
        const warning = staleWarnings.find(w => w.task_id === t.id);
        return warning ? { ...t, stale_warning: warning.stale_warning } : t;
      });

      let message = `${projectName || 'Workload'}: ${taskItems.length} open task${taskItems.length !== 1 ? 's' : ''} (${overdueCount} overdue), ${dealItems.length} active deal${dealItems.length !== 1 ? 's' : ''}, ${noteItems.length} recent note${noteItems.length !== 1 ? 's' : ''}.`;
      if (staleWarnings.length > 0) {
        message += ` WARNING: ${staleWarnings.length} task(s) may have stale status — recent activity suggests completion.`;
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            project: projectName,
            tasks: { total: taskItems.length, overdue: overdueCount, stale: staleWarnings.length, items: annotatedTasks },
            deals: { total: dealItems.length, items: dealItems },
            notes: {
              total: noteItems.length,
              items: noteItems.map(n => ({ text: n.text, created_at: n.created_at, agent: n.agent_name })),
            },
            contacts: contactItems,
            health: { last_note_from: health },
            message,
          }),
        }],
      };
    }

    default:
      return null;
  }
}
