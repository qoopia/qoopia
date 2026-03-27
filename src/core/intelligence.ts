/**
 * Graceful Degradation Engine for Qoopia
 * Layer 1: LLM (haiku) for entity matching, Voyage for embeddings
 * Layer 2: Keyword matching + FTS5 (always available)
 */

import { rawDb } from '../db/connection.js';

// ── Interfaces ──

export interface MatchedEntity {
  type: 'task' | 'deal' | 'contact';
  id: string;
  name: string;
  confidence: 'high' | 'medium';
  auto_updated?: boolean;
  previous_status?: string;
  new_status?: string;
}

export interface MatchResult {
  matched_entities: MatchedEntity[];
  method: 'llm' | 'keyword';
}

export interface SearchResult {
  results: Array<{
    type: 'note' | 'task' | 'deal' | 'contact' | 'activity';
    id: string;
    text: string;
    score: number;
    created_at?: string;
  }>;
  method: 'embeddings' | 'fts5';
}

// ── Capabilities ──

export function getCapabilities(): { llm: boolean; embeddings: boolean } {
  return {
    llm: !!process.env.QOOPIA_LLM_API_KEY,
    embeddings: !!process.env.QOOPIA_VOYAGE_API_KEY,
  };
}

// ── Status patterns ──

const STATUS_PATTERNS: Array<{ pattern: RegExp; status: string }> = [
  { pattern: /\b(?:completed|finished|done with|done|closed)\b/i, status: 'done' },
  { pattern: /\b(?:cancelled|canceled|abandoned)\b/i, status: 'cancelled' },
  { pattern: /\b(?:started|began|working on)\b/i, status: 'in_progress' },
];

// ── Keyword extraction ──

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'then', 'when', 'where', 'why', 'how', 'all',
  'each', 'some', 'no', 'not', 'only', 'so', 'than', 'too', 'very',
  'just', 'and', 'but', 'or', 'if', 'while', 'that', 'this', 'it',
  'its', 'i', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they',
  'them', 'his', 'her', 'task', 'deal', 'contact', 'completed',
  'finished', 'started', 'cancelled', 'done', 'report', 'activity',
]);

function extractKeywords(text: string): string[] {
  return text
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()))
    .map(w => w.toLowerCase());
}

// ── Layer 2: Keyword-based entity matching ──

function keywordMatch(text: string, workspaceId: string): MatchResult {
  const matched: MatchedEntity[] = [];
  const seen = new Set<string>();
  const keywords = extractKeywords(text);

  // Detect status intent
  let detectedStatus: string | undefined;
  for (const sp of STATUS_PATTERNS) {
    if (sp.pattern.test(text)) {
      detectedStatus = sp.status;
      break;
    }
  }

  for (const kw of keywords) {
    const likePattern = `%${kw}%`;

    const tasks = rawDb.prepare(
      'SELECT id, title, status FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL AND LOWER(title) LIKE ? LIMIT 3'
    ).all(workspaceId, likePattern) as Array<{ id: string; title: string; status: string }>;
    for (const t of tasks) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const entity: MatchedEntity = { type: 'task', id: t.id, name: t.title, confidence: 'medium' };
      if (detectedStatus && t.status !== detectedStatus) {
        entity.previous_status = t.status;
        entity.new_status = detectedStatus;
      }
      matched.push(entity);
    }

    const deals = rawDb.prepare(
      'SELECT id, name, status FROM deals WHERE workspace_id = ? AND deleted_at IS NULL AND LOWER(name) LIKE ? LIMIT 3'
    ).all(workspaceId, likePattern) as Array<{ id: string; name: string; status: string }>;
    for (const d of deals) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const entity: MatchedEntity = { type: 'deal', id: d.id, name: d.name, confidence: 'medium' };
      if (detectedStatus && d.status !== detectedStatus) {
        entity.previous_status = d.status;
        entity.new_status = detectedStatus;
      }
      matched.push(entity);
    }

    const contacts = rawDb.prepare(
      'SELECT id, name FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL AND LOWER(name) LIKE ? LIMIT 3'
    ).all(workspaceId, likePattern) as Array<{ id: string; name: string }>;
    for (const ct of contacts) {
      if (seen.has(ct.id)) continue;
      seen.add(ct.id);
      matched.push({ type: 'contact', id: ct.id, name: ct.name, confidence: 'medium' });
    }
  }

  return { matched_entities: matched.slice(0, 20), method: 'keyword' };
}

// ── Layer 1: LLM-based entity matching ──

interface LlmAction {
  action: string;
  entity_type: string;
  search_query: string;
  new_status?: string;
  confidence: string;
}

