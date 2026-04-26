# ADR-011: Phase 4 (Migration planning) accepted — ready for Phase 5 Execute

**Status**: accepted
**Date**: 2026-04-11
**Deciders**: Асхат + Claude

## Контекст

Phase 4 (Migration planning) проходилась 2026-04-11 сразу после закрытия Phase 3 TO-BE. Короткая фаза с фокусом: **runbook для перехода V2 → V3.0 без потерь и с rollback safety**.

Phase 4 — не код и не design, а **операционный план** который consumer (developer / Claude in Phase 5) применяет последовательно.

## Варианты

Как в ADR-010, это процедурный gate-ADR. Формально — 3 варианта для compliance:

### Вариант A (самый простой возможный): принять Phase 4, перейти к Phase 5

- Плюсы: momentum сохранён, план ≤ 3 документов готов, всё executable
- Минусы: нет

### Вариант B: дополнительный review pass migration script spec перед Phase 5

- Плюсы: больше уверенности в transform logic
- Минусы: overhead без пользы — spec уже написан на уровне pseudo-code готового к копированию

### Вариант C: написать и протестировать migration script **прямо сейчас** (не ждать Phase 5)

- Плюсы: ранняя валидация
- Минусы: это Phase 5 work, смешивает фазы, нарушает дисциплину («каждая фаза закрывается явным "да"» из CLAUDE.md)

## Решение

Выбран **Вариант A**. Phase 4 принимается.

### Что принято в Phase 4

**Migration planning документы**:

- `docs/30-migration/README.md` — scope и правила фазы
- `docs/30-migration/00-overview.md` — high-level strategy (parallel run + per-agent cutover + rollback safety net), migration phases Step 1-11, timeline estimate ~22 дня
- `docs/30-migration/01-data-migration.md` — **executable spec** для `scripts/migrate-from-v2.ts`: row-by-row transformation по 18 секциям (A-R) от workspaces до webhook_dead_letters. Идemпотентный, транзакционный, верифицируемый. LoC ~400.
- `docs/30-migration/02-cutover.md` — cutover runbook: pre-flight checks, per-agent migration procedure (Day 0/1-3/3 green), Saule deployment flow, 4 rollback scenarios (agent rollback, full rollback, partial, DB corruption). Acceptance criteria specified.

### Key decisions зафиксированные в этих документах

1. **Parallel run V2+V3** на разных портах (V2 3737, V3 3738). Port swap опционален в конце.

2. **V2 → read-only после migration start** через `chmod 444` на SQLite DB файл. Гарантирует consistent rollback point. (**Superseded 2026-04-25 после Codex security review QSEC-004**: chmod approach небезопасен для запущенного процесса с открытыми fd / WAL — см. updated runbook в `30-migration/02-cutover.md` и `HANDOFF-PHASE-5.md` Шаг 13: quiesce + restart c `QOOPIA_READ_ONLY=1` + immutable snapshot.)

3. **Agent order**: Alan → Aizek → Dan → Claude → **Aidan last**. Aidan последний потому что пишет реальным людям и ошибки имеют external visibility.

4. **Per-agent 3 day observation window** прежде чем считать migrated. Если хоть что-то red — не green-lighted, rollback этого agent.

5. **Full rollback path** ≤ 10 минут ручной работы (удовлетворяет A6).

6. **Saule deployment параллельно**, не блокирован Askhat migration. Gate: stable V3 install command + хотя бы Alan мигрирован на V3 у Askhat (proof работоспособности).

7. **Active OAuth tokens переносятся** чтобы Claude.ai connector не требовал re-auth. Идемпотентный путь если что.

8. **Agent API key hashes переносятся как есть** — zero-downtime для agent auth.

9. **Migration + cutover tooling в `scripts/`, не в `src/`** — не считается в бюджет H1 core LoC.

## Последствия

### Что становится проще

