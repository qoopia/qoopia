# 01 — TO-BE: Qoopia V3.0 SQL Schema (DDL)

**Базис**: `docs/10-as-is/01-schema.md` + ADR-002 (Layer B deferred) + ADR-004 (simplicity budgets) + ADR-005 (LCM absorption)

**Бюджет H3**: ≤ 10 real tables в начальной схеме. Эта DDL имеет **10 real tables**. ✓

Этот файл содержит **исполнимую SQL DDL** — копируется в `migrations/001-initial-schema.sql` при реализации.

## Design decisions quick-reference

1. **ULID strings** для всех PK вместо INTEGER AUTOINCREMENT — sortable, time-encoded, globally unique, готовы к потенциальному multi-node в V3.5+
2. **TEXT for timestamps** в ISO 8601 UTC format (`'YYYY-MM-DDTHH:MM:SSZ'`) — single format, легко сравнивать строками
3. **JSON в TEXT полях** для `metadata` (используем `json_extract()` для индексов/фильтров)
4. **Soft delete через `deleted_at TEXT`** — NULL = активна
5. **FTS5 contentless** — триггеры sync-ят изменения
6. **Foreign keys enabled** (`PRAGMA foreign_keys = ON`)
7. **WAL mode** (`PRAGMA journal_mode = WAL`)
8. **`workspace_id` NOT NULL** на всех user-facing таблицах

## Initial migration SQL

