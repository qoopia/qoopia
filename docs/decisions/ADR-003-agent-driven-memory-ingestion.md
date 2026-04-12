# ADR-003: Agent-driven memory ingestion via system prompt, not Claude Code hooks

**Status**: accepted
**Date**: 2026-04-11
**Deciders**: Асхат + Claude

## Контекст

Первоначальный набросок Qoopia V3 предполагал интеграцию с Claude Code через hooks:
- `SessionStart` hook → `qoopia session-bootstrap` → инжект истории в system prompt
- `UserPromptSubmit` / `PostToolUse` / `Stop` hooks → автоматическая запись сообщений в Qoopia
- `SessionEnd` hook → финальная компакция

Это было скопировано из модели LCM plugin в OpenClaw, где плагин сидел **внутри** context engine pipeline.

Изучение lcm-mcp Нияза Ирсалиева показало альтернативный подход: агент сам вызывает memory tools **через инструкции в своём system prompt**. Никаких hooks, никаких настроек Claude Code per-install. Работает в любой среде где агент может вызывать MCP tools (Claude Code, Claude.ai connectors, Cowork, OpenClaw, Telegram bot).

## Варианты

### Вариант A (самый простой возможный): агент-driven через инструкции в system prompt

Пример инструкции (≤ 20 строк):

```
## Memory

You have persistent memory via Qoopia MCP server.

On session start:
- Call session_recent(agent_id="me", session_id="YYYY-MM-DD") to load today's context
- Call recall(query="current state of <project>") to get relevant notes

During conversation:
- Call session_save for every user message and every response
- After major decisions: note(content=..., tags=..., links=[task_ids])
- Every ~20 messages: session_summarize(content=<your summary>, range=<ids>, level=1)
```

- Плюсы:
  - Работает в любой среде (Claude Code, Claude.ai, OpenClaw, Telegram)
  - Ноль конфигурации платформы
  - Никаких hooks per-install
  - Легко объясняется и переносится на новую машину
  - Переносится с агентом автоматически (system prompt живёт в файле агента)
  - Как у peer implementation (lcm-mcp Нияза) — проверено рабочим решением
- Минусы:
  - Агент может «забыть» вызвать tool — зависит от инструкции
  - Нет атомарной гарантии «каждое сообщение записано»
  - В редких случаях агент экономит токены и пропускает save

### Вариант B: Claude Code hooks + конфиг на каждой машине

- Плюсы:
  - Гарантированный автоматический ingest (не зависит от поведения агента)
  - Невозможно «забыть» записать
- Минусы:
  - Требует Claude Code hooks setup per-install
  - Ломается при обновлении Claude Code или смене конфигурации
  - Не переносится в Claude.ai connectors, Cowork, OpenClaw
  - Разные агенты в одной среде требуют разных хуков
  - Добавляет зависимость от платформы Claude Code конкретно

### Вариант C: гибрид — хуки где возможно, инструкции где нет

- Плюсы:
  - Автоматизация там где поддерживается
- Минусы:
  - Два code-path вместо одного
  - Двойные инструкции (через хук **и** через system prompt как fallback)
  - Усложняет debugging («почему не записалось? Хук не сработал или агент не вызвал?»)
  - Нарушает принцип simplicity (два способа делать одно и то же)

## Решение

Выбран **Вариант A** — agent-driven через system prompt instructions.

**Риск «агент может забыть»** смягчается тремя способами:
1. **Чёткая короткая инструкция** в system prompt (≤ 30 строк как бюджет H7) — агент её читает каждый ход
2. **Понятные имена tools** (`session_save`, `session_summarize`) — снижают когнитивную нагрузку
3. **Feedback loop**: если через некоторое время окажется что агенты систематически пропускают сохранения — мы добавляем **опциональный** background worker (не hooks!) который периодически проверяет целостность и напоминает. Это не в V3.0.

**Проверка на простоту**: Вариант A — самый простой. Один механизм, один code-path, работает везде. Выбран без компромиссов.

## Последствия

### Что становится проще

- Install на новой машине: агент получает system prompt с блоком инструкций, подключается к MCP Qoopia — всё работает. Никакой настройки хуков.
- Перенос агента с машины на машину: забираешь файл агента (с system prompt), агент на новой машине всё помнит через Qoopia.
- Смена среды (OpenClaw → Claude Code → Claude.ai): инструкция одна и та же.
- Развёртывание у Сауле: она просто подключает Qoopia как MCP и копирует инструкции в свои агенты. Никакой hook-конфигурации у неё на машине.
- Debugging: если что-то не записалось — смотрим логи агента, вопрос один («агент вызвал tool или нет»).

### Что становится сложнее

- Нужно поддерживать **качественные** инструкции в system prompt. Это документ который эволюционирует.
- При введении нового memory-tool нужно обновлять system prompt каждого агента (но это разовая операция).
- Агент тратит токены на прочтение инструкции каждый ход — это бюджет H7 (≤ 30 строк).

### Что мы теперь не сможем сделать

- Гарантировать «ни одно сообщение не пропущено» на уровне системы. Полагаемся на дисциплину агента + его инструкцию.
- Автоматически перехватывать `PreToolUse` — если какой-то tool требует специальной логики на уровне контекста (например, «перед чтением большого файла проверь не читал ли уже»), это должно быть реализовано как вызов Qoopia **изнутри** system prompt, а не как hook.

### Что нужно будет пересмотреть

- Если агенты массово пропускают сохранения (>10% сообщений теряется) — добавляем reconciliation background worker в V3.5 (не hooks, а периодический audit).
- Если Claude Code добавит стандартизованный MCP-hook API — можем пересмотреть.

## Ссылки

- `docs/00-principles/03-use-cases.md` UC-7 — LCM absorption через этот подход
- `research/peers/lcm-mcp/README.md` — пример block инструкции в system prompt
- `docs/00-principles/PHASE-1.5-SIMPLICITY-PASS.md` — контекст Simplicity Pass
