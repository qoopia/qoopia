# 04 — TO-BE: `qoopia install` deployment flow

**Базис**: ADR-007 (Bun runtime) + бюджеты D1 (≤ 5 мин)/H4 (0 конфигов)/H5 (≤ 3 команды)/H6 (≤ 2 мин до first call)

**Primary goal**: одна команда — работающий MCP сервер. Это **gate** для развёртывания у Сауле (NG-9/Q9 из Phase 1).

## User experience (happy path)

```
$ curl -fsSL https://bun.sh/install | bash        # one-time Bun install
$ bunx qoopia install

┌─────────────────────────────────────────────┐
│  Qoopia V3.0 installer                      │
└─────────────────────────────────────────────┘

✓ Data directory created: ~/.qoopia/data
✓ Logs directory created: ~/.qoopia/logs
✓ Backups directory created: ~/.qoopia/backups
✓ SQLite database initialized
✓ Migrations applied (version 1)
✓ Default workspace created: "default"
✓ Admin agent created: "admin"
✓ LaunchAgent installed: com.qoopia.mcp
✓ Server started on http://localhost:3737

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  INSTALLATION COMPLETE — 42 seconds
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  MCP URL:        http://localhost:3737/mcp
  Admin API key:  <YOUR_QOOPIA_API_KEY>

Add this to your MCP client config (e.g. ~/.claude/mcp.json):

  {
    "qoopia": {
      "type": "streamable-http",
      "url": "http://localhost:3737/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_QOOPIA_API_KEY>"
      }
    }
  }

Save this API key — it won't be shown again. Store it in a password manager.

Next steps:
  - Create workspaces:  qoopia admin create-workspace <name>
  - Create agents:      qoopia admin create-agent <name> --workspace <slug>
  - Check status:       qoopia status
  - View logs:          qoopia logs
  - Uninstall:          qoopia uninstall

Documentation: https://qoopia.example.com/docs  (add real link later)
```

**Total time**: ~40-60 секунд на чистой машине (Bun уже установлен).
**Commands**: 2 (bun install + `bunx qoopia install`) → в бюджете H5 (≤ 3).

## Что делает `qoopia install`

### Шаг 1: Prep directories

```bash
mkdir -p "$QOOPIA_DATA_DIR" "$QOOPIA_DATA_DIR/../logs" "$QOOPIA_DATA_DIR/../backups"
chmod 700 "$QOOPIA_DATA_DIR"  # user-only access to SQLite file
```

Default: `$QOOPIA_DATA_DIR = $HOME/.qoopia/data`.

### Шаг 2: Initialize database

```typescript
import { Database } from "bun:sqlite";
const db = new Database(path.join(dataDir, "qoopia.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA foreign_keys = ON");
```

### Шаг 3: Run migrations

```typescript
import { readdirSync, readFileSync } from "fs";
const migrationFiles = readdirSync("./migrations").filter(f => f.endsWith(".sql")).sort();
for (const file of migrationFiles) {
  const version = parseInt(file.split("-")[0]);
  const applied = db.prepare("SELECT 1 FROM schema_versions WHERE version = ?").get(version);
  if (applied) continue;
  const sql = readFileSync(`./migrations/${file}`, "utf8");
  db.exec("BEGIN");
  db.exec(sql);
  db.exec("COMMIT");
  console.log(`✓ Migration ${file} applied`);
}
```

Initial migration `001-initial-schema.sql` — готов в `20-to-be/01-schema.md`.

### Шаг 4: Create default workspace + admin

```typescript
const workspaceId = ulid();
db.prepare(`INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES (?, 'Default', 'default')`).run(workspaceId);

const apiKey = generateApiKey();  // 32 random bytes → base64url → prefix "q_"
const apiKeyHash = sha256(apiKey);
const agentId = ulid();
db.prepare(`INSERT INTO agents (id, workspace_id, name, type, api_key_hash) VALUES (?, ?, 'admin', 'standard', ?)`).run(agentId, workspaceId, apiKeyHash);

console.log(`Admin API key: ${apiKey}`);  // Only time it's shown
```