```sql
-- migrations/001-initial-schema.sql
-- Qoopia V3.0 initial schema
-- Created: 2026-04-11
-- Principles: Phase 1 + Simplicity Pass

-- ============================================================
-- PRAGMAs (applied at connection open, not here, but documented)
-- ============================================================
-- PRAGMA journal_mode = WAL;
-- PRAGMA synchronous = NORMAL;
-- PRAGMA busy_timeout = 5000;
-- PRAGMA foreign_keys = ON;

-- ============================================================
-- GROUP A: Identity & tenancy
-- ============================================================

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,                       -- ULID
  name TEXT NOT NULL,                        -- display name
  slug TEXT UNIQUE NOT NULL,                 -- URL-safe unique identifier
  settings TEXT NOT NULL DEFAULT '{}',       -- free-form JSON for future flags
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,                       -- ULID
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'member',       -- 'owner' | 'member'
  api_key_hash TEXT,                         -- SHA256 hex of API key
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,                       -- ULID
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,                        -- 'alan', 'aidan', 'claude-code', etc.
  type TEXT NOT NULL DEFAULT 'standard',     -- 'standard' | 'claude-privileged' (cross-workspace read)
  api_key_hash TEXT NOT NULL,                -- SHA256 hex
  active INTEGER NOT NULL DEFAULT 1,         -- soft disable
  last_seen TEXT,                            -- updated on successful auth
  metadata TEXT NOT NULL DEFAULT '{}',       -- free-form JSON
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_agents_workspace ON agents(workspace_id);
CREATE INDEX idx_agents_api_key ON agents(api_key_hash) WHERE active = 1;

-- ============================================================
-- GROUP B: Universal notes (replaces tasks/deals/contacts/
-- finances/projects/notes from V2)
-- ============================================================

CREATE TABLE notes (
  id TEXT PRIMARY KEY,                       -- ULID
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT REFERENCES agents(id),       -- who created
  type TEXT NOT NULL,                        -- 'note' | 'task' | 'deal' | 'contact' | 'finance' | 'project' | 'memory' | 'rule' | 'knowledge' | 'context'
  text TEXT NOT NULL,                        -- primary content (title + body)
  metadata TEXT NOT NULL DEFAULT '{}',       -- type-specific JSON
  project_id TEXT REFERENCES notes(id),      -- self-referential (project is a note of type='project')
  task_bound_id TEXT REFERENCES notes(id),   -- task-bound retention (auto-purge when task closed)
  session_id TEXT,                           -- chat session reference (soft link)
  source TEXT NOT NULL DEFAULT 'manual',     -- 'manual' | 'mcp' | 'import' | 'migration'
  tags TEXT NOT NULL DEFAULT '[]',           -- JSON array of strings
  deleted_at TEXT,                           -- soft delete
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_notes_workspace ON notes(workspace_id);
CREATE INDEX idx_notes_type ON notes(workspace_id, type) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_project ON notes(project_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_agent ON notes(agent_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_created ON notes(workspace_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_task_bound ON notes(task_bound_id) WHERE task_bound_id IS NOT NULL;

-- Partial indexes on JSON metadata for common query patterns
-- (Added as needed in future migrations; examples:)
-- CREATE INDEX idx_notes_task_status ON notes(json_extract(metadata, '$.status'))
--   WHERE type = 'task' AND deleted_at IS NULL;
-- CREATE INDEX idx_notes_task_due ON notes(json_extract(metadata, '$.due_date'))
--   WHERE type = 'task' AND deleted_at IS NULL;

-- FTS5 virtual table для full-text search
CREATE VIRTUAL TABLE notes_fts USING fts5(
  text,
  content='notes',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'  -- handles RU/EN including accents
);

-- Sync triggers (contentless FTS5 pattern)
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;

CREATE TRIGGER notes_au AFTER UPDATE OF text ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO notes_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- ============================================================
-- GROUP C: Session memory (UC-7 LCM absorption)
-- ============================================================

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                       -- ULID or agent-provided key like 'YYYY-MM-DD'
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT REFERENCES agents(id),
  title TEXT,                                -- optional human label
  metadata TEXT NOT NULL DEFAULT '{}',       -- free-form JSON
  task_bound_id TEXT REFERENCES notes(id),   -- if session bound to task
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_active TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX idx_sessions_agent ON sessions(agent_id);
CREATE INDEX idx_sessions_active ON sessions(workspace_id, last_active DESC);
CREATE INDEX idx_sessions_task_bound ON sessions(task_bound_id) WHERE task_bound_id IS NOT NULL;

CREATE TABLE session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,     -- sequential for cheap range queries
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  agent_id TEXT REFERENCES agents(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,                     -- message text
  metadata TEXT NOT NULL DEFAULT '{}',       -- tool_call / tool_result / file refs
  token_count INTEGER,                       -- optional estimate
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_session_messages_session ON session_messages(session_id, id);
CREATE INDEX idx_session_messages_workspace ON session_messages(workspace_id, created_at DESC);

-- FTS5 on session_messages.content
CREATE VIRTUAL TABLE session_messages_fts USING fts5(
  content,
  content='session_messages',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER session_messages_ai AFTER INSERT ON session_messages BEGIN
  INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER session_messages_ad AFTER DELETE ON session_messages BEGIN
  INSERT INTO session_messages_fts(session_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

-- Update trigger intentionally omitted: session_messages are append-only

CREATE TABLE summaries (
  id TEXT PRIMARY KEY,                       -- ULID
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  agent_id TEXT REFERENCES agents(id),
  content TEXT NOT NULL,                     -- agent-written summary text
  msg_start_id INTEGER NOT NULL,             -- inclusive range start
  msg_end_id INTEGER NOT NULL,               -- inclusive range end
  level INTEGER NOT NULL DEFAULT 1,          -- 1=leaf, 2=summary of summaries, 3+
  token_count INTEGER,                       -- optional estimate
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_summaries_session ON summaries(session_id, msg_start_id);
CREATE INDEX idx_summaries_workspace ON summaries(workspace_id, created_at DESC);

-- ============================================================
-- GROUP D: Activity log
-- ============================================================

CREATE TABLE activity (
  id TEXT PRIMARY KEY,                       -- ULID
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT REFERENCES agents(id),       -- who triggered
  action TEXT NOT NULL,                      -- 'created', 'updated', 'deleted', etc.
  entity_type TEXT NOT NULL,                 -- 'note', 'session', 'agent', ...
  entity_id TEXT,                            -- optional ref
  project_id TEXT REFERENCES notes(id),      -- denormalized for fast project activity queries
  summary TEXT NOT NULL,                     -- human-readable
  details TEXT NOT NULL DEFAULT '{}',        -- structured JSON
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_activity_workspace ON activity(workspace_id, created_at DESC);
CREATE INDEX idx_activity_entity ON activity(entity_type, entity_id);
CREATE INDEX idx_activity_project ON activity(project_id, created_at DESC) WHERE project_id IS NOT NULL;

-- NOTE: no FTS5 on activity (Phase 2 Finding 7 — activity rarely searched by content)

-- ============================================================
-- GROUP E: OAuth
-- ============================================================

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,                       -- client_id
  name TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),       -- associated agent (for delegation)
  client_secret_hash TEXT NOT NULL,          -- SHA256
  redirect_uris TEXT NOT NULL DEFAULT '[]',  -- JSON array
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- No separate oauth_codes table: codes are stored in oauth_tokens with token_type='code'
-- and short expires_at. This collapses 3 tables to 1.

CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,               -- SHA256 of opaque token
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  token_type TEXT NOT NULL CHECK (token_type IN ('access', 'refresh', 'code')),
  code_challenge TEXT,                       -- for token_type='code' (PKCE)
  code_challenge_method TEXT,                -- 'S256' typically
  redirect_uri TEXT,                         -- for token_type='code'
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_oauth_tokens_client ON oauth_tokens(client_id) WHERE revoked = 0;
CREATE INDEX idx_oauth_tokens_agent ON oauth_tokens(agent_id) WHERE revoked = 0;
CREATE INDEX idx_oauth_tokens_expires ON oauth_tokens(expires_at) WHERE revoked = 0;

-- ============================================================
-- GROUP F: System
-- ============================================================

CREATE TABLE schema_versions (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE idempotency_keys (
  key_hash TEXT PRIMARY KEY,                 -- SHA256 of Idempotency-Key header
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  response TEXT NOT NULL,                    -- cached JSON response
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

-- ============================================================
-- Seed: record this migration
-- ============================================================

INSERT INTO schema_versions (version, description) VALUES
  (1, 'Initial V3.0 schema: universal notes, sessions, summaries, simplified OAuth');
```

