# 07 — Migration map: V2 → V3.0

**Цель документа**: одна таблица по каждой подсистеме V2 с решением «что делаем в V3.0» и путём миграции. Это **выход Фазы 2** и **вход Фазы 3** (TO-BE).

**Дата**: 2026-04-11
**Базис**: 00-overview + 01-schema + 02-mcp-tools + 03-core-services + 04-auth + 05-api-rest + 06-deployment

## Сводная LoC таблица

| Подсистема | V2 LoC | V3.0 LoC (оценка) | Δ | % сокращение |
|---|---|---|---|---|
| MCP framework | ~410 | ~140 | −270 | −66% |
| MCP tools (memory + CRUD) | ~2000 | ~500 | −1500 | −75% |
| MCP tools (session_*) NEW | — | +150 | +150 | new |
| Core services | ~1115 | ~120 | −995 | −89% |
| Auth/middleware | ~1891 | ~432 | −1459 | −77% |
| REST handlers (non-auth, non-MCP) | ~2820 | ~115 | −2705 | −96% |
| `src/index.ts` + bootstrap | ~50 | ~30 | −20 | −40% |
| `db/` (connection, migrate, columns) | ~150 | ~100 | −50 | −33% |
| Types, utils, misc | ~300 | ~200 | −100 | −33% |
| **Total** | **~9379** | **~1787** | **−7592** | **−81%** |

**Результат**: V3.0 **укладывается в бюджет H1** (≤ 2000 LoC core). С запасом.

## Сводная таблица баз данных

| | V2 | V3.0 |
|---|---|---|
| Real tables | 20 | ~10 |
| FTS5 shadow tables | 25 | ~10 (2 FTS5 indexes × 5) |
| Всего в sqlite_master | 45 | ~22-25 |
| Applied migrations | 6 (V2 history) | starts from 1 (fresh V3 schema) |
| Данных (rows) в prod snapshot | 2623 total | те же 2623 мигрированы |

## Зависимости

| Зависимость | V2 | V3.0 | Примечание |
|---|---|---|---|
| Node.js | v24.14.0 required (hardcoded) | Bun 1.x или Node 22+ | Runtime decision — Фаза 3 |
| Hono | ✓ | ✓ или нативный Bun HTTP | Фаза 3 |
| better-sqlite3 | ✓ | ✓ или Bun builtin SQLite | Фаза 3 |
| zod | ✓ | ✓ | KEEP |
| jose (JWT) | ✓ | **DROP** (opaque tokens) | см. 04-auth |
| pino | ✓ | ✓ или console | minor |
| ulid | ✓ | ✓ | KEEP |
| **@anthropic SDK / Voyage** | в env, через fetch | **0** — нет внешних API | см. 03-core-services |
| **Итого runtime deps** | 7-8 | **3-5** | в бюджете H2 (≤5) |

## Per-subsystem миграция

### Группа 1: Schema & data (01-schema.md)

| V2 объект | Действие | Путь миграции |
|---|---|---|
| `workspaces` table | KEEP | Direct copy (1 row) |
| `users` table | SIMPLIFY | Copy 1 row, drop `session_expires_at` |
| `agents` table | KEEP + simplify | Copy 6 rows, drop `previous_key_*`, simplify `permissions` |
| `notes` table | KEEP + расширить | Copy 200 rows, drop `embedding`/`matched_entities`/`auto_updates`, add `metadata`/`task_bound_id` |
| `tasks` table | **DROP**, merge в notes | Transform 133 rows → notes (type='task', metadata={status, priority, ...}) |
| `deals` table | **DROP**, merge в notes | Transform 7 rows → notes (type='deal') |
| `contacts` table | **DROP**, merge в notes | Transform 44 rows → notes (type='contact') |
| `finances` table | **DROP**, merge в notes | Transform 17 rows → notes (type='finance') |
| `projects` table | **DROP**, merge в notes | Transform 6 rows → notes (type='project') |
| `contact_projects` junction | **DROP** | Связи мигрируют в `notes.metadata.contacts` |
| `deal_contacts` junction | **DROP** | То же |
| `activity` table | KEEP + SIMPLIFY | Copy 2191 rows, drop `revision_before`/`revision_after` |
| `activity_archive` | **DROP** | В V3.0 retention просто удаляет старые записи |
| `oauth_clients` | KEEP | Direct copy |
| `oauth_codes` | KEEP | Не переносим (short-lived) |
| `oauth_tokens` | KEEP or regenerate | Copy active, или force re-auth |
| `magic_links` | **DROP** | — |
| `schema_versions` | KEEP | Reset to version 1 |
| `idempotency_keys` | KEEP | Direct copy (retention already works) |
| `webhook_dead_letters` | **DROP** | — |
| **NEW**: `sessions` | Add | Empty (agents start populating через UC-7) |
| **NEW**: `session_messages` | Add | Empty |
| **NEW**: `summaries` | Add | Empty |

