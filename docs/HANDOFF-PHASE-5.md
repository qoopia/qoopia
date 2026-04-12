# HANDOFF → Phase 5 Execute

**Создан**: 2026-04-11, в конце сессии 1
**Читать в следующей сессии ПЕРВЫМ** после `CLAUDE.md` и recall из Qoopia.

---

## TL;DR для следующей сессии

Ты — новая сессия Claude, только что открытая. Задача:
1. Прочитай `CLAUDE.md` в корне
2. Прочитай **этот документ** (HANDOFF-PHASE-5.md)
3. Сделай `recall("QOOPIA V3 PHASE")` в Qoopia MCP — получишь несколько checkpoint notes
4. **НЕ читай** старые документы Phase 1-4 подряд. Они есть в `docs/`, читай только нужные когда дойдёшь до соответствующего шага реализации.
5. Начни **Phase 5 Execute** по плану ниже

**Контекст**: Асхат хочет закончить реализацию и cutover **сегодня**. Нет недель ожидания. Нет медленного 22-дневного rollout. Цель: V3 ships, agents migrated, V2 off — за одну сессию.

**Текущий статус**: 5 из 6 фаз проектирования завершены. Blueprint полный. Осталось **написать код** и **выполнить cutover**.

---

## Что уже сделано (session 1, 2026-04-11)

### Design phases закрыты (5 из 6)

| Фаза | Deliverables | Commit |
|---|---|---|
| 0. Setup | workspace, git, ADR-001 | `89b1b2d` |
| 1. Principles | 5 документов в `docs/00-principles/` | `d0a777c`-`0fc3136` |
| 1.5. Simplicity Pass | Audit + 8-point simplification | `46ca415` |
| 2. AS-IS audit | 9 документов в `docs/10-as-is/` | `e9738c5` |
| 3. TO-BE design | 5 документов в `docs/20-to-be/` + ADR-007/008/009/010 | `0914f11` |
| 4. Migration planning | 4 документа в `docs/30-migration/` + ADR-011 | `28e2505` |

### 11 ADR зафиксированы

| ADR | Решение |
|---|---|
| 001 | Отдельный workspace `~/qoopia-v3/`, прод V2 read-only |
| 002 | Two-layer retrieval, Layer B (semantic) deferred to V3.5 — **V3.0 = FTS5 only** |
| 003 | Agent-driven memory ingestion via system prompt, **not** Claude Code hooks |
| 004 | Radical simplicity as first-class principle + numeric budgets |
| 005 | Qoopia V3 absorbs LCM functionality via Layer A session memory |
| 006 | Phase 1 accepted after Simplicity Pass |
| 007 | **Runtime = Bun 1.x** (primary), Node 22+ as fallback |
| 008 | **Transport = `@modelcontextprotocol/sdk` + Streamable HTTP** |
| 009 | **Auth = opaque tokens** (OAuth) + SHA-256 API keys (agents) |
| 010 | Phase 3 accepted |
| 011 | Phase 4 accepted |

---

## Критические baseline цифры для Phase 5

### Target architecture (Phase 3 TO-BE)

| Метрика | Бюджет | Цель |
|---|---|---|
| **H1 Core LoC** (без migration scripts) | ≤ 2000 | ~1725 |
| **H2 Runtime deps** | ≤ 5 | 3 (`@modelcontextprotocol/sdk`, `zod`, `ulid`) |
| **H3 Real tables** | ≤ 10 | 10 |
| **H4 Config files в default install** | 0 | 0 |
| **H5 Install команды** | ≤ 3 | 2 (`bun install` + `bunx qoopia install`) |
| **H6 До первого успешного вызова** | ≤ 2 мин | ~40-60 сек |
| **H7 System prompt lines в agent template** | ≤ 30 | 17-29 |
| **H8 MCP tools** | ≤ 15 | 13 |

### Stack решения (ADR-007/008/009)

