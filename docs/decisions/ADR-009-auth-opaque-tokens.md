# ADR-009: Auth — opaque tokens для OAuth, SHA-256 API keys для агентов

**Status**: accepted
**Date**: 2026-04-11
**Deciders**: Асхат + Claude

## Контекст

V2 Qoopia имеет **906 LoC** `oauth.ts` — полная OAuth 2.0 реализация: PKCE code flow, refresh tokens, Dynamic Client Registration (DCR), JWKS endpoint, JWT access tokens с RSA/EC подписями, token introspection (RFC 7662), token revocation (RFC 7009), OAuth discovery metadata.

Реально используется только **PKCE code flow + refresh token** (Claude.ai MCP connector). Остальное — никем не запрашивается. Это over-engineering по ADR-004.

Дополнительно V2 использует **SHA-256 API keys** для agent auth (старый путь, работает отлично): агент посылает key, middleware SHA-256 хэширует и лукапит в `agents.api_key_hash`.

Нужно решение для V3.0: как минимизировать auth layer, сохранив совместимость с Claude.ai + agent API keys.

## Варианты

### Вариант A (самый простой возможный): Opaque tokens + SHA-256 API keys

**Что это**:
- **Agent API keys**: то же что в V2 — агент держит random string, Qoopia хранит SHA-256 hash в `agents.api_key_hash`. Lookup на каждый request.
- **OAuth access tokens**: **opaque** — не JWT, а случайная строка (ULID или base64 random). Qoopia хранит hash в `oauth_tokens.token_hash` с `expires_at` + `revoked`. Validate = DB lookup.

- Плюсы:
  - **Нет JWT / JWKS / key rotation** — убираем подсистему подписей
  - **Нет `jose` dependency** — минус 1 npm package
  - **Instant revocation** — `UPDATE oauth_tokens SET revoked = 1` → следующий request блокируется. JWT нельзя мгновенно invalidate без token blacklist.
  - **Проще setup** — Клиенту (Claude.ai) не нужно проверять JWKS, не нужно RSA/EC public keys
  - **DB lookup cost тривиален** — SQLite lookup с PK hash ~0.1 мс на локальной машине
  - **Простой auth middleware** — один `SELECT ... WHERE token_hash = ?`, без try/catch на JWT verify
  - **Единый mental model** — для agent API key и OAuth token используется одинаковая схема (SHA256 hash → DB lookup)
  - Peer lcm-mcp Нияза использует похожую logic (простая session-based, не JWT)
- Минусы:
  - Каждый auth check делает DB query (vs JWT stateless verify). На 1000 req/s это становится bottleneck, на 10 req/s — незаметно. **Наш профиль — десятки req/min**, не issue.
  - Нельзя делиться public key со сторонними системами для verify без доступа к Qoopia. В V3.0 сторонних verifier'ов **нет**.

### Вариант B: JWT + JWKS (как V2)

- Плюсы:
  - Stateless verify — DB lookup не нужен
  - Стандартно для OAuth 2.0 с discovery
  - Поддерживается «из коробки» OAuth client libraries
- Минусы:
  - **906 LoC** реализации в V2 — больше чем нужно для single-user local deploy
  - Сложность: RSA/EC key generation, `jose` dep, JWKS endpoint, key rotation, JWT verify paths
  - **Нет instant revocation** — revoked JWT живёт до expires_at (или нужен отдельный blacklist, что сводит к opaque)
  - Нарушает бюджет H1 (≤ 2000 LoC core) если тянуть из V2 как есть

### Вариант C: Pre-shared secret только (no OAuth)

**Что это**: убираем OAuth вообще, все клиенты аутентифицируются через фиксированный API key в конфиге.

- Плюсы:
  - Максимальная простота (200 LoC auth layer)
  - Нет таблиц oauth_*
- Минусы:
  - **Не совместимо с Claude.ai connector** — Claude.ai требует OAuth 2.0 code flow. Без OAuth — нет Claude.ai интеграции. Это **dealbreaker**, поскольку Claude.ai — primary production клиент.

### Вариант D: Hybrid — opaque tokens для OAuth, JWT для internal

- Плюсы:
  - Внешние клиенты через OAuth opaque (совместимость), internal через JWT (stateless)
- Минусы:
  - **Два auth code-path** — усложнение без пользы
  - Внутренние вызовы в Qoopia всё равно идут через тот же middleware, нет "внутреннего" клиента
  - Нарушает радикальную простоту

## Решение

Выбран **Вариант A — Opaque tokens для OAuth, SHA-256 API keys для agents**.

### Конкретный flow