**One-shot migration script**: `scripts/migrate-from-v2.ts` или `.sql`. Читает `~/.openclaw/qoopia/data/qoopia.db` read-only, пишет в `~/.qoopia/data/qoopia.db` (новый V3 файл).

**Risk**: прод-Qoopia остаётся нетронутой → rollback = просто не переключить DSN у агентов.

### Группа 2: MCP tools (02-mcp-tools.md)

| V2 tool | V3.0 | Примечание |
|---|---|---|
| `note` | → `note_create` + optional `note_suggest_links` | Drop 95% magic. INSERT + activity. Опциональные подсказки отдельным tool |
| `recall` | → `recall` упрощённый | **FIX 300-char truncation bug**. FTS5 only. No method field. |
| `brief` | → `brief` упрощённый | Drop `detectStaleTasks`, drop auto-magic |
| `list` | → `note_list` | generic по type |
| `get` | → `note_get` | generic по id |
| `create` | → `note_create` | generic с type + metadata |
| `update` | → `note_update` | generic с patch-style merge |
| `delete` | → `note_delete` | soft delete |
| — | **NEW**: `session_save` | UC-7 LCM absorption |
| — | **NEW**: `session_recent` | UC-7 |
| — | **NEW**: `session_search` | UC-7 |
| — | **NEW**: `session_summarize` | UC-7 |
| — | **NEW**: `session_expand` | UC-7 |
| — | **NEW**: `activity_list` | Отдельный tool для activity (не note) |

**Количество MCP tools**: 8 → ~13. В бюджете H8 (≤ 15).

### Группа 3: Core services (03-core-services.md)

| V2 file | Действие | Размер Δ |
|---|---|---|
| `intelligence.ts` (657) | **DROP 100%** | −657 |
| `webhooks.ts` (181) | **DROP 100%** | −181 |
| `event-bus.ts` (71) | **DROP 100%** | −71 |
| `keywords.ts` (23) | **DROP 100%** | −23 |
| `retention.ts` (103) | SIMPLIFY | −43 |
| `activity-log.ts` (60) | KEEP + drop eventBus emit | −20 |
| `logger.ts` (~20) | KEEP | 0 |
| `validator.ts` | KEEP | 0 |
| **Core total** | | **−995 LoC** |

**Что теряем**: auto-linking notes, auto-status updates, semantic search cascade, webhooks, SSE event bus, stale task detection.

**Что получаем**: predictability, zero external deps, zero env vars for core, deterministic behavior.

### Группа 4: Auth (04-auth.md)

| V2 file | Действие | Размер Δ |
|---|---|---|
| `handlers/oauth.ts` (906) | SIMPLIFY — переход на **opaque tokens** | −726 |
| `handlers/auth.ts` (212, magic links) | **DROP 100%** | −212 |
| `handlers/agents.ts` (261) | SIMPLIFY | −181 |
| `middleware/auth.ts` (106) | SIMPLIFY | −46 |
| `middleware/permissions.ts` (198) | **DROP 100%** | −198 |
| `middleware/rate-limit.ts` (96) | **DROP 100%** в V3.0 | −96 |
| `middleware/cors.ts` / `idempotency.ts` / `request-id.ts` | KEEP | 0 |
| **Auth total** | | **−1459 LoC (−77%)** |

### Группа 5: REST handlers (05-api-rest.md)

| Категория | Действие | Размер Δ |
|---|---|---|
| Entity CRUD (7 files, 1325 LoC) | **DROP all** | −1325 |
| Batch/events/export/files (4 files, 422 LoC) | **DROP all** | −422 |
| `observe.ts` SSE (158) | **DROP** | −158 |
| `openapi.ts` (316) | **DROP** | −316 |
| `health.ts` (100) | SIMPLIFY | −70 |
| `reindex.ts` (35) | KEEP | 0 |
| **REST total (non-auth)** | | **−2291 LoC (−96%)** |

