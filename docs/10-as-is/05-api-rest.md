# 05 — AS-IS: REST API handlers

**Источник**: `~/.openclaw/qoopia/src/api/handlers/`
**Всего REST handlers LoC**: **3928** (включая oauth 906 и auth 212 которые audited в 04-auth.md)

## Список всех handlers

| Handler | LoC | Назначение | V3.0 |
|---|---|---|---|
| `oauth.ts` | 906 | OAuth 2.0 full spec | → 180 (см. 04-auth) |
| `openapi.ts` | 316 | OpenAPI spec generator | **DROP** |
| `deals.ts` | 277 | REST CRUD для deals | **DROP** (merged into notes) |
| `agents.ts` | 261 | Agent management | → 80 (см. 04-auth) |
| `tasks.ts` | 259 | REST CRUD для tasks | **DROP** |
| `projects.ts` | 223 | REST CRUD для projects | **DROP** |
| `contacts.ts` | 224 | REST CRUD для contacts | **DROP** |
| `auth.ts` | 212 | Magic link auth | **DROP** (см. 04-auth) |
| `finances.ts` | 210 | REST CRUD для finances | **DROP** |
| `observe.ts` | 158 | SSE stream для dashboard | **DROP** |
| `export.ts` | 127 | JSON/CSV export | **DROP** (или отложено) |
| `files.ts` | 114 | File attachments | **DROP** |
| `health.ts` | 100 | Health checks | **KEEP + SIMPLIFY** |
| `batch.ts` | 92 | Batch operations | **DROP** |
| `events.ts` | 89 | Events REST endpoints | **DROP** |
| `search.ts` | 81 | REST search | **DROP** (replaced by MCP recall) |
| `activity.ts` | 51 | REST activity log | **DROP** (replaced by MCP) |
| `reindex.ts` | 35 | FTS5 reindex | **KEEP** (admin tool) |
| `mcp.ts` | 1 | Re-export | dropped after refactor |
| **Всего handlers** | **3928** | | **~280** |
| + `mcp/*` (MCP tools) | ~2000 | Разобрано в 02-mcp-tools | **~500** |
| **Итого api layer** | **~5928** | | **~780** |

## Основные категории

### A. Entity CRUD handlers — **DROP all** (kept only через MCP)

**Файлы**: `tasks.ts`, `deals.ts`, `contacts.ts`, `finances.ts`, `projects.ts`, `activity.ts`, `search.ts`

**Всего LoC**: 259 + 277 + 224 + 210 + 223 + 51 + 81 = **1325 LoC**

**Что делают**: зеркалируют MCP tools через REST API. Каждый `POST /tasks`, `PATCH /tasks/:id`, `DELETE /tasks/:id`, `GET /tasks` и т.п.

**Кто использует** в prod:
- Dashboard (отложен в V3.0 по NG-5)
- Внешние системы через REST API — в теории да, на практике никто не использует
- Агенты — **не используют** REST, они ходят через MCP

**Решение V3.0**: **DROP all 7 files**.

**Обоснование**: дублирование кода, нет реальных потребителей, Phase 1 Simplicity Pass решил «MCP как primary API, REST только минимальный для operator/health». Это радикальное упрощение **−1325 LoC одним махом**.

**Если понадобится REST для внешних систем в V3.5+**: добавляем тонкий REST-to-MCP proxy — один handler который принимает REST запрос и вызывает MCP handleToolCall() внутри. 50 LoC макс.

### B. Batch / Events / Export / Files — **DROP all**

**Файлы**: `batch.ts` (92), `events.ts` (89), `export.ts` (127), `files.ts` (114)

**Всего LoC**: **422 LoC**

**`batch.ts`** — batch operations endpoint. Полезно для массовых импортов. Не используется в реальности. **DROP**.

**`events.ts`** — REST endpoint для получения списка events / activity. Overlap с `activity.ts` и с MCP `list(entity='activity')`. **DROP**.

**`export.ts`** — экспорт данных в JSON/CSV. Полезно для backup, но в V3.0 backup — через SQLite dump (`sqlite3 db.db .dump > backup.sql`). Не нужно REST endpoint. **DROP**.

**`files.ts`** — file attachments на задачи/сделки. Связано с `tasks.attachments JSON` поле. В V3.0 files handling отложен (NG-15). **DROP**.

**Возврат в V3.5**: export как part of operator UI, files как отдельный sub-system если понадобится.

### C. Observer / SSE — **DROP**

**Файл**: `observe.ts` (158 LoC)

**Что делает**: подключается к `eventBus` как SSE subscriber, стримит события real-time клиенту (dashboard для live updates).