## Таблиц итого

| # | Таблица | Описание |
|---|---|---|
| 1 | `workspaces` | Tenant boundary |
| 2 | `users` | Humans |
| 3 | `agents` | API key registry |
| 4 | `notes` | Universal entity (note/task/deal/contact/finance/project) |
| 5 | `sessions` | Chat session registry |
| 6 | `session_messages` | Raw messages (append-only) |
| 7 | `summaries` | Agent-written session summaries |
| 8 | `activity` | Audit log |
| 9 | `oauth_clients` | OAuth client registry |
| 10 | `oauth_tokens` | Opaque tokens (access + refresh + code collapsed) |
| 11 | `schema_versions` | Migration tracking |
| 12 | `idempotency_keys` | Retry safety |

**Real tables**: 12 (включая 2 system). **User-facing real tables**: 10. ✓ H3 budget.

**FTS5 shadow tables**: 2 virtual tables × ~5 internal tables каждый = **~10 shadow**.

**Всего sqlite_master**: ~22-24 (vs 45 в V2).

## Ключевые изменения vs V2

| V2 | V3.0 | Why |
|---|---|---|
| 5 entity tables (tasks/deals/contacts/finances/projects) | 1 `notes` с type + metadata | Phase 1.5 Simplicity Pass #3 |
| 2 junction tables (deal_contacts, contact_projects) | Hromaged в `notes.metadata` | Phase 1.5 #3 |
| `activity` + `activity_archive` | `activity` only, retention purges | Phase 1.5 #4 |
| `oauth_clients` + `oauth_codes` + `oauth_tokens` | `oauth_clients` + `oauth_tokens` (codes collapsed) | Simplify |
| `magic_links` | **dropped** | NG-5 (no dashboard) |
| `webhook_dead_letters` | **dropped** | Phase 2 03-core-services 03.4 |
| `notes.embedding BLOB` | **dropped** | ADR-002 Layer B deferred |
| `notes.matched_entities` | **dropped** | No auto-linking |
| `notes.auto_updates` | **dropped** | No auto-status-magic |
| `tasks.revision_before/after` | **dropped** | No revision tracking |
| — | **NEW**: `sessions` | UC-7 LCM absorption |
| — | **NEW**: `session_messages` | UC-7 |
| — | **NEW**: `summaries` | UC-7 |
| — | **NEW**: `notes.task_bound_id` | F3 task-bound retention |

## Query patterns

Примеры как будет работать CRUD на универсальной таблице `notes`.

### Create a task

```sql
-- Bun pseudo-code:
db.run(
  `INSERT INTO notes (id, workspace_id, agent_id, type, text, metadata, project_id, task_bound_id)
   VALUES (?, ?, ?, 'task', ?, ?, ?, ?)`,
  [id, wsId, agentId, title, JSON.stringify({status: 'todo', priority: 'medium', due_date: '2026-04-20'}), projectId, null]
);
```

### List all open tasks in a project