### Группа 6: Deployment (06-deployment.md)

| Компонент | V2 | V3.0 |
|---|---|---|
| Runtime | Node hardcoded | Bun или Node, detected |
| start.sh | 15 LoC с хардкодами | 5 LoC без хардкодов или удалён |
| launchd | через OpenClaw gateway | standalone `com.qoopia.mcp.plist` |
| `qoopia install` | **отсутствует** | **~100 LoC new script** |
| Миграции | in-code | `migrations/*.sql` files |
| Бэкапы | нет | daily SQLite .backup + 7-day rotation |

## Порядок миграции (рекомендация для Фазы 5)

Предварительный (детали в Фазе 3/4):

1. **Prep** (Фаза 3 — TO-BE):
   - Финальное проектирование V3.0 схемы и API
   - Выбор runtime (Bun vs Node) — вероятно Bun
   - Прототип ключевых компонентов: MCP server skeleton, notes CRUD, session memory

2. **Clean-room build** (Фаза 5):
   - Новая codebase в `~/qoopia-v3/src/` (или subdirectory)
   - Не форкаем прод-Qoopia, **переписываем с чистого листа** с использованием V2 как reference
   - lcm-mcp Нияза как baseline для session memory tools (`research/peers/lcm-mcp/`)

3. **Migration of data**:
   - Скрипт `scripts/migrate-from-v2.ts` создаёт новый `qoopia-v3.db` из `~/.openclaw/qoopia/data/qoopia.db`
   - Запускается один раз, занимает секунды (данных мало)
   - V2 БД остаётся нетронутой как backup

4. **Cutover для Асхата**:
   - V3.0 Qoopia запускается на отдельном порту (например 3738) параллельно с V2 (3737)
   - Обновляются MCP connectors агентов **по одному**: Alan → тест → Aizek → тест → Claude → тест → Aidan
   - V2 остаётся включенной но read-only в течение ~1 недели для rollback
   - После подтверждения стабильности — V2 выключается

5. **Deploy у Сауле**:
   - `qoopia install` на её Mac Mini
   - Migration from her data (empty — свежий start)
   - Agent api_keys генерируются впервые, Claude.ai connector на её аккаунт

## Risk register

### Высокие риски

**R1: Миграция данных теряет информацию из `tasks.attachments` / `deals.documents` JSON полей**
- Mitigation: все JSON поля из старых entity-таблиц мерджатся в `notes.metadata` с explicit mapping
- Verification: после миграции — count check + sample-based field verification

**R2: Agents auth сломается при переходе на opaque tokens**
- Mitigation: API key path (SHA256 lookup в `agents.api_key_hash`) остаётся без изменений. Только JWT path меняется. Агенты с API key работают as-is.
- Claude.ai connector нужно будет re-authorize один раз (один human clickthrough)

**R3: Claude.ai MCP connector не поддерживает opaque tokens**
- Проверить: Claude.ai **документирован** как поддерживающий RFC 6749 OAuth 2.0 Bearer tokens, которые могут быть opaque или JWT. Opaque tokens должны работать.
- Fallback: если не работает — оставляем JWT path но переходим на HS256 (symmetric) вместо RSA+JWKS. Экономия меньше, но работает.

### Средние риски

**R4: Потеря FTS5 качества при merge entities в одну таблицу**
- V2 имеет отдельные FTS5 индексы на tasks/deals/contacts/notes — каждый оптимизирован под тексты своего типа
- V3.0 имеет один общий FTS5 на `notes.text` — возможно чуть худший relevance для смешанных запросов
- Mitigation: FTS5 supports rank functions and column weighting; добавим `type`-based boosting при необходимости. Тестируем на golden set в Фазе 2 конца.

**R5: Удаление auto-status detection приведёт к неаккуратному трекингу задач**
- Агенты Claude/Alan/Aizek должны явно вызывать `note_update(id, metadata.status)` когда завершают задачу
- В V2 это было "magic" — система угадывала
- Mitigation: в system prompt инструкциях явно написать «после завершения задачи вызови `note_update` с новым статусом». Простой fix.

### Низкие риски

**R6: Удаление webhooks приведёт к потере integration точки**
- Никто в prod не использовал webhooks
- Mitigation: в V3.5 добавим если появится реальная нужда

