# 02 — AS-IS: MCP tools surface

**Источник**: `~/.openclaw/qoopia/src/api/handlers/mcp/`
**Всего MCP tools в V2**: **8** (после consolidation в Pass 4, было 29)
**Tool profiles**: memory (3 tools) / crm (8 tools) / full (все)

## MCP server framework

### Transport

**File**: `~/.openclaw/qoopia/src/api/handlers/mcp/index.ts` (252 LoC)

V2 использует **MCP Streamable HTTP** — не stdio, не SSE-only, а двойной режим:
- `POST /mcp` — JSON-RPC requests
- `GET /mcp` with `Accept: text/event-stream` — SSE keep-alive stream для server-initiated notifications
- Session via `Mcp-Session-Id` header (MCP spec)

**Protocol version**: `2025-03-26`.

**Оценка**: это **правильный и современный** подход. Streamable HTTP — рекомендованный MCP transport для сервер-сайд МCP. Bun/Node оба поддерживают.

**Решение для V3.0**: **KEEP pattern**, можно упростить реализацию. 252 LoC — много для transport layer; peer lcm-mcp делает всё в ~100 LoC через `@modelcontextprotocol/sdk`. В V3.0 используем SDK напрямую вместо кастомной реализации JSON-RPC parsing, server info, tools/list, notifications handling.

**Экономия**: ~150 LoC из этого файла + исчезает кастомный JSON-RPC fallback.

### Tool registry

**File**: `src/api/handlers/mcp/registry.ts` (54 LoC)

Содержит:
- `TOOLS` — flat array всех tool definitions (из всех модулей)
- `TOOL_PROFILES` — `memory` (note/recall/brief), `crm` (+ CRUD), `full` (все)
- `TOOL_PERMISSIONS` — статическая map для memory tools
- `resolveToolPermission()` — динамика для CRUD tools через entity
- `handleToolCall()` — dispatch к первому модулю который отвечает

**Решение V3.0**: **SIMPLIFY**.

- `TOOL_PROFILES` — KEEP концепция (полезно разделить agent на "memory-only" и "full access"), но упростить до 2 профилей: `minimal` (session + recall) и `full` (+ notes CRUD + entities). Trimming.
- `TOOL_PERMISSIONS` / `resolveToolPermission` — DROP. В V3.0 permission model = «агент может всё в своём workspace, не может ничего в чужом». Один WHERE workspace_id = agent_workspace. Не нужно per-tool ACL.
- `handleToolCall` — KEEP, упростить

**Экономия**: 54 → ~20 LoC.

### Tool call handler

**File**: `src/api/handlers/mcp/index.ts:57-147` (`mcpPostHandler`, ~90 LoC)

Делает: auth check, session ID, JSON-RPC parse, method dispatch (initialize / tools/list / tools/call / notifications), profile enforcement, permission check, tool dispatch.

**Решение V3.0**: **SIMPLIFY через MCP SDK**. Заменить кастомную реализацию на `McpServer` + `SSEServerTransport` или `StreamableHttpServerTransport`. Handler становится ~20 LoC как у Нияза.

## Tool-by-tool audit

Ниже — все 8 MCP tools с решениями.

### T1. `note` — **SIMPLIFY DRASTICALLY (split into 2-3 tools)**

**File**: `src/api/handlers/mcp/tools/memory.ts:10-169` (~107 LoC handler + 42 LoC definition)

**Сейчас делает** (12 операций в одном вызове):
1. Парсинг args (text, agent_name, session_id, entities_hint, project, type)
2. Проверка text не пустой
3. Resolve project (by ULID or by name lookup)
4. `matchFromNote(text)` — **Haiku LLM call** для entity matching
5. Merge с hint entities через `matchEntities()` (keyword fallback)
6. `detectAndApplyStatusChanges(text, ...)` — парсит regex patterns для status updates (done/cancelled/in_progress), применяет UPDATE на matched entities, возвращает applied + suggested
7. Для каждого applied auto-update — отдельный `logActivity()`
8. INSERT в notes с ULID id
9. `logActivity()` для самой заметки (action='noted')
10. **Background** `storeEmbedding()` через Voyage API (fire-and-forget)
11. Query open tasks в том же project
12. Return с `{note_id, matched, suggested, remaining, capabilities, message}`

