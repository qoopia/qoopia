# 03 — AS-IS: core services

**Источник**: `~/.openclaw/qoopia/src/core/`
**Файлы**: intelligence.ts (657) + retention.ts (103) + activity-log.ts (60) + event-bus.ts (71) + webhooks.ts (181) + keywords.ts (23) + logger.ts + validator.ts

**Всего core LoC**: **~1100** без logger/validator

## 03.1 `intelligence.ts` — 657 LoC — **DROP 95%, KEEP ~30 LoC**

Самый большой файл V2. Содержит **6 разных подсистем** в одном месте.

### Что внутри

**File header**:
```
Graceful Degradation Engine for Qoopia
Layer 1: LLM (haiku) for entity matching, Voyage for embeddings
Layer 2: Keyword matching + FTS5 (always available)
```

### Подсистема 1: Capabilities detection (~10 LoC)

`getCapabilities()` — возвращает `{llm: bool, embeddings: bool}` на основе env vars `QOOPIA_LLM_API_KEY` и `QOOPIA_VOYAGE_API_KEY`.

**Решение**: **DROP**. В V3.0 capabilities статические (FTS5 всегда есть, ничего другого не проверяем). Если понадобится feature flag — env var + простой читатель.

### Подсистема 2: HTTP retry + rate limiting (~80 LoC)

`fetchWithRetry()` + `runRateLimited()` + `sleep()` + `parseRetryAfterMs()` + rate-limit chain maps.

**Назначение**: wrapper для внешних HTTP (Haiku, Voyage) с exponential backoff и rate-limiting per-provider.

**Решение**: **DROP** полностью. В V3.0 ноль внешних HTTP-вызовов из core (ни Haiku, ни Voyage, ни webhook). Если понадобится — стандартный fetch + 1-line retry.

### Подсистема 3: Keyword-based entity matching (~70 LoC)

`keywordMatch(text, workspaceId)` — строит `LIKE %kw%` clause через `extractKeywords()`, UNION ALL поиск по tasks/deals/contacts, фильтрация по `STATUS_PATTERNS` regex для определения `detected_status`.

**Решение**: **DROP**. В V3.0 нет auto-linking notes к задачам/сделкам/контактам. Если агент хочет «найди похожие» — вызывает `recall()` или `note_suggest_links` (см. 02-mcp-tools.md).

### Подсистема 4: LLM-based entity matching (~100 LoC)

`llmMatch(text, workspaceId)` — вызов Anthropic Haiku API с промптом извлекающим structured actions из заметки. Возвращает JSON массив действий: `[{action, entity_type, search_query, new_status, confidence}, ...]`.

Модель: `claude-haiku-4-5-20251001`.

**Решение**: **DROP полностью**. В V3.0:
- Нет внешних LLM-вызовов из Qoopia
- Нет auto-magic разбора заметок
- Агент явно говорит что делать (если написал «я закончил задачу X» → он **сам** вызывает `note_update(id=X, metadata.status='done')`)

Это согласуется с **ADR-004 radical simplicity** и **ADR-003 agent-driven** — убираем implicit magic.

### Подсистема 5: Embedding generation / storage (~80 LoC)

`getEmbedding(text)` — HTTP вызов к Voyage API (`https://api.voyageai.com/v1/embeddings`), модель `voyage-3`. Возвращает Float32Array.

`storeEmbedding(noteId, text)` — вызывает getEmbedding, пишет BLOB в `notes.embedding`.

**Решение**: **DROP полностью**. Layer B отложен в V3.5 (ADR-002). Колонка `embedding` из таблицы `notes` тоже выкидывается (см. 01-schema.md B1).

**Экономия**: ~80 LoC + нет зависимости от Voyage API + нет env var `QOOPIA_VOYAGE_API_KEY` + нет background fire-and-forget в `note_create`.

### Подсистема 6: Embedding search (semantic) (~100 LoC)

`embeddingSearch(query, workspaceId, limit)` — получает query embedding от Voyage, затем:
1. SELECT все notes с embedding IS NOT NULL
2. Читает BLOB → `new Float32Array(buffer)` для каждого
3. Вычисляет cosine similarity **в Node.js memory**
4. Sort + slice top N

