# 00 — AS-IS overview прод-Qoopia

**Дата**: 2026-04-11
**Версия**: Qoopia V2, зафиксирована по состоянию на 2026-04-11
**Путь**: `~/.openclaw/qoopia/`

## Stack

| Компонент | Значение |
|---|---|
| Runtime | **Node.js** (через `tsx` в dev, `node dist/index.js` в prod) |
| HTTP framework | **Hono** (`@hono/node-server` 1.14.1, `hono` 4.7.5) |
| DB driver | **better-sqlite3** 11.10.0 (sync, fast) |
| DB | **SQLite** с FTS5 |
| JWT / auth | **jose** 6.2.2 |
| Logger | **pino** 9.6.0 |
| IDs | **ulid** 2.3.0 |
| Validation | **zod** 3.24.2 |
| Test runner | **vitest** 3.0.9 |
| Build | `tsc` → `dist/` |

**Ключевое**: runtime — Node, не Bun. Это значит что в V3.0 переход на Bun (для соответствия baseline Нияза) — это отдельное решение с миграционной стоимостью, а не «просто используем Bun».

**Deps total** в core: **8 runtime packages** + 7 dev. Qoopia V2 уже сейчас укладывается в бюджет H2 (≤ 5 runtime deps после упрощения — возможно, потому что `jose` / `pino` / `hono` можно пересмотреть, но это не критично).

**Важно**: embedding-слой в V2 уже реализован через **Voyage API прямыми HTTP-вызовами**, без SDK. То есть в `package.json` его не видно, но он живёт в `src/core/intelligence.ts`. Выводы раньше о «нет embeddings в V2» — были неверны.

## Размер кодовой базы

| Метрика | V2 |
|---|---|
| Всего TS-файлов в `src/` | **56** |
| Всего LoC (без node_modules, без dist) | **~9379** |
| Самый большой файл | `src/core/intelligence.ts` — **657 строк** |
| Второй по размеру | `src/api/handlers/mcp/tools/memory.ts` — 342 строки |
| Третий | `src/api/handlers/mcp/tools/crud.ts` — 239 строк |
| Core services total | intelligence 657 + keywords 23 + retention 103 + activity-log 60 + event-bus 71 + webhooks 181 = **1095 LoC** |

**Бюджет V3.0 H1**: ≤ 2000 LoC core. Текущий V2 уже **4.7× больше** только в core+memory+crud. Но большая часть этого объёма — `intelligence.ts` (semantic search + entity matching + auto-status-detection), которую мы в V3.0 **радикально упрощаем** (см. ниже).

## Состояние БД

| Метрика | Значение |
|---|---|
| Всего таблиц в sqlite_master | **45** |
| Из них real tables (не FTS shadow, не sqlite_sequence) | **20** |
| FTS5 shadow tables | **25** (5 FTS5 индексов × 5 служебных таблиц каждый — `_config`, `_data`, `_docsize`, `_idx`, `_content`) |
| Schema versions применено | **6** |
| Размер БД файла | проверяется отдельно, вероятно ~10-30 МБ (данных мало) |

**Реальные объёмы данных** (snapshot 2026-04-11):

| Таблица | Rows |
|---|---|
| activity | **2191** |
| notes | **200** |
| tasks | **133** |
| contacts | 44 |
| finances | 17 |
| deals | 7 |
| projects | 6 |
| agents | 6 |
| users | 1 |
| workspaces | 1 |

**Наблюдения**:
1. Только **1 workspace** и **1 user** — multi-tenant пока не используется в реальности, но колонка `workspace_id` везде есть. Это подтверждает: можно упростить V3.0 multi-tenant до «один workspace_id столбец + WHERE» без риска ломки существующих данных.
2. **200 notes и 133 tasks за всю историю V2** — объёмы крошечные. FTS5 на таких объёмах — зона комфорта, embeddings не оправданы.
3. **2191 activity** — это основной «вес», но activity — это history log, почти никогда не читается агентами через retrieval. Активно используется только `logActivity()` при каждой операции.
4. **166/200 notes имеют populated embedding** (Voyage Float32Array в BLOB). То есть embedding подсистема реально работает. Просто очень мало пользы извлекается.

## Ключевые находки (будут детализированы в следующих документах)

### Находка 1: **300-символьный truncation bug** — найден

Файл: `~/.openclaw/qoopia/src/api/handlers/mcp/tools/memory.ts:218`

```typescript
text: r.text ? String(r.text).substring(0, 300) : r.text
```

