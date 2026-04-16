# ADR-013: Claude Code Auto-Session Ingestion

**Status**: accepted
**Date**: 2026-04-16
**Deciders**: Асхат + Alan

## Контекст

Claude Code сохраняет каждый разговор в `~/.claude/projects/<cwd-hash>/<session-uuid>.jsonl`.
Эти файлы содержат все turns: user, assistant, tool_use, tool_result, thinking, attachment.

Цель: автоматически синхронизировать текстовые turns из Claude Code в Qoopia sessions,
чтобы Alan и другие агенты могли:
- видеть историю работы агентов в Qoopia (session_recent, session_search)
- строить контекст без ручного session_save
- анализировать активность агентов через единый интерфейс

Ограничения:
- JSONL-файлы могут расти быстро (тысячи строк в день)
- Не все записи нужны: thinking, tool_use, queue-operation — служебные
- Один и тот же файл могут тейлить несколько процессов (race condition)
- Агент должен знать к какому Qoopia-агенту относится каждый CWD

## Варианты

### Вариант A (самый простой возможный): Ручной session_save

Агенты продолжают вызывать session_save вручную через MCP.

- Плюсы: нулевые изменения инфраструктуры, нет новых процессов
- Минусы: агенты забывают (задокументированная проблема — Aizek пропустил весь день),
  требует дисциплины на уровне промпта
- Почему отвергнут: решение не решает проблему — оно просто надеется на неё

### Вариант B: Периодический batch-импорт (cron)

Cron-задача каждые N минут читает все JSONL, импортирует новые записи.

- Плюсы: проще чем tailer (нет fs.watch), нет постоянно живущего процесса
- Минусы: задержка N минут, сложнее отслеживать cursor по файлам,
  при сбое можно потерять или задублировать записи
- Почему отвергнут: задержка неприемлема для session_recent (используется в начале сессий)

### Вариант C (выбранный): Отдельный Bun-процесс с fs.watch (tailer)

Отдельный процесс смотрит на `~/.claude/projects/**/*.jsonl` через fs.watch,
читает новые байты по cursor, фильтрует, дедуплицирует, POST-ит в `/ingest/session`.

- Плюсы: near-realtime (<1с задержка), cursor-based (нет replay), dedup по (session_id, uuid),
  retry+backoff при недоступности Qoopia, отдельный ключ (ingest-daemon) изолирует права
- Минусы: ещё один процесс, нужен launchd plist, нужен новый тип агента

**Проверка на простоту**: Вариант B проще, но не удовлетворяет требованию realtime.
Вариант A удовлетворяет simplicity, но не решает проблему. Вариант C — минимальный
из тех, что реально решают задачу.

## Решение

Выбран вариант **C** — tailer как отдельный Bun-процесс.

### Ключевые решения внутри C:

**1. Отдельный тип агента `ingest-daemon`**

Tailer аутентифицируется как агент типа `ingest-daemon`. Это позволяет:
- HTTP-endpoint /ingest/* проверять тип и отказывать всем остальным
- Избежать добавления cross-attribution флага к стандартным агентам

**2. Cross-attribution через attributed_agent_id**

Tailer знает к какому агенту относится CWD (через allowlist).
При POST /ingest/session он передаёт `attributed_agent_id` — ID целевого агента.
Qoopia сохраняет session под именем этого агента, не инgest-daemon.

**3. Allowlist в таблице claude_code_agents**

Mapping cwd_prefix → agent_id хранится в БД, а не в конфиге файле.
Это позволяет менять allowlist без рестарта tailer (TTL-кэш 60с).

**4. Whitelist: только user + assistant.text**

Импортируются только записи с `type: user` или `type: assistant`.
Для assistant — только content-блоки с `type: text` (не thinking, не tool_use).
Причина: thinking-блоки большие, не несут смысла в сессионном контексте.
tool_use/tool_result могут содержать чувствительные данные.

**5. Dedup по (session_id, uuid)**

Каждая запись имеет уникальный uuid. Dedup предотвращает дубли при рестартах tailer.
Текущая реализация: in-memory Set (7a). Персистентный dedup — задача Phase 7b.

**6. Cursor по байтовому смещению**

Tailer хранит `fileCursors[path] = bytesRead`. При изменении читает только новые байты.
При старте cursor = текущий размер файла (не реплей истории).

**7. ingest.key в ~/.qoopia/ingest.key**

Ключ хранится отдельно от MCP-ключей агентов. Это позволяет:
- Ротировать ключ ingest-daemon независимо
- В будущем использовать разные ключи для разных tailer-инстансов (7c)

## Threat Model

**T1: Подмена attributed_agent_id**

Атака: скомпрометированный tailer POST-ит sessions под чужим agent_id.
Защита:
- /ingest/session проверяет что target agent существует и активен
- saveMessage проверяет что session_id не принадлежит другому агенту
- ingest-daemon key хранится в ~/.qoopia/ingest.key (не в env, не в коде)

**T2: Replay атака (повторная отправка старых записей)**

Атака: злоумышленник повторяет старые POST /ingest/session.
Защита:
- Dedup по (session_id, uuid) — uuid глобально уникален (генерируется Claude Code)
- В metadata сохраняется `ingest_uuid` — можно аудировать

**T3: Чтение чужих JSONL**

Атака: tailer читает JSONL проекта не в allowlist.
Защита:
- Tailer проверяет cwd каждой записи через resolveAgent()
- Записи с cwd не из allowlist молча игнорируются
- allowlist управляется через admin CLI (только admin)

**T4: DoS через большой JSONL**

Атака: огромный JSONL файл перегружает tailer или Qoopia.
Защита:
- MAX_CONTENT = 100_000 chars в saveMessage (уже существует)
- Tailer читает в chunks, не весь файл сразу
- Rate limit на /ingest/* наследуется от общего apiLimiter

**T5: Секреты в session content**

Атака: API ключи в сообщениях агента сохраняются в sessions.
Защита:
- assertNoSecrets() уже вызывается в saveMessage для content и metadata
- Whitelist только text-блоков исключает system-messages с ключами

## Последствия

- Что становится проще: история сессий агентов автоматически в Qoopia без дисциплины промпта
- Что становится сложнее: ещё один процесс, нужен launchd plist, мониторинг tailer
- Что мы не сможем сделать: импортировать thinking-блоки и tool_use (сознательное решение)
- Что нужно пересмотреть при изменении условий: если JSONL-формат изменится в новой версии Claude Code — обновить парсер в tailer.ts

## Ссылки

- `src/ingest/tailer.ts` — основной процесс
- `src/admin/claude-agents.ts` — allowlist CRUD
- `migrations/004_claude_code_agents.sql` — схема таблицы
- `src/http.ts` — endpoints /ingest/session, /ingest/allowlist
- `templates/com.qoopia.tailer.plist` — launchd plist (не загружать до Phase 7.5)
- ADR-004 (simplicity-first) — принцип, почему Вариант A отвергнут
