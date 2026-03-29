import { rawDb } from '../../db/connection.js';

export function resolveActorName(auth: { id: string; name?: string; workspace_id: string }): string {
  // Try auth.name first if it looks like a human name (not a ULID)
  if (auth.name && !/^[0-9A-Z]{26}$/.test(auth.name)) return auth.name.toLowerCase();
  // Look up agent name from agents table
  const row = rawDb.prepare('SELECT name FROM agents WHERE id = ?').get(auth.id) as { name: string } | undefined;
  if (row) return row.name.toLowerCase();
  return auth.id; // fallback
}