- **Runtime**: Bun 1.x
- **DB**: `bun:sqlite` (встроенный в Bun) + SQLite FTS5
- **HTTP**: `Bun.serve()` (встроенный, не Hono)
- **MCP**: `@modelcontextprotocol/sdk` с Streamable HTTP transport
- **Validation**: zod
- **IDs**: ulid
- **Auth**: SHA-256 API keys (agents) + opaque tokens (OAuth для Claude.ai)

---

## Phase 5 Execute — последовательность работ

**Цель**: написать V3.0 code, выполнить миграцию, сделать cutover — в одной сессии.

### Шаг 0: Подготовка workspace

```bash
cd ~/qoopia-v3
ls  # должно быть: docs/, research/, README.md, CLAUDE.md, .claude/

# Создать code структуру
mkdir -p src/{mcp,services,db,auth,admin,utils} scripts migrations
```

### Шаг 1: package.json + tsconfig.json

Файл `package.json`:
```json
{
  "name": "qoopia",
  "version": "3.0.0",
  "description": "Memory and truth layer for AI agents",
  "type": "module",
  "bin": {
    "qoopia": "src/cli.ts"
  },
  "scripts": {
    "start": "bun run src/index.ts",
    "dev": "bun --watch run src/index.ts",
    "install-service": "bun run src/admin/install.ts",
    "migrate-from-v2": "bun run scripts/migrate-from-v2.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0",
    "ulid": "^2.3.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.7.0"
  }
}
```

`tsconfig.json` — стандартный Bun preset (можно копировать из `research/peers/lcm-mcp/tsconfig.json` как baseline).

### Шаг 2: Initial migration SQL

Скопировать DDL из `docs/20-to-be/01-schema.md` в `migrations/001-initial-schema.sql`.

**Это literal copy-paste**. DDL уже готов, 10 таблиц + FTS5 triggers + indexes.

### Шаг 3: `src/db/connection.ts` + `src/db/migrate.ts`

```typescript
// src/db/connection.ts — ~30 LoC
import { Database } from "bun:sqlite";
import path from "path";
import fs from "fs";

const DATA_DIR = process.env.QOOPIA_DATA_DIR || path.join(process.env.HOME!, ".qoopia/data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "qoopia.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA foreign_keys = ON");

export function runInTransaction<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
```