async function llmMatch(text: string, workspaceId: string): Promise<MatchResult | null> {
  const apiKey = process.env.QOOPIA_LLM_API_KEY;
  if (!apiKey) return null;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: 'Extract structured facts from this agent note. Return JSON array of actions: [{"action": "status_change", "entity_type": "task", "search_query": "...", "new_status": "done|cancelled|in_progress", "confidence": "high|medium"}]. Only include high-confidence matches. If a task/deal/contact is explicitly mentioned as completed/cancelled/started, include it. Return ONLY the JSON array, no other text.',
        messages: [{ role: 'user', content: text }],
      }),
    });

    if (!resp.ok) return null;

    const data = await resp.json() as { content: Array<{ type: string; text: string }> };
    const responseText = data.content?.[0]?.text || '';

    // Extract JSON from response
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;

    const actions: LlmAction[] = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(actions) || actions.length === 0) return null;

    const matched: MatchedEntity[] = [];
    const seen = new Set<string>();

    for (const action of actions) {
      if (action.confidence !== 'high') continue;
      const query = action.search_query;
      if (!query) continue;

      const likePattern = `%${query}%`;
      const entityType = action.entity_type;

      if (entityType === 'task' || !entityType) {
        const tasks = rawDb.prepare(
          'SELECT id, title, status FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL AND LOWER(title) LIKE ? LIMIT 3'
        ).all(workspaceId, likePattern.toLowerCase()) as Array<{ id: string; title: string; status: string }>;
        for (const t of tasks) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          const entity: MatchedEntity = { type: 'task', id: t.id, name: t.title, confidence: 'high' };
          if (action.new_status && t.status !== action.new_status) {
            entity.previous_status = t.status;
            entity.new_status = action.new_status;
          }
          matched.push(entity);
        }
      }

      if (entityType === 'deal' || !entityType) {
        const deals = rawDb.prepare(
          'SELECT id, name, status FROM deals WHERE workspace_id = ? AND deleted_at IS NULL AND LOWER(name) LIKE ? LIMIT 3'
        ).all(workspaceId, likePattern.toLowerCase()) as Array<{ id: string; name: string; status: string }>;
        for (const d of deals) {
          if (seen.has(d.id)) continue;
          seen.add(d.id);
          const entity: MatchedEntity = { type: 'deal', id: d.id, name: d.name, confidence: 'high' };
          if (action.new_status && d.status !== action.new_status) {
            entity.previous_status = d.status;
            entity.new_status = action.new_status;
          }
          matched.push(entity);
        }
      }

      if (entityType === 'contact') {
        const contacts = rawDb.prepare(
          'SELECT id, name FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL AND LOWER(name) LIKE ? LIMIT 3'
        ).all(workspaceId, likePattern.toLowerCase()) as Array<{ id: string; name: string }>;
        for (const ct of contacts) {
          if (seen.has(ct.id)) continue;
          seen.add(ct.id);
          matched.push({ type: 'contact', id: ct.id, name: ct.name, confidence: 'high' });
        }
      }
    }

    if (matched.length === 0) return null;
    return { matched_entities: matched.slice(0, 20), method: 'llm' };
  } catch {
    return null; // Fall through to Layer 2
  }
}

// ── Main: matchFromNote ──

export async function matchFromNote(text: string, workspaceId: string): Promise<MatchResult> {
  // Layer 1: Try LLM
  const llmResult = await llmMatch(text, workspaceId);
  if (llmResult) return llmResult;

  // Layer 2: Keyword fallback
  return keywordMatch(text, workspaceId);
}

// ── Voyage embeddings ──