### Шаг 5: Generate launchd plist

```xml
<!-- Template: com.qoopia.mcp.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.qoopia.mcp</string>
    <key>ProgramArguments</key>
    <array>
        <string>{{BUN_PATH}}</string>
        <string>run</string>
        <string>{{QOOPIA_ENTRY}}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>QOOPIA_DATA_DIR</key>
        <string>{{QOOPIA_DATA_DIR}}</string>
        <key>QOOPIA_PORT</key>
        <string>{{QOOPIA_PORT}}</string>
        <key>QOOPIA_LOG_LEVEL</key>
        <string>info</string>
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>{{LOG_DIR}}/qoopia.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>{{LOG_DIR}}/qoopia.stderr.log</string>
    <key>WorkingDirectory</key>
    <string>{{WORKING_DIR}}</string>
</dict>
</plist>
```

Install script fills placeholders и пишет файл в `~/Library/LaunchAgents/com.qoopia.mcp.plist`.

### Шаг 6: Load launchd service

```bash
launchctl unload ~/Library/LaunchAgents/com.qoopia.mcp.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.qoopia.mcp.plist
```

После этого launchd запускает Qoopia как background service. При reboot — автоматически.

### Шаг 7: Wait for health check

```typescript
// Poll http://localhost:3737/health until OK (max 30 sec)
const start = Date.now();
while (Date.now() - start < 30_000) {
  try {
    const resp = await fetch(`http://localhost:${port}/health`);
    if (resp.ok) {
      console.log("✓ Server responding");
      break;
    }
  } catch {}
  await new Promise(r => setTimeout(r, 500));
}
```

### Шаг 8: Print success banner + API key

См. UX example выше.

---

## `qoopia` CLI commands

Binary CLI устанавливается вместе с Qoopia через `bun install -g qoopia` или `bunx qoopia <command>`.

| Command | Описание |
|---|---|
| `qoopia install` | Первичная установка (описано выше) |
| `qoopia uninstall` | Unload launchd + (опционально) delete data |
| `qoopia status` | Ping `/health` + показать running/stopped |
| `qoopia logs [--follow]` | Tail логов из `~/.qoopia/logs/` |
| `qoopia admin create-workspace <name> [--slug=<slug>]` | Создать workspace |
| `qoopia admin create-agent <name> --workspace <slug> [--type=<standard\|claude-privileged>]` | Создать agent, вывести API key |
| `qoopia admin list-agents` | Список агентов |
| `qoopia admin rotate-key <agent-name>` | Сгенерировать новый key, старый invalidate |
| `qoopia admin delete-agent <agent-name>` | Удалить агента |
| `qoopia backup [--to <path>]` | Ручной бэкап (поверх автоматических daily) |
| `qoopia restore <backup-file>` | Восстановить из бэкапа (с confirmation prompt) |
| `qoopia version` | Version info + DB schema version |

**Размер implementation CLI**: ~120 LoC (простые wrappers вокруг services + formatting).

## Environment variables

Все опциональные. Default работают из коробки.

| Var | Default | Описание |
|---|---|---|
| `QOOPIA_PORT` | `3737` | HTTP port |
| `QOOPIA_DATA_DIR` | `$HOME/.qoopia/data` | SQLite DB location |
| `QOOPIA_LOG_DIR` | `$HOME/.qoopia/logs` | Log files |
| `QOOPIA_BACKUP_DIR` | `$HOME/.qoopia/backups` | Backup location |
| `QOOPIA_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `QOOPIA_PUBLIC_URL` | `http://localhost:$QOOPIA_PORT` | Used for OAuth metadata (discovery endpoint) |
| `QOOPIA_OAUTH_ISSUER` | = `QOOPIA_PUBLIC_URL` | OAuth issuer claim |
| `QOOPIA_MAINTENANCE_HOUR` | `4` | Hour (0-23 local) for daily maintenance + backup |
| `QOOPIA_BACKUP_KEEP` | `7` | Number of daily backups to keep |
| `QOOPIA_RETENTION_ACTIVITY_DAYS` | `90` | Activity log retention |

