# 00 — Migration overview

**Базис**: Phase 2 07-migration-map.md + Phase 3 20-to-be

## High-level strategy

**Parallel run + agent-by-agent cutover + read-only V2 rollback safety net.**

```
┌─────────────────────────────────────────────────────┐
│ BEFORE migration                                     │
│                                                      │
│ Agents (Alan, Aizek, Aidan, Dan, Claude)             │
│          │                                            │
│          ▼ MCP connector                             │
│   V2 Qoopia @ localhost:3737                         │
│   ~/.openclaw/qoopia/data/qoopia.db                  │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ DURING migration (Phase 5 Execute + Phase 4 cutover)│
│                                                      │
│ Agents step 1: migrate Alan → V3                     │
│                                                      │
│ Alan ────▶ V3 Qoopia @ localhost:3738 ───▶ new DB   │
│                                                      │
│ Aizek, Aidan, Dan, Claude ────▶ V2 @ 3737 ───▶ old DB│
│                                                      │
│ V2 read-only from this moment (for rollback safety)  │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ AFTER migration (all agents on V3)                   │
│                                                      │
│ Agents ────▶ V3 Qoopia @ localhost:3737              │
│                 ~/.qoopia/data/qoopia.db             │
│                                                      │
│ V2 @ 3738 (staging port) still alive for 1 week     │
│ Then: V2 stopped. Data archived as                   │
│       ~/.openclaw/qoopia/backup-pre-v3.db            │
└─────────────────────────────────────────────────────┘
```

## Migration phases (steps)

### Step 1: Build V3.0 code (Phase 5 Execute)

Prerequisite. V3.0 implementation готова: все 13 MCP tools, DDL, install script, CLI, system prompts.

### Step 2: Install V3 on Askhat's Mac Mini in parallel

```bash
# Bun already installed (one-time)
bunx qoopia install --port 3738  # parallel to V2 on 3737
```

Результат:
- Qoopia V3 запущена на порту **3738** (не 3737 где живёт V2)
- Данные в `~/.qoopia/data/qoopia.db` (свежая БД, пустая)
- Admin agent created, API key printed
- V2 продолжает работать на 3737 без изменений

### Step 3: Run data migration script

```bash
bunx qoopia migrate-from-v2 --source ~/.openclaw/qoopia/data/qoopia.db
```

Читает старую БД read-only, transforms rows по mapping из `01-data-migration.md`, пишет в новую БД. См. Phase 2 07-migration-map.md Group 1 (schema migration) для high-level; Phase 4 01-data-migration.md даёт executable spec.

**Время**: секунды (всего 2623 rows в V2).

### Step 4: Verify migration

```bash
bunx qoopia verify-migration
```

Проверяет: row counts, sample data, FTS5 rebuild, cross-references.

### Step 5: Switch V2 to read-only mode

**Цель**: гарантировать что данные V2 **не меняются** после migration start. Это критично для rollback safety.

Механика: temporary patch в V2 code (или через file permissions на SQLite DB). Пример: `chmod 444 ~/.openclaw/qoopia/data/qoopia.db` — агенты получают write errors, но reads работают. Rollback strategy: `chmod 644` вернёт write.

**Alternative**: установить agent middleware ALL_READS_ONLY flag в V2 конфиге если есть. Если нет — chmod подход работает.

### Step 6: Migrate Alan first (single-agent test)

Alan — самый «легковесный» агент (см. Phase 1 personas), потерять пару дней работы Alan не критично, он sandbox для V3 proof.

1. Обновить system prompt Alan (добавить Qoopia V3 MCP connector из `20-to-be/03-system-prompt.md` Template E)
2. Убрать Qoopia V2 MCP connector из Alan config
3. Перезапустить Alan
4. **Мониторинг 72 часа**:
   - Alan вспоминает контекст через `session_recent` + `recall`?
   - Tool calls срабатывают без ошибок?
   - Latency в ожидаемых пределах (B группа)?
   - Есть ли unhandled errors в логах V3?

Если всё ОК → green light для следующих агентов.

**Rollback путь для Alan** (если что-то не так):
1. Вернуть V2 MCP connector в config
2. Убрать V3
3. Перезапустить
4. Alan работает как раньше (V2 read-only → нет потерь)

### Step 7: Migrate Aizek, then Dan, then Claude

