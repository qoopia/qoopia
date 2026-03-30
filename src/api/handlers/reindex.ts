import type { Context } from 'hono';
import { rawDb } from '../../db/connection.js';
import { storeEmbedding, getCapabilities } from '../../core/intelligence.js';
import type { AuthContext } from '../../types/index.js';

export default async function reindexHandler(c: Context<{ Variables: { auth: AuthContext } }>) {
  const auth = c.get('auth');

  if (!getCapabilities().embeddings) {
    return c.json({ error: 'Voyage API key not configured — cannot generate embeddings' }, 503);
  }

  const notes = rawDb.prepare(
    'SELECT id, text FROM notes WHERE workspace_id = ? AND embedding IS NULL'
  ).all(auth.workspace_id) as Array<{ id: string; text: string }>;

  let processed = 0;
  let skipped = 0;
  const failed: string[] = [];

  for (const note of notes) {
    if (!note.text || note.text.trim().length === 0) {
      skipped++;
      continue;
    }
    try {
      await storeEmbedding(note.id, note.text);
      processed++;
    } catch {
      failed.push(note.id);
    }
  }

  return c.json({ processed, skipped, failed });
}
