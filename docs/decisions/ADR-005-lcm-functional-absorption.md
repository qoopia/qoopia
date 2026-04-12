# ADR-005: Qoopia V3 absorbs LCM functionality via Layer A session memory

**Status**: accepted
**Date**: 2026-04-11
**Deciders**: Асхат + Claude

## Контекст

Lossless Context Management (LCM) — плагин для OpenClaw (`~/.openclaw/extensions/lossless-claw/`), основанный на paper Voltropy. Реализует DAG-based summarization, сохраняя каждое сообщение сессии и компактируя через leaf/condensed summaries.

LCM работал у Асхата с Alan и Aizek в OpenClaw. После миграции Alan и Aizek в Claude Code LCM **недоступен** — потому что Claude Code не имеет плагинной архитектуры с `contextEngine` slot.

Результат: сегодня чаты Claude Code не могут передать друг другу контекст между собой; `recall` текущей Qoopia V2 режет по 280 символов, что делает compact handoff невозможным.

Одновременно изучение peer implementation lcm-mcp Нияза Ирсалиева (2026-04-11) показало что **функциональность LCM достижима** в Claude Code через MCP server + инструкции в system prompt агента.

## Варианты

### Вариант A (самый простой возможный): Qoopia V3 Layer A поглощает функцию LCM полностью

- Qoopia добавляет 3 таблицы: `sessions`, `session_messages`, `summaries` (плюс FTS5 индексы)
- Qoopia добавляет 5 MCP tools: `session_save`, `session_recent`, `session_search`, `session_summarize`, `session_expand`
- Агент вызывает их через инструкции в system prompt (см. ADR-003)
- Summaries хранятся с `level` полем (1 = leaf summary, 2 = summary of summaries, ...), никакого DAG с parent links
- Никакого background auto-compaction (см. NG-13 в 05-non-goals.md) — агент сам вызывает `session_summarize`
- Никаких hooks Claude Code — полагаемся на инструкции

- Плюсы:
  - Единый MCP server для всей памяти (session + notes + entities) — одна инсталляция, один connector
  - Нет отдельного сервиса LCM который надо поднимать рядом
  - Multi-tenant из коробки (workspace_id column)
  - Работает в любой среде (Claude Code, Claude.ai, OpenClaw, Cowork)
  - Schema и MCP surface — расширение того что уже есть в Qoopia
- Минусы:
  - Qoopia становится немного больше (~3 таблицы, ~5 tools)
  - Пересекается с существующей ролью Qoopia как CRM notes store — нужно чётко разграничить session layer vs notes layer
  - Не воспроизводит in-pipeline context hijack OpenClaw (но это и невозможно в Claude Code)

### Вариант B: запустить lcm-mcp Нияза параллельно с Qoopia

- Два MCP server'а: Qoopia (notes, entities) + lcm-mcp (session memory)
- Агенты подключают оба

- Плюсы:
  - Готовое peer решение, можно использовать as-is
  - Минимум работы с нашей стороны
- Минусы:
  - Два MCP connector в каждом агенте
  - Две отдельные БД, нет cross-query (не найти session-сообщение через notes-поиск и наоборот)
  - Два процесса, два health-check, два install
  - Нет workspace isolation в lcm-mcp — только agent_id
  - Нет task-bound retention (NG из 02-personas.md)
  - Нарушает принцип «одно решение для всей памяти» (цель Qoopia V3)

### Вариант C: написать отдельный LCM-сервис как подпроект Qoopia V3

- Отдельный бинарник `qoopia-lcm` который общается с основной Qoopia

- Плюсы:
  - Чёткая граница между podsистемами
- Минусы:
  - Два процесса для одного tenant'а
  - Сложнее install (D1)
  - Два code base
  - IPC между ними — overhead

## Решение

Выбран **Вариант A**.

**Что Qoopia V3 перенимает от LCM** (функционально):