**Проблема**: O(N) на каждый запрос. Работает на 200 нотах. **Не работает** на 20k. Никакой индексации (нет sqlite-vec, нет HNSW).

**Решение**: **DROP полностью**. По двум причинам:
1. ADR-002: Layer B отложен
2. Эта реализация всё равно не масштабировалась бы — in-memory cosine на >1k записях деградирует катастрофически

### Подсистема 7: `semanticSearch()` wrapper (~50 LoC)

`semanticSearch(query, workspaceId, limit)` — пытается `embeddingSearch`, если возвращает null (нет API key или API лежит) — fallback на `fts5Search` из отдельной функции. Plus dedup и merge.

**Решение**: **DROP wrapper + KEEP идею FTS5 search**, но переписать как простой FTS5 call без cascade. В V3.0 `recall()` просто делает FTS5 SELECT.

### Подсистема 8: Status change detection (~120 LoC)

`detectAndApplyStatusChanges(text, workspaceId, actorId, source, matchResult)` — делает следующее:
1. Для каждой matched entity проверяет `STATUS_PATTERNS` regex
2. Если regex matches + entity имеет текущий status — генерирует status change candidate с confidence
3. Если confidence === 'high' — применяет UPDATE прямо в БД
4. Если confidence === 'medium' — кладёт в `suggested` список для возврата агенту
5. Возвращает `{applied: [...], suggested: [...]}`

**Это ядро "auto-magic"** в `note_create` tool.

**Решение**: **DROP полностью**. Причины:
- Нарушает принцип «агент знает что делает» (ADR-003/004)
- Regex-based heuristics ошибаются (есть edge cases с «nearly finished», «not done» и т.д.)
- Сложно отладить («почему задача вдруг закрылась?»)
- Агент всё равно должен проверять результат и часто overriding
- Если функционал очень нужен — агент делает `note_suggest_status(note_id)` как **отдельный** tool, получает список, сам решает применять (см. 02-mcp-tools.md T1 предложение)

**Экономия**: ~120 LoC + упрощение mental model ("что сделает `note`")

### Подсистема 9: `detectStaleTasks()` (~60 LoC)

Проверяет open tasks у которых **matched entities** в недавних notes с `done`-patterns — возможно задача должна быть закрыта. Возвращает warnings для `brief()`.

**Решение**: **DROP**. Эвристика. Агент видит recent notes в `brief()` сам и решает.

### Подсистема 10: `matchFromNote()` (~30 LoC)

Точка входа для tool `note`. Пробует `llmMatch()`, fallback на `keywordMatch()`.

**Решение**: **DROP** вместе с подсистемами 3 и 4.

### Итог по intelligence.ts

| Подсистема | V2 LoC | V3.0 |
|---|---|---|
| Capabilities | ~10 | DROP |
| HTTP retry/rate-limit | ~80 | DROP |
| Keyword matching | ~70 | DROP |
| LLM matching | ~100 | DROP |
| Embedding gen | ~80 | DROP |
| Embedding search | ~100 | DROP |
| semanticSearch wrapper | ~50 | DROP (replaced by simple FTS5 call in recall handler) |
| Status change detection | ~120 | DROP |
| Stale task detection | ~60 | DROP |
| matchFromNote | ~30 | DROP |
| **Total** | **657** | **~0** |

**intelligence.ts перестаёт существовать** в V3.0. Это самое большое упрощение в core.

**Что теряем функционально**:
- Auto-linking notes к задачам/сделкам/контактам — агент делает руками (через `note_create({..., metadata.links: [...]}`))
- Auto-status updates — агент делает руками (`note_update({id, metadata.status: 'done'})`)
- Semantic search — отложено в V3.5 по ADR-002
- Stale task warnings — агент сам смотрит

**Что получаем**: latency, predictability, простоту, нет зависимости от 2 внешних APIs, нет 2 env vars, нет 1 таблицы колонки.

## 03.2 `retention.ts` — 103 LoC — **SIMPLIFY**

