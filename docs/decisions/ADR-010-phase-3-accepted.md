# ADR-010: Phase 3 (TO-BE) accepted — ready for Phase 4/5

**Status**: accepted
**Date**: 2026-04-11
**Deciders**: Асхат + Claude

## Контекст

Phase 3 (TO-BE architecture design) проходилась 2026-04-11 сразу после закрытия Phase 2 AS-IS audit. Цель: превратить принципы Phase 1 + AS-IS findings Phase 2 в **executable blueprint** для V3.0 реализации.

Фаза 3 — не код, а design specs. Primary acceptance test: разработчик может начать писать код без дополнительных design-вопросов.

## Варианты

Phase 3 ADR — это процедурный ADR (закрытие фазы), не архитектурный выбор. Но следую правилу ADR-000 template (минимум 3 альтернативы):

### Вариант A (самый простой возможный): принять Phase 3 deliverables as-is, переходить к Phase 4 (Migration)

- Плюсы:
  - Сохраняем momentum работы
  - Все документы свежие в памяти владельца
  - Понятная точка фиксации «принципы приняты, дизайн принят, осталось мигрировать и писать код»
- Минусы:
  - Возможно какие-то детали дизайна обнаружатся как недостаточно проработанные в Фазе 5
  - Mitigation: добавить в план «если что — возврат к Phase 3 doc с явным ADR correction»

### Вариант B: дополнительный review pass перед закрытием Phase 3

- Плюсы: большая уверенность
- Минусы: overhead без ясной пользы — принципы уже прошли 4 rounds (Phase 1 original, Simplicity Pass, Phase 2 lens, Phase 3 proposal)

### Вариант C: не закрывать Phase 3 формально, плавно перейти в Phase 4

- Плюсы: неформально, быстро
- Минусы: размывает gate-based discipline (правило из `CLAUDE.md`: «каждая фаза закрывается явным "да"»). Нарушает Фазовую дисциплину.

## Решение

Выбран **Вариант A**. Phase 3 принимается.

### Что принято в Phase 3

**Архитектурные решения** (зафиксированы как ADRs):

- **ADR-007**: Runtime = Bun 1.x (primary), Node 22+ as fallback. Reasoning: simplicity budgets (3 deps vs 7-8), fast cold start, builtin SQLite/HTTP, proven в peer lcm-mcp.
- **ADR-008**: Transport = `@modelcontextprotocol/sdk` + Streamable HTTP. Reasoning: 252 LoC custom → ~80 LoC via SDK, spec compliance автоматом.
- **ADR-009**: Auth = opaque tokens (OAuth) + SHA-256 API keys (agents). Reasoning: 906 LoC OAuth spec → ~225 LoC, instant revocation, no JWKS.

**Design документы**:

- `docs/20-to-be/README.md` — Phase 3 scope, правила, deliverables
- `docs/20-to-be/00-overview.md` — stack, layer diagram, LoC budget распределение, principles compliance check
- `docs/20-to-be/01-schema.md` — **executable DDL** с 10 real tables, 2 FTS5 indexes, triggers, constraints. Ready to copy in `migrations/001-initial-schema.sql`.
- `docs/20-to-be/02-mcp-tools.md` — JSON schemas для 13 tools, behavior, error paths, LoC estimates
- `docs/20-to-be/03-system-prompt.md` — **6 готовых templates** для агентов (universal + Claude + Aidan + Aizek + Alan + Dan), все укладываются в H7 (≤ 30 строк)
- `docs/20-to-be/04-install.md` — `qoopia install` flow, launchd plist template, CLI commands, env vars, backup/restore

### Target LoC distribution (from `00-overview.md`)

| Слой | LoC |
|---|---|
| Transport + bootstrap | ~100 |
| Auth | ~225 |
| MCP tools | ~650 |
| Services (notes, sessions, recall, retention) | ~300 |
| Data layer | ~150 |
| Admin CLI | ~80 |
| Utils | ~100 |
| `qoopia install` CLI | ~120 |
| **Total V3.0 core** | **~1725** |