```typescript
// src/db/migrate.ts — ~50 LoC
import { db } from "./connection.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "../../migrations");

export function runMigrations() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`);

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
  for (const file of files) {
    const version = parseInt(file.split("-")[0]);
    const applied = db.prepare("SELECT 1 FROM schema_versions WHERE version = ?").get(version);
    if (applied) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec("COMMIT");
      console.log(`✓ Applied migration ${file}`);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${err}`);
    }
  }
}
```

### Шаг 4: `src/auth/` — SHA256 API keys + OAuth opaque tokens

Скопировать логику из `docs/20-to-be/04-install.md` OAuth section + `docs/10-as-is/04-auth.md` «что остаётся в V3.0 auth layer».

Файлы:
- `src/auth/api-keys.ts` — `createApiKey()`, `verifyApiKey()` (SHA256 lookup in agents)
- `src/auth/oauth.ts` — PKCE code flow + token endpoint + revoke endpoint
- `src/auth/middleware.ts` — extract Bearer, lookup in agents OR oauth_tokens, set auth context
- `src/auth/well-known.ts` — `/.well-known/oauth-authorization-server` + `/.well-known/oauth-protected-resource`

Total ~225 LoC.

### Шаг 5: `src/services/` — бизнес логика

Файлы:
- `src/services/notes.ts` — CRUD для universal notes table. Shallow metadata merge в update. ~80 LoC
- `src/services/sessions.ts` — session_save, session_recent, session_search, session_summarize, session_expand. ~100 LoC
- `src/services/recall.ts` — FTS5 query sanitizer + query builder + cost metric. ~60 LoC
- `src/services/brief.ts` — workspace snapshot builder. ~40 LoC
- `src/services/activity.ts` — logActivity helper. ~20 LoC
- `src/services/retention.ts` — daily maintenance: task-bound purge, idempotency cleanup, old activity purge, daily backup. ~60 LoC

Total ~360 LoC.

### Шаг 6: `src/mcp/tools.ts` — регистрация всех 13 MCP tools

Скопировать specs из `docs/20-to-be/02-mcp-tools.md`. Для каждого tool:

```typescript
server.tool("note_create", description, inputSchema, async (args, { authInfo }) => {
  // Validate workspace_id scope via authInfo
  const result = await notesService.create({
    ...args,
    workspace_id: authInfo.workspace_id,
    agent_id: authInfo.agent_id,
  });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});
```

13 handlers × ~35 LoC = ~450 LoC.
+ Registration + profile filtering + helpers ~80 LoC.
Total ~530 LoC.

### Шаг 7: `src/index.ts` + `src/server.ts` — bootstrap

```typescript
// src/server.ts — ~30 LoC
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamable-http.js";
import { registerTools } from "./mcp/tools.js";

export function createMcpServer(authContext: AuthContext): McpServer {
  const server = new McpServer({
    name: "qoopia",
    version: "3.0.0",
    description: "Memory and truth layer for AI agents",
  });
  registerTools(server, authContext);
  return server;
}
```

```typescript
// src/index.ts — ~60 LoC
import { runMigrations } from "./db/migrate.js";
import { db } from "./db/connection.js";
import { startMaintenance } from "./services/retention.js";
import { createHttpHandler } from "./http.js";

runMigrations();
startMaintenance();

const PORT = parseInt(process.env.QOOPIA_PORT || "3737");
const server = Bun.serve({
  port: PORT,
  fetch: createHttpHandler(),
});

console.log(`Qoopia V3.0 listening on http://localhost:${PORT}`);

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

function shutdown() {
  console.log("Shutting down...");
  server.stop();
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  process.exit(0);
}
```

`src/http.ts` — маршрутизация HTTP requests к MCP transport + OAuth + health + admin. ~80 LoC.

### Шаг 8: `src/admin/` — install CLI и admin commands

Файлы:
- `src/admin/install.ts` — `qoopia install`. Создаёт directories, запускает migrations, создаёт default workspace + admin agent, генерирует API key, пишет launchd plist, loads service, prints success banner. ~120 LoC
- `src/admin/agents.ts` — create/list/rotate-key/delete agent. ~60 LoC
- `src/admin/workspaces.ts` — create-workspace. ~20 LoC
- `src/cli.ts` — entry point для `qoopia <command>`. ~50 LoC

Template для launchd plist — в `docs/20-to-be/04-install.md`, copy verbatim.

Total ~250 LoC.

### Шаг 9: `scripts/migrate-from-v2.ts` — migration script

Скопировать executable spec из `docs/30-migration/01-data-migration.md`. 18 секций (A-R) — каждая становится function. Транзакционный, идемпотентный.

~400 LoC.

### Шаг 10: `scripts/verify-migration.ts` — verification

Скопировать из `docs/30-migration/01-data-migration.md` verification section. Count checks + sample spot-checks + FTS5 smoke test + cross-reference validation.

~100 LoC.

### Total Phase 5 implementation LoC estimate

| Module | LoC |
|---|---|
| Migration SQL | 200 (SQL, не считается в H1) |
| db/ | 80 |
| auth/ | 225 |
| services/ | 360 |
| mcp/tools + server | 640 |
| index/http/bootstrap | 170 |
| admin/cli/install | 250 |
| utils (logger, validators, errors) | ~100 |
| **Total core** | **~1825** |
| scripts/migrate-from-v2 | 400 |
| scripts/verify-migration | 100 |
| **Scripts (not in H1)** | **500** |

**H1 бюджет ≤ 2000 LoC: в рамках с запасом 175 LoC.**

### Шаг 11: Smoke test на dev машине

```bash
cd ~/qoopia-v3
bun install
bun run src/index.ts  # should start on 3737

# В другом терминале:
curl http://localhost:3737/health
# → {"status":"ok","version":"3.0.0",...}
```

### Шаг 12: Run migration on Askhat Mac Mini

**ВАЖНО**: V3 не должна конфликтовать с живой V2. V2 работает на порту 3737 (или через OpenClaw gateway). V3 **ставится на порт 3738** для параллельной работы.

```bash
# Stop conflict: если порт 3737 занят V2, использовать 3738
QOOPIA_PORT=3738 bunx qoopia install
# → creates ~/.qoopia/data/qoopia.db with fresh schema
# → installs launchd plist on port 3738
# → prints admin API key

# Run migration
bun run scripts/migrate-from-v2.ts --source ~/.openclaw/qoopia/data/qoopia.db
# → reads V2 read-only, transforms rows, writes to V3
# → prints report with counts

# Verify
bun run scripts/verify-migration.ts
# → all checks pass
```

### Шаг 13: Freeze V2 (read-only)

```bash
chmod 444 ~/.openclaw/qoopia/data/qoopia.db
chmod 444 ~/.openclaw/qoopia/data/qoopia.db-wal 2>/dev/null || true
chmod 444 ~/.openclaw/qoopia/data/qoopia.db-shm 2>/dev/null || true
```

### Шаг 14: Migrate agents (в ускоренном режиме — по желанию Askhat)

**Классический план** (из Phase 4 02-cutover.md) — 3 дня observation per agent. ~22 дня total.

**Ускоренный план** (если Askhat хочет сегодня):
1. Migrate Alan → smoke test → если OK (5 min), next
2. Migrate Aizek → smoke test → если OK, next
3. Migrate Dan → smoke test → next
4. Migrate Claude → smoke test → next
5. Migrate Aidan last → smoke test

**Risk**: без 3-day observation может пропустить edge cases. **Mitigation**: V2 остаётся read-only и rollback в любой момент занимает 5 минут.

**Per-agent procedure**:
```
1. cd ~/.openclaw/agents/<name>  (или где живёт prompt файл)
2. Backup current prompt: cp prompt.md prompt.md.bak
3. Edit prompt.md: 
   - Remove bloated project context section
   - Add Memory (Qoopia) block из docs/20-to-be/03-system-prompt.md (выбрать template)
4. Add MCP connector config:
   {
     "qoopia": {
       "type": "streamable-http",
       "url": "http://localhost:3738/mcp",
       "headers": {"Authorization": "Bearer <agent key>"}
     }
   }
5. Remove old Qoopia V2 connector config
6. Restart agent
7. Smoke test: ask agent "What's your current state?" — should reference data from V3
```

### Шаг 15: Port swap (опционально)

Если всё работает и хочется чтобы V3 жила на «исторически» важном порту 3737:

```bash
# Stop V2
launchctl unload ~/Library/LaunchAgents/com.openclaw.gateway.plist  # OR whatever
# Stop V3
launchctl unload ~/Library/LaunchAgents/com.qoopia.mcp.plist

# Edit plist: change port from 3738 to 3737
# Or set env var QOOPIA_PORT=3737

# Restart V3 on new port
launchctl load ~/Library/LaunchAgents/com.qoopia.mcp.plist

# Update all agent configs from port 3738 → 3737
```

### Шаг 16: Final verification + Stop V2

```bash
# V3 health check
curl http://localhost:3737/health

# V2 shutdown (if port swap done)
launchctl unload ~/Library/LaunchAgents/com.openclaw.gateway.plist

# Backup V2 data
cp ~/.openclaw/qoopia/data/qoopia.db ~/.openclaw/qoopia/data/backup-pre-v3-$(date +%Y%m%d).db

# V2 files preserved (do NOT delete)
```

**Cutover complete**.

### Шаг 17: Push code to GitHub (опционально)

Ранее Асхат упомянул что хочет push в GitHub после завершения.

```bash
cd ~/qoopia-v3
gh repo create askhatsoltanov/qoopia-v3 --private --source=. --push
# или --public если хочется публично
```

**Уточнить с Асхатом**: private vs public, owner namespace.

---

## Файлы для reference в Phase 5

### Must-read для каждого шага

| Задача | Какой doc читать |
|---|---|
| DDL / schema | `docs/20-to-be/01-schema.md` |
| MCP tool implementation | `docs/20-to-be/02-mcp-tools.md` |
| Auth implementation | `docs/20-to-be/00-overview.md` + ADR-009 |
| System prompts для агентов | `docs/20-to-be/03-system-prompt.md` (6 templates) |
| Install / CLI / launchd | `docs/20-to-be/04-install.md` |
| Migration script code | `docs/30-migration/01-data-migration.md` |
| Cutover runbook | `docs/30-migration/02-cutover.md` |
| Peer reference (simplicity baseline) | `research/peers/lcm-mcp/` |

### ADRs к которым стоит обращаться

| Вопрос в коде | ADR |
|---|---|
| Почему Bun а не Node | ADR-007 |
| Почему MCP SDK а не custom | ADR-008 |
| Почему opaque tokens а не JWT | ADR-009 |
| Почему одна таблица notes а не per-entity | ADR-004 simplicity + Phase 1.5 scope |
| Почему нет semantic search | ADR-002 |
| Почему agent сам зовёт session_save а не hooks | ADR-003 |
| Почему Qoopia включает LCM functionality | ADR-005 |

---

## Критические вещи НЕ ЗАБЫТЬ

### 1. 300-char truncation bug FIX

В V3.0 tool `recall()` **никогда не truncate'ит text**. Это literal удаление одной строки по сравнению с V2 (`memory.ts:218`). Response поле `text` — целое.

### 2. Hard cap 100 KB на content

В `note_create` и `session_save` — если content > 100 KB, возвращаем error с инструкцией разбить. NG-15.

### 3. workspace_id scope enforcement

Каждый SQL query в услугах **обязан** иметь `WHERE workspace_id = ?` с значением из `authInfo.workspace_id`. Исключение — Claude с `agents.type = 'claude-privileged'` имеет право на cross-workspace read (но не write).

Помоги себе: напиши helper `ensureWorkspaceScope(sql, workspaceId, params)` который проверяет в testing что WHERE присутствует.

### 4. Agent API keys — migrated as-is

Таблица `agents` мигрируется с сохранением `api_key_hash`. Это означает что **Alan/Aizek/Aidan/Dan/Claude продолжают работать** с теми же API keys после cutover, без re-generation.

### 5. Active OAuth tokens migrated

`oauth_tokens` WHERE `revoked=0 AND expires_at > now()` переносятся. Claude.ai connector **не требует re-auth** после cutover. Это защищает от потери всех Claude сессий.

### 6. V2 DB никогда не модифицируется

После migration start: `chmod 444` на V2 DB. Все operations против V2 строго read-only. Rollback path гарантирован.

### 7. Идемпотентность migration script

Все `INSERT` в migration script используют `ON CONFLICT ... DO NOTHING`. Можно re-run без ошибок. Если partial failure — просто запустить опять.

### 8. Phase 5 = implementation, not design

Если в процессе coding возникает архитектурный вопрос — **не решать на ходу**. Открыть соответствующий TO-BE doc, найти ответ, следовать ему. Если ответа нет — **это означает Phase 3 пропустила design gap**, нужно написать явный ADR-correction.

### 9. CLAUDE.md правила

- Русский язык в общении
- Краткие ответы без filler-фраз
- Прямота важнее вежливости
- Не придумывать факты
- Прод V2 **read-only** (кроме migration start chmod) — не запускать код против живого V2 без подтверждения

### 10. Checkpoint notes в Qoopia

После каждого существенного шага Phase 5 — `note()` с тегом `QOOPIA V3` и coherent прогрессом. Это даст **следующей** сессии (если вдруг Phase 5 не closes in one session) быстрый pickup.

---

## Risk awareness

### Риски ускоренного cutover (без 3-day observation)

| Риск | Mitigation |
|---|---|
| Edge case в FTS5 запросе который не найдёт пока агент не воспроизведёт | V2 read-only rollback за 5 мин |
| `session_save` ошибается на tool_call metadata | V2 rollback + fix + retry |
| Aidan email task-bound purge преждевременный | Проверить F3 на **тестовой задаче** перед Aidan migration |
| Claude cross-workspace privilege misconfigured | Smoke test с двумя workspaces перед Claude migration |
| OAuth token migration ломает Claude.ai connector | Tested upfront, иначе force re-auth через browser |

### Risks implementation в одну сессию

| Риск | Mitigation |
|---|---|
| Context window exhaustion в Claude Code | **Начать с чистой сессии** из `~/qoopia-v3`, не continuation |
| Bun `@modelcontextprotocol/sdk` compatibility bug | Fallback на Node согласно ADR-007 escape hatch (~50 LoC diff) |
| FTS5 query syntax parsing errors | Test sanitizer на sample queries перед registration |
| Launchd plist не работает как ожидается | Manual `bun run src/index.ts` fallback |

---

## Success criteria для Phase 5

После Phase 5 должно быть **true**:

- [ ] V3.0 код написан и тестируется локально (`bun run src/index.ts` работает)
- [ ] `bunx qoopia install` работает на чистом dir (H5 ≤ 3 команды)
- [ ] Migration script переносит prod V2 данные без потерь (verify script passes)
- [ ] Хотя бы один agent успешно использует V3 в реальной работе (Alan как minimum)
- [ ] V2 read-only mode активен
- [ ] Daily backup запускается (файл в `~/.qoopia/backups/`)
- [ ] Primary acceptance test: agent system prompt containing Qoopia block ≤ 30 строк, agent помнит контекст через session_recent

**Optional (bonus Phase 5 в одну сессию)**:
- [ ] Все 5 agents migrated
- [ ] V2 stopped
- [ ] Port swap 3738 → 3737
- [ ] Code pushed to GitHub

---

## Session 1 стейт при close

**Git state**:
- Branch: `claude/nice-saha` (worktree в `.claude/worktrees/nice-saha/`)
- Main: `main` branch
- Commits ahead of main: ~12
- Remote: **none** (локальный репо без origin)

**Qoopia V2 state**: untouched. Все изменения только в `~/qoopia-v3/` worktree.

**Checkpoint notes в Qoopia MCP** (recall с тегом "QOOPIA V3 PHASE"):
- Phase 1 close: `01KNZDP8MXZNCGMNWH7SHZV25R`
- Phase 1.5 + Phase 1 final: `01KNZHZK62QS6GQ1HRAWWTBAX0`
- Phase 2 close: `01KNZK4PD4EDKMH1B1DKNPN762`
- Phase 3 close: `01KNZMF2BYTDHGBMKPBX7WXDDH`
- Phase 4 close: `01KNZMYP2DFMTN3CBYNJ6Z3Y5R`

---

## Final instruction для следующей Claude сессии

```
Шаг 0: Прочитать CLAUDE.md + этот файл + recall("QOOPIA V3 PHASE") в Qoopia

Шаг 1: Sanity check — ls docs/, git log --oneline -5, посмотреть README

Шаг 2: Начать Phase 5 execute по плану выше (шаги 0-17)

Шаг 3: НЕ ОБСУЖДАТЬ design — всё решено. Только implementation.

Шаг 4: Коммитить после каждого крупного блока (миграции, auth, services, tools, install). 
       Checkpoint note после каждого коммита.

Шаг 5: Если что-то непредвиденное — stop, ask Askhat. НЕ импровизировать архитектурные решения.

Шаг 6: Целевой конец: V3 работает на Askhat Mac, хотя бы Alan на V3, V2 read-only.
       Stretch: все agents migrated, V2 off, GitHub push.
```

---

**Удачи следующей сессии. Blueprint полный. Код не должен содержать сюрпризов.**