| Функция LCM | Реализация в Qoopia V3 |
|---|---|
| Persistent message log | Таблица `session_messages` + FTS5 |
| Summary DAG | Таблица `summaries` с полем `level` (упрощение: линейные уровни вместо полного DAG) |
| `lcm_grep` | `session_search(query, scope, limit)` — FTS5 |
| `lcm_describe` | `session_expand(start_id, end_id)` — возвращает исходные сообщения в диапазоне |
| `lcm_expand_query` | Отложено в V3.5+ — sub-agent expansion через delegation grants требует больше проработки |
| `lcm_save` hooks | Agent-driven через system prompt (см. ADR-003) |
| Auto-compaction | **Не переносится** — см. NG-13, агент сам вызывает `session_summarize` |
| Large file interception | **Не переносится** — см. NG-15, правило 100 KB cap |
| Session reconciliation | **Не переносится** — Claude Code сам ведёт свой транскрипт, мы дублируем через save-on-turn |
| Multi-tenant изоляция | **Добавляется**: workspace_id на каждой записи (у LCM не было) |
| Task-bound retention | **Добавляется**: записи с task_id стираются при закрытии задачи (у LCM не было) |

**Что не переносится из LCM и почему**:

1. **DAG с parent_summaries links** — упрощаем до линейных уровней через поле `level`. Если понадобится настоящий DAG (редко) — добавляем в V3.5.
2. **In-pipeline context engine hooks** — Claude Code не имеет context engine slot. Компенсируется тем что агент сам вызывает recall/search/expand.
3. **Separate summarization LLM cascade** (Haiku auth profiles etc.) — агент сам пишет саммари (см. NG-13).
4. **Large file interception** — см. NG-15.
5. **Session JSONL reconciliation** — полагаемся на at-save-time persistence.
6. **FTS5 query sanitizer слишком грубый у peer** — делаем аккуратнее на нашей стороне.

**Проверка на простоту**: Вариант A — самый простой из действительно работающих. Вариант B был бы проще по объёму кода (скопировать Нияза), но создаёт два MCP server'а, что нарушает simplicity на уровне пользователя (install, connector, debug). Вариант A — один MCP server, одна схема, один процесс.

## Последствия

### Что становится проще

- У пользователя один MCP connector для всей памяти Qoopia (session + notes + entities)
- Cross-query возможен: найти note, которая ссылается на сообщение из сессии; найти задачу, по которой шла переписка
- Multi-tenant isolation распространяется и на session memory автоматически через `workspace_id`
- Task-bound retention тоже работает для session-сообщений (контекст по закрытой задаче стирается)
- `qoopia install` покрывает всё — не надо отдельно настраивать `lcm-mcp`

### Что становится сложнее

- Qoopia чуть больше (3 таблицы + 5 tools добавлены)
- Нужно чётко разграничить «session messages» (короткоживущий контекст чатов) от «notes» (долгоживущая структурированная память)
- Нужен грамотный FTS5 query sanitizer (делаем лучше чем peer)

### Что мы теперь не сможем сделать

- Запустить LCM как отдельный изолированный сервис — он живёт внутри Qoopia
- Использовать готовый код lcm-mcp Нияза как drop-in (мы берём его как reference baseline, не как зависимость)
- Воспроизвести LCM **побитово** в OpenClaw — это не цель, Claude Code среда принципиально другая

### Что нужно будет пересмотреть

- Если линейные `level`-уровни саммари окажутся недостаточно гибкими — добавляем parent_links в V3.5
- Если agent-driven save окажется ненадёжным (>10% пропусков) — добавляем background reconciliation worker
- Если Claude Code добавит context engine API — можем подключиться напрямую

## Ссылки

- `docs/00-principles/03-use-cases.md` UC-7 — LCM-equivalent session memory
- `docs/decisions/ADR-002-two-layer-retrieval-layer-b-deferred.md` — контекст Layer A
- `docs/decisions/ADR-003-agent-driven-memory-ingestion.md` — механизм вызовов
- `docs/00-principles/05-non-goals.md` NG-13 — отказ от auto-summarization
- `docs/00-principles/05-non-goals.md` NG-15 — отказ от large file interception
- `~/.openclaw/extensions/lossless-claw/` — оригинальный плагин LCM (read-only reference)
- `/tmp/lcm-mcp-review/` — peer implementation Нияза Ирсалиева (изучена 2026-04-11)
