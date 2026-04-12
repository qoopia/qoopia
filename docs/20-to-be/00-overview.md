# 00 — TO-BE: архитектура Qoopia V3.0 overview

**Дата**: 2026-04-11
**Базис**: Phase 1 + Phase 1.5 + Phase 2 AS-IS + ADR-007/008/009

## Stack

| Слой | Выбор | Обоснование |
|---|---|---|
| Runtime | **Bun 1.x** | ADR-007 |
| Language | TypeScript (strict) | Ecosystem, zod validation |
| HTTP server | **`Bun.serve()`** (built-in) | No Hono needed for our scale |
| DB | **`bun:sqlite`** (built-in) | No `better-sqlite3` needed |
| FTS | **SQLite FTS5** | Built into SQLite, zero deps |
| MCP framework | **`@modelcontextprotocol/sdk`** | ADR-008 |
| Transport | **Streamable HTTP** | Claude.ai connector compatible |
| Auth | **Opaque tokens** + SHA256 API keys | ADR-009 |
| Validation | **zod** | Industry standard, small |
| IDs | **ulid** | Sortable, time-encoded |
| Logger | **`console` wrapped** (no pino) | Minimize deps to ≤5 |

**Runtime dependencies** (`package.json`):
```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0",
    "ulid": "^2.3.0"
  }
}
```

**Total: 3 runtime deps**. Бюджет H2 (≤5) с запасом.

## Архитектурные слои

```
┌──────────────────────────────────────────────────┐
│ MCP клиенты                                       │
│ Claude Code | Claude.ai | OpenClaw | custom       │
└──────────────────┬───────────────────────────────┘
                   │ Streamable HTTP
                   │ Authorization: Bearer <opaque-token>
┌──────────────────▼───────────────────────────────┐
│ Transport Layer (~80 LoC)                         │
│ Bun.serve + McpServer + StreamableHTTPTransport   │
└──────────────────┬───────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────┐
│ Auth Middleware (~40 LoC)                         │
│ SHA256(token) → agents OR oauth_tokens            │
│ → sets auth.{agent_id, workspace_id, type}        │
└──────────────────┬───────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────┐
│ MCP Tool Registry (~80 LoC)                       │
│ 13 tools total:                                   │
│ - note_create, note_get, note_list,               │
│   note_update, note_delete, note_search           │
│ - recall (generic FTS5 across notes+activity)     │
│ - brief (workspace snapshot)                      │
│ - session_save, session_recent, session_search,   │
│   session_summarize, session_expand               │
│ - activity_list (read activity log)               │
└──────────────────┬───────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────┐
│ Services Layer (~250 LoC)                         │
│ - notes service (CRUD with metadata merge)        │
│ - sessions service (session_* operations)         │
│ - recall service (FTS5 queries + cost metric)     │
│ - activity logger                                 │
│ - retention (daily maintenance)                   │
└──────────────────┬───────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────┐
│ Data Layer (~150 LoC)                             │
│ - connection.ts (bun:sqlite + PRAGMAs)            │
│ - migrations runner (read migrations/*.sql)       │
│ - workspace scoping helper (enforce WHERE)        │
└──────────────────┬───────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────┐
│ SQLite Database                                   │
│ ~/.qoopia/data/qoopia.db                          │
│ 10 real tables + 10 FTS5 shadow tables            │
└───────────────────────────────────────────────────┘
```

## LoC budget распределение

| Слой | LoC оценка | В бюджете H1 (≤2000)? |
|---|---|---|
| Transport + bootstrap (`index.ts`, `server.ts`) | ~100 | ✓ |
| Auth (OAuth handlers + middleware) | ~225 | ✓ |
| MCP tools (13 tools, registration + handlers) | ~650 | ✓ |
| Services (notes, sessions, recall, retention) | ~300 | ✓ |
| Data layer (connection, migrations, helpers) | ~150 | ✓ |
| Admin (create/rotate/delete agents) | ~80 | ✓ |
| Misc utils (logger, errors, validators) | ~100 | ✓ |
| `qoopia install` CLI | ~120 | ✓ |
| **Total** | **~1725** | ✓ (275 LoC запас) |

## Schema overview

**10 real tables** (детали в 01-schema.md):

| Таблица | Назначение |
|---|---|
| `workspaces` | Tenant boundary |
| `users` | Humans (1 per workspace typically) |
| `agents` | API key registry |
| `notes` | **Universal entity table** (type ∈ {note, task, deal, contact, finance, project}) + metadata JSON |
| `activity` | Audit log (без archive) |
| `sessions` | Chat session registry |
| `session_messages` | Raw messages of chat sessions |
| `summaries` | Agent-written summaries, linked to message ranges |
| `oauth_clients` | OAuth client registry |
| `oauth_tokens` | Opaque access + refresh tokens |

**FTS5 indexes**:
- `notes_fts` — на `notes.text`
- `session_messages_fts` — на `session_messages.content`

**Системные таблицы**:
- `idempotency_keys`
- `schema_versions`

**Всего**: 10 real + 10 FTS5 shadow + 2 system = **~22 таблицы** в sqlite_master vs 45 в V2.

## MCP tools overview

**13 tools** (бюджет H8 ≤15):

### Memory primary (2)
- `recall(query, limit?, scope?)` — FTS5 search across notes + activity
- `brief(project?, agent?)` — workspace snapshot

### Notes CRUD (5)
- `note_create(text, type, metadata?, project_id?, task_bound_id?, session_id?)`
- `note_get(id)`
- `note_list(type?, filters?, limit?)`
- `note_update(id, text?, metadata?)`
- `note_delete(id)`