- Phase 5 developer имеет готовый runbook миграции, не нужно придумывать по ходу
- Agent downtime минимальный — per-agent cutover, не big-bang
- Saule deployment может быть **параллельным** с Askhat migration — она не ждёт окончания
- Rollback это **ожидаемая часть процесса**, не emergency panic

### Что становится сложнее

- Cutover занимает ~22 дня (не один день). Это feature, не bug — медленно и безопасно.
- Требует дисциплины: не торопиться, выдерживать 3-day observation per agent
- Требует мониторинга: developer (или Claude) должен тратить время на observation, не только coding

### Что мы теперь не сможем сделать

- Big-bang миграция за один день — нарушает agent-by-agent правило
- Мигрировать Aidan первым — нарушает risk order
- Cutover без parallel run V2 — нарушает rollback safety

### Что нужно пересмотреть

- Если в Phase 5 реализации обнаружится что V3 schema имеет bug — 01-data-migration.md mapping может потребовать обновления
- Если Aidan migration выявит edge case с task-bound retention — пересмотр F3 criterion
- Если Saule deployment upреётся — ADR о конкретной проблеме

## Phase status после этого ADR

| Фаза | Что | Статус |
|---|---|---|
| 0. Setup | Workspace, git, tracking | ✅ done |
| 1. Principles | Зачем, для кого, что "хорошо" | ✅ done |
| 1.5. Simplicity Pass | Аудит принципов | ✅ done |
| 2. AS-IS | Как устроено сегодня | ✅ done |
| 3. TO-BE | Целевая архитектура | ✅ done |
| **4. Migration** | **План миграции V2→V3** | **✅ done** |
| 5. Execute | Реализация | ⚪ next |

**5 из 6 фаз закрыты** за одну сессию 2026-04-11. Осталась **Phase 5 (Execute)** — написание кода V3.0 по blueprint из Phase 1-4.

## Следующий шаг: Phase 5 Execute

Phase 5 — **это код**. Не документы. Не design. Implementation по готовому blueprint.

### Pre-Phase-5 readiness check

- ✅ Principles зафиксированы (Phase 1 + Simplicity Pass)
- ✅ AS-IS понят (Phase 2)
- ✅ TO-BE спроектирован полностью (Phase 3 + ADR-007/008/009)
- ✅ Migration план executable (Phase 4)
- ⚪ Runtime decision: Bun (ADR-007) — нужен установленный Bun на dev machine
- ⚪ Repository: возможно нужна отдельная `src/` структура внутри `~/qoopia-v3/` или отдельная репа для кода

### Phase 5 scope preview

1. **Bootstrap repository structure** — `~/qoopia-v3/src/`, `package.json`, `tsconfig.json`, базовый layout
2. **Migration files** — создать `migrations/001-initial-schema.sql` из `20-to-be/01-schema.md`
3. **Core services** — implement 13 MCP tools, auth middleware, retention
4. **CLI** — `qoopia install`, `qoopia admin *`, `qoopia status` etc из `20-to-be/04-install.md`
5. **Migration script** — implement `scripts/migrate-from-v2.ts` из `30-migration/01-data-migration.md`
6. **Verification** — implement `scripts/verify-migration.ts`
7. **Test suite** — minimal integration tests (LoC budget allows)
8. **Run on Askhat Mac Mini** — actual parallel deployment and per-agent cutover

**Timeline Phase 5**: 1-2 недели coding + migration + cutover ~22 дня = **~5-6 недель total до V2 off**.

Phase 5 **not started in this session** — requires actual implementation time. ADR-011 = Phase 4 closed, Phase 5 opens when ready.

## Ссылки

- `docs/30-migration/README.md`
- `docs/30-migration/00-overview.md`
- `docs/30-migration/01-data-migration.md`
- `docs/30-migration/02-cutover.md`
- Phase 2 `07-migration-map.md` — базис для Phase 4
- Phase 3 ADR-007/008/009 — bootstrap decisions для Phase 5
- ADR-010 — Phase 3 accepted (предыдущая gate)
