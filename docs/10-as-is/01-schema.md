# 01 — AS-IS: SQL schema аудит

**Источник**: `~/.openclaw/qoopia/data/qoopia.db` (прод БД, read-only)
**Всего таблиц в sqlite_master**: 45
**Real tables (без FTS5 shadow и sqlite_sequence)**: **20**
**Schema versions применено**: 6

## Подход

Для каждой таблицы указано:
- **Назначение** — зачем она нужна
- **Ключевые колонки**
- **Данных сейчас** — сколько строк в prod snapshot 2026-04-11
- **Решение V3.0** — **KEEP** / **SIMPLIFY** / **DROP**
- **Миграция** — как данные переносятся (если переносятся)

Таблицы сгруппированы по назначению: Identity (3), Core entities (6), Junctions (2), Activity (2), Auth (4), System (3).

## Группа A — Identity & tenancy (3 таблицы)

### A1. `workspaces` — **KEEP (SIMPLIFY settings)**

**Назначение**: tenant boundary. Один workspace = одно изолированное пространство данных.

**Колонки**: `id, name, slug (UNIQUE), settings (JSON), created_at, updated_at`

**Данных**: 1 row (единственный tenant в prod).

**Решение**: KEEP таблицу, структуру и FK referenced из всех user-facing таблиц. Это фундамент isolation'а из `02-personas.md` и ADR-001 Simplicity Pass decisions.

**SIMPLIFY**: поле `settings` в V2 содержит webhook configs (используется в `webhooks.ts`). В V3.0 webhooks выкидываются (см. ниже `webhook_dead_letters`), settings становится пустым JSON или выкидывается совсем. Пока оставим как свободный `settings JSON` для будущих workspace-specific флагов, без заданной структуры.

**Миграция**: как есть, slug можно сохранить.

### A2. `users` — **SIMPLIFY (drop session_expires_at + magic-link деп)**

**Назначение**: человеческие пользователи (для dashboard login через magic links).

**Колонки**: `id, workspace_id, name, email UNIQUE, role, api_key_hash, last_seen, session_expires_at, created_at`

**Данных**: 1 row.

**Решение**: SIMPLIFY. Users оставляем **минимальными** для случая «пусть у workspace есть owner-human», но большую часть логики magic-link авторизации выкидываем (см. группу E ниже).

- `role` — оставляем (owner/member для будущего)
- `api_key_hash` — оставляем для minimal auth path
- `session_expires_at` — DROP, token validity управляется через `oauth_tokens.expires_at`
- `last_seen` — DROP, не используется в реальной логике

**Миграция**: перенос 1 строки, drop двух колонок.

### A3. `agents` — **KEEP (SIMPLIFY permissions)**

**Назначение**: реестр агентов с API keys и metadata. В контексте Qoopia это primary identity — агенты это первые пользователи (см. `02-personas.md`).

**Колонки**: `id, workspace_id, name, type, api_key_hash, key_rotated_at, previous_key_hash, previous_key_expires, permissions (JSON), metadata (JSON), last_seen, active, created_at`

**Данных**: 6 rows (Aidan, Alan, Aizek, Dan, Claude-related).

**Решение**: KEEP как primary identity для V3.0. Агент — житель своего workspace (1 agent = 1 workspace в V3.0 default).

**SIMPLIFY**:
- **Key rotation с previous_key_hash + previous_key_expires** — сложная механика поддерживающая graceful rotation. В V3.0 **упрощаем до single current key hash**. Rotation = просто `UPDATE agents SET api_key_hash = ?`, без grace period. Если агент использовал старый key — получает 401 и перезагружается с новым. Проще и достаточно.
- **permissions (JSON)** — в V2 используется tool-level permission map (см. `registry.ts` `TOOL_PERMISSIONS`). В V3.0 с одним workspace и одним агентом — permissions сводятся к «агент полностью владеет своим workspace». Если позже понадобится более granular — вернём.
- **metadata** — свободный JSON, оставляем.

**Миграция**: перенос 6 строк, drop `key_rotated_at`/`previous_key_hash`/`previous_key_expires`, упрощение `permissions` до пустого JSON или удаление.

## Группа B — Core entities (6 таблиц)

**Главное решение Phase 1.5 Simplicity Pass**: объединяем **все 5 business-entity таблиц** (`tasks`, `deals`, `contacts`, `finances`, `projects`) в **одну таблицу `notes`** с полем `type` и JSON `metadata`. Плюс существующая `notes` становится этой универсальной таблицей.

