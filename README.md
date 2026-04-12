# Qoopia V3 — Workspace

Рабочая мастерская для редизайна Qoopia. **Прод-система живёт в `~/.openclaw/qoopia/` и её мы не трогаем**, пока не закончим проектирование и не согласуем миграцию.

## Цель

Превратить Qoopia в:
1. Стабильный **RAG-слой** — единый источник знаний для всех агентов
2. Единый **источник правды** по сущностям (tasks, deals, contacts, finances, notes, projects)
3. Стабильный **MCP сервер** для любой системы, которая хочет подключиться
4. Систему с **идеальной логикой записей** — понятно, что куда пишется
5. **Минимальный порог входа** — новый пользователь понимает систему за минуты, не часы

## Владелец

Асхат Солтанов.

## Как тут ориентироваться

```
qoopia-v3/
├── docs/
│   ├── 00-principles/   ← ФАЗА 1: зачем и для кого. Пишется первой.
│   ├── 10-as-is/        ← ФАЗА 2: как устроено сегодня на самом деле
│   ├── 20-to-be/        ← ФАЗА 3: целевая архитектура
│   ├── 30-migration/    ← ФАЗА 4: план миграции
│   └── decisions/       ← ADR (Architecture Decision Records): почему сделали вот так
├── research/            ← выписки из прод-Qoopia: код, схема, замеры
└── README.md            ← ты здесь
```

## Фазы работы

| Фаза | Что | Статус |
|---|---|---|
| 0. Setup | Workspace, git, tracking | ✅ done |
| 1. Principles | Зачем Qoopia, для кого, что "хорошо" | ✅ done (после Simplicity Pass) |
| 1.5. Simplicity Pass | Аудит принципов на over-engineering после lcm-mcp ревью | ✅ done |
| 2. AS-IS | Как устроено сегодня | ✅ done — 9 документов в `docs/10-as-is/` |
| 3. TO-BE | Целевая архитектура | ✅ done — 5 документов в `docs/20-to-be/` + 3 ADR |
| 4. Migration | План переезда | ⚪ pending — **следующая** |
| 5. Execute | Реализация | ⚪ pending |

**Правило**: каждая фаза заканчивается явным "да, идём дальше" от владельца. Не проскакиваем.

## Команда (6 линз)

Каждое решение проходит через шесть взглядов:

1. **Product & UX** — ради кого это, как чувствуется первый контакт
2. **Information Architecture** — что куда пишется, какие категории
3. **Data & Retrieval (RAG)** — схема, embeddings, гибридный поиск
4. **API & MCP** — форма tools, ergonomics для LLM
5. **Security & Ops** — workspaces, keys, бэкапы, rollback
6. **Migration** — как переехать без потерь

Если хоть одна линза против — возвращаемся.

## ADR-процесс

Каждое важное решение фиксируется как отдельный файл `docs/decisions/ADR-NNN-title.md`.
Формат — см. `docs/decisions/ADR-000-template.md`.
Смысл: через полгода мы (или новый агент) открываем ADR и **понимаем почему** мы решили именно так, а не иначе.

## Как вернуться к работе в новой сессии

Claude Desktop App не имеет "Projects" для Claude Code (только для обычных чатов). Вместо этого **Claude Code группирует сессии по рабочей папке** — "OPENCLAW", "ZA-GAME" и т.д. появляются автоматически когда ты стартовал сессию из соответствующей папки.

**Чтобы появился проект "qoopia-v3" в сайдбаре Claude Code**, запусти следующую сессию отсюда:

```bash
cd ~/qoopia-v3 && claude
```

Или через Desktop App: New session → выбери папку `~/qoopia-v3/`.

При старте сессии Claude Code **автоматически прочитает `CLAUDE.md`** в этой папке, и новый агент получит онбординг: куда смотреть, какая фаза, что read-only, как сохранить прогресс. Контракт лежит в `CLAUDE.md` в корне.

## Прогресс

- 2026-04-11: Фаза 0 завершена. Workspace создан.
- 2026-04-11: Фаза 1 (Principles) пройдена — 5 документов написаны и подписаны.
- 2026-04-11: Фаза 1.5 (Simplicity Pass) проведена после изучения peer implementation lcm-mcp от Нияза Ирсалиева. Вырезано over-engineering по 8 областям. V3.0 scope радикально упрощён: FTS5 only, no semantic, no auto-compaction, no large file handling, one workspace mode, one notes table.
- 2026-04-11: Фаза 1 закрыта финально. 6 ADR зафиксированы.
- 2026-04-11: Фаза 2 (AS-IS audit) завершена. 9 документов в `docs/10-as-is/`. Финальная карта миграции: V2 9379 LoC → V3.0 ~1787 LoC (−81%), 20 таблиц → 10, 2 внешних API deps → 0, `intelligence.ts` (657 LoC) → DROP. 300-char truncation bug pinpointed at `memory.ts:218`.
- 2026-04-11: Фаза 3 (TO-BE) завершена. 5 документов в `docs/20-to-be/` + 4 ADR. Bootstrap решения: Runtime = Bun (ADR-007), Transport = MCP SDK (ADR-008), Auth = opaque tokens (ADR-009). Executable DDL готов, 13 MCP tools specs готовы, 6 system prompt templates готовы, `qoopia install` flow готов. Target: ~1725 LoC core, 3 deps. Phase 3 accepted via ADR-010. Следующий шаг — Фаза 4 (Migration planning).