Это **та самая одна строка** которая ломает передачу контекста между чатами Claude уже несколько недель. `recall()` обрезает каждый результат до 300 символов перед возвратом агенту. Агент получает огрызок, не может собрать полную заметку, ломается handoff между сессиями.

**Тег**: **DROP** (не несём в V3.0). В V3.0 возврат идёт целиком, пагинация — отдельно.

### Находка 2: `note` tool делает слишком много

Файл: `memory.ts:62-169` (≈ 107 строк на **один** tool handler)

Операции которые выполняет `note()` за один вызов:
1. Парсинг args
2. Резолвинг project по имени или ULID
3. **LLM-based entity matching** (`matchFromNote` → Haiku API через `intelligence.ts`)
4. Merge с hint entities
5. **Auto-status detection** (`detectAndApplyStatusChanges`) — парсит текст заметки, смотрит на matched entities, вычисляет «перевод статуса» (todo→done / active→closed и т.д.) с confidence gating
6. Применение статус-апдейтов в БД
7. Логирование каждого auto-update как отдельная activity запись
8. INSERT самой заметки
9. logActivity для создания заметки
10. **Background Voyage embedding** (`storeEmbedding` fire-and-forget)
11. Подбор оставшихся open tasks в том же проекте
12. Построение detailed response с matched/suggested/remaining/capabilities/message

**Проблема**: единственный MCP tool вызов делает 12 операций с двумя внешними API (Haiku + Voyage). Latency непредсказуема, failure modes размазаны, отладка сложная.

**В V3.0 (после упрощения)**: `note_create` делает только: INSERT + activity log + return id. Всё остальное — **опциональные отдельные tools** (`note_match_entities`, `note_suggest_status_updates`), которые агент вызывает **только когда нужно**. Это соответствует Simplicity Pass decisions.

**Тег**: **SIMPLIFY** (разбить на части, убрать implicit magic).

### Находка 3: semantic search реально работает, но на малых объёмах

Файл: `~/.openclaw/qoopia/src/core/intelligence.ts:372-...` (`embeddingSearch` + `semanticSearch`)

Логика: Voyage embeddings → cosine similarity в памяти → ranked results. Fallback на FTS5 когда нет API key или Voyage лежит. **Graceful degradation** уже реализован.

**Проблема**: на 200 нотах и 166 embedded — это overengineering. Cosine similarity считается в Node, не в БД (нет sqlite-vec). Это **O(N)** на каждый запрос. При N=200 работает, при N=20000 уже нет.

**Тег**: **DROP** (Layer B отложен в V3.5, ADR-002). Если/когда понадобится — вернёмся с sqlite-vec или pgvector, не с in-memory cosine.

### Находка 4: FTS5 уже везде где нужно

FTS5 индексы существуют на: `notes`, `tasks`, `deals`, `contacts`, `activity`. Триггеры insert/update/delete синхронизируют. Это **уже готовая основа** для Layer A в V3.0 — не надо изобретать, надо **перенести и упростить** (одна общая таблица notes вместо 5).

**Тег**: **KEEP** структурно (FTS5 индекс на notes-like таблице), **SIMPLIFY** organizationally (один FTS5 индекс на одну универсальную таблицу).

### Находка 5: OAuth / magic links / JWT — полноценный auth слой

Файлы: `src/api/handlers/auth.ts`, `src/api/handlers/oauth.ts`, `src/api/middleware/auth.ts`, таблицы `oauth_clients`, `oauth_codes`, `oauth_tokens`, `magic_links`.

Это **полноценная реализация**: OAuth 2.0 authorization code flow с PKCE, refresh tokens, magic links для human login.

**Проблема для V3.0**: это всё для сценария «множество пользователей подключаются к одной Qoopia через Claude.ai connector». Реально используется? В текущем snapshot — **1 user и 6 agents** в базе. Скорее всего OAuth используется только Claude.ai как MCP connector.

**Тег**: **SIMPLIFY**. OAuth оставляем **только** в той минимальной форме которая нужна для Claude.ai MCP connector (issue token, validate token). Magic links — **DROP** (не нужны когда агент-driven).

### Находка 6: REST API сильно дублирует MCP

Файлы: `src/api/handlers/tasks.ts`, `deals.ts`, `contacts.ts`, `projects.ts`, `finances.ts`, `activity.ts`, `search.ts`, `export.ts`, `files.ts`, `agents.ts`, `events.ts`, `batch.ts`, `openapi.ts`.