#### Agent auth (primary path для CLI/script клиентов)

```
1. Admin создаёт агента: POST /admin/agents (name=alan, workspace_id=...)
2. Qoopia генерирует random API key (32 bytes base64 → ~43 chars)
3. Qoopia INSERT в agents: api_key_hash = SHA256(api_key)
4. Qoopia возвращает api_key (единственный раз, больше нигде не хранится)
5. Агент кладёт в конфиг как `Authorization: Bearer <api_key>`
6. На каждый request:
   middleware: hash = SHA256(token)
   SELECT id, workspace_id, name FROM agents WHERE api_key_hash = ? AND active = 1
   Если found → auth context set → next()
```

#### OAuth auth (для Claude.ai connector)

```
1. Claude.ai делает GET /.well-known/oauth-authorization-server → discovery JSON
2. Claude.ai redirects user в GET /oauth/authorize?client_id=...&code_challenge=...
3. Qoopia показывает authorize page, user approves
4. Qoopia генерирует random code → stores в oauth_codes → redirect к Claude.ai
5. Claude.ai делает POST /oauth/token с code + code_verifier (PKCE)
6. Qoopia verifies PKCE → генерирует 2 random tokens:
   - access_token (opaque, 48 chars base64)
   - refresh_token (opaque, 48 chars base64)
   Хранит SHA256(access_token) и SHA256(refresh_token) в oauth_tokens
7. На каждый MCP request:
   middleware: hash = SHA256(token)
   SELECT agent_id, workspace_id, expires_at, revoked FROM oauth_tokens WHERE token_hash = ?
   Если found + !revoked + expires_at > now() → auth context set
```

**Key insight**: agent API keys и OAuth access tokens используют **одну и ту же таблицу lookup model** на уровне middleware — разница только в том где hash найдёт row (`agents` vs `oauth_tokens`). Middleware пробует обе таблицы.

### Размер реализации

| Подсистема | LoC оценка |
|---|---|
| `POST /oauth/authorize` (PKCE code flow) | ~50 |
| `POST /oauth/token` (exchange + refresh) | ~60 |
| `POST /oauth/revoke` (instant revoke) | ~15 |
| `GET /.well-known/oauth-authorization-server` | ~20 |
| `GET /.well-known/oauth-protected-resource` | ~10 |
| Auth middleware (agent API key + oauth token) | ~40 |
| `POST /admin/agents` + rotate key | ~30 |
| **Total auth layer** | **~225** |

Vs V2: 906 (oauth) + 212 (auth handler, dropped) + 198 (permissions, dropped) + 106 (middleware) = **1422 LoC → ~225 LoC** (−84%).

**Проверка на простоту**: Вариант A самый простой **из тех что совместимы с Claude.ai**. C проще но несовместим (dealbreaker). B сложнее в 4 раза. D гибрид — избыточно.

## Последствия

### Что становится проще

- **Instant revocation** — `UPDATE oauth_tokens SET revoked = 1`, следующий request агента = 401, мгновенно
- **Нет `jose` dep** — минус 1 runtime package
- **Нет JWKS endpoint** — минус ~50 LoC дополнительно
- **Нет key rotation logic для RSA/EC** — никаких 4096-bit keys, PEM файлов, key IDs
- **Auth middleware unified** — один SELECT pattern для обеих auth paths
- **Setup простой** — генерация RSA keys не нужна при `qoopia install`

### Что становится сложнее

- **DB lookup на каждый request** — на ультра-высоких объёмах (1000+ req/s) cache layer нужен. Не в scope V3.0.
- **Если SQLite недоступен** — auth ломается. Но если SQLite недоступен, весь Qoopia не работает, так что это не дополнительная точка отказа.

### Что мы теперь не сможем сделать

- **Federate tokens с внешним OAuth provider** — не планируется
- **Share JWT с другими сервисами для offline verify** — не актуально в single-node setup
- **Load-balance across nodes без sticky sessions** — не в scope V3.0 (single-node)

### Что нужно будет пересмотреть

- Если появится need для multi-node / HA setup — возможно вернуться к JWT или shared cache (Redis)
- Если появится реальная security concern про DB lookup latency — добавить in-memory LRU для valid tokens (small)

## Ссылки

- `docs/10-as-is/04-auth.md` — V2 1891 LoC auth layer audit
- RFC 6749 OAuth 2.0 — Bearer tokens могут быть opaque
- RFC 7636 PKCE — используется как есть
- Claude.ai MCP connector docs — accepts opaque Bearer tokens
- `research/peers/lcm-mcp/src/index.ts` — простой auth model reference