Пояснение ниже по каждой таблице, потом — общий план миграции.

### B1. `notes` — **KEEP, становится универсальной entity-таблицей**

**Назначение** (в V2): свободные «заметки» агентов — factoids, decisions, memory items. Типизированы через `type` поле (rule/memory/knowledge/context).

**Колонки**: `id, workspace_id, agent_id, agent_name, session_id, text, project_id, source, embedding BLOB, matched_entities JSON, auto_updates JSON, created_at, type`

**Данных**: **200 rows**. Из них **166 с populated embedding** (Voyage).

**Решение**: KEEP таблицу, но **расширить под универсальные entities**. В V3.0 notes содержит **всё**: notes, задачи, сделки, контакты, финансы, проекты — каждая запись имеет `type` (note/task/deal/contact/finance/project/session_message) и structured `metadata (JSON)`.

**Изменения колонок**:
- `text` → KEEP, основное содержимое
- `type` → KEEP и расширить enum
- `embedding BLOB` → **DROP** (Layer B отложен, см. ADR-002)
- `matched_entities JSON` → **DROP** (no auto-matching, см. Finding 2 in overview)
- `auto_updates JSON` → **DROP** (no auto-status, см. Finding 2)
- `source` → KEEP
- `session_id` → KEEP + добавить `session_ordinal` для UC-7 LCM absorption
- `agent_id`, `agent_name` → KEEP (полезно для filter by agent in brief)
- `project_id` → SIMPLIFY. В V3.0 `project` — это note с `type='project'`. Связь task→project становится `metadata.project_id`. Но ради простоты keep `project_id` как отдельную FK-колонку для быстрых JOIN'ов.
- **Добавить**: `metadata (JSON)` — свободное поле для type-specific полей (task.status, deal.asking_price, contact.email и т.д.)
- **Добавить**: `task_bound_id TEXT` — для retention policy (запись связана с задачей, при закрытии задачи удаляется, см. F3 из 04-success-criteria.md)
- **Добавить**: `deleted_at TEXT` — soft delete

**Миграция 200 rows**: straightforward. Copy id/workspace/text/type/project_id/agent_id/session_id/created_at. Embedding и matched_entities теряются (не используются).

### B2. `tasks` — **DROP table, migrate rows to `notes` with type='task'**

**Данных**: 133 rows.

**Поля**: `id, project_id, workspace_id, title, description, status, priority, assignee, due_date, blocked_by, parent_id, source, tags, notes (field!), attachments, revision, deleted_at, created_at, updated_at, updated_by`

**Миграция**:
- `id` → `notes.id` (сохраняем ULID)
- `title` → `notes.text` (main content, первая строка)
- `description` → merged into `notes.text` (вторая+ строки) или в `metadata.description`
- `project_id` → `notes.project_id` (прямая FK)
- `workspace_id` → `notes.workspace_id`
- `type` = `'task'`
- `metadata` = `{status, priority, assignee, due_date, blocked_by, parent_id, tags, attachments, revision}`
- `notes` field → в `metadata.inline_notes` (чтобы не терять)
- `source`, `created_at`, `updated_at`, `updated_by` → keep
- `deleted_at` → keep
- FTS5 индекс `tasks_fts` — dropped, всё ищется через `notes_fts`

**DROP**: таблица `tasks`, FTS5 `tasks_fts*` (5 shadow tables), индексы `idx_tasks_*` (5 штук).

### B3. `deals` — **DROP table, migrate rows to `notes` with type='deal'**

**Данных**: 7 rows.

**Поля**: `id, project_id, workspace_id, name, address, status, asking_price, target_price, monthly_rent, lease_term_months, metadata (already JSON!), documents (JSON), timeline (JSON), tags, notes (field), revision, deleted_at, created_at, updated_at, updated_by`

**Миграция**:
- `name` → `notes.text`
- `metadata` в V2 уже JSON → merged в `notes.metadata`: `{status, address, asking_price, target_price, monthly_rent, lease_term_months, documents, timeline, tags, inline_notes, ...v2_metadata}`
- `type` = `'deal'`
- Связь deal ↔ contacts в текущей V2 через таблицу `deal_contacts` (см. C1). В V3.0 хранится в `metadata.contact_ids` (массив)

**DROP**: таблица `deals`, FTS5 `deals_fts*`, индексы `idx_deals_*`.

### B4. `contacts` — **DROP table, migrate rows to `notes` with type='contact'**

**Данных**: 44 rows.