async function getEmbedding(text: string): Promise<Float32Array | null> {
  const apiKey = process.env.QOOPIA_VOYAGE_API_KEY;
  if (!apiKey) return null;

  try {
    const resp = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'voyage-3-lite',
        input: [text],
      }),
    });

    if (!resp.ok) return null;

    const data = await resp.json() as { data: Array<{ embedding: number[] }> };
    const embedding = data.data?.[0]?.embedding;
    if (!embedding) return null;

    return new Float32Array(embedding);
  } catch {
    return null;
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function storeEmbedding(noteId: string, text: string): Promise<void> {
  const embedding = await getEmbedding(text);
  if (!embedding) return;
  const buffer = Buffer.from(embedding.buffer);
  rawDb.prepare('UPDATE notes SET embedding = ? WHERE id = ?').run(buffer, noteId);
}

// ── Layer 1 semantic search: Voyage embeddings ──

async function embeddingSearch(query: string, workspaceId: string, limit: number): Promise<SearchResult | null> {
  const queryEmbedding = await getEmbedding(query);
  if (!queryEmbedding) return null;

  const notes = rawDb.prepare(
    'SELECT id, text, embedding, created_at FROM notes WHERE workspace_id = ? AND embedding IS NOT NULL'
  ).all(workspaceId) as Array<{ id: string; text: string; embedding: Buffer; created_at: string }>;

  if (notes.length === 0) return null;

  const scored = notes.map(note => {
    const noteEmbedding = new Float32Array(note.embedding.buffer, note.embedding.byteOffset, note.embedding.byteLength / 4);
    const score = cosineSimilarity(queryEmbedding, noteEmbedding);
    return { type: 'note' as const, id: note.id, text: note.text, score, created_at: note.created_at };
  });

  scored.sort((a, b) => b.score - a.score);

  return {
    results: scored.slice(0, limit),
    method: 'embeddings',
  };
}

// ── Layer 2 semantic search: FTS5 ──

function fts5Search(query: string, workspaceId: string, limit: number): SearchResult {
  const results: SearchResult['results'] = [];
  const ftsQuery = query.split(/\s+/).filter(t => t.length > 1).map(t => `"${t}"*`).join(' ');

  if (!ftsQuery) return { results: [], method: 'fts5' };

  // Search notes
  try {
    const notes = rawDb.prepare(
      `SELECT n.id, n.text, n.created_at, rank FROM notes_fts f JOIN notes n ON n.rowid = f.rowid WHERE notes_fts MATCH ? AND n.workspace_id = ? ORDER BY rank LIMIT ?`
    ).all(ftsQuery, workspaceId, limit) as Array<{ id: string; text: string; created_at: string; rank: number }>;
    for (const n of notes) {
      results.push({ type: 'note', id: n.id, text: n.text, score: -n.rank, created_at: n.created_at });
    }
  } catch { /* empty */ }

  // Search tasks
  try {
    const tasks = rawDb.prepare(
      `SELECT t.id, t.title, t.created_at, rank FROM tasks_fts f JOIN tasks t ON t.rowid = f.rowid WHERE tasks_fts MATCH ? AND t.workspace_id = ? AND t.deleted_at IS NULL ORDER BY rank LIMIT ?`
    ).all(ftsQuery, workspaceId, limit) as Array<{ id: string; title: string; created_at: string; rank: number }>;
    for (const t of tasks) {
      results.push({ type: 'task', id: t.id, text: t.title, score: -t.rank, created_at: t.created_at });
    }
  } catch { /* empty */ }

  // Search deals
  try {
    const deals = rawDb.prepare(
      `SELECT d.id, d.name, d.created_at, rank FROM deals_fts f JOIN deals d ON d.rowid = f.rowid WHERE deals_fts MATCH ? AND d.workspace_id = ? AND d.deleted_at IS NULL ORDER BY rank LIMIT ?`
    ).all(ftsQuery, workspaceId, limit) as Array<{ id: string; name: string; created_at: string; rank: number }>;
    for (const d of deals) {
      results.push({ type: 'deal', id: d.id, text: d.name, score: -d.rank, created_at: d.created_at });
    }
  } catch { /* empty */ }

  // Search contacts
  try {
    const contacts = rawDb.prepare(
      `SELECT c.id, c.name, c.created_at, rank FROM contacts_fts f JOIN contacts c ON c.rowid = f.rowid WHERE contacts_fts MATCH ? AND c.workspace_id = ? AND c.deleted_at IS NULL ORDER BY rank LIMIT ?`
    ).all(ftsQuery, workspaceId, limit) as Array<{ id: string; name: string; created_at: string; rank: number }>;
    for (const c of contacts) {
      results.push({ type: 'contact', id: c.id, text: c.name, score: -c.rank, created_at: c.created_at });
    }
  } catch { /* empty */ }

  // Search activity
  try {
    const activity = rawDb.prepare(
      `SELECT a.id, a.summary, a.timestamp, rank FROM activity_fts f JOIN activity a ON a.rowid = f.rowid WHERE activity_fts MATCH ? AND a.workspace_id = ? ORDER BY rank LIMIT ?`
    ).all(ftsQuery, workspaceId, limit) as Array<{ id: string; summary: string; timestamp: string; rank: number }>;
    for (const a of activity) {
      results.push({ type: 'activity', id: a.id, text: a.summary, score: -a.rank, created_at: a.timestamp });
    }
  } catch { /* empty */ }

  // Sort by score descending and limit
  results.sort((a, b) => b.score - a.score);
  return { results: results.slice(0, limit), method: 'fts5' };
}

// ── Main: semanticSearch ──

export async function semanticSearch(query: string, workspaceId: string, limit: number = 10): Promise<SearchResult> {
  // Layer 1: Try embeddings
  const embResult = await embeddingSearch(query, workspaceId, limit);
  if (embResult && embResult.results.length > 0) return embResult;

  // Layer 2: FTS5 fallback
  return fts5Search(query, workspaceId, limit);
}
