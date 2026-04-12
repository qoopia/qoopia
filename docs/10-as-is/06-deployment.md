# 06 — AS-IS: Deployment, runtime, migrations

**Источник**: `~/.openclaw/qoopia/start.sh`, `package.json`, `migrations/` (пуст), `src/db/`

## 06.1 Runtime и startup

### `start.sh`

```sh
#!/bin/sh
REQUIRED_NODE="/Users/askhatsoltanov/.nvm/versions/node/v24.14.0/bin/node"
if [ ! -x "$REQUIRED_NODE" ]; then
  echo "FATAL: Required Node not found at $REQUIRED_NODE" >&2
  exit 1
fi
export PATH="$(dirname $REQUIRED_NODE):$PATH"
ACTUAL_VERSION=$($REQUIRED_NODE -v)
echo "Qoopia starting with Node $ACTUAL_VERSION (required: v24.14.0)"
export QOOPIA_PUBLIC_URL="${QOOPIA_PUBLIC_URL:-https://mcp.qoopia.ai}"
export PORT="${PORT:-3737}"
cd /Users/askhatsoltanov/.openclaw/qoopia
exec $REQUIRED_NODE node_modules/.bin/tsx src/index.ts
```

**Наблюдения**:
1. **Hardcoded path** к Node `v24.14.0` через nvm путь Асхата → **ХАРДКОД**, именно это нарушение ADR-004 "multi-tenant ready from day 1"
2. **Hardcoded cwd** `cd /Users/askhatsoltanov/.openclaw/qoopia` → ещё один хардкод
3. **Hardcoded public URL** `https://mcp.qoopia.ai` — Асхатовский домен
4. `tsx` runs TypeScript без build step — это может быть dev-style, но работает в prod
5. Порт 3737 по умолчанию

**Решение V3.0**: **SIMPLIFY + DEHARDCODE**.

```sh
#!/usr/bin/env bash
# Zero-hardcode V3 startup
PORT="${QOOPIA_PORT:-3737}"
DATA_DIR="${QOOPIA_DATA_DIR:-$HOME/.qoopia/data}"
PUBLIC_URL="${QOOPIA_PUBLIC_URL:-http://localhost:$PORT}"
mkdir -p "$DATA_DIR"
exec bun run src/index.ts  # или node dist/index.js
```

**Или** ещё проще: `start.sh` вообще не нужен, если `package.json` `start` скрипт делает то же самое.

**В V3.0**:
- Zero hardcoded paths
- Zero hardcoded URLs
- `XDG_DATA_HOME` или `~/.qoopia/data` как дефолт
- Runtime detected, не required specific version
- `qoopia install` script настраивает launchd plist (см. ниже)

**Экономия**: полное устранение хардкодов (требование ADR «no hardcoded askhat/paths») + совместимость с Сауле из коробки.

### package.json scripts

V2:
```
"start": "node dist/index.js",
"dev": "tsx watch src/index.ts",
"build": "tsc && npm run copy-assets",
"migrate": "tsx src/db/migrate.ts",
"test": "vitest"
```

V3.0: **KEEP** same pattern. Возможно заменить `node` → `bun` если переходим на Bun runtime. Добавить:
- `install` — one-command setup (создаёт data dir, применяет миграции, готов к запуску)
- `admin` — CLI для управления agents/workspaces (операторский интерфейс)

## 06.2 Migrations

### Состояние

Папка `~/.openclaw/qoopia/migrations/` — **пуста**. Миграции живут в коде (`src/db/migrate.ts`).