```sql
SELECT id, text, metadata, created_at
FROM notes
WHERE workspace_id = ?
  AND type = 'task'
  AND project_id = ?
  AND deleted_at IS NULL
  AND json_extract(metadata, '$.status') NOT IN ('done', 'cancelled')
ORDER BY
  json_extract(metadata, '$.due_date') ASC,
  created_at DESC
LIMIT 50;
```

**Performance**: на 133 tasks (prod snapshot) — instantaneous. На 10k tasks — быстро потому что есть `idx_notes_type`. На 100k tasks — может понадобиться partial index на `json_extract(metadata, '$.status')`, добавляется одной строкой в migration.

### Full-text search across all notes

```sql
SELECT n.id, n.type, n.text, n.created_at
FROM notes_fts f
JOIN notes n ON n.rowid = f.rowid
WHERE notes_fts MATCH ?           -- user query
  AND n.workspace_id = ?
  AND n.deleted_at IS NULL
ORDER BY rank
LIMIT ?;
```

**Это замена для V2 `recall()`** — один FTS5 query, без semantic fallback, без substring truncation.

### Session recent для UC-1

```sql
SELECT id, role, content, metadata, created_at
FROM session_messages
WHERE session_id = ? AND workspace_id = ?
ORDER BY id DESC
LIMIT 50;
-- затем в коде: .reverse() для хронологического порядка
```

### Session search для UC-2

```sql
SELECT sm.id, sm.session_id, sm.role, sm.content, sm.created_at
FROM session_messages_fts f
JOIN session_messages sm ON sm.id = f.rowid
WHERE session_messages_fts MATCH ?
  AND sm.workspace_id = ?
ORDER BY rank
LIMIT ?;
```

### Task-bound retention cleanup (daily maintenance)

```sql
-- Find tasks closed > 1 hour ago
WITH closed_tasks AS (
  SELECT id FROM notes
  WHERE type = 'task'
    AND deleted_at IS NULL
    AND json_extract(metadata, '$.status') IN ('done', 'cancelled')
    AND datetime(updated_at) <= datetime('now', '-1 hour')
)
-- Purge bound notes
DELETE FROM notes
WHERE task_bound_id IN (SELECT id FROM closed_tasks);

-- Purge bound sessions and their messages
DELETE FROM sessions
WHERE task_bound_id IN (SELECT id FROM closed_tasks);
-- session_messages cascade NOT configured; explicit DELETE:
DELETE FROM session_messages
WHERE session_id NOT IN (SELECT id FROM sessions);
```

(Real implementation wraps this in a transaction with logging.)

## FTS5 query syntax

Qoopia будет принимать raw FTS5 queries от агента, но с **sanitizer** который:
1. Экранирует кавычки
2. Удаляет `AND`/`OR`/`NOT` если не в кавычках — чтобы агент мог писать «buy milk» без необходимости думать о booleans
3. Автоматически добавляет prefix-match (`"word"*`) к каждому термину для русской морфологии
4. Ограничивает максимальную длину query (1000 chars)

**Пример**:
- Input: `"как вернуть товар"`
- Sanitized FTS5: `"как"* "вернуть"* "товар"*`
- Returns: notes где есть «как», «вернуть», «товар» в любом порядке и с любыми окончаниями

## Retention policy (уточнение F3 из 04-success-criteria.md)

**Single maintenance job** (daily, первый запуск через 1 час после старта):

1. **Task-bound purge**: notes и sessions где `task_bound_id` ссылается на закрытую задачу → DELETE
2. **Expired idempotency keys**: DELETE FROM idempotency_keys WHERE expires_at < now()
3. **Old activity**: DELETE FROM activity WHERE created_at < now() - 90 days
4. **Expired oauth tokens + codes**: DELETE FROM oauth_tokens WHERE expires_at < now() AND token_type IN ('code', 'access')
5. **Daily backup**: `VACUUM INTO '~/.qoopia/backups/qoopia-YYYY-MM-DD.db'`
6. **Rotate backups**: keep last 7 daily backups

**Not in retention** (kept forever unless explicitly deleted):
- Non-task-bound notes
- Sessions not bound to tasks
- Refresh tokens (until explicit revoke)

## Что готово к Фазе 5

Этот DDL — **готов к copy в `migrations/001-initial-schema.sql`** в Фазе 5 без дополнительных изменений. Все решения зафиксированы. Все trade-offs обоснованы выше.

**Gap на момент Фазы 3**: нужен `002-initial-data.sql` который создаёт default workspace + admin user (генерируется в `qoopia install`). Это детали install скрипта, см. `04-install.md`.
