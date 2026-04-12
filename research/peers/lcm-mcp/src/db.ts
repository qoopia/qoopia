import { Database } from "bun:sqlite";
import path from "path";
import fs from "fs";

export const DATA_DIR = process.env.LCM_DATA_DIR || "/data/lcm";

fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, "lcm.db");

const db = new Database(DB_PATH);

db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 5000");
db.run("PRAGMA foreign_keys = ON");

// ─── Schema ─────────────────────────────────────────────────────────────────

db.run(`CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT DEFAULT '{}'
)`);

db.run(`CREATE TABLE IF NOT EXISTS sessions (
  id TEXT NOT NULL, agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT DEFAULT '{}',
  PRIMARY KEY (id, agent_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
)`);

db.run(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  chat_id TEXT, message_id TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
)`);

db.run(`CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  msg_start_id INTEGER NOT NULL, msg_end_id INTEGER NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
)`);

db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id')`);
db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(content, content='summaries', content_rowid='id')`);

db.run(`CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content); END`);
db.run(`CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content); END`);
db.run(`CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON summaries BEGIN INSERT INTO summaries_fts(rowid, content) VALUES (new.id, new.content); END`);
db.run(`CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON summaries BEGIN INSERT INTO summaries_fts(summaries_fts, rowid, content) VALUES ('delete', old.id, old.content); END`);

db.run(`CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, agent_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id, agent_id, id DESC)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_summaries_agent ON summaries(agent_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id, agent_id)`);

// ─── Prepared statements ────────────────────────────────────────────────────

const upsertAgent = db.prepare(`
  INSERT INTO agents (id, name) VALUES ($id, $name)
  ON CONFLICT(id) DO UPDATE SET last_seen = datetime('now'), name = COALESCE($name, agents.name)
`);

const insertSession = db.prepare(`INSERT OR IGNORE INTO sessions (id, agent_id) VALUES ($id, $agent_id)`);
const updateSessionActive = db.prepare(`UPDATE sessions SET last_active = datetime('now') WHERE id = $id AND agent_id = $agent_id`);

const insertMessage = db.prepare(`
  INSERT INTO messages (session_id, agent_id, role, content, chat_id, message_id)
  VALUES ($session_id, $agent_id, $role, $content, $chat_id, $message_id)
`);

const insertSummary = db.prepare(`
  INSERT INTO summaries (session_id, agent_id, content, msg_start_id, msg_end_id, level)
  VALUES ($session_id, $agent_id, $content, $msg_start_id, $msg_end_id, $level)
`);

const searchMessagesAll = db.prepare(`
  SELECT m.id, m.session_id, m.agent_id, m.role, m.content, m.timestamp, m.chat_id
  FROM messages_fts f JOIN messages m ON m.id = f.rowid
  WHERE messages_fts MATCH $query ORDER BY m.id DESC LIMIT $limit
`);

const searchMessagesByAgent = db.prepare(`
  SELECT m.id, m.session_id, m.agent_id, m.role, m.content, m.timestamp, m.chat_id
  FROM messages_fts f JOIN messages m ON m.id = f.rowid
  WHERE messages_fts MATCH $query AND m.agent_id = $agent_id ORDER BY m.id DESC LIMIT $limit
`);

const searchSummariesAll = db.prepare(`
  SELECT s.id, s.session_id, s.agent_id, s.content, s.msg_start_id, s.msg_end_id, s.level, s.created_at
  FROM summaries_fts f JOIN summaries s ON s.id = f.rowid
  WHERE summaries_fts MATCH $query ORDER BY s.id DESC LIMIT $limit
`);

const searchSummariesByAgent = db.prepare(`
  SELECT s.id, s.session_id, s.agent_id, s.content, s.msg_start_id, s.msg_end_id, s.level, s.created_at
  FROM summaries_fts f JOIN summaries s ON s.id = f.rowid
  WHERE summaries_fts MATCH $query AND s.agent_id = $agent_id ORDER BY s.id DESC LIMIT $limit
`);

const getRecentMessages = db.prepare(`
  SELECT id, session_id, agent_id, role, content, timestamp, chat_id, message_id
  FROM messages WHERE session_id = $session_id AND agent_id = $agent_id
  ORDER BY id DESC LIMIT $limit
`);

const getMessageRangeByAgent = db.prepare(`
  SELECT id, session_id, agent_id, role, content, timestamp, chat_id
  FROM messages WHERE id BETWEEN $start_id AND $end_id AND agent_id = $agent_id ORDER BY id ASC
`);

const listSessionsByAgent = db.prepare(`
  SELECT s.id, s.agent_id, s.created_at, s.last_active,
    (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.agent_id = s.agent_id) as message_count
  FROM sessions s WHERE s.agent_id = $agent_id ORDER BY s.last_active DESC LIMIT $limit
`);

const listSessionsAll = db.prepare(`
  SELECT s.id, s.agent_id, s.created_at, s.last_active,
    (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.agent_id = s.agent_id) as message_count
  FROM sessions s ORDER BY s.last_active DESC LIMIT $limit
`);

const listAgents = db.prepare(`
  SELECT a.id, a.name, a.created_at, a.last_seen,
    (SELECT COUNT(*) FROM messages m WHERE m.agent_id = a.id) as message_count,
    (SELECT COUNT(DISTINCT s.id) FROM sessions s WHERE s.agent_id = a.id) as session_count
  FROM agents a ORDER BY a.last_seen DESC