**Содержит**:
- `archiveOldActivity()` — перемещает activity старше 90 дней из `activity` в `activity_archive`
- `purgeExpiredIdempotencyKeys()` — удаляет keys где `expires_at < now()`
- `purgeOldDeadLetters()` — удаляет webhook dead letters старше 30 дней
- `runMaintenance()` — запускает все три
- `startMaintenanceSchedule()` — setTimeout первый запуск через 1 час, потом setInterval 24h

**Решение**: **SIMPLIFY**. Конкретные изменения:

1. **`archiveOldActivity` → `purgeOldActivity`** — drop, don't archive. Нет таблицы `activity_archive` в V3.0 (см. 01-schema D2).
2. **`purgeExpiredIdempotencyKeys`** — KEEP как есть, простая операция.
3. **`purgeOldDeadLetters`** — DROP. Нет webhook_dead_letters (см. 03.4 ниже).
4. **Добавить**: `purgeTaskBoundContext()` — для F3 из 04-success-criteria.md. Удалить `session_messages` и `notes` где `task_bound_id` ссылается на закрытую задачу (soft-deleted ≥ 1 час назад).
5. **`runMaintenance`** — вызывает purgeOldActivity + purgeExpiredIdempotencyKeys + purgeTaskBoundContext.
6. **Schedule** — KEEP через setInterval/setTimeout.

**Размер**: 103 → ~60 LoC.

## 03.3 `activity-log.ts` — 60 LoC — **KEEP (drop eventBus emit)**

**Содержит**:
- `LogEntry` interface
- `logActivity()` — INSERT в activity table + emit на `eventBus`

**Решение**: **KEEP структурно, SIMPLIFY**:
- DROP `eventBus.emit()` call — см. 03.5 ниже, event-bus выкидывается
- DROP поля `revision_before` / `revision_after` (убраны из схемы 01-schema D1)
- Оставить lazy prepared statement

**Размер**: 60 → ~40 LoC.

**Использование**: каждая MCP-операция которая изменяет state вызывает `logActivity()`. Это аудиторский лог. В V3.0 — такой же, просто меньше активности потому что меньше magic (нет `auto-update` records от detectAndApplyStatusChanges).

## 03.4 `webhooks.ts` — 181 LoC — **DROP полностью**

**Содержит**:
- `WebhookConfig` интерфейс (Telegram или HTTP webhook)
- `getWorkspaceWebhooks(workspaceId)` — читает настройки из `workspaces.settings.webhooks JSON`
- `deliverWebhook()` — HTTP POST с retry, SSRF protection (блок private hosts), dead letter на fail
- `formatTelegramMessage()` — HTML форматирование для Telegram bot API
- `dispatchWebhooks(event)` — итерация по subscribers, match событий, fire-and-forget delivery

**Подключение**: вызывается из `event-bus.ts` при каждом событии (если есть subscribers) → оттуда на каждую `logActivity()` потенциально уходит webhook.

**Проверка использования**: в prod БД единственный workspace имеет `settings = '{}'` или аналогичный без `webhooks` ключа. **Никто webhooks не настраивал**. Это dead code.

**Решение**: **DROP**.

**Что это означает**:
- Telegram агенты (Dan в WhatsApp family chat, потенциальные другие) — они **не** получают уведомления от Qoopia через webhook. Они работают иначе — через прямые API вызовы к своим messenger'ам, не через Qoopia webhook.
- Если когда-то понадобится «Qoopia уведомляет внешний мир о событии» — это другой use case, отдельный subsystem, не несём в V3.0.

**Экономия**: 181 LoC + 1 таблица (`webhook_dead_letters`) + retention `purgeOldDeadLetters` + SSRF code + Telegram formatter.

## 03.5 `event-bus.ts` — 71 LoC — **DROP**

**Содержит**:
- `QoopiaEvent` interface
- `EventBus` class: `subscribe`, `emit`, `closeAll`, `subscriberCount`
- In-memory Map<subscriber_id, {workspace_id, handler, filters}>
- Filter logic: workspace matching, project filter, entity type filter
- Export singleton `eventBus`

**Использование**:
1. `activity-log.ts:logActivity()` вызывает `eventBus.emit(event)`
2. `webhooks.ts:dispatchWebhooks(event)` — подписывается как consumer
3. REST `observe` endpoint (`src/api/handlers/observe.ts`) подписывается для SSE streaming к dashboard

