import { rawDb } from '../../../db/connection.js';
import { extractKeywords } from '../../../core/keywords.js';

export interface MatchedEntity {
  type: 'task' | 'deal' | 'contact';
  id: string;
  name: string;
  confidence: 'high' | 'medium';
  auto_updated?: boolean;
}

export const STATUS_PATTERNS: Array<{ pattern: RegExp; status: string }> = [
  { pattern: /\b(?:completed|(?<!almost\s)(?<!nearly\s)finished|done with|done)\b/i, status: 'done' },
  { pattern: /\b(?:cancelled|canceled|abandoned|dropped)\b/i, status: 'cancelled' },
  { pattern: /\b(?:started|working on|began|beginning|in progress)\b/i, status: 'in_progress' },
];

export function matchEntities(summary: string, workspaceId: string, hintsIds?: string[]): MatchedEntity[] {
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

export function autoUpdateStatuses(summary: string, matched: MatchedEntity[], workspaceId: string, actorId: string): void {
  const now = () => new Date().toISOString().replace(/\.\d{3}Z/, 'Z');
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

export const now = () => new Date().toISOString().replace(/\.\d{3}Z/, 'Z');
export const jsonStr = (v: unknown) => JSON.stringify(v ?? []);

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolHandler = (name: string, args: Record<string, unknown>, workspaceId: string, actorId: string) => Promise<unknown | null>;