**Проблемы**:
- Один tool call = **два внешних API вызова** (Haiku + Voyage)
- Latency непредсказуема
- Ошибка в любом из шагов — partial state (e.g., note сохранена, embedding не записан, status update применён но activity не залогирована)
- Agent не контролирует что именно произошло — magic
- 12 операций в одном месте = сложно отладить, невозможно простое unit-тестирование

**Решение V3.0**: разбить на **2-3 tools**:

1. **`note_create`** — **primary, простой**:
   - Args: `text`, `type`, `project_id?`, `agent_name?`, `session_id?`, `metadata?`, `task_bound_id?`, `tags?`
   - Делает: INSERT в notes + logActivity
   - Всё. Ноль LLM, ноль embedding, ноль auto-magic.
   - Size: ~30 LoC

2. **`note_suggest_links`** — **опциональный, агент явно зовёт**:
   - Args: `text`, `limit?`
   - Делает: FTS5 search по существующим notes, возвращает top-N потенциально связанных — агент сам решает добавить их как ссылки в metadata
   - Ноль LLM — чистый FTS5 match
   - Size: ~20 LoC
   - Это **замена** `matchFromNote()` — но вместо magic auto-matching при каждом note создании, агент вызывает только когда хочет
   
3. **`note_suggest_status`** — **опциональный, возможно вообще не делаем в V3.0**:
   - Args: `note_text`, `entity_ids[]`
   - Делает: STATUS_PATTERNS regex matching + возврат **suggestions only** (не применяет automatically)
   - Агент сам решает применять ли через `note_update`
   - Size: ~30 LoC
   - **Alternative**: просто **не делаем это в V3.0**. Агент сам знает что если написал «я закончил задачу X» — нужно позвать `note_update(id=X, status='done')`. Avoid magic.

**Решение на status suggestions**: отложить в V3.5 или не делать вообще. Склоняюсь к **не делать** — это classic over-engineering («угадай что имел в виду»). Агенты Claude/Alan/Aizek явно знают что они делают.

**Размер изменения**: 107 LoC → ~30 LoC (`note_create`) + 20 LoC (`note_suggest_links`) = **50 LoC total** вместо 107. И ноль зависимости от Haiku/Voyage.

### T2. `recall` — **SIMPLIFY (remove semantic + remove 300-char truncation)**

**File**: `src/api/handlers/mcp/tools/memory.ts:171-224` (~53 LoC)

**Сейчас делает**:
1. Parse args (query, limit, type filter, entities filter)
2. Calculate `fetchLimit` (extra results для компенсации post-filter)
3. Call `semanticSearch()` → в intelligence.ts → embedding search or FTS5 fallback
4. Apply entity type filter (tasks/deals/contacts/activity/note)
5. Apply note type filter (rule/memory/knowledge/context)
6. Slice to searchLimit
7. **Truncate `r.text` to 300 chars** (**THE BUG**)
8. Return `{results, method, message}`

**Проблемы**:
- **THE 300-char truncation bug** (line 218)
- Semantic search через Voyage — отложено в V3.5
- Entities filter смешан с type filter — усложняет агенту понимание что он получит
- Returns `method` поле — показывает какой путь retrieval использовался, в V3.0 всегда FTS5 — это поле убирается

**Решение V3.0**: **SIMPLIFY**:

```
recall(query, limit?, scope?)
- query: FTS5 query string (один source of truth, никаких post-filters)
- limit: max results, default 10, cap 50
- scope: "all" | "notes" | "tasks" | ... (фильтр по type, применяется в SQL не после)
- Returns: results[] без truncation, plus totals, plus cost metric
```

**Key changes**:
1. **Truncation DROPPED completely**. Возвращаем `text` целиком. Если результат большой — используй `limit=5` или `limit=3`.
2. **Semantic search DROPPED**. FTS5 only. Signaturе tool без параметра `method`.
3. **Filter в SQL**, не post-filter. `WHERE type IN (?, ?, ?)` быстрее и детерминированно.
4. **Cost metric**: возвращаем `tokens_saved: estimate` (сколько токенов сэкономил recall vs «грузить всё» — критерий C1 из 04-success-criteria.md)
5. Recall — **один общий tool для notes + entities + session_messages**. Не отдельные. Отдельно — `session_search()` для истории чатов (UC-7).