**R7: Удаление SSE event bus**
- Реально использовался только для dashboard live-updates, dashboard в V3.0 нет
- Mitigation: agents polling через `brief()` или `recall()` — для session memory (UC-7) не нужно real-time push

## Primary acceptance test для Фазы 2

✅ **Этот документ (`07-migration-map.md`) содержит**: для каждой подсистемы V2 явное решение в V3.0 и путь миграции.

Это **deliverable**, который был заявлен в `README.md` Фазы 2. Фаза 2 **может быть закрыта**.

## Сводная V2 → V3.0 финальная картина

| Метрика | V2 | V3.0 цель | % сокращение |
|---|---|---|---|
| Core LoC | 9379 | ~1787 | **−81%** |
| Real tables | 20 | ~10 | −50% |
| sqlite_master total | 45 | ~22-25 | −45% |
| MCP tools | 8 | ~13 | +60% (добавляем session_*) |
| Runtime deps | 7-8 | 3-5 | −40% |
| External API deps (LLM, embeddings) | 2 (Haiku, Voyage) | 0 | **−100%** |
| env vars for core | 2 | 0 | −100% |
| Background workers/timers | 3 | 1 | −66% |
| Auth paths | 2 (API key + JWT) | 2 (API key + opaque token) | same |
| Magic/heuristic logic | 3 subsystems | 0 | **−100%** |
| 300-char truncation bug | **ПРИСУТСТВУЕТ** | **FIXED** | critical |

## Связь с principles (Фаза 1) — проверка

| Принцип / критерий | Соответствие V3.0 плана |
|---|---|
| 01-why token economy | ✅ session_* tools + recall без truncation |
| 01-why multi-tenant ready | ✅ zero hardcodes, `qoopia install` |
| 01-why radical simplicity | ✅ −81% LoC, intelligence.ts DROP |
| 02-personas workspace isolation | ✅ single `workspace_id` column + WHERE |
| 02-personas one workspace mode | ✅ autonomous-only в V3.0 |
| 03-use-cases primary acceptance test | ✅ «check Qoopia» в one-line system prompt |
| 03-use-cases 7 reliability reqs | ✅ каждое покрывается Plan |
| 03-use-cases UC-7 LCM absorption | ✅ 5 session_* tools |
| 04-success-criteria group A (reliability) | ✅ атомарные INSERTs, retention, backup |
| 04-success-criteria group B (latency) | ✅ FTS5 sub-100ms реально |
| 04-success-criteria group C (token economy) | ✅ `recall` без truncation, cost visibility |
| 04-success-criteria group D (deployment) | ✅ `qoopia install` ≤ 3 команды |
| 04-success-criteria group E (retrieval) | ✅ FTS5 качество, отложен semantic |
| 04-success-criteria group F (isolation) | ✅ workspace_id scope |
| 04-success-criteria group G (UX) | ✅ ~13 tools, понятные имена |
| 04-success-criteria group H (simplicity budgets) | ✅ укладываемся (LoC, deps, tables, commands) |
| 05-non-goals NG-13 no auto-summarize | ✅ session_summarize accepts agent text |
| 05-non-goals NG-14 no semantic | ✅ Layer B deferred to V3.5 |
| 05-non-goals NG-15 no large files | ✅ 100 KB hard cap |
| ADR-002 two-layer | ✅ только Layer A в V3.0 |
| ADR-003 agent-driven | ✅ нет Claude Code hooks, system prompt instructions |
| ADR-004 radical simplicity budgets | ✅ явные числовые проверки |
| ADR-005 LCM absorption | ✅ session_* tools спроектированы |

**Итог**: V3.0 план **полностью соответствует** всем принципам Фазы 1 + Фазы 1.5.

## Что дальше

**Фаза 2 завершена**. Переход к **Фазе 3 — TO-BE**:

1. Проектирование финальной V3.0 схемы (SQL DDL, включая FTS5 triggers, partial indexes, foreign keys)
2. Проектирование MCP tool definitions (точные JSON schemas)
3. Runtime decision: Bun vs Node
4. Transport decision: Streamable HTTP via MCP SDK vs custom
5. Token auth decision: opaque vs HS256 JWT
6. Прототип нескольких ключевых компонентов:
   - notes CRUD with metadata merge
   - session memory with FTS5
   - `qoopia install` one-command setup
7. ADR-007 «Phase 2 audit accepted, Phase 3 TO-BE scope»