### Session memory (5) — NEW, UC-7 LCM absorption
- `session_save(session_id, role, content, metadata?)`
- `session_recent(session_id, limit?)`
- `session_search(query, scope?, limit?)`
- `session_summarize(session_id, content, range, level?)`
- `session_expand(start_id, end_id)`

### Activity (1)
- `activity_list(entity_type?, project_id?, limit?)`

## Auth model

**Два параллельных пути**, один code-path в middleware:

1. **Agent API key**:
   - Агент держит random 32-byte base64 string
   - Middleware SHA256 → lookup в `agents.api_key_hash`
   - Used by: CLI клиенты, Claude Code с direct MCP config, custom agents

2. **OAuth opaque token**:
   - Claude.ai делает PKCE code flow → получает opaque access + refresh
   - Middleware SHA256 → lookup в `oauth_tokens.token_hash`
   - Check `expires_at` + `revoked`
   - Used by: Claude.ai connector

**Workspace scoping**: после auth установлен `auth.workspace_id`, все SQL запросы через helper `ensureWorkspaceScope(query, workspaceId)` добавляют `WHERE workspace_id = ?`. Cross-workspace read **только** если `auth.type === 'claude-privileged'` (см. ADR-002 Claude exception).

## Deployment overview

```
~/.qoopia/
├── data/
│   └── qoopia.db          # SQLite DB
├── logs/
│   ├── qoopia.stdout
│   └── qoopia.stderr
└── backups/
    ├── qoopia-2026-04-11.db
    └── ...                # 7 last daily backups

~/Library/LaunchAgents/
└── com.qoopia.mcp.plist   # launchd service, auto-start
```

**`qoopia install`** (one command):
1. `mkdir -p ~/.qoopia/{data,logs,backups}`
2. Run initial migration (create 10 tables + FTS5 + triggers)
3. Create default workspace "default"
4. Create admin agent with generated API key
5. Render launchd plist from template, write to `~/Library/LaunchAgents/`
6. `launchctl load` plist → server starts on port 3737
7. Print:
   ```
   ✓ Qoopia installed
   MCP URL: http://localhost:3737/mcp
   Admin API key: <key>
   Add to your MCP client config:
   {
     "qoopia": {
       "type": "streamable-http",
       "url": "http://localhost:3737/mcp",
       "headers": {
         "Authorization": "Bearer <key>"
       }
     }
   }
   ```

**Env vars** (все опциональные, с дефолтами):
- `QOOPIA_PORT` (default 3737)
- `QOOPIA_DATA_DIR` (default `~/.qoopia/data`)
- `QOOPIA_LOG_LEVEL` (default `info`)
- `QOOPIA_PUBLIC_URL` (default `http://localhost:$PORT`)

**Zero required config files**. Всё работает из коробки.

## Как V3.0 удовлетворяет принципам Фазы 1

### 01-why.md (token economy, engine-driven)
- ✅ Agent-driven ingestion через system prompt (ADR-003)
- ✅ FTS5 retrieval без semantic overhead (ADR-002)
- ✅ Agent-written summaries (NG-13)

### 02-personas.md (workspace isolation)
- ✅ `workspace_id` на каждой user-facing таблице
- ✅ Auth middleware scope enforcement
- ✅ Claude cross-workspace read privilege через `agent.type='claude'` flag

### 03-use-cases.md
- UC-1 старт с контекстом: `session_recent()` + `recall()`
- UC-2 handoff между чатами: `session_save()` каждое сообщение + `session_recent()` при восстановлении
- UC-3 точечный retrieval: `recall()` FTS5 (keyword only в V3.0)
- UC-4 task-bound: `notes.task_bound_id` + retention auto-purge
- UC-5 mid-session compaction: `session_summarize()` agent-written
- UC-6 cross-workspace для Claude: middleware bypass для Claude privilege
- UC-7 LCM absorption: все 5 `session_*` tools

### 04-success-criteria.md
- Group A reliability: atomic INSERTs, daily backup, migration rollback
- Group B latency: FTS5 sub-100ms достижимо на 1 GB
- Group C token economy: `recall()` без truncation (fix из V2 bug), cost metric в response
- Group D deployment: `qoopia install` ≤ 2 команды, ≤ 2 минуты, 0 конфигов
- Group E retrieval quality: FTS5 Recall@5 ≥ 85% на golden set (Фаза 2 создаёт)
- Group F isolation: workspace_id scope enforcement
- Group G UX: 13 tools, понятные имена, разумные defaults
- Group H simplicity: все budgets достижимы по дизайну (см. LoC table выше)

### 05-non-goals.md
- NG-13 no auto-summarize: ✅ `session_summarize` accepts agent text
- NG-14 no semantic: ✅ FTS5 only, нет embedding tables
- NG-15 no large files: ✅ 100 KB hard cap в `note_create`/`session_save`
- NG-1 to NG-12: покрыто (no CRM dashboard, no BI, no message bus, etc.)

## Что дальше

Следующие документы Фазы 3:
- `01-schema.md` — полная DDL: CREATE TABLE, indexes, FTS5 triggers
- `02-mcp-tools.md` — JSON schemas и behavior для каждого из 13 tools
- `03-system-prompt.md` — template ≤30 строк для агентов
- `04-install.md` — `qoopia install` CLI + launchd plist template

После всех 4 + 3 ADR (007/008/009) закрываем Фазу 3 через ADR-010.
