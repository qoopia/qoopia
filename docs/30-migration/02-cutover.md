# 02 — Cutover plan + Saule deployment + Rollback

**Базис**: 00-overview.md (high-level strategy) + 01-data-migration.md (data transform spec) + Phase 1 02-personas.md (agent priorities)

Этот документ отвечает на: **как переключать агентов с V2 на V3 безопасно**, **как деплоить у Сауле**, и **как откатиться** если что-то пошло не так.

## Pre-cutover prerequisites

Перед тем как начать cutover должны быть зелёными:

| Prerequisite | Status проверка |
|---|---|
| V3 code готов (Phase 5 Execute завершён) | `bunx qoopia version` возвращает 3.0.0 |
| V3 server запускается standalone | `curl http://localhost:3738/health` → 200 OK |
| Migration script протестирован на копии prod DB | manual test on `~/tmp/qoopia-v2-copy.db` успешен |
| Verification script проходит без ошибок | `verify-migration` exits 0 |
| Бэкап V2 сделан | `cp ~/.openclaw/qoopia/data/qoopia.db ~/.openclaw/qoopia/data/backup-pre-v3-$(date +%s).db` |
| Agent API keys проверены что работают в V3 после migration | manual curl with old key against V3 |
| OAuth `/oauth/authorize` endpoint работает в V3 для Claude.ai | manual browser test |
| `qoopia admin create-agent` работает | integration test |

**Если хоть один red — cutover не начинается**.

## Agent migration order

Из Phase 1 02-personas.md — порядок важен. Agents имеют разные risk profiles.

### Порядок (low risk → high risk)

1. **Alan** — universal assistant, low stakes, sandbox для V3 validation
2. **Aizek** — HappyCake KZ coordinator, medium stakes, проверка workspace isolation
3. **Dan** — family chat, isolated workspace, проверка retention + autonomy
4. **Claude** (все Claude instances: Claude Code, Claude.ai, Cowork) — проверка cross-workspace privilege + multiple simultaneous sessions
5. **Aidan** — email operations with real people, **последний**, task-bound retention critical

**Почему Aidan последний**: его ошибки имеют external visibility (real people receiving email from him). Мы хотим видеть что V3 стабильна **под нагрузкой** остальных 4 агентов до того как Aidan переключается.

### Per-agent migration procedure

Для каждого agent повторяем:

**Day 0** — switchover:

```
1. Open agent's system prompt file (~/.openclaw/agents/<name>/prompt.md or equivalent)
2. Remove old Qoopia MCP connector config
3. Add new Qoopia MCP connector config:
   {
     "qoopia": {
       "type": "streamable-http",
       "url": "http://localhost:3738/mcp",
       "headers": {
         "Authorization": "Bearer <agent's V3 api key>"
       }
     }
   }
4. Replace "project context / open tasks / recent notes" bloated sections
   with template from docs/20-to-be/03-system-prompt.md (choose appropriate template)
5. Restart agent process
6. Ask agent a simple question to verify startup: "What's the latest on <current work>?"
7. Verify response references data from V3 (not hallucination, not empty)
```

**Day 1-3** — observation:

- Agent в нормальной работе, owner использует как обычно
- Log monitoring: errors in V3 logs? HTTP 5xx responses?
- Latency monitoring: `tail -f ~/.qoopia/logs/qoopia.stderr` для ошибок
- Tool call monitoring: `qoopia admin tool-stats --agent <name>` (если implement'ed) или SQL:
  ```sql
  SELECT COUNT(*) as n, json_extract(metadata, '$.tool') as tool
  FROM activity
  WHERE agent_id = ? AND created_at >= datetime('now', '-1 day')
  GROUP BY tool;
  ```

**Day 3 — green light**:

Agent migrated если **все** проверки зелёные:

- [ ] Zero HTTP 5xx responses в логах
- [ ] Zero unhandled exceptions в stderr
- [ ] Agent успешно вызывает `session_recent` на старте (проверка UC-1)
- [ ] Agent создаёт notes через `note_create` (проверка UC-4)
- [ ] При рестарте agent поднимает контекст через `session_recent` (проверка UC-2)
- [ ] FTS5 search возвращает осмысленные результаты на agent queries (проверка UC-3)
- [ ] Latency p99 < 200 мс на agent traffic (критерии B)

Если **что-то red** — agent **не green-lighted**, rollback этого agent на V2 (см. ниже), остальных не трогаем.

### Agent rollback procedure (per-agent)

Если agent сломался на V3:

```
1. Revert agent's system prompt file (git checkout or manual)
2. Put back old Qoopia V2 MCP connector config (port 3737)
3. Remove V3 connector
4. Restart agent
5. Agent продолжает работать с V2 где всё по-прежнему (V2 в read-only mode но reads работают)
```

**Важно**: V2 в read-only означает что agent на V2 **не может создавать новые notes**. Это significant limitation. Rollback это **emergency stop**, не нормальный режим.

**Если rollback случился** — это серьёзный сигнал:
1. Stop further migrations (не трогаем остальных agents)
2. Investigate root cause (что именно сломалось в V3?)
3. Fix V3
4. Re-attempt migration того agent первым, потом продолжаем порядок

## Параллельный run V2+V3

### Конфигурация portов

| Port | Service | Data DB | Status |
|---|---|---|---|
| 3737 | V2 (legacy) | `~/.openclaw/qoopia/data/qoopia.db` | read-only после migration start |
| 3738 | V3 (new) | `~/.qoopia/data/qoopia.db` | read-write |

Оба сервиса запущены через launchd одновременно. Agents указывают в конфиге **один** из двух портов.

### V2 → read-only switch

После migration script complete:

```bash
chmod 444 ~/.openclaw/qoopia/data/qoopia.db
chmod 444 ~/.openclaw/qoopia/data/qoopia.db-wal
chmod 444 ~/.openclaw/qoopia/data/qoopia.db-shm
```

V2 process получит `SQLITE_READONLY` errors при попытке write. Agents на V2 могут только читать — новые notes не создаются.

**Why**: это гарантирует **consistent rollback point**. Если через неделю мы решим откатиться — данные V2 такие же как в момент migration, никто их не менял «между делом».

**Undo** (при emergency rollback): `chmod 644 ~/.openclaw/qoopia/data/qoopia.db*`.

### Monitoring обоих services

```bash
# Health checks
watch 'curl -s http://localhost:3737/health && echo; curl -s http://localhost:3738/health'

# Log tailing
tail -f ~/.qoopia/logs/qoopia.stderr ~/.openclaw/qoopia/logs/*.log
```

## Saule deployment (parallel to Askhat migration)

**Не блокирован** Askhat cutover'ом. Может начаться как только V3 code готов.

### Saule pre-flight checklist

Перед установкой у Сауле должны быть зелёными:

**V3 maturity checks** (общие для всех deploy):

- [ ] V3.0 code в stable state (commit pinned, не rolling master)
- [ ] `qoopia install` протестирован Askhat'ом на чистой VM или clean dir
- [ ] `qoopia uninstall` работает и чисто удаляет
- [ ] Admin CLI (`qoopia admin create-workspace/agent`) работает
- [ ] Documentation для Saule готова (короткий gist или Notion page с шагами)

**Saule machine specific**:

- [ ] Её Mac Mini имеет Bun installed (или инструкция установить)
- [ ] Достаточно disk space (~500 MB для Bun + binaries + data)
- [ ] Tailscale up (если она будет подключаться к общему Qoopia — но **скорее всего нет**, у неё отдельная инсталляция)
- [ ] Claude.ai подписка у неё работает (для OAuth connector test)

**Askhat agent стабильности**:

- [ ] Хотя бы Alan мигрирован успешно на V3 у Askhat (proof что V3 работает в реальности)

### Saule install procedure

```
На Сауле Mac Mini:

$ curl -fsSL https://bun.sh/install | bash
  # first-time Bun setup, ~1 минута

$ bunx qoopia install

  # same output as Askhat saw, just fresh install
  # No migration (она не имела V2)
  # Admin API key generated and shown
  
$ qoopia admin create-workspace zoe-workspace --slug zoe
$ qoopia admin create-agent zoe --workspace zoe --type standard
  # Prints Zoe's API key
  
$ qoopia admin create-workspace mia-workspace --slug mia  
$ qoopia admin create-agent mia --workspace mia --type standard
  # Prints Mia's API key
```

Для каждого агента (Zoe, Mia) Сауле копирует API key в соответствующий MCP connector config в её agent system. При первом запуске агента:

1. Агент подключается к `http://localhost:3737/mcp`
2. Делает `session_recent` — получает **empty** (fresh install)
3. Создаёт свою первую note через `note_create`
4. Работает нормально

**Саулины агенты не имеют исторических данных** — это фича, не bug. Она одновременно получает **clean start + acceptance test** что V3 работает у external user.

### Saule acceptance criteria

После одной недели использования V3 у Сауле:

- [ ] Zoe работает без errors
- [ ] Mia работает без errors  
- [ ] Zoe помнит контекст между сессиями
- [ ] Mia помнит контекст между сессиями
- [ ] Zoe и Mia **НЕ видят** данные друг друга (workspace isolation работает)
- [ ] `qoopia install` был one-command и понятен
- [ ] Backups в `~/.qoopia/backups/` накапливаются автоматически

**Если всё зелёное — ADR-002 multi-tenant требование валидировано в бою**. Это primary acceptance test из Phase 1 01-why.md («годно для 99% пользователей»).

## Full rollback plan (worst case)

**Когда применяется**: V3 полностью сломалась и не поддаётся quick fix. Все agents не могут работать. Критическая ситуация.

### Полный откат на V2

```bash
# Step 1: Stop V3
launchctl unload ~/Library/LaunchAgents/com.qoopia.mcp.plist

# Step 2: Restore V2 writability
chmod 644 ~/.openclaw/qoopia/data/qoopia.db
chmod 644 ~/.openclaw/qoopia/data/qoopia.db-wal
chmod 644 ~/.openclaw/qoopia/data/qoopia.db-shm

# Step 3: Revert all agent configs (git checkout if using git, manual otherwise)
cd ~/.openclaw/agents
for agent in alan aizek aidan dan claude; do
  git -C $agent checkout prompt.md
done

# Step 4: Restart agents
for agent in alan aizek aidan dan claude; do
  launchctl kickstart -k gui/$(id -u)/com.openclaw.agent.$agent
done

# Step 5: Verify
curl http://localhost:3737/health
```

**Время rollback**: ~5-10 минут ручной работы. Удовлетворяет критерию A6 (≤ 10 минут ручной работы на восстановление).

**Что теряется**: всё что было создано в V3 **после** migration start. Не в V2.

- Notes созданные через `note_create` в V3 → теряются
- Session messages в V3 → теряются
- Settings изменения в V3 → теряются

**Что сохраняется**: V2 state на момент migration start — все tasks/deals/contacts/finances/projects/notes/activity.

**Mitigation для потерянного**: V3 DB файл `~/.qoopia/data/qoopia.db` можно **сохранить** для forensics / восстановления через скрипт. Не удалять automatically.

### Partial rollback (только часть agents)

Если сломался только один agent — rollback только его, остальные на V3.

Это **нормальный путь** в первые 3-5 дней после cutover start. Agent rollback процедура описана выше в "Agent rollback procedure (per-agent)".

### Data corruption в V3 (recovery из backup)

Если V3 DB повреждена (sqlite corruption, partial write):

```bash
# Stop V3
launchctl unload ~/Library/LaunchAgents/com.qoopia.mcp.plist

# Find latest good backup
ls -la ~/.qoopia/backups/
# Example: qoopia-2026-04-10.db, qoopia-2026-04-09.db, ...

# Restore
cp ~/.qoopia/backups/qoopia-2026-04-10.db ~/.qoopia/data/qoopia.db

# Verify
bunx qoopia verify

# Restart
launchctl load ~/Library/LaunchAgents/com.qoopia.mcp.plist
```

**Потеря**: всё что было после latest daily backup (до 24 часов). Акцептируемо для сценария corruption.

## Sequence diagrams

### Happy path cutover

```
Day 0:  V3 code ready
        ↓
Day 0:  bunx qoopia install --port 3738 (parallel)
        ↓
Day 0:  Run migrate-from-v2 script
        ↓
Day 0:  V2 → read-only (chmod 444)
        ↓
Day 0:  Verify migration (counts + samples)
        ↓
Day 0:  Migrate Alan → V3
        ↓
Day 3:  Alan green, migrate Aizek
        ↓
Day 6:  Aizek green, migrate Dan
        ↓
Day 9:  Dan green, migrate Claude
        ↓
Day 12: Claude green, migrate Aidan
        ↓
Day 15: Aidan green, all on V3
        ↓
Day 22: Full V3 stability week complete
        ↓
Day 22: Stop V2 (launchctl unload), archive qoopia.db
        ↓
Day 22: DONE
```

**Total**: ~22 дня с momentum работы Phase 5 completion.

### Agent single-point rollback

```
Day X:  Alan migrated to V3
        ↓
Day X+1: Alan errors out on some tool call
         ↓
Day X+1: Investigate: bug in V3 OR bad agent prompt?
         ↓
         → If fixable quickly: patch V3 + restart
         ↓
         → If deep bug: revert Alan config to V2
         ↓
Day X+1: chmod 644 for Alan sessions temporarily? No — keep V2 read-only
         Alan on V2 has read-only access, can still do most things
         Priority: fix V3 bug, re-migrate Alan
         ↓
Day X+2 or X+3: Fix done, re-migrate Alan
                Continue standard cutover order
```

## Связь с bulk principles

| Принцип / критерий | Как покрыто в этом плане |
|---|---|
| A5 Integrity (atomic writes at sbo) | Migration script in transaction |
| A6 Backups восстановление ≤ 10 min | Full rollback procedure ≤ 10 min |
| A7 Migrations without breaking | Parallel V2+V3 + per-agent cutover |
| F1 Cross-workspace no-read | Verified in Saule (Zoe vs Mia isolation test) |
| F3 Task-bound auto-purge | Verified в Aidan migration (explicit test case) |
| D3 Deploy identity (Askhat ↔ Saule) | Same `qoopia install` command |
| Primary acceptance test (system prompt collapse) | Agent migration step 4: replace system prompt with templates |
| «железобетонно» надёжность | Parallel run + per-agent cutover + rollback paths |

## LoC implication для Phase 5

Migration + cutover tooling — **одноразовый code** не в core:

| Script | LoC |
|---|---|
| `scripts/migrate-from-v2.ts` | ~400 (из 01-data-migration.md) |
| `scripts/verify-migration.ts` | ~100 |
| `scripts/cutover-checklist.ts` (CLI helper) | ~80 (optional) |
| **Total migration tooling** | **~580 LoC** |

Это **не** считается в бюджет H1 (core LoC ≤ 2000), это **migration-specific** код который живёт в `scripts/` и не shipped в production.

## Что готово к Phase 5

- Data migration script spec — 01-data-migration.md (executable, 400 LoC estimate)
- Cutover procedure — этот документ (runbook per-agent)
- Saule deployment flow — этот документ (acceptance criteria specified)
- Rollback paths — этот документ (4 scenarios each with procedure)

**Нет design gaps**. Phase 5 developer может implement + execute.

Единственное open: **exact dates** cutover — определяются по готовности Phase 5 code. Не в scope Phase 4.