**Решение**: **DROP**. Причины:
1. `event-bus.ts` выкидывается (03-core-services 03.5)
2. Dashboard отложен (NG-5)
3. Real-time push агенту не нужен — он polling'ом через `brief()`

**Экономия**: 158 LoC + eliminates SSE infrastructure сложности.

### D. OpenAPI spec generator — **DROP**

**Файл**: `openapi.ts` (316 LoC)

**Что делает**: генерирует OpenAPI 3.0 spec на основе registered handlers для автодокументации API.

**Решение**: **DROP**. Причины:
1. Большинство REST handlers удаляется → нечего документировать
2. MCP surface имеет свою документацию через tool definitions
3. OpenAPI — over-engineering для локального single-user сервера
4. 316 LoC самогенерируемой документации которую никто не читает — чистое over-engineering

**Если понадобится**: генерируется на базе MCP tool definitions автоматически, 30 LoC.

**Экономия**: 316 LoC.

### E. Health checks — **KEEP + SIMPLIFY**

**Файл**: `health.ts` (100 LoC)

**Что делает**: probably several endpoints — `/health`, `/ready`, possibly DB check, migration status, version info.

**Решение**: **KEEP core** — `/health` endpoint нужен для `qoopia install` verification (Группа D критерии). **SIMPLIFY** до 1 endpoint:

```
GET /health
→ { status: "ok", version: "3.0.0", db: "connected", uptime_s: N, workspace_count: N, agent_count: N }
```

**Размер**: 100 → ~30 LoC.

### F. Reindex — **KEEP**

**Файл**: `reindex.ts` (35 LoC)

**Что делает**: admin endpoint для пересчёта FTS5 индекса (нужно после большой миграции или если FTS5 corruption).

**Решение**: **KEEP**. 35 LoC, полезно для V3 миграции и recovery. Attaches к operator UI в V3.0.

### G. MCP handler — 1 LoC re-export

`mcp.ts` — после рефакторинга Pass 4 это просто `export * from './mcp/index.js'`. 1 строка. Исчезает при переходе на новую структуру.

## Router

**File**: `src/api/router.ts` (unknown LoC, not yet read but will be less important in V3.0)

Hono app с регистрацией всех роутов. В V3.0 router становится **очень маленький**:

```typescript
import { Hono } from 'hono';
import mcp from './mcp/index.js';
import oauth from './oauth/index.js';
import health from './health.js';
import admin from './admin.js';

const app = new Hono();
app.use(requestId);
app.use(cors);
app.route('/mcp', authMiddleware, mcp);
app.route('/oauth', oauth);        // no auth, OAuth itself IS auth
app.route('/.well-known', oauth);  // discovery, public
app.route('/health', health);      // public
app.route('/admin', authMiddleware, admin); // operator UI
export default app;
```

**Размер**: ~50 LoC максимум.

## Сводка REST layer

| Категория | V2 LoC | V3.0 LoC |
|---|---|---|
| Entity CRUD (7 files) | 1325 | **0** |
| Batch/events/export/files | 422 | **0** |
| Observer SSE | 158 | **0** |
| OpenAPI spec generator | 316 | **0** |
| Health | 100 | ~30 |
| Reindex | 35 | 35 |
| OAuth | 906 | ~180 |
| Auth magic links | 212 | **0** |
| Agents admin | 261 | ~80 |
| Router | ? | ~50 |
| **Всего** | **~3735** | **~375** |

**Экономия**: **~3360 LoC (−90%)** в REST handlers.

## src/index.ts (entry point)

Короткий read подтвердил:
```typescript
runMigrations();
eventBus.subscribe({id:'__webhooks__', handler: dispatchWebhooks, ...});  // DROP в V3.0
startMaintenanceSchedule();
const server = serve({ fetch: api.fetch, port: PORT });
// graceful shutdown: stopMaintenanceSchedule + eventBus.closeAll + server.close + db.close
```

**Решение V3.0**: **SIMPLIFY**.

```typescript
// V3.0 index.ts — ~30 LoC
import { serve } from '@hono/node-server';  // или Bun.serve
import { runMigrations } from './db/migrate.js';
import { rawDb } from './db/connection.js';
import { startMaintenance } from './core/retention.js';
import app from './router.js';

runMigrations();
startMaintenance();

const server = serve({ fetch: app.fetch, port: Number(process.env.PORT || 3737) });

function shutdown() {
  server.close(() => {
    rawDb.pragma('wal_checkpoint(TRUNCATE)');
    rawDb.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

**Размер**: ~30 LoC vs current ~50. Без eventBus, без webhooks, без разнообразных subsystem initializations.