Порядок:
- **Aizek** — работа с KZ командой, middle risk. 72 часа мониторинг.
- **Dan** — low stakes (family chat), быстрая проверка что retention работает для family workspace.
- **Claude** (все Claude sessions, Claude Code + Claude.ai + Cowork) — включение cross-workspace read privilege. Эта точка самая сложная потому что Claude используется во многих контекстах одновременно.

Каждый agent — **3 дня** мониторинг прежде чем считать migrated.

### Step 8: Migrate Aidan last

**Aidan — особый случай**.

Причины последнего:
- Пишет реальным людям через email
- Task-bound retention для email должна работать
- Ошибки тут видны внешним партнёрам (риелторы, legal)

**Дополнительные проверки** для Aidan:
- Task-bound purge работает корректно (создать тестовую задачу → закрыть → убедиться что связанный контекст удалён через час)
- Email drafts сохраняются в `notes` с правильным `task_bound_id`
- `session_search` находит старые переписки по ключевым словам

### Step 9: V3 полная операционная (≥ 1 неделя)

После миграции всех 5 агентов, V3 работает ≥ 7 дней в производстве.

**Метрики мониторинга**:
- Uptime ≥ 99.9% (критерий A4)
- Latency p99 < 100 мс на FTS5 queries (B3)
- Zero unhandled errors в логах
- Daily backup файлы в `~/.qoopia/backups/`

### Step 10: Stop V2, archive data

После успешной недели V3:

```bash
launchctl unload ~/Library/LaunchAgents/com.openclaw.gateway.plist  # OR similar
cp ~/.openclaw/qoopia/data/qoopia.db ~/.openclaw/qoopia/data/backup-pre-v3-$(date +%Y%m%d).db
# V2 остановлена, данные заархивированы
```

V2 файлы **не удаляются**. Они — исторический бэкап на случай если через месяцы обнаружится что что-то недомигрировано.

### Step 11: Port swap (опционально)

Если хочется чтобы V3 работала на «historic» порту 3737:

```bash
qoopia admin update-config --port 3737  # или в env var
launchctl unload ~/Library/LaunchAgents/com.qoopia.mcp.plist
# edit plist or env vars
launchctl load ~/Library/LaunchAgents/com.qoopia.mcp.plist
# Update all agent configs port 3738 → 3737
```

Это опционально — V3 может жить на 3738 forever, агенты будут привыкшие.

## Timeline estimate

| Step | Длительность |
|---|---|
| 1. Build V3 code (Phase 5) | 1-2 недели |
| 2-4. Install + migrate data + verify | 1 час |
| 5. V2 read-only | instant |
| 6. Alan 72h monitor | 3 дня |
| 7. Aizek, Dan, Claude — each 3 days | 9 дней |
| 8. Aidan 72h monitor | 3 дня |
| 9. Full V3 stability week | 7 дней |
| 10. Stop V2 | instant |
| **Total from code-ready до V2 off** | **~22-25 дней** |

Это **не спешка**. Медленная миграция с rollback safety — основная защита от «мы сломали то что работало».

## Связь с Сауле deployment

**Саулины агенты Zoe/Mia** — отдельная история. Её deploy происходит **параллельно** с Askhat миграцией, не блокирован ею:

1. После того как V3 code готов (Step 1), Саулe может получить `qoopia install` на её Mac Mini
2. У неё **свежая установка** — никакой миграции данных не требуется (нет V2 у неё)
3. Zoe и Mia получают **fresh start** в V3 с первого дня
4. Это одновременно — acceptance test «multi-tenant годности» (Phase 1 Q9)

**Гейт для Сауле** из Phase 1: работающий `qoopia install`. Зафиксирован в 20-to-be/04-install.md.

**Saule pre-flight checklist** — см. `02-cutover.md`.

## Rollback scenarios (quick reference)

Детали в `02-cutover.md`, здесь — кратко:

| Scenario | Action |
|---|---|
| Alan на V3 глючит | Вернуть V2 MCP connector Alan, продолжить остальных на V2 |
| Data migration script сломал что-то | Re-run с fresh V3 db (V2 read-only, ничего не потеряно) |
| V3 server crash loop | `launchctl unload` V3, агенты на V2 через 3737 |
| Catastrophic V3 failure через неделю после cutover | Restore из `~/.openclaw/qoopia/data/qoopia.db` (read-only copy), restart V2, revert agent configs |
| Corruption в V3 DB | Restore latest backup из `~/.qoopia/backups/qoopia-YYYY-MM-DD.db` |

**Каждый scenario** имеет defined path и максимум 10 минут ручной работы (критерий A6).
