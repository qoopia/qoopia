# ADR-006: Phase 1 (Principles) accepted after Simplicity Pass

**Status**: accepted
**Date**: 2026-04-11
**Deciders**: Асхат + Claude

## Контекст

Фаза 1 (Principles) Qoopia V3 проходилась с 2026-04-11. Написано 5 документов: `01-why.md`, `02-personas.md`, `03-use-cases.md`, `04-success-criteria.md`, `05-non-goals.md`. Первоначально все 5 были подписаны в v1.

В середине Фазы 1 (после изучения peer implementation lcm-mcp Нияза Ирсалиева) стало ясно что первоначальный набросок V3 содержал over-engineering. Открыта Фаза 1.5 Simplicity Pass, которая пересмотрела 8 областей и привела к упрощениям.

Этот ADR формально закрывает Фазу 1 **в её финальном состоянии после Simplicity Pass**, чтобы можно было переходить к Фазе 2 (AS-IS audit прод-Qoopia).

## Варианты

### Вариант A (самый простой возможный): один явный ADR-закрытие с перечислением принятого

- Плюсы:
  - Чёткая точка во времени «принципы зафиксированы»
  - Один файл для будущих сессий «что именно принято»
  - Легко ссылаться из Фазы 2 документов
- Минусы: небольшое дублирование с содержимым самих документов

### Вариант B: не делать отдельный ADR, полагаться на commit history

- Плюсы: меньше файлов
- Минусы: будущая сессия или новый человек не сможет быстро понять «а что реально принято» без чтения всех 5 документов и git log

### Вариант C: ADR для каждого принципа отдельно

- Плюсы: гранулярность
- Минусы: 5 файлов вместо 1, избыточно

## Решение

Выбран **Вариант A**.

### Принято в Фазе 1 (после Simplicity Pass)

**Принципы (`01-why.md`)**:
1. Qoopia — **token-economy layer для агентов**, а не CRM для человека
2. Primary user — **агенты** (Alan, Aizek, Aidan, Claude, Dan, будущие)
3. Три функции в порядке важности: (1) token economy, (2) session memory, (3) knowledge base
4. **Design stance**: решаем свои боли + годно для всех (multi-tenant с первой строки)
5. **Cross-cutting принцип 1**: железобетонная надёжность (7 требований в 03-use-cases.md)
6. **Cross-cutting принцип 2**: радикальная простота (добавлено в Simplicity Pass, ADR-004)
7. **Масштаб KB**: 1 ГБ типично, 10 ГБ как ceiling

**Personas (`02-personas.md`)**:
1. Tier 1: агенты парка Асхата — Alan, Aizek, Aidan, Dan, Claude
2. Tier 2: Асхат сам — **косвенный пользователь**, не открывает руками
3. Tier 3: Сауле и её парк — **первый внешний валидатор**
4. Tier 4: «любой кто работает в мультиагентной среде»
5. **Workspace model (упрощено в Simplicity Pass)**: ОДИН режим — autonomous. Каждый агент владеет своим workspace. Knowledge-base — отдельное измерение, не workspace. Claude имеет persistent cross-workspace read privilege.
6. Retention email контекста: task-bound, auto-purge при закрытии задачи
7. Gate для развёртывания Сауле: работающий one-command install

**Use cases (`03-use-cases.md`)**:
- UC-1: старт новой сессии с полным контекстом
- UC-2: передача задачи между чатами Claude
- UC-3: точечный retrieval по KB (FTS5 в V3.0, semantic в V3.5)
- UC-4: task-bound контекст с автоочисткой
- UC-5: сброс контекста агента в середине сессии
- UC-6: cross-workspace чтение для Claude
- UC-7: LCM-equivalent session memory (добавлен в Simplicity Pass)
- **Primary acceptance test**: коллапс system prompt агента в одну строчку «проверь Qoopia» с железобетонным доверием
- **7 требований железобетонности** — входной билет в Фазу 2