**Размер**: 53 → ~25 LoC.

### T3. `brief` — **SIMPLIFY (drop auto-magic, drop stale detection)**

**File**: `src/api/handlers/mcp/tools/memory.ts:226-337` (~111 LoC)

**Сейчас делает**: собирает снимок workspace — open tasks, deal list, recent notes, linked contacts, agent health, stale task warnings.

**Проблема**: `brief()` — это `SELECT` запросы которые агент мог бы сделать сам через `list()` + `recall()`. Это convenience tool, но сейчас он **слишком умный**:
- `detectStaleTasks()` — эвристика «задача open но свежие notes намекают что закрыта». Это тот же auto-magic что и в `note_create`.
- Агентский health — group by agent_name — полезно, но это operator info, не memory info.

**Решение V3.0**: **SIMPLIFY**:

```
brief(workspace?, project?)
- Returns: { 
    open_tasks_count, 
    open_tasks_summary[] (titles only, no metadata),
    recent_notes_count,
    recent_notes_summary[] (first 200 chars),
    recent_activity_count,
    agent_last_activity: {agent_name: last_timestamp}
  }
```

**Что убираем**:
- `detectStaleTasks` и stale_warning (эвристика, DROP)
- Deals отдельно — теперь entities все в notes, включаются в общий "recent_notes_summary"
- Contacts linked to project — агент может позвать `note_list({type: 'contact', project_id})` явно если нужно
- **300-char truncate на notes** — оставим SUBSTR(text, 1, 500) для readability, но **с чётким указанием в API docs** что это только для preview, и что `note_get(id)` вернёт целиком

**Размер**: 111 → ~40 LoC.

### T4-T8. CRUD tools: `list`, `get`, `create`, `update`, `delete` — **REPLACE with generic `note_*`**

**File**: `src/api/handlers/mcp/tools/crud.ts` (239 LoC) + 6 per-entity handlers в `tools/tasks.ts`, `deals.ts`, `contacts.ts`, `finances.ts`, `projects.ts`, `activity.ts`

**Сейчас**: `crud.ts` — роутер, принимает `entity` параметр и диспатчит к соответствующему handler'у. Per-entity handlers содержат реальную CRUD-логику (≈ 200-400 LoC каждый).

**Решение V3.0**: **REPLACE WITH UNIFIED `note_*` TOOLS**.

После объединения всех entities в таблицу `notes` (см. 01-schema Group B), CRUD становится единым набором tools:

| Старый tool | V3.0 replacement |
|---|---|
| `list(entity='tasks', filters...)` | `note_list(type='task', filters...)` |
| `list(entity='deals', ...)` | `note_list(type='deal', ...)` |
| `list(entity='contacts', ...)` | `note_list(type='contact', ...)` |
| `list(entity='finances', ...)` | `note_list(type='finance', ...)` |
| `list(entity='projects', ...)` | `note_list(type='project', ...)` |
| `list(entity='activity', ...)` | `activity_list(...)` (отдельный tool, activity — не note) |
| `get(entity='tasks', id)` | `note_get(id)` (type определяется из записи) |
| `create(entity='X', ...)` | `note_create(type='X', text, metadata, ...)` (см. T1) |
| `update(entity='X', id, ...)` | `note_update(id, text?, metadata?, ...)` |
| `delete(entity='X', id)` | `note_delete(id)` (soft delete, устанавливает deleted_at) |

**Экономия**: crud.ts 239 LoC + 6 per-entity handlers (≈ 1200-1500 LoC total) → **~200 LoC** одного общего модуля `notes-crud.ts`.

**MCP tools count**: было 5 consolidated (list/get/create/update/delete) + 3 memory (note/recall/brief) = **8**. Станет: **~11-13** — `note_create`/`note_get`/`note_update`/`note_delete`/`note_list`/`note_search`/`recall`/`brief` + `session_save`/`session_recent`/`session_search`/`session_summarize`/`session_expand`.

**Бюджет H8** (≤ 15 MCP tools): ✅ укладываемся.

## Что добавляется в V3.0 (из ADR-005)