**Бюджет H1** (≤ 2000 LoC): ✓ с запасом 275 LoC.

### Dependencies target

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0",
    "ulid": "^2.3.0"
  }
}
```

**3 runtime deps**. Бюджет H2 (≤ 5): ✓ с запасом.

## Последствия

### Что становится проще

- Phase 5 developer может сразу писать код по blueprint, не возвращаясь к design вопросам
- Все budgets (H1-H8) проверены на совместимость с design — нет risk что implementation упрётся
- Primary acceptance test (coll одну строчку system prompt) имеет конкретный template в `03-system-prompt.md`
- Migration from V2 имеет конкретный mapping (см. Phase 2 07-migration-map.md)

### Что становится сложнее

- Любая корректировка design после этой точки требует **явного ADR с reasoning** (дисциплина радикальной простоты)
- Поменять runtime (Bun → Node) после этого = новый ADR отменяющий ADR-007
- Поменять transport (SDK → custom) = новый ADR отменяющий ADR-008

### Что мы теперь не сможем сделать

- Добавить semantic retrieval в V3.0 без ADR-011 отменяющего ADR-002 Layer B deferral
- Добавить кастомную OAuth implementation без ADR отменяющего ADR-009
- Вернуться к V2 стилю с per-entity tables без ADR отменяющего Phase 1.5 entity collapse

### Что нужно будет пересмотреть

- Если в Phase 5 реализации обнаружится что Bun/SDK/opaque tokens неожиданно ломаются — Phase 3 документы ревизируются, fallback plan активируется (описан в каждом ADR)
- Если LoC budget начнёт трещать в Phase 5 — запускается вторая Simplicity Pass
- Если primary acceptance test начнёт проваливаться — ревизия 03-system-prompt template

## Phase status после этого ADR

| Фаза | Что | Статус |
|---|---|---|
| 0. Setup | Workspace, git, tracking | ✅ done |
| 1. Principles | Зачем, для кого, что "хорошо" | ✅ done |
| 1.5. Simplicity Pass | Аудит принципов | ✅ done |
| 2. AS-IS | Как устроено сегодня | ✅ done |
| **3. TO-BE** | **Целевая архитектура** | **✅ done** |
| 4. Migration | План миграции V2→V3 | ⚪ next |
| 5. Execute | Реализация | ⚪ pending |

## Следующий шаг: Phase 4 (Migration planning)

Phase 4 — **короткая фаза**. Цели:

1. **Data migration script** — точный путь переноса rows из V2 `~/.openclaw/qoopia/data/qoopia.db` в V3 `~/.qoopia/data/qoopia.db`. Большая часть уже описана в Phase 2 `07-migration-map.md`, нужно оформить как executable transformation spec.

2. **Cutover plan** — как переключать agents с V2 MCP connector на V3 MCP connector по одному, с rollback возможностью. Детали: параллельное использование на разных портах (V2 на 3737, V3 на 3738), postpone Aidan last (см. Phase 1 personas).

3. **Pre-flight checklist для Сауле** — что должно быть доказано перед тем как её Mac Mini получит Qoopia.

4. **Rollback plan** — как вернуться на V2 если V3 окажется сломанным в production.

**Оценка размера Phase 4**: 2-3 документа, короче чем Phase 3. Дальше Phase 5 Execute.

## Ссылки

- `docs/20-to-be/README.md` — scope и правила
- `docs/20-to-be/00-overview.md` — архитектурный summary
- `docs/20-to-be/01-schema.md` — DDL
- `docs/20-to-be/02-mcp-tools.md` — MCP tool specs
- `docs/20-to-be/03-system-prompt.md` — templates для агентов
- `docs/20-to-be/04-install.md` — deployment flow
- ADR-007 (Bun) / ADR-008 (MCP SDK) / ADR-009 (opaque tokens) — foundational decisions
- ADR-006 — Phase 1 accepted (предыдущая gate)
- Phase 2 07-migration-map.md — базис для Phase 4 data migration