**Решение**: **DROP**. Причины:
1. Основной consumer (webhooks.ts) удаляется (см. 03.4)
2. Другой consumer (observe/SSE endpoint) относится к dashboard который отложен в V3.0 (NG-5)
3. Без consumer'ов event bus — overhead без пользы

**Что теряем**: real-time push-уведомления агентов о событиях в БД. В V3.0 агенты polling'ом через `brief()` или `recall()` узнают о новых событиях. Для session memory (UC-7) polling не нужен — агент сам пишет, сам читает.

**Экономия**: 71 LoC + все `eventBus.emit()` вызовы + SSE-related код в `observe.ts`.

## 03.6 `keywords.ts` — 23 LoC — **DROP**

**Содержит**: `STOP_WORDS` set + `extractKeywords(text)` — фильтр слов длиннее 2 символов, не stop word, lowercased.

**Использование**: единственный caller — `intelligence.ts:buildKeywordPatterns()` и `utils.ts:matchEntities()` для LIKE-поиска entities.

**Решение**: **DROP**. Используется только в модулях которые сами выкидываются.

## 03.7 `logger.ts` — ~20 LoC — **KEEP**

Pino wrapper. Стандартный. Используется везде.

**Решение**: **KEEP**. Возможно переход на более лёгкую альтернативу (`console.log` с префиксами) если экономия deps критична — но пока pino ok.

## 03.8 `validator.ts` — **KEEP (мало информации, проверим в деталях позже)**

Zod-based валидация. Нужен для input sanitization. **KEEP**.

## Сводка core services

| Файл | V2 LoC | V3.0 LoC | Δ |
|---|---|---|---|
| intelligence.ts | 657 | ~0 | **−657** |
| webhooks.ts | 181 | 0 | **−181** |
| retention.ts | 103 | ~60 | −43 |
| event-bus.ts | 71 | 0 | **−71** |
| activity-log.ts | 60 | ~40 | −20 |
| keywords.ts | 23 | 0 | **−23** |
| logger.ts | ~20 | ~20 | 0 |
| validator.ts | ? | keep | 0 |
| **Всего core** | **~1115** | **~120** | **−995 (−89%)** |

**Это главный источник экономии LoC в V3.0**. core services сокращаются почти на 90%.

## Почему это безопасно

**Страх**: «мы выкидываем 995 LoC из core — вдруг что-то сломается?»

**Ответ**:
1. **intelligence.ts 657 LoC** — это auto-magic поверх базовой БД операций. Все «простые» пути (создание, чтение, обновление, удаление) работают **без** intelligence.ts. Проверено логикой: `note_create` в V3.0 = просто INSERT, `recall` = FTS5 SELECT, ничего больше. Auto-linking и auto-status были бонусом, а не основой.

2. **webhooks.ts + event-bus.ts 252 LoC** — никем реально не используется в текущем prod (нет configured webhooks, нет SSE подписчиков кроме dashboard который отложен).

3. **keywords.ts 23 LoC** — вспомогательный для выкидываемых функций.

4. **retention.ts 43 LoC экономии** — упрощение двух подсистем которые выкидываются (activity_archive, dead letters).

**Суммарно**: нет ни одного use case из `03-use-cases.md` который требует этих 995 LoC. Primary acceptance test (коллапс system prompt в «check Qoopia») работает через простые CRUD + session + recall, без auto-magic.

## Что получаем в итоге

| Метрика | V2 | V3.0 |
|---|---|---|
| Core LoC | ~1115 | ~120 |
| Внешних API зависимостей | 2 (Haiku + Voyage) | **0** |
| env vars для core | 2 | **0** |
| Background workers | 3 (maintenance + eventBus + voyage fire-and-forget) | 1 (maintenance) |
| Количество фоновых таймеров | 2 (setTimeout 1h, setInterval 24h) | 1 (setInterval 24h) |
| "Умных" эвристик | 3 (entity match, status change, stale detection) | **0** |

Это **огромное упрощение** mental model. «Что происходит когда агент вызывает `note_create`?» в V3.0 имеет один ответ: **INSERT в notes + INSERT в activity + RETURN id**. В V2 — 12-шаговая диаграмма.
