# 02 — TO-BE: MCP tools specification

**Базис**: `10-as-is/02-mcp-tools.md` + ADR-008 (MCP SDK) + Phase 1 principles

**Всего tools**: **13** (бюджет H8 ≤15)
**Профили**: `memory` (5 tools — recall/brief/session_*), `full` (13 — все)

Каждый tool описан: назначение, JSON schema входа, shape ответа, error paths, connection к use cases.

## Tool registration pattern (Bun + MCP SDK)

```typescript
// src/mcp/tools.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { notesService } from "../services/notes.js";
import { sessionsService } from "../services/sessions.js";
// ...

export function registerTools(server: McpServer, authContext: AuthContext) {
  server.tool("note_create", /* description */, /* input schema */, async (args) => {
    // handler implementation
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  // ... 12 more
}
```

MCP SDK берёт на себя: JSON-RPC, tools/list, session management, notifications. Мы только регистрируем handlers.

---

## Group A: Memory primary (2 tools)

### T1. `recall`

**Назначение**: FTS5 full-text поиск по notes + activity. Основной retrieval tool. **Не** возвращает результаты с truncation (fix bug из V2 `memory.ts:218`).

**Покрывает UC**: UC-1 (старт с контекстом), UC-3 (точечный retrieval по KB), UC-6 (Claude cross-workspace read)

**Input schema** (zod):
```typescript
{
  query: z.string().min(1).max(1000).describe("Full-text search query. Keywords, not a sentence. Use multiple terms to narrow."),
  limit: z.number().int().min(1).max(50).optional().default(10).describe("Max results (1-50)"),
  scope: z.enum(["notes", "activity", "all"]).optional().default("notes").describe("What to search: notes only, activity only, or both"),
  type: z.enum(["note", "task", "deal", "contact", "finance", "project", "memory", "rule", "knowledge", "context"]).optional().describe("Filter by note type"),
  project_id: z.string().optional().describe("Filter to a specific project (by ULID)"),
  cross_workspace: z.boolean().optional().default(false).describe("Search across all workspaces. Only honored for privileged agents (Claude).")
}
```

**Response shape**:
```json
{
  "results": [
    {
      "id": "01HR...",
      "type": "note|task|deal|contact|finance|project|activity",
      "text": "full text, NOT truncated",
      "metadata": { /* type-specific */ },
      "project_id": "01HR..." ,
      "created_at": "2026-04-10T14:30:00Z",
      "workspace_id": "01HR...",
      "rank": -2.5
    }
  ],
  "total_found": 12,
  "query": "original query",
  "sanitized_query": "prefix-matched FTS5 expression",
  "cost": {
    "tokens_returned": 450,
    "tokens_full_scan_estimate": 15000,
    "savings_ratio": 0.97
  }
}
```

**Key changes vs V2**:
- **NO truncation** — поле `text` всегда целое
- **NO semantic** — FTS5 only (ADR-002)
- **Cost metric** в response (критерий C1)
- **Cross-workspace** только для privileged agents (ADR-002 Claude exception)
- Один tool заменяет V2 `recall` + `search`

**Error paths**:
- Empty query → `{isError: true, content: "Query is required"}`
- Query > 1000 chars → truncated silently with warning
- Cross-workspace requested by non-privileged → ignored, scoped to agent's workspace

---

### T2. `brief`

**Назначение**: Snapshot текущего состояния workspace или проекта. Использует агент **на старте сессии** для быстрого восстановления контекста.

**Покрывает UC**: UC-1 (старт с контекстом)

**Input schema**:
```typescript
{
  project: z.string().optional().describe("Project ID (ULID) or exact project name"),
  agent: z.string().optional().describe("Filter tasks/notes to specific agent by name"),
  limit_per_section: z.number().int().min(1).max(50).optional().default(10).describe("Max items per section")
}
```

**Response shape**:
```json
{
  "workspace_id": "01HR...",
  "project": "Qoopia V3" /* or null */,
  "open_tasks": {
    "total": 14,
    "overdue": 2,
    "items": [
      {"id": "...", "text": "Design TO-BE schema", "metadata": {"status": "in_progress", "due_date": "2026-04-15"}}
    ]
  },
  "recent_notes": {
    "total": 8,
    "items": [
      {"id": "...", "text": "Decided to defer Layer B...", "agent": "claude", "created_at": "..."}
    ]
  },
  "active_deals": {
    "total": 3,
    "items": [...]
  },
  "agent_activity": {
    "claude": {"last_active": "2026-04-11T16:00:00Z", "notes_today": 23},
    "alan": {"last_active": "2026-04-10T09:00:00Z", "notes_today": 0}
  },
  "cost": { "tokens_returned": 850 }
}
```