### Session memory tools (UC-7)

Эти tools **появляются** в V3.0 и их не было в V2. Они реализуют LCM-equivalent для Claude Code.

1. **`session_save(agent, session_id, role, content, metadata?)`** — запись сообщения сессии. Используется агентом **каждое сообщение**.
2. **`session_recent(agent, session_id, limit?)`** — последние N сообщений сессии. Используется **на старте** новой сессии для восстановления контекста.
3. **`session_search(query, scope?, limit?)`** — FTS5 поиск по всем сохранённым сообщениям. Scope: `"own" | "workspace" | "all"`.
4. **`session_summarize(agent, session_id, content, range, level?)`** — агент передаёт **готовый текст саммари** (не Qoopia генерирует), Qoopia хранит в таблице `summaries` с linking на `msg_start_id`-`msg_end_id`.
5. **`session_expand(start_id, end_id)`** — развернуть саммари обратно в исходные сообщения.

**Размер**: ~150 LoC total для всех 5 tools (сравни с lcm-mcp у Нияза где эти функции 200 LoC).

## Сводка: V2 MCP surface → V3.0

| Категория | V2 | V3.0 |
|---|---|---|
| Memory (`note`, `recall`, `brief`) | 3 tools, ~270 LoC | 3 упрощённых tools, ~95 LoC |
| Memory extras (optional) | — | `note_suggest_links` ~20 LoC |
| CRUD (consolidated) | 5 tools dispatching to 6 entity handlers, ~1500 LoC | 5 generic `note_*` tools, ~200 LoC |
| Session memory | — | 5 new `session_*` tools, ~150 LoC |
| **Tool count** | **8** | **~13** |
| **Implementation LoC** | **~2000** | **~500** |

**Размер сокращения**: 2000 → 500 LoC = **−75%**.

## MCP server framework сокращение

| Файл | V2 LoC | V3.0 LoC |
|---|---|---|
| `mcp/index.ts` (server + transport) | 252 | ~80 (через MCP SDK) |
| `mcp/registry.ts` | 54 | ~20 |
| `mcp/utils.ts` | 102 | ~40 (drop matchEntities, autoUpdateStatuses) |

**Всего framework**: 408 → ~140 LoC.

**Tool implementations**: ~2000 → ~500 LoC.

**Итого MCP layer**: ~2400 → ~640 LoC. **−73%**.

## Permission model в V3.0

**V2 complexity**: `TOOL_PERMISSIONS` map + dynamic `resolveToolPermission` + `checkMcpToolPermission` которая читает `agents.permissions JSON` и матчит rules против `[entity, action]` пары.

**V3.0 rule**: **агент имеет полный доступ в свой home workspace + read-only на knowledge_base + Claude имеет глобальный read privilege**.

Реализация: middleware auth читает `oauth_tokens` → находит `agent_id` + `workspace_id` → каждый SQL запрос автоматически добавляет `WHERE workspace_id = ?` через query helper. **Одна функция** `ensureWorkspaceScope(sql, workspaceId)`. **Нет** per-tool ACL.

**Экономия**: ~50 LoC из permissions, ~30 LoC из JSON parsing rules, упрощение debug ("почему tool не вызывается").

## Ключевые решения этого документа

| # | Решение | Экономия | Риск |
|---|---|---|---|
| 1 | MCP SDK вместо кастомного JSON-RPC | ~150 LoC | minor — SDK version drift |
| 2 | Unified `note_*` CRUD вместо per-entity handlers | ~1300 LoC | minor — JSON metadata чуть менее типизирован |
| 3 | Drop `matchFromNote` / auto-status-magic | ~200 LoC | агент теряет «автоматику», но она всё равно была unreliable |
| 4 | Drop 300-char truncation (THE BUG FIX) | −1 LoC | zero риск, огромная ценность |
| 5 | Drop semantic search в retrieval tools | ~100 LoC | отложено в V3.5 по ADR-002 |
| 6 | Simple permission model (workspace_id scope only) | ~80 LoC | minor — per-tool ACL ушёл, но никто им не пользуется |
| 7 | Add session_* tools для UC-7 | +150 LoC | это **добавление**, но даёт ключевую ценность |

**Чистая экономия** в MCP layer: ~1750 LoC.