**Поля**: `id, workspace_id, name, role, company, email, phone, telegram_id, language, timezone, category, communication_rules, tags, notes (field), revision, deleted_at, created_at, updated_at, updated_by`

**Миграция**:
- `name` → `notes.text`
- `metadata` = `{role, company, email, phone, telegram_id, language, timezone, category, communication_rules, tags, inline_notes}`
- `type` = `'contact'`

**DROP**: таблица `contacts`, FTS5 `contacts_fts*`, индексы `idx_contacts_*`.

### B5. `finances` — **DROP table, migrate rows to `notes` with type='finance'**

**Данных**: 17 rows.

**Поля**: `id, workspace_id, project_id, type (subscription/credit/investment/budget/purchase/acquisition), name, amount, currency, recurring, status, tags, notes, revision, deleted_at, created_at, updated_at, updated_by`

**Миграция**:
- `name` → `notes.text`
- `project_id` → `notes.project_id`
- `metadata` = `{finance_type, amount, currency, recurring, status, tags, inline_notes}` — внимание, тут конфликт: у V2 в `finances` есть поле `type` (тип финансовой операции) и у `notes` в V3 тоже есть `type` (general note type). Переименовываем внутреннее в `metadata.finance_type`.

**DROP**: таблица `finances`, индексы `idx_finances_*`. Finances в V2 не имеет FTS5 — в V3.0 автоматически получает через универсальный `notes_fts`.

### B6. `projects` — **DROP table, migrate rows to `notes` with type='project'**

**Данных**: 6 rows.

**Поля**: `id, workspace_id, name, description, status, owner_agent_id, color, tags, settings (JSON), revision, deleted_at, created_at, updated_at, updated_by`

**Миграция**:
- `name` → `notes.text`
- `metadata` = `{description, status, owner_agent_id, color, tags, settings}`
- `type` = `'project'`

**Особенность**: поле `notes.project_id` по-прежнему ссылается на project-note через `notes.id`. То есть V3.0 сохраняет **self-referential link**: notes могут ссылаться на project-note для группировки.

**DROP**: таблица `projects`, индексы `idx_projects_*`.

### Итог Группы B

**Было**: 6 таблиц (tasks/deals/contacts/finances/projects/notes) + 4 FTS5 индекса (на tasks/deals/contacts/notes — finances и projects без FTS5) + ~25 индексов.

**Станет**: **1 таблица** `notes` + 1 FTS5 `notes_fts` + ~8 индексов (workspace, type, project_id, task_bound_id, agent_id, session_id, created_at, partial).

**Экономия схемы**: 6 → 1 = 5 table drops. В контексте бюджета H3 (≤ 10 таблиц в начальной схеме) это критично.

## Группа C — Junction tables (2)

### C1. `deal_contacts` — **DROP** (replaced by metadata.contact_ids)

**Поля**: `deal_id, contact_id, role, PK (deal_id, contact_id)`

**Миграция**: в V3.0 deal-note хранит `metadata.contacts: [{contact_id, role}, ...]`. JSON-массив, не таблица.

**Trade-off**: теряется возможность быстро найти «все deals этого contact'а» через прямой JOIN. Для этого в V3.0 используется FTS5 search по contact name или `notes_search` с фильтром по metadata JSON.

**DROP**: таблица, индексы.

### C2. `contact_projects` — **DROP** (replaced by metadata.contact_ids on project notes)

**Поля**: `contact_id, project_id, role, PK (contact_id, project_id)`

**Миграция**: аналогично deal_contacts. Связь хранится в `metadata.contacts` project-заметки.

**DROP**: таблица, индексы.

## Группа D — Activity log (2 таблицы)

### D1. `activity` — **KEEP + SIMPLIFY (drop revision tracking)**

**Назначение**: аудит всех операций. Каждый create/update/delete entity генерирует activity-запись через `logActivity()`.

**Поля**: `id, workspace_id, timestamp, actor, action, entity_type, entity_id, project_id, summary, details JSON, revision_before, revision_after`

**Данных**: **2191 rows** (самый большой объём в V2).

**Решение**: KEEP, но **SIMPLIFY**:
- `revision_before` / `revision_after` → **DROP**. Это из V2 «revisioning» системы, которая в реальности не используется для rollback.
- `details JSON` → KEEP для free-form context
- FTS5 `activity_fts` → **DROP**. Activity почти никогда не ищется агентом через FTS (см. overview Finding 7). Удаление экономит 5 shadow tables + триггеры.
- Индексы `idx_activity_workspace`, `idx_activity_timestamp`, `idx_activity_entity` → KEEP (нужны для `brief()` и фильтров).