**Key changes vs V2**:
- **NO stale detection** (03-core-services.md) — dropped heuristic
- **NO auto-magic warnings**
- Preview snippets `SUBSTR(text, 1, 500)` для readability — **not hard truncation**, documented in output with `text_preview_only: true` flag where applicable
- Unified: all entities from `notes` table with type filter

---

## Group B: Notes CRUD (5 tools)

### T3. `note_create`

**Назначение**: Создать запись в универсальной таблице `notes`. Заменяет V2 `note` (но БЕЗ auto-magic) и V2 `create(entity=X)`.

**Покрывает UC**: все (primary write path)

**Input schema**:
```typescript
{
  text: z.string().min(1).max(100_000).describe("Main content. First line often used as title."),
  type: z.enum(["note", "task", "deal", "contact", "finance", "project", "memory", "rule", "knowledge", "context"]).optional().default("note"),
  metadata: z.record(z.unknown()).optional().describe("Type-specific structured data as JSON object"),
  project_id: z.string().optional().describe("Link to a project note (by ULID)"),
  task_bound_id: z.string().optional().describe("Bind this note to a task. Will be auto-purged when task is closed."),
  session_id: z.string().optional().describe("Link to a chat session (for traceability)"),
  tags: z.array(z.string()).optional().describe("Tags for categorization"),
  agent_name: z.string().optional().describe("Override agent display name (default: authed agent)")
}
```

**Response**:
```json
{
  "created": true,
  "id": "01HR...",
  "type": "task",
  "workspace_id": "01HR...",
  "created_at": "2026-04-11T17:00:00Z"
}
```

**Key changes vs V2**:
- **NO LLM entity matching** (removed `matchFromNote`)
- **NO auto-status detection** (removed `detectAndApplyStatusChanges`)
- **NO Voyage embedding generation** (Layer B deferred)
- **NO automatic activity cascade** (only one `logActivity` call for the note itself)
- **Hard cap 100 KB** on text (NG-15)
- Просто `INSERT INTO notes (...) VALUES (...)` + `logActivity('created', 'note', id, ...)` + return

**Size**: ~30 LoC handler vs 107 в V2.

**Error paths**:
- Empty text → 400
- Invalid type → 400 (enum validation)
- text > 100KB → 400 with instruction to split
- project_id references non-existent → 404
- task_bound_id references non-task → 400

---

### T4. `note_get`

**Назначение**: Получить одну запись по ID.

**Input schema**:
```typescript
{
  id: z.string().min(26).max(26).describe("ULID of the note"),
  include_activity: z.boolean().optional().default(false).describe("Include activity log entries for this note")
}
```

**Response**:
```json
{
  "id": "01HR...",
  "type": "task",
  "text": "full text",
  "metadata": { ... },
  "project_id": "01HR...",
  "task_bound_id": null,
  "session_id": null,
  "tags": ["migration"],
  "agent_id": "01HR...",
  "source": "mcp",
  "created_at": "...",
  "updated_at": "...",
  "deleted_at": null,
  "activity": [ /* if include_activity */ ]
}
```

---

### T5. `note_list`

**Назначение**: List/filter notes. Заменяет V2 `list(entity=X, ...)`.

**Input schema**:
```typescript
{
  type: z.enum([...]).optional().describe("Filter by type"),
  project_id: z.string().optional(),
  agent: z.string().optional().describe("Filter by agent name"),
  status: z.string().optional().describe("Filter by metadata.status (e.g. 'todo', 'done', 'active')"),
  tags: z.array(z.string()).optional().describe("Must contain ALL these tags"),
  since: z.string().optional().describe("ISO 8601 timestamp — only notes created after this"),
  until: z.string().optional().describe("ISO 8601 timestamp — only notes created before this"),
  session_id: z.string().optional().describe("Filter to a specific session"),
  include_deleted: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(500).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
  order: z.enum(["created_desc", "created_asc", "updated_desc"]).optional().default("created_desc")
}
```

**Response**:
```json
{
  "items": [ /* note objects, without full text — text_preview up to 500 chars */ ],
  "total": 234,
  "limit": 50,
  "offset": 0,
  "has_more": true
}
```

**Implementation**:
- Builds WHERE clause dynamically with parameterized values
- Always includes `workspace_id = ?` and `deleted_at IS NULL` (unless include_deleted)
- Metadata filters use `json_extract(metadata, '$.key') = ?`

---

### T6. `note_update`

**Назначение**: Patch-style update (merge metadata).

**Input schema**:
```typescript
{
  id: z.string().min(26).max(26),
  text: z.string().max(100_000).optional().describe("Replace text completely"),
  metadata: z.record(z.unknown()).optional().describe("Merged with existing metadata (shallow)"),
  metadata_replace: z.record(z.unknown()).optional().describe("Replace metadata completely (mutually exclusive with metadata)"),
  project_id: z.string().nullable().optional(),
  tags: z.array(z.string()).optional().describe("Replaces existing tags")
}
```

