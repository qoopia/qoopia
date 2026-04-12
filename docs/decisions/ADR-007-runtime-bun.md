# ADR-007: Runtime — Bun 1.x as primary, Node 22+ as fallback

**Status**: accepted
**Date**: 2026-04-11
**Deciders**: Асхат + Claude

## Контекст

Qoopia V3.0 нужен JavaScript runtime для запуска MCP сервера. V2 использует **Node.js v24.14.0 (hardcoded через nvm path в `start.sh`)**. Это один из хардкодов которые ADR-004 (Simplicity) и multi-tenant требование из `01-why.md` требуют удалить.

Peer reference lcm-mcp Нияза Ирсалиева использует **Bun** и достигает 665 LoC + 2 dependencies. Наш бюджет H1 (≤ 2000 LoC) и H2 (≤ 5 runtime deps) зависят от выбора runtime.

## Варианты

### Вариант A (самый простой возможный): Bun 1.x только

**Что это**: Bun как единственный поддерживаемый runtime. `bun install && bun run src/index.ts`.

- Плюсы:
  - **Встроенный SQLite** через `bun:sqlite` — нет зависимости `better-sqlite3` (одна deps минус)
  - **Быстрый cold start** (~50-100 мс) — критично для H6 «первый вызов ≤ 2 минут»
  - **`bunx qoopia`** возможен — zero-install distribution path (H5)
  - **Встроенный HTTP server** через `Bun.serve()` — возможно заменит Hono (ещё одна deps минус)
  - **Встроенный test runner** (`bun test`) — replace `vitest` (dev dep минус)
  - **TypeScript без transpilation step** — нет отдельного `build` этапа
  - **Built-in bundler и single-binary compile** (`bun build --compile`) для distribution
  - **Как у peer lcm-mcp** — proven setup для MCP сервера в Claude Code окружении
- Минусы:
  - **Новее Node** — экосистема меньше, некоторые edge case'ы могут появиться
  - **`better-sqlite3` не работает** в Bun (Bun использует свой `bun:sqlite`)
  - Миграция с Node на Bun требует переписать `connection.ts`
  - Если Bun уронится на каком-то граничном случае — отладка сложнее чем у Node
  - Некоторые npm-пакеты имеют native bindings, не все совместимы

### Вариант B: Node 22+ только (как V2)

- Плюсы:
  - Proven в V2, zero миграционных рисков
  - `better-sqlite3` работает (уже используется)
  - Максимальная экосистема
  - Mature, предсказуемое поведение
- Минусы:
  - **Требует build step** (`tsc` → `dist/`) — усложняет install
  - **Медленнее cold start** (~500-800 мс Node + tsx)
  - **Нет built-in SQLite** — остаётся зависимость `better-sqlite3` (native binary, нужен build tools на машине пользователя для установки)
  - **`bunx` аналог отсутствует** — `npx @qoopia/mcp` возможен, но устанавливает всё в npm cache, медленнее
  - Дополнительные deps для test runner (`vitest`) и dev mode (`tsx`)
  - Не позволяет выйти в single-binary distribution
  - Нарушает бюджет H5 «≤ 3 команды install» на machines без Node v22+

### Вариант C: Both, runtime-agnostic code

**Что это**: писать код чтобы работал и под Node и под Bun — общий layer для SQLite, HTTP.

- Плюсы:
  - Максимальная гибкость
  - Пользователь выбирает
- Минусы:
  - **Два code-path** для SQLite (better-sqlite3 vs bun:sqlite) и HTTP (hono vs Bun.serve)
  - **Удваивает сложность** тестирования — нужно гонять CI на обоих
  - Нарушает радикальную простоту (ADR-004) — один механизм должен решать одну задачу
  - **Меньше итогового упрощения** — всё равно приходится тащить Hono + better-sqlite3 для Node fallback

## Решение

Выбран **Вариант A — Bun 1.x как primary runtime, с осознанной возможностью миграции на Node если Bun упрётся**.

### Обоснование

1. **Simplicity budget** — без Bun бюджет H2 (≤ 5 deps) нереалистичен:
   - Node: hono + @hono/node-server + better-sqlite3 + jose + pino + ulid + zod = **7 runtime deps**
   - Bun: Bun.serve (built-in) + bun:sqlite (built-in) + ulid + zod + @modelcontextprotocol/sdk = **3 runtime deps**