**Миграция**: перенос 2191 rows, без FTS5.

### D2. `activity_archive` — **DROP** (replace with retention policy on single table)

**Назначение**: архив записей старше 90 дней (см. `retention.ts:archiveOldActivity`).

**Решение**: **DROP таблицу**. В V3.0 используем **одну таблицу** `activity` с retention:
- Записи старше N дней (конфигурируется, по умолчанию 90) просто **удаляются** через scheduled maintenance
- Если понадобится архив — выгружается в JSON файл снаружи, не в отдельную таблицу
- Это соответствует **NG-13** (retention как simple two-rule policy) и группе H (taблица меньше → бюджет ближе)

**Trade-off**: теряется возможность «восстановить историю старше 90 дней». На практике — это никогда не делалось.

**Миграция**: 0 rows перенос (текущий archive size = ? — проверим, но в любом случае drop).

## Группа E — Auth (4 таблицы)

### E1. `oauth_clients` — **KEEP (SIMPLIFY)**

**Назначение**: OAuth 2.0 client registry. Используется Claude.ai connector flow.

**Поля**: `id, name, agent_id (FK), client_secret_hash, redirect_uris JSON, created_at`

**Решение**: KEEP. Claude.ai подключается через OAuth, мы **не отказываемся** от MCP connector через Claude.ai (это основной способ как Claude использует Qoopia).

**SIMPLIFY**: минимизируем поля, убираем refresh-rotation логику если она есть.

**Миграция**: перенос существующих клиентов.

### E2. `oauth_codes` — **KEEP**

**Назначение**: короткоживущие authorization codes (PKCE flow). TTL ~10 минут.

**Поля**: `code_hash, client_id, redirect_uri, workspace_id, agent_id, code_challenge, code_challenge_method, expires_at, used, created_at`

**Решение**: KEEP. Требуется для OAuth code flow.

**Миграция**: не нужна (коды короткоживущие, перенос не имеет смысла).

### E3. `oauth_tokens` — **KEEP**

**Назначение**: refresh + access tokens для Claude.ai connector.

**Поля**: `token_hash, client_id, agent_id, workspace_id, token_type, expires_at, revoked, created_at`

**Решение**: KEEP. Активно используется.

**Миграция**: перенос активных токенов (чтобы не ломать текущие Claude.ai сессии). Но возможно проще форсировать повторную авторизацию — зависит от графика миграции.

### E4. `magic_links` — **DROP**

**Назначение**: one-time login links для users (human login в dashboard).

**Поля**: `id, user_id, token_hash, expires_at, used_at, created_at`

**Решение**: **DROP**.

Причины:
- Dashboard redesign отложен (NG-5)
- Агенты используют API key / OAuth, не magic links
- 1 user в реальности
- Magic link = дополнительная подсистема (email sending? какой транспорт?)

**Миграция**: не нужна. Drop таблицу + handlers + middleware.

## Группа F — System / utility (3 таблицы)

### F1. `schema_versions` — **KEEP**

**Назначение**: трекинг применённых миграций.

**Поля**: `version INT PK, applied_at, description`

**Решение**: KEEP — нужен для migration runner. Сбросим нумерацию в V3.0 с версии 1.

### F2. `idempotency_keys` — **KEEP (maybe SIMPLIFY)**

**Назначение**: idempotent requests — если клиент retry'ит с тем же ключом, Qoopia возвращает кэшированный результат вместо повторной операции.

**Поля**: `key_hash PK, response TEXT, created_at, expires_at`

**Решение**: KEEP. Полезно для retry safety агентов.

**SIMPLIFY**: возможно переименовать колонки, убрать хэширование если агенты передают короткий ключ напрямую. Пересмотрим в Фазе 3.

**Retention**: через `purgeExpiredIdempotencyKeys()` уже работает (см. retention.ts). Оставить.

### F3. `webhook_dead_letters` — **DROP (webhooks выкидываются)**

**Назначение**: failed webhook deliveries для retry / manual inspection. `retention.ts:purgeOldDeadLetters` чистит >30 дней.

**Решение**: **DROP**. В V3.0 webhooks вообще не делаем (см. `03-core-services.md` про webhooks.ts). Если в V3.5 появится реальная боль «нужен pub/sub наружу» — добавим, возможно с другой архитектурой.

**Миграция**: drop таблицу + `webhooks.ts` (181 LoC) + код в `event-bus.ts` который вызывает `dispatchWebhooks`.

