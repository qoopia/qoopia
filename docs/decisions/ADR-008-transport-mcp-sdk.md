# ADR-008: Transport — `@modelcontextprotocol/sdk` с Streamable HTTP

**Status**: accepted
**Date**: 2026-04-11
**Deciders**: Асхат + Claude

## Контекст

Qoopia V3.0 — MCP server. Нужно выбрать:
1. **MCP SDK или кастомная реализация** протокола
2. **Транспорт**: stdio, SSE, Streamable HTTP

V2 использует **кастомный JSON-RPC** парсинг (`src/api/handlers/mcp/index.ts`, 252 LoC) через Hono endpoints (`POST /mcp` + `GET /mcp` для SSE keep-alive). Реализует initialize / tools/list / tools/call / notifications руками.

Peer lcm-mcp использует **@modelcontextprotocol/sdk** (`McpServer` + `SSEServerTransport`), ~100 LoC на весь MCP layer.

## Варианты

### Вариант A (самый простой возможный): `@modelcontextprotocol/sdk` + Streamable HTTP

- Плюсы:
  - **MCP SDK делает всё** — JSON-RPC parsing, session management, tools/list, tools/call dispatch, notifications, error codes
  - **Спецификация live** — SDK обновляется с MCP spec. Мы не отстаём.
  - **Streamable HTTP** — современный MCP transport, рекомендованный для сервер-сайд. Поддерживает Claude.ai connector.
  - Меньше LoC (252 → ~80)
  - Меньше места для багов: session-ID tracking, SSE ping keep-alive, malformed JSON — всё уже решено в SDK
- Минусы:
  - Внешняя deps (~1 MB), но в бюджете H2 (≤5)
  - Version drift — если SDK выпустит breaking change, адаптируемся
  - Чуть меньше контроля над deep customizations

### Вариант B: Кастомная JSON-RPC реализация (как V2)

- Плюсы:
  - Полный контроль
  - Ноль внешних SDK deps
- Минусы:
  - 252 LoC boilerplate который можно не писать
  - **Догонять спецификацию вручную** когда Anthropic выпускает новые revisions MCP
  - Ручное session management, SSE keep-alive logic, error codes — источники bug'ов
  - В V2 уже есть — не экономит время в переписывании

### Вариант C: stdio-only transport

- Плюсы:
  - Простейший из возможных — только stdin/stdout
  - Нет HTTP server вообще
- Минусы:
  - **Не работает с Claude.ai connector** — Claude.ai требует HTTP endpoint
  - Не работает с remote клиентами (Tailscale, Сауле на другой машине)
  - Не работает с несколькими одновременными клиентами
  - Нарушает architectural fit — Qoopia V3.0 **должна** быть доступна из Claude.ai и из Claude Code одновременно

### Вариант D: Streamable HTTP custom (без SDK)

- Плюсы:
  - Current MCP transport, работает с Claude.ai
- Минусы:
  - Как B — переписываем SDK заново

## Решение

Выбран **Вариант A — `@modelcontextprotocol/sdk` + Streamable HTTP transport**.

### Обоснование

1. **Спецификационное соответствие** — MCP spec эволюционирует; SDK = мы автоматически on spec. Кастом = ручной апдейт при каждой revision.

2. **LoC экономия** — 252 → 80 LoC в transport layer. Часть бюджета H1 (≤ 2000 LoC).

3. **Совместимость** — Streamable HTTP поддерживается Claude.ai connector (primary production клиент), Claude Code MCP tooling, Cowork, Agent SDK. Один transport, все клиенты.

4. **Peer validation** — lcm-mcp Нияза использует exactly этот setup и работает в Claude Code + Tailscale.

5. **Bun совместимость** — `@modelcontextprotocol/sdk` работает в Bun (проверено в peer).

### Конкретный setup

```typescript
// src/server.ts — ~30 LoC
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamable-http.js";
import { registerTools } from "./mcp/tools.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "qoopia",
    version: "3.0.0",
    description: "Qoopia — memory and truth layer for AI agents",
  });
  registerTools(server);
  return server;
}

// src/index.ts — bootstrap
// Bun.serve handles HTTP; Streamable HTTP transport attaches to MCP requests
```

Session management, JSON-RPC parsing, tools/list, notifications — всё внутри SDK.

**Проверка на простоту**: Вариант A самый простой из тех что работают. Вариант C проще по коду, но не удовлетворяет требованию «работает с Claude.ai» (primary client). Варианты B и D одинаково отвергнуты как custom re-implementation уже готового SDK.

## Последствия

### Что становится проще

- MCP layer в V3.0 будет ~80 LoC vs 252 в V2 (−68%)
- Новые MCP features (если Anthropic добавит) — просто `bun update` + немного glue кода
- Error handling унифицирован через SDK
- Session management done-for-us

### Что становится сложнее

- **Version management SDK** — если выйдет breaking change, нужно adapt. Pin version в package.json, aware обновлений.
- **Debug deep issues** — нужно читать SDK source когда edge case появится

### Что мы теперь не сможем сделать

- Реализовать proprietary MCP extensions (не в scope Qoopia V3)
- Оптимизировать transport layer under SDK level (не актуально для нашего объёма трафика)

### Что нужно будет пересмотреть

- Если SDK забагован или необновляется — fallback на custom implementation (~250 LoC как в V2)
- Если Anthropic выпустит SDK v2 с breaking changes — мигрируем

## Ссылки

- `@modelcontextprotocol/sdk` — https://www.npmjs.com/package/@modelcontextprotocol/sdk
- `research/peers/lcm-mcp/src/index.ts` — reference использования SDK
- `docs/10-as-is/02-mcp-tools.md` — V2 кастомная реализация 252 LoC
- `docs/00-principles/04-success-criteria.md` группа H — LoC бюджеты