2. **Install budget H5** (≤ 3 команды) — реалистично с Bun:
   - `curl -fsSL https://bun.sh/install | bash` — один раз на машине
   - `bunx qoopia install` — setup + start
   - Две команды. У Node пришлось бы: установить Node, установить npm пакет, build, запустить (4+ команды).

3. **Cold start latency** — Bun ~100 мс vs Node+tsx ~800 мс. Это влияет на perception скорости когда MCP клиент reconnect'ится, launchd restart, тестирование.

4. **Peer validation** — lcm-mcp Нияза работает в bun, proven в среде Claude Code + Tailscale.

5. **Bun 1.x mature enough** — релиз 1.0 был в 2023, сейчас 1.1+ с сотнями bug fixes. Для задач «HTTP server + SQLite + ULID + zod validation» — зона комфорта.

### Escape hatch: что если Bun упрётся

Если в Фазе 5 выяснится что Bun **ломает** критичный use case (например, `@modelcontextprotocol/sdk` не совместим с Bun HTTP):

**Fallback план**:
1. Минимальные изменения в коде: `bun:sqlite` → `better-sqlite3`, `Bun.serve` → `@hono/node-server`
2. Это ~50 LoC изменений в 2-3 файлах (connection layer и server bootstrap)
3. Runtime полностью меняется с Bun на Node, exit code примерно такой же
4. Пишем ADR-011 «Rollback from Bun to Node», фиксируем причину

**Вероятность**: низкая. Bun + @modelcontextprotocol/sdk проверены в lcm-mcp Нияза.

**Проверка на простоту**: Вариант A самый простой. Меньше deps, меньше install steps, меньше build pipeline. Отвергаем B потому что несовместим с бюджетом H2 (≤5 deps) без компромиссов. Отвергаем C потому что нарушает принцип «один способ делать одну задачу».

## Последствия

### Что становится проще

- **Install**: `bunx qoopia install` — одна команда до работающего MCP сервера (после one-time Bun setup)
- **Build step исчезает**: TypeScript запускается напрямую, нет `tsc` + `dist/` + `copy-assets`
- **Deps минус 3-4**: хватает `ulid` + `zod` + `@modelcontextprotocol/sdk` + (optional) `pino`
- **Cold start** ~10× быстрее чем Node+tsx
- **Single-binary distribution** возможна через `bun build --compile` — в V3.5 может пригодиться для shipping к конечным пользователям без Bun
- **Test runner** built-in, не тащим vitest

### Что становится сложнее

- **Edge cases**: если Bun упадёт на чём-то (меньше Stack Overflow ответов, меньше GitHub issues)
- **Отладка** в некоторых случаях — `node --inspect` заменяется на Bun debugging tools, которые менее mature
- **Миграция кода из V2** — переписать connection.ts и bootstrap, но это ~50 LoC
- **Знание Bun специфики** — разработчик должен знать `Bun.serve`, `bun:sqlite`, `bunx`, `bun install`

### Что мы теперь не сможем сделать

- Использовать `better-sqlite3` напрямую (нужно `bun:sqlite`)
- Использовать некоторые npm пакеты которые жёстко требуют Node runtime (мало таких для нашего домена)
- Легко переносить код V2 напрямую — minimal adaptation нужна

### Что нужно будет пересмотреть

- Если Bun 2.x выйдет с breaking changes и сломает нас — рассмотреть миграцию на Node или freeze на 1.x
- Если появится `@modelcontextprotocol/sdk` incompatibility — Вариант A escape hatch (rollback to Node)
- Если single-binary distribution окажется неактуальной — избавимся от `bun build --compile` требования

## Ссылки

- `research/peers/lcm-mcp/package.json` — baseline Bun setup (3 deps)
- `docs/00-principles/04-success-criteria.md` группа H — simplicity budgets
- `docs/10-as-is/06-deployment.md` — V2 `start.sh` hardcoded Node v24.14.0
- Bun docs: https://bun.sh/docs
- `@modelcontextprotocol/sdk` npm — совместим с Bun по заявлению maintainers