## Сводная таблица: было → станет

| Группа | V2 таблиц | V3.0 таблиц | Δ |
|---|---|---|---|
| A. Identity | workspaces, users, agents | workspaces, users, agents | 0 |
| B. Core entities | notes + tasks + deals + contacts + finances + projects | **notes** (universal) | **−5** |
| C. Junctions | contact_projects, deal_contacts | — (в JSON metadata) | **−2** |
| D. Activity | activity + activity_archive | activity | **−1** |
| E. Auth | oauth_clients, oauth_codes, oauth_tokens, magic_links | oauth_clients, oauth_codes, oauth_tokens | **−1** |
| F. System | schema_versions, idempotency_keys, webhook_dead_letters | schema_versions, idempotency_keys | **−1** |
| **Всего** | **20** | **10** | **−10** |

**Плюс добавляем** (см. ADR-005 LCM absorption):
- `sessions` — реестр session-чатов (одна запись = одна сессия чата)
- `session_messages` — messages внутри сессии (UC-1, UC-2, UC-5, UC-7)
- `summaries` — иерархия саммари (`level` field для DAG-уровней)

**Итого V3.0 схема**: 10 − 5 (из V2) + 3 (новых) = **~10 real tables**.

**Бюджет H3 (≤ 10 tables в начальной схеме)**: ✅ укладываемся впритык.

**Плюс FTS5 shadow tables**: 5 FTS5 индексов в V2 → **2 FTS5 индекса в V3.0** (`notes_fts` + `session_messages_fts`). Соответственно 25 → 10 shadow tables.

**Итого sqlite_master в V3.0**: ~10 real + 10 FTS5 shadow + служебные = **~22-25 таблиц**, против 45 в V2.

## Миграция — общая последовательность

Детали будут в `07-migration-map.md`. Короткий sketch:

1. **Создать новую БД** `qoopia-v3.db` с V3.0 схемой (10 tables)
2. **One-shot скрипт переноса**:
   - Workspaces / users / agents — direct copy
   - tasks → notes (type='task', metadata = {...}) — 133 rows
   - deals → notes (type='deal', contacts в metadata) — 7 rows
   - contacts → notes (type='contact', metadata) — 44 rows
   - finances → notes (type='finance') — 17 rows
   - projects → notes (type='project') — 6 rows
   - notes → notes (type=unchanged, drop embedding/matched_entities/auto_updates) — 200 rows
   - activity → activity (drop revision fields) — 2191 rows
   - activity_archive → dropped (or merged into activity if retention allows)
   - OAuth tables — direct copy
   - Drop: magic_links, webhook_dead_letters, contact_projects, deal_contacts
3. **FTS5 rebuild** — пересоздать `notes_fts` с нуля после переноса
4. **Verify** — count checks, sample retrievals, cross-check IDs

**Ожидаемое время миграции**: минуты (данных мало, 4 МБ DB).

**Risk mitigation**: старая `qoopia.db` остаётся read-only как backup, новая создаётся параллельно. Rollback = просто не переключить DSN в конфиге MCP server'а.

## Что это даёт для бюджетов группы H

| Бюджет | V2 факт | V3.0 цель | Статус |
|---|---|---|---|
| H3: ≤ 10 real tables в начальной схеме | 20 | ~10 | ✅ в бюджете |
| sqlite_master всего | 45 | ~22-25 | значительное сокращение |
| FTS5 индексов | 5 | 2 | 60% меньше triggers |
| Миграция схемы | 6 версий | с версии 1 | clean slate |

**Основное упрощение в схеме**: объединение 5 entity-таблиц в 1 через тип + metadata. Это **не** теряет функциональность — агент всё равно создаёт, читает, обновляет «задачу» — просто через одну общую таблицу с разным `type`.

**Связь с принципом радикальной простоты (ADR-004)**: одна таблица проще чем 5. Одни CRUD-тулзы (`note_create/get/update/delete`) проще чем 5 параллельных наборов. Одна FTS5-индексация проще чем 5. Добавляя «индекс по `metadata->>'$.due_date'`» поддерживаем быстрые фильтры там где нужно.

**Risk**: агент должен знать что делать `SELECT json_extract(metadata, '$.status') FROM notes WHERE type='task'` вместо `SELECT status FROM tasks`. Но агенты работают через MCP tools, не через сырой SQL. MCP tool `note_list({type: 'task', filters: {status: 'todo'}})` скрывает эту сложность внутри.