**Nothing is required**. Если агент запускает `bunx qoopia install` на чистой машине — всё работает с defaults. ✓ H4.

## Uninstall flow

```
$ qoopia uninstall

This will:
  ✗ Stop Qoopia server (launchctl unload)
  ✗ Remove LaunchAgent plist
  ? Keep data directory?      [Y/n]
  ? Keep backups directory?   [Y/n]

Proceed? [y/N]: y

✓ Server stopped
✓ LaunchAgent removed
✓ Data preserved at ~/.qoopia/data
✓ Backups preserved at ~/.qoopia/backups

To reinstall later:  bunx qoopia install
To delete data:      rm -rf ~/.qoopia
```

**Key principle**: uninstall **не теряет данные** by default. Пользователь явно подтверждает.

## Развёртывание у Сауле (gate from Phase 1)

Сауле запускает на своём Mac Mini:

```
$ curl -fsSL https://bun.sh/install | bash
$ bunx qoopia install
```

Получает:
- Работающий Qoopia MCP server
- API key для admin agent
- Возможность создавать свои workspace'ы для Zoe и Mia (будущих агентов у неё)
- Backup автоматический ежедневно

**Проверка**:
1. `curl http://localhost:3737/health` → `{"status": "ok"}`
2. Создать agent: `qoopia admin create-agent zoe --workspace default`
3. Вставить API key в MCP connector её Claude.ai или OpenClaw-to-Claude-Code setup
4. Agent может вызывать MCP tools

Если всё это работает **одной командой** на её машине — **primary acceptance test multi-tenant deploy пройден**.

## Backup и restore

### Автоматический daily backup

Daily maintenance job (описан в 01-schema.md retention section):

```typescript
// In services/retention.ts, called on schedule
async function dailyBackup() {
  const dateStr = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
  const backupPath = path.join(backupDir, `qoopia-${dateStr}.db`);

  // SQLite VACUUM INTO — atomic, non-blocking
  db.exec(`VACUUM INTO '${backupPath}'`);

  // Rotate — keep last N
  const backups = fs.readdirSync(backupDir)
    .filter(f => f.startsWith("qoopia-") && f.endsWith(".db"))
    .sort()
    .reverse();
  for (const old of backups.slice(QOOPIA_BACKUP_KEEP)) {
    fs.unlinkSync(path.join(backupDir, old));
  }

  logger.info({count: backups.length, latest: dateStr}, "Daily backup complete");
}
```

### Manual backup

```
$ qoopia backup --to /tmp/qoopia-$(date +%s).db
✓ Backup written to /tmp/qoopia-1712875200.db (4.2 MB)
```

### Restore

```
$ qoopia restore ~/.qoopia/backups/qoopia-2026-04-10.db

WARNING: This will replace the current database with the backup.
Current data will be preserved in ~/.qoopia/data/qoopia.db.pre-restore-<timestamp>

Proceed? [y/N]: y

✓ Server stopped
✓ Current DB saved as qoopia.db.pre-restore-1712875200
✓ Backup restored
✓ Server restarted
```

**Соответствие A6** (бэкапы, ≤ 10 минут на восстановление): ✓. Реально — секунды.

## Что готово к Фазе 5

Весь install flow описан до шага implementation. LaunchAgent plist template готов (placeholders заполняются на runtime). CLI commands перечислены с behavior. Env vars с defaults.

**Gap к Фазе 5**: реализация CLI (~120 LoC). Template plist файла (40 строк XML). Но design решений больше не требуется.

**Risk**: launchd plist нужен для macOS. Для Linux (если кто-то развернёт — маловероятно в V3.0) — нужен systemd unit equivalent. **Отложено в V3.5**: Linux/Windows support как follow-up.

Для V3.0 scope — macOS only (Асхат + Сауле оба на Mac).