**Response**:
```json
{
  "updated": true,
  "id": "01HR...",
  "fields_updated": ["text", "metadata.status"],
  "updated_at": "2026-04-11T17:05:00Z"
}
```

**Key behavior**:
- **Metadata merge is shallow** by default. `{status: 'done'}` merges with existing metadata, keeping other fields.
- `metadata_replace` — если агент хочет полностью заменить (редко)
- UPDATE ... SET updated_at = now()
- logActivity('updated', 'note', id, ...)

---

### T7. `note_delete`

**Назначение**: Soft delete (sets `deleted_at`). Hard delete только через admin CLI.

**Input schema**:
```typescript
{
  id: z.string().min(26).max(26)
}
```

**Response**:
```json
{ "deleted": true, "id": "01HR..." }
```

**Behavior**: `UPDATE notes SET deleted_at = now() WHERE id = ? AND workspace_id = ?`

---

## Group C: Session memory (5 tools) — NEW for UC-7

Эти tools — ключевая добавка V3.0. Реализуют LCM-equivalent session memory для агентов в Claude Code / Claude.ai / любой среде.

### T8. `session_save`

**Назначение**: Сохранить одно сообщение сессии. **Агент вызывает это на КАЖДОЕ сообщение** через инструкции в system prompt.

**Покрывает UC**: UC-2 (handoff между чатами), UC-5 (mid-session compaction), UC-7 (LCM absorption)

**Input schema**:
```typescript
{
  session_id: z.string().min(1).max(100).describe("Session identifier. Convention: 'YYYY-MM-DD' or ULID. Must be consistent within one conversation."),
  role: z.enum(["user", "assistant", "system", "tool"]).describe("Message role"),
  content: z.string().min(1).max(100_000).describe("Message content (text representation)"),
  metadata: z.record(z.unknown()).optional().describe("Optional: tool_call, tool_result, file_refs, etc."),
  token_count: z.number().int().positive().optional().describe("Optional: estimated token count")
}
```

**Response**:
```json
{
  "saved": true,
  "id": 12345,  // auto-increment integer for range queries
  "session_id": "2026-04-11",
  "seq": 42  // position within session
}
```

**Implementation**:
- `INSERT OR IGNORE INTO sessions (id, workspace_id, agent_id) VALUES (?, ?, ?)` — create session if new
- `UPDATE sessions SET last_active = now() WHERE id = ?`
- `INSERT INTO session_messages (workspace_id, session_id, agent_id, role, content, metadata, token_count) VALUES (...)`
- Return `lastInsertRowid` as `id`

**NOT** logged to activity (would flood activity log — session memory is separate).

**Hard cap 100 KB** on content (NG-15).

---

### T9. `session_recent`

**Назначение**: Получить последние N сообщений сессии. Агент вызывает **на старте новой сессии** для восстановления контекста.

**Покрывает UC**: UC-1 (старт с контекстом), UC-2 (handoff)

**Input schema**:
```typescript
{
  session_id: z.string().describe("Session to load. Use 'latest' to load most recent session of this agent."),
  limit: z.number().int().min(1).max(500).optional().default(50).describe("Number of recent messages (latest last)"),
  include_summaries: z.boolean().optional().default(true).describe("Include any summaries for this session")
}
```

**Response**:
```json
{
  "session_id": "2026-04-11",
  "session_created_at": "...",
  "session_last_active": "...",
  "messages": [
    {"id": 1, "role": "user", "content": "...", "created_at": "..."},
    {"id": 2, "role": "assistant", "content": "...", "created_at": "..."}
  ],
  "summaries": [
    {"id": "01HR...", "content": "Early in this session we...", "msg_start_id": 1, "msg_end_id": 20, "level": 1}
  ],
  "message_count": 50,
  "has_more_before": true,
  "cost": {"tokens_returned": 4200}
}
```

**Behavior**:
- Fetches latest `limit` messages ORDER BY id DESC, then reverses for chronological
- Also fetches all summaries for session
- If `session_id = 'latest'`: `SELECT id FROM sessions WHERE workspace_id = ? AND agent_id = ? ORDER BY last_active DESC LIMIT 1`

---

### T10. `session_search`

**Назначение**: FTS5 search по всем сохранённым сообщениям.

**Input schema**:
```typescript
{
  query: z.string().min(1).max(1000),
  session_id: z.string().optional().describe("Limit to specific session. Omit to search across sessions."),
  scope: z.enum(["own_agent", "workspace", "all"]).optional().default("own_agent").describe("Search scope (cross-workspace requires privilege)"),
  limit: z.number().int().min(1).max(100).optional().default(20),
  since: z.string().optional(),
  until: z.string().optional()
}
```