**Success criteria (`04-success-criteria.md`)**:
- Группа A: Reliability (7 критериев)
- Группа B: **Latency** (пересмотрена под FTS5 Layer A в V3.0 — sub-100 мс достижимо)
- Группа C: Token economy (cost visibility, ≥70% экономии, system prompt ≤ 500 tokens)
- Группа D: Deployment simplicity (install ≤ 3 команды, ≤ 2 минуты, 0 конфигов)
- Группа E: Retrieval quality (пересмотрена под FTS5 — Recall@5 ≥ 85%)
- Группа F: Isolation (workspace boundary enforcement)
- Группа G: UX для агента (понятные ошибки, ≤ 10-15 tools)
- **Группа H: Simplicity budgets** (добавлена в Simplicity Pass — LoC ≤ 2000, deps ≤ 5, tables ≤ 10, etc.)

**Non-goals (`05-non-goals.md`)**:
- NG-1 до NG-12: первоначальный список
- NG-13: нет авто-саммаризации (добавлено в Simplicity Pass)
- NG-14: нет semantic search в V3.0 (добавлено в Simplicity Pass)
- NG-15: нет large file interception в V3.0 (добавлено в Simplicity Pass)

### Scope cut для V3.0 (из Simplicity Pass)

Эти вещи отложены из V3.0 в V3.5+ и будут добавлены **по факту реальной боли**:
- Semantic / embedding retrieval (Layer B) — ADR-002
- Shared / scoped workspace modes
- Отдельные таблицы для tasks/deals/contacts/finances/projects (в V3.0 — одна `notes` с `type` + JSON metadata)
- Large file storage layer
- Background auto-compaction
- LRU / importance scoring / summarization-before-delete retention
- Cryptographic tenant isolation
- Claude Code hooks integration
- sub-agent expansion через delegation grants

### Архитектурные решения Фазы 1 зафиксированы в ADR

- ADR-001: Отдельный workspace `~/qoopia-v3/`
- ADR-002: Two-layer retrieval, Layer B deferred
- ADR-003: Agent-driven memory ingestion
- ADR-004: Radical simplicity as first-class principle
- ADR-005: LCM functional absorption
- ADR-006 (этот): Phase 1 accepted after Simplicity Pass

## Последствия

### Что становится проще

- Фаза 2 (AS-IS audit) может стартовать с чёткими критериями: не «что там есть в V2», а «что из V2 соответствует простейшему пути V3.0 и что надо выкинуть»
- Будущие сессии Claude могут прочитать этот ADR и получить полное состояние принципов за 5 минут
- Скоуп V3.0 явно ограничен — исключена расползаемость

### Что становится сложнее

- Любое возвращение к принципам требует явного ADR с обоснованием (не «я передумал»)
- Будущая Фаза 3 (TO-BE) связана жёсткими бюджетами из группы H

### Что мы теперь не сможем сделать

- Добавить фичу в V3.0 без прохождения simplicity-check (ADR-004)
- Пересмотреть scope cut Simplicity Pass без нового ADR

### Что нужно будет пересмотреть

- После первого реального deployment у Сауле — проверить реалистичность бюджетов группы H на практике
- После 1-2 месяцев живого использования V3.0 — собрать список «вот эти вещи из отложенных в V3.5 действительно нужны»

## Ссылки

- `docs/00-principles/01-why.md` — финальная версия
- `docs/00-principles/02-personas.md` — финальная версия
- `docs/00-principles/03-use-cases.md` — финальная версия
- `docs/00-principles/04-success-criteria.md` — финальная версия
- `docs/00-principles/05-non-goals.md` — финальная версия
- `docs/00-principles/PHASE-1.5-SIMPLICITY-PASS.md` — процесс Simplicity Pass
- `docs/decisions/ADR-001` ... `ADR-005` — архитектурные решения Фазы 1

## Следующий шаг

**Фаза 2: AS-IS audit прод-Qoopia (`~/.openclaw/qoopia/`)**.

Цель: разобраться **что реально есть** в текущей V2 — схема БД, MCP tools, CRUD пути, зависимости, поведение. Подсвечены через призму V3.0 scope: что переносится as-is, что упрощается, что выкидывается, что требует миграции.

Фаза 2 **не меняет** прод — только читает. Deliverable: `docs/10-as-is/` с документами по каждой подсистеме.
