# Peer implementations

Здесь лежат копии сторонних реализаций, которые мы изучаем как reference и baseline для Qoopia V3. **Не зависимости и не код для копирования** — только чтобы сравнить наши решения с чужими.

## lcm-mcp

**Автор**: Нияз Ирсалиев
**Изучено**: 2026-04-11
**Источник**: ZIP получен от Асхата (`~/Downloads/lcm-mcp.zip`)
**Лицензия**: MIT (см. `lcm-mcp/LICENSE`)

**Суть**: MCP server для Claude Code, заменяющий Lossless Context Management функцию в среде где нет OpenClaw plugin system. 665 строк, 2 файла (`src/db.ts`, `src/index.ts`), Bun + SQLite + FTS5 + SSE. 8 MCP tools: save, search, recent, expand, summarize, sessions, agents, stats.

**Что мы взяли как идеи** (интегрировано в наши ADR):
- Agent-driven ingestion через system prompt — ADR-003
- FTS5 вместо embeddings для session memory — ADR-002
- Agent-written summaries без отдельного LLM cascade — NG-13
- 100 KB content cap вместо large file interception — NG-15
- SSE transport для Tailscale-ready multi-machine deployment
- SQLite PRAGMA setup (WAL, busy_timeout, foreign_keys)
- HTTP health endpoint как минимальная observability

**Что мы делаем иначе**:
- Workspace isolation (у Нияза только agent_id)
- Task-bound retention
- Структурированные entities через notes с type + metadata
- Более аккуратный FTS5 query sanitizer
- Schema versioning и миграции
- Cross-query между session memory и notes

**Почему НЕ используем код напрямую**: нужна интеграция с существующим Qoopia data model, multi-tenant workspace, task-bound retention. Берём как **baseline для simplicity budgets** (группа H в 04-success-criteria.md) — не имеем права быть на порядок сложнее без явного обоснования.