Каждый из них — **REST endpoint** дублирующий functionality MCP tools. Плюс dashboard ходит в REST, не в MCP.

**Проблема**: двойной code-path. Изменение в одном месте требует sync в другом.

**Тег**: **DROP** для MCP-эквивалентных эндпоинтов (дублируют MCP), **KEEP** только для health, openapi, dashboard-specific и очень специфичных вещей (export, batch, reindex).

**Дополнительно**: в V3.0 (NG-5) dashboard для end-user отложен, operator UI — minimal. Значит большинство REST endpoints просто выкидываются.

### Находка 7: activity log — основной объём

`activity` таблица — 2191 строк. Логирование каждой операции через `core/activity-log.ts`. Используется в:
- `brief()` для показа недавней активности
- `recall()` как один из sources
- FTS5 индекс есть

**Тег**: **SIMPLIFY**. Activity log нужен для auditability, но:
- Retention должна быть (сейчас есть `activity_archive` как архив, но logic retention не проверен)
- В agentic use case большая часть activity — это автогенерация от самой Qoopia (auto-status updates, note creation events) — это **мета-шум**, не добавляет ценности
- В V3.0 упрощаем: **одна** `activity` таблица, без archive (LRU + retention), минимальный набор action-types, без FTS5 индекса (activity ищется редко и ограниченно)

### Находка 8: intelligence.ts — 657 строк смешанной магии

Файл: `src/core/intelligence.ts`

Содержит:
- `getCapabilities()` — есть ли Haiku и Voyage
- `matchFromNote()` — LLM entity matching через Haiku API
- `detectAndApplyStatusChanges()` — auto-update task/deal status на основе note content
- `detectStaleTasks()` — проверка что open task не противоречит recent notes
- `getEmbedding()` / `storeEmbedding()` — Voyage API
- `embeddingSearch()` / `semanticSearch()` — cosine similarity retrieval с FTS5 fallback
- `fetchWithRetry()` — HTTP retry wrapper

**Проблема**: это шесть разных подсистем в одном файле:
1. Capability detection
2. LLM entity matching
3. Auto-status heuristics
4. Embedding generation
5. Embedding search
6. HTTP retry

В V3.0 после Simplicity Pass:
- **Capability detection** — не нужно, capabilities статические (FTS5 есть всегда)
- **LLM entity matching** — выкидываем (tool `note_create` просто создаёт note, без magic)
- **Auto-status heuristics** — выкидываем или делаем **отдельным** опциональным tool (`note_suggest_status`)
- **Embedding generation** — выкидываем (Layer B отложен)
- **Embedding search** — выкидываем (Layer B)
- **HTTP retry** — не нужно (нет внешних API вызовов)

**Итого**: **657 → ~0 LoC** из этого файла в V3.0 core. Это один из крупнейших single-file упрощений.

**Тег**: **DROP** большая часть, `detectAndApplyStatusChanges` возможно **SIMPLIFY** до отдельного опционального tool.

## Куда двигаемся дальше

- `01-schema.md` — детальный аудит 20 таблиц с per-column решениями
- `02-mcp-tools.md` — 9 tools: что остаётся, что упрощается, что добавляется (session_*)
- `03-core-services.md` — intelligence/keywords/retention/activity/event-bus/webhooks по каждому
- `04-auth.md` — OAuth + magic + users/agents минимализация
- `05-api-rest.md` — REST surface, что убирается полностью
- `06-deployment.md` — runtime, start.sh, migration pipeline, logs
- `07-migration-map.md` — итоговая таблица со всеми решениями

## Предварительная оценка сложности миграции

На основе этого overview:
- **Схема**: сокращение с 20 real tables до ~7-10 (workspaces, agents, notes [объединена], sessions, session_messages, summaries, activity). Миграция — one-shot с data transform.
- **MCP tools**: с 9 → ~12-15 (добавляются session_*, упрощаются note/recall/brief).
- **Core services**: intelligence.ts выкидывается полностью (657 LoC), retention.ts упрощается (103 → ~30 LoC), event-bus и webhooks — возможно тоже выкидываются (webhook-сценариев в V3.0 нет явных).
- **Auth**: OAuth минимализуется, magic links выкидываются.
- **REST**: большинство handlers выкидывается, остаётся ~5 (health, openapi, mcp, operator).
- **Ожидаемый итог**: 9379 → **2000-2500 LoC**. В бюджете H1 (≤ 2000) или чуть выше — проверим в Фазе 3 при реальном проектировании.