Реально применённые миграции (из `schema_versions` таблицы):
1. Initial schema with all tables, indexes, FTS5, and triggers
2. OAuth tables: oauth_clients, oauth_codes, oauth_tokens
3. Notes table with FTS5 and triggers
4. Add session_expires_at to users for server-side token expiry (HIGH #6)
5. Add type column to notes (rule/memory/knowledge/context) with backfill and index
6. Add partial index for embedded notes by workspace (HIGH #3)

**6 миграций** применено.

### `src/db/migrate.ts`

Не читал детально, но из package.json видно что runner — `tsx src/db/migrate.ts` запускает мигратор. Миграции, вероятно, hardcoded в TypeScript файле как массив `{version, description, sql}`.

**Решение V3.0**: **KEEP pattern**, **reset version counter**.

V3.0 migration system:
1. **Clean slate** — версии начинаются с 1 в новой `qoopia-v3.db`
2. Миграции в `migrations/NNN-description.sql` как отдельные SQL файлы (легче читать и рецензировать)
3. Migration runner:
   - Создаёт `schema_versions` если нет
   - Читает файлы из папки, сортирует по номеру
   - Применяет не-applied в transaction
4. **Один-shot migration from V2** — отдельный скрипт `scripts/migrate-from-v2.ts` который читает старую БД и переносит данные в новую по mapping из 01-schema

**Размер migrate.ts**: TBD, вероятно ~100 LoC. **SIMPLIFY** до минимального migration runner ~50-60 LoC.

## 06.3 DB connection

**File**: `src/db/connection.ts` (не читал, но упоминается везде как `import { rawDb } from '../db/connection.js'`)

Вероятно: better-sqlite3 Database wrapper с PRAGMAs (WAL, busy_timeout, foreign_keys).

**Решение V3.0**: **KEEP pattern** с минимальными изменениями. Standard PRAGMAs:
```typescript
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');  // WAL-safe, faster than FULL
```

## 06.4 Launchd / auto-start

### Текущее состояние (известно из памяти предыдущих сессий)

Qoopia в prod **запускается через OpenClaw gateway** — не через свой собственный launchd plist. То есть OpenClaw — который имеет launchd plist — запускает Qoopia как дочерний процесс через gateway config.

**Проверка**: вероятно есть `~/Library/LaunchAgents/com.openclaw.gateway.plist` или аналогичный, и в `~/.openclaw/openclaw.json` прописан запуск Qoopia.

**Проблема для V3.0**: V3 Qoopia **должна работать standalone**, не требуя OpenClaw. Это критично потому что:
1. Сауле не использует OpenClaw в том же конфиге (другая машина, другие агенты)
2. Любой внешний пользователь не должен устанавливать OpenClaw как prerequisite
3. ADR-004 «multi-tenant ready» + group D «qoopia install ≤ 3 commands»

**Решение V3.0**: **STANDALONE launchd plist**.

```
~/Library/LaunchAgents/com.qoopia.mcp.plist
```

Содержит:
- `Label`: `com.qoopia.mcp`
- `ProgramArguments`: absolute path to `qoopia` binary (or `bun run` if using Bun)
- `EnvironmentVariables`: `QOOPIA_DATA_DIR`, `QOOPIA_PORT`, `QOOPIA_PUBLIC_URL`
- `KeepAlive`: true
- `RunAtLoad`: true
- `StandardErrorPath` / `StandardOutPath` — в `~/.qoopia/logs/`

**`qoopia install`** команда:
1. Creates `~/.qoopia/data` dir
2. Creates `~/.qoopia/logs` dir
3. Applies migrations (creates initial workspace + admin agent)
4. Generates launchd plist from template
5. `launchctl load` plist
6. Prints MCP connector URL + admin api_key
7. Exits

**Размер**: ~100 LoC для install script.

**Это фундаментально для Сауле gate** (05-non-goals.md Q9) — она запускает `qoopia install`, получает работающий MCP сервер на своём Mac Mini, и всё.

## 06.5 Логи

### Текущее состояние

V2 использует pino logger. Куда пишутся логи — TBD. В `start.sh` redirect не виден, значит всё в stdout/stderr, которые наследует launchd + пишет в default launchd logs.

**Решение V3.0**: **SIMPLIFY**.

- **Stdout/stderr** → OS system log (launchd пишет в `~/Library/Logs/` или `/var/log/`)
- **Опционально**: `QOOPIA_LOG_FILE` env var для записи в кастомный файл
- **Log rotation**: через `launchd` плиста параметры `StandardOutPath` / `StandardErrorPath` + ручная ротация если нужно. Или `logrotate`-стиль подход в V3.5.
- **Log level**: `QOOPIA_LOG_LEVEL` env var (`info` / `debug` / `warn`)

**Zero complex log infrastructure**. pino или даже просто `console.log` с префиксом.

## 06.6 Бэкапы

### Текущее состояние

Не видно bаckup infrastructure в V2. Вероятно, ничего нет — полагаемся на Time Machine на Mac Mini Асхата.

**Решение V3.0**: **SIMPLE daily backup**.

Добавить в `retention.ts` + `startMaintenance`:
- Ежедневно в 04:00 локального времени:
  - `sqlite3 db.db ".backup backup-YYYY-MM-DD.db"` → `~/.qoopia/backups/`
  - Удалить бэкапы старше 7 дней (keep latest 7)
- **Это всё**. Никакого incremental, никакого cloud sync, никакого external tool.
- В V3.5 может добавиться опциональный S3/Restic integration.

**Размер**: ~30 LoC в retention.ts.

**Совместимо с критерием A6** (бэкап ≤ 1 раз в сутки, восстановление ≤ 10 минут ручной работы).

## Сводка deployment layer

| Компонент | V2 | V3.0 |
|---|---|---|
| start.sh LoC | ~15 (с hardcodes) | ~5 (без hardcodes) или **удалён** |
| Launchd plist | через OpenClaw gateway | **standalone** `com.qoopia.mcp.plist` |
| `qoopia install` command | отсутствует | **~100 LoC** new script |
| Migration runner | in-code | in-files (`migrations/*.sql`) |
| Migration count | 6 applied | starts from 1 (fresh V3 schema) |
| Backups | nothing (Time Machine) | daily SQLite .backup + 7-day rotation |
| Logs | stdout via launchd | stdout via launchd + optional log file |
| Hardcoded paths | **есть** (Node version, cwd, public URL) | **zero** |

## Критические изменения для Сауле

Эти изменения **обязательны** чтобы developer/Сауле могли развернуть Qoopia на своём Mac Mini:

1. **`qoopia install`** — one-command setup. Сегодня: нет. V3.0: **да**.
2. **Launchd plist standalone** — не зависит от OpenClaw. Сегодня: зависит. V3.0: **нет**.
3. **Zero hardcoded paths** — PUBLIC_URL, data dir, Node path. Сегодня: hardcoded. V3.0: env vars с разумными defaults.
4. **Port configurable** — уже так в V2 (через `PORT` env var). KEEP.
5. **SQLite data dir configurable** — через `QOOPIA_DATA_DIR` env var. Default `~/.qoopia/data`. V2: hardcoded в `~/.openclaw/qoopia/data/qoopia.db`.

## Бюджет H5 проверка

**H5**: ≤ 3 команды в `qoopia install` до работающего MCP.

**V3.0 цель**:
```
curl -fsSL https://get.qoopia.dev | bash       # 1 команда: download + install + setup
# (или)
bun install -g qoopia && qoopia install         # 2 команды: install binary, setup
# (или)
git clone && cd qoopia && bun run install       # 3 команды: clone, cd, install
```

Любой из этих вариантов укладывается в ≤ 3 команды. **✅ в бюджете**.

**H6** (≤ 2 минуты до первого успешного вызова): достижимо если Bun runtime (start ~200ms), миграции быстрые (10 таблиц, ms), и агент подключается через уже готовый api_key после install.