`);

const countAgents = db.prepare(`SELECT COUNT(*) as cnt FROM agents`);

const getStatsAll = db.prepare(`SELECT
  (SELECT COUNT(*) FROM agents) as total_agents,
  (SELECT COUNT(*) FROM sessions) as total_sessions,
  (SELECT COUNT(*) FROM messages) as total_messages,
  (SELECT COUNT(*) FROM summaries) as total_summaries,
  (SELECT MIN(timestamp) FROM messages) as earliest_message,
  (SELECT MAX(timestamp) FROM messages) as latest_message
`);

const getStatsByAgent = db.prepare(`SELECT
  (SELECT COUNT(DISTINCT s.id) FROM sessions s WHERE s.agent_id = $agent_id) as total_sessions,
  (SELECT COUNT(*) FROM messages m WHERE m.agent_id = $agent_id) as total_messages,
  (SELECT COUNT(*) FROM summaries s WHERE s.agent_id = $agent_id) as total_summaries,
  (SELECT MIN(timestamp) FROM messages WHERE agent_id = $agent_id) as earliest_message,
  (SELECT MAX(timestamp) FROM messages WHERE agent_id = $agent_id) as latest_message
`);

// ─── Transactional helpers ──────────────────────────────────────────────────

const saveMessageTx = db.transaction((params: {
  session_id: string; agent_id: string;
  role: "user" | "assistant" | "system"; content: string;
  chat_id?: string | null; message_id?: string | null;
}) => {
  upsertAgent.run({ $id: params.agent_id, $name: null });
  insertSession.run({ $id: params.session_id, $agent_id: params.agent_id });
  updateSessionActive.run({ $id: params.session_id, $agent_id: params.agent_id });
  const result = insertMessage.run({
    $session_id: params.session_id, $agent_id: params.agent_id,
    $role: params.role, $content: params.content,
    $chat_id: params.chat_id || null, $message_id: params.message_id || null,
  });
  return Number(result.lastInsertRowid);
});

const saveSummaryTx = db.transaction((params: {
  session_id: string; agent_id: string; content: string;
  msg_start_id: number; msg_end_id: number; level: number;
}) => {
  upsertAgent.run({ $id: params.agent_id, $name: null });
  insertSession.run({ $id: params.session_id, $agent_id: params.agent_id });
  const result = insertSummary.run({
    $session_id: params.session_id, $agent_id: params.agent_id,
    $content: params.content, $msg_start_id: params.msg_start_id,
    $msg_end_id: params.msg_end_id, $level: params.level,
  });
  return Number(result.lastInsertRowid);
});

// ─── Public API ─────────────────────────────────────────────────────────────

export function saveMessage(params: {
  session_id: string; agent_id: string;
  role: "user" | "assistant" | "system"; content: string;
  chat_id?: string; message_id?: string;
}): number {
  return saveMessageTx(params);
}

export function saveSummary(params: {
  session_id: string; agent_id: string; content: string;
  msg_start_id: number; msg_end_id: number; level?: number;
}): number {
  if (params.msg_start_id > params.msg_end_id) {
    throw new Error(`Invalid range: start (${params.msg_start_id}) > end (${params.msg_end_id})`);
  }
  return saveSummaryTx({ ...params, level: params.level || 1 });
}

export function search(query: string, limit: number = 20, agentId?: string) {
  const clampedLimit = Math.min(Math.max(1, limit), 200);
  const safeQuery = query.replace(/['"]/g, "").split(/\s+/).filter(Boolean)
    .map((w) => `"${w}"*`).join(" OR ");
  if (!safeQuery) return { messages: [], summaries: [] };

  const messages = agentId
    ? searchMessagesByAgent.all({ $query: safeQuery, $limit: clampedLimit, $agent_id: agentId })
    : searchMessagesAll.all({ $query: safeQuery, $limit: clampedLimit });

  const summaries = agentId
    ? searchSummariesByAgent.all({ $query: safeQuery, $limit: clampedLimit, $agent_id: agentId })
    : searchSummariesAll.all({ $query: safeQuery, $limit: clampedLimit });

  return { messages: messages as any[], summaries: summaries as any[] };
}

export function getRecent(sessionId: string, agentId: string, limit: number = 50) {
  const clampedLimit = Math.min(Math.max(1, limit), 500);
  return getRecentMessages.all({ $session_id: sessionId, $agent_id: agentId, $limit: clampedLimit }) as any[];
}

export function expandRange(startId: number, endId: number, agentId: string) {
  return getMessageRangeByAgent.all({ $start_id: startId, $end_id: endId, $agent_id: agentId }) as any[];
}

export function getSessions(limit: number = 20, agentId?: string) {
  const clampedLimit = Math.min(Math.max(1, limit), 100);
  return agentId
    ? listSessionsByAgent.all({ $agent_id: agentId, $limit: clampedLimit }) as any[]
    : listSessionsAll.all({ $limit: clampedLimit }) as any[];
}

export function getAgents() {
  return listAgents.all() as any[];
}

export function getAgentCount(): number {
  return (countAgents.get() as any).cnt;
}

export function stats(agentId?: string) {
  return agentId
    ? getStatsByAgent.get({ $agent_id: agentId }) as any
    : getStatsAll.get() as any;
}

export function close() {
  db.close();
}