**Response**:
```json
{
  "results": [
    {
      "id": 12345,
      "session_id": "2026-04-11",
      "role": "user",
      "content": "full message, NOT truncated",
      "created_at": "...",
      "rank": -3.2
    }
  ],
  "total_found": 7,
  "query": "...",
  "cost": {"tokens_returned": 1200}
}
```

---

### T11. `session_summarize`

**Назначение**: Сохранить agent-written саммари range сообщений. Агент **сам пишет текст** саммари и передаёт — Qoopia ничего не генерирует (NG-13).

**Покрывает UC**: UC-5 (mid-session compaction)

**Input schema**:
```typescript
{
  session_id: z.string(),
  content: z.string().min(1).max(50_000).describe("Your summary text. Include key decisions, facts, action items."),
  msg_start_id: z.number().int().positive().describe("First message ID in range"),
  msg_end_id: z.number().int().positive().describe("Last message ID in range"),
  level: z.number().int().min(1).max(10).optional().default(1).describe("1 = summary of raw messages, 2 = summary of summaries, etc."),
  token_count: z.number().int().positive().optional()
}
```

**Response**:
```json
{
  "saved": true,
  "summary_id": "01HR...",
  "range": "12345-12387",
  "level": 1
}
```

**Validation**:
- `msg_start_id <= msg_end_id`
- Range not empty
- Level within 1-10

---

### T12. `session_expand`

**Назначение**: Развернуть саммари обратно в исходные сообщения. Используется когда агент хочет увидеть детали за саммари.

**Input schema**:
```typescript
{
  start_id: z.number().int().positive().describe("First message id (inclusive)"),
  end_id: z.number().int().positive().describe("Last message id (inclusive)"),
  session_id: z.string().optional().describe("Optional additional session filter")
}
```

**Response**:
```json
{
  "messages": [ /* session_messages in chronological order */ ],
  "count": 43,
  "cost": {"tokens_returned": 8700}
}
```

**Behavior**: `SELECT ... FROM session_messages WHERE id BETWEEN ? AND ? AND workspace_id = ? ORDER BY id ASC`

---

## Group D: Activity (1 tool)

### T13. `activity_list`

**Назначение**: Просмотр audit log. Чаще всего используется для `brief()` и отладки.

**Input schema**:
```typescript
{
  entity_type: z.string().optional().describe("Filter by entity type (note, session, agent, etc.)"),
  entity_id: z.string().optional().describe("Filter by entity id"),
  project_id: z.string().optional(),
  agent: z.string().optional(),
  action: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional().default(50)
}
```

**Response**:
```json
{
  "items": [
    {
      "id": "01HR...",
      "action": "created",
      "entity_type": "note",
      "entity_id": "01HR...",
      "agent": "claude",
      "summary": "Created task 'Design TO-BE schema'",
      "created_at": "..."
    }
  ],
  "total": 2191,
  "limit": 50
}
```

---

## Tool profiles

| Profile | Tools | Intended users |
|---|---|---|
| `memory` | recall, brief, session_save, session_recent, session_search | Read-heavy agents, session-focused workflows |
| `full` | all 13 | Default for agents with write access to their workspace |

Profile передаётся клиентом при `initialize` MCP call (`clientInfo.name: 'profile:memory'` или `_meta.toolProfile`). Server responding через `tools/list` фильтрует доступные.

---

## Error codes (shared across tools)

| Code | Meaning |
|---|---|
| `INVALID_INPUT` | zod validation failed |
| `NOT_FOUND` | Entity with given id doesn't exist |
| `FORBIDDEN` | Cross-workspace access denied |
| `CONFLICT` | Idempotency collision or concurrent update |
| `SIZE_LIMIT` | Content exceeds 100KB |
| `INTERNAL` | Unexpected server error |

Все ответы в формате:
```json
{"isError": true, "content": [{"type": "text", "text": "INVALID_INPUT: text must be between 1 and 100000 chars"}]}
```

---

## LoC estimate

| Component | LoC |
|---|---|
| Tool registration in `src/mcp/tools.ts` | ~80 |
| 13 handlers (avg ~35 LoC each) | ~450 |
| Shared helpers (workspace scope, zod schemas, error handling) | ~120 |
| **Total MCP tools layer** | **~650** |

Vs V2: ~2000 LoC in MCP tools (8 tools + 6 entity handlers + intelligence calls).
**Сокращение**: −67%.

---

## Что готово к Фазе 5

Все 13 tools имеют **готовые JSON schemas** которые copy-paste в код. Behavior полностью определён. Error paths перечислены. Это действительно blueprint а не набросок.

**Gap**: query sanitizer для FTS5 (детали реализации в `src/services/recall.ts`, ~30 LoC). Будет написан в Фазе 5.
