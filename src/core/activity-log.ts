import { ulid } from 'ulid';
import { rawDb } from '../db/connection.js';
import { eventBus } from './event-bus.js';

export interface LogEntry {
  workspace_id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id?: string;
  project_id?: string;
  summary: string;
  details?: Record<string, unknown>;
  revision_before?: number;
  revision_after?: number;
}

const insertStmt = () => rawDb.prepare(`
  INSERT INTO activity (id, workspace_id, actor, action, entity_type, entity_id, project_id, summary, details, revision_before, revision_after)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let _stmt: ReturnType<typeof insertStmt> | null = null;

export function logActivity(entry: LogEntry): string {
  const id = ulid();
  const now = new Date().toISOString().replace(/\.\d{3}Z/, 'Z');

  if (!_stmt) _stmt = insertStmt();
  _stmt.run(
    id,
    entry.workspace_id,
    entry.actor,
    entry.action,
    entry.entity_type,
    entry.entity_id ?? null,
    entry.project_id ?? null,
    entry.summary,
    JSON.stringify(entry.details ?? {}),
    entry.revision_before ?? null,
    entry.revision_after ?? null,
  );

  // Emit to event bus for SSE subscribers
  eventBus.emit({
    id,
    workspace_id: entry.workspace_id,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    project_id: entry.project_id,
    actor: entry.actor,
    action: entry.action,
    summary: entry.summary,
    revision: entry.revision_after,
    timestamp: now,
  });

  return id;
}
