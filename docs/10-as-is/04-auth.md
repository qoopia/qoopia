# 04 — AS-IS: Auth & identity

**Источник**: `~/.openclaw/qoopia/src/api/middleware/auth.ts` + `handlers/auth.ts` + `handlers/oauth.ts` + `handlers/agents.ts`

**LoC**:
- `handlers/oauth.ts` — **906** (самый большой handler!)
- `handlers/agents.ts` — 261
- `handlers/auth.ts` — 212
- `middleware/auth.ts` — 106
- `middleware/permissions.ts` — 198
- `middleware/rate-limit.ts` — 96
- `middleware/cors.ts` — 38
- `middleware/idempotency.ts` — 54
- `middleware/request-id.ts` — 20

**Всего auth/middleware**: **1891 LoC**

Это **вторая по размеру** подсистема V2 после core/intelligence.ts + все MCP tools вместе.

## 04.1 Auth middleware (`src/api/middleware/auth.ts`, 106 LoC)

**Делает** на каждом запросе:
1. Читает `Authorization: Bearer <token>` header
2. Если header отсутствует — 401 + `WWW-Authenticate` с OAuth discovery link
3. **Priority 1: API Key** (token не начинается с `eyJ`):
   - SHA-256 hash token
   - Lookup в `agents.api_key_hash` (current key) → auth as agent
   - Lookup в `agents.previous_key_hash` (+ grace period check) → auth as agent
   - Lookup в `users.api_key_hash` → auth as user + session expiry check
4. **Priority 2: JWT** (token starts with `eyJ`):
   - `verifyAccessToken(token)` из `oauth.ts`
   - Читает `payload.sub` → lookup `agents.name`
   - Set auth context with agent info

**Оценка качества**: достаточно хорошо структурировано. Grace period на key rotation — дополнительная complexity.

**Решение V3.0**: **SIMPLIFY**.

1. **Drop previous_key_hash / grace period** — rotation = просто `UPDATE agents SET api_key_hash = ?`. Если агент использовал старый key — 401, пусть обновит. Simpler.
2. **Drop user session_expires_at check** — users в V3.0 minimal (см. 01-schema A2).
3. **Simplify WWW-Authenticate discovery header** — можно оставить как есть (полезно для OAuth discovery), это 1 line.
4. **Keep** API key path для агентов (основной use case).
5. **Keep** JWT path для OAuth (для Claude.ai connector).

**Размер**: 106 → ~60 LoC.

## 04.2 OAuth handler (`src/api/handlers/oauth.ts`, 906 LoC)

Это **самый большой** файл handlers. Реализует **OAuth 2.0 authorization code flow + PKCE + refresh tokens + OAuth discovery metadata + JWKS endpoint + DCR (Dynamic Client Registration) + token introspection + token revocation**.

**Endpoints**:
- `POST /oauth/register` — Dynamic Client Registration (RFC 7591)
- `GET /.well-known/oauth-authorization-server` — discovery
- `GET /.well-known/oauth-protected-resource` — resource metadata (RFC 9728)
- `GET /.well-known/jwks.json` — public keys для JWT verification
- `GET /oauth/authorize` — authorization endpoint (PKCE code flow)
- `POST /oauth/token` — token endpoint (exchange code → access+refresh, refresh → new access)
- `POST /oauth/introspect` — token introspection (RFC 7662)
- `POST /oauth/revoke` — token revocation (RFC 7009)
- `verifyAccessToken(token)` — JWT verify helper (used by middleware)
- Internal: JWT signing key management, PKCE challenge verification, code storage, token hashing

**Оценка качества**: это полноценная OAuth 2.0 реализация на уровне спецификаций. С DCR, discovery, JWKS, introspection — всё как нужно для enterprise MCP connector.

**Проблема**: это **огромная подсистема** для того что реально используется. В prod реально активны только:
- `/oauth/authorize` + `/oauth/token` (Claude.ai code flow + refresh)
- `/.well-known/oauth-protected-resource` (Claude.ai discovery)
- `verifyAccessToken()` (auth middleware)

**DCR, introspection, revocation** — вероятно не используются вообще. Проверяется.

**Решение V3.0**: **MAJOR SIMPLIFY**.

**Минимум для Claude.ai connector**:
1. `POST /oauth/register` DCR — **DROP** (Claude.ai может передавать pre-configured client_id/secret через env vars при setup)
2. `GET /.well-known/oauth-authorization-server` — **KEEP** (простой JSON метаданных)
3. `GET /.well-known/oauth-protected-resource` — **KEEP** (5 строк JSON)
4. `GET /.well-known/jwks.json` — **KEEP** если используем JWT с RSA/EC, или **DROP** если переходим на HS256 или opaque tokens
5. `GET /oauth/authorize` — **KEEP** (PKCE code flow)
6. `POST /oauth/token` — **KEEP** (exchange + refresh)
7. `POST /oauth/introspect` — **DROP** (MCP clients не используют, только auth middleware делает проверку внутри себя)
8. `POST /oauth/revoke` — **SIMPLIFY** (можно оставить minimal: `UPDATE oauth_tokens SET revoked = 1`)
9. JWT signing with RSA/EC + JWKS → **REPLACE with HS256** (symmetric, один secret в env, проще setup). Trade-off: нельзя дать третьей стороне public key для verify без connecting to Qoopia. Для V3.0 — достаточно, Claude.ai всё равно проверяет через introspect или прямой запрос к Qoopia.

**Альтернативный радикальный путь**: **opaque tokens** вместо JWT.
- Token = случайная строка (например ULID или random base64)
- Qoopia хранит hash в `oauth_tokens` с `expires_at`
- Validate = lookup в таблице + check expires_at + check revoked
- **Нет JWT**, нет подписи, нет JWKS, нет key rotation для JWT

Это то как делают многие production OAuth серверы (включая GitHub, Slack). **Проще и безопаснее**: revoke мгновенно применяется (не надо ждать истечения JWT).

**Решение**: **recommend opaque tokens в V3.0**. Это радикальное упрощение.

**Размер oauth.ts**: 906 LoC → **~150-200 LoC** (только authorize + token + well-known endpoints + minimal revoke).

**Экономия**: ~700 LoC только в oauth.ts. Плюс simplification в middleware/auth.ts (нет JWT path, один code-path).

## 04.3 Auth handler (`src/api/handlers/auth.ts`, 212 LoC)

Отдельный handler от OAuth. Содержит (предположительно — не читал полностью):
- `POST /auth/login` — magic link request
- `GET /auth/verify` — magic link verification
- `POST /auth/logout` — session termination
- Dashboard human login flow

**Решение V3.0**: **DROP полностью**.

Причины:
- Dashboard redesign отложен (NG-5)
- Magic links выкидываются (01-schema E4)
- Единственный user в prod — Асхат, и он не ходит в dashboard
- Agent auth идёт через API key / OAuth, не через этот handler

**Экономия**: 212 LoC.

## 04.4 Agents handler (`src/api/handlers/agents.ts`, 261 LoC)

CRUD для `agents` таблицы. Endpoints для создания агента, ротации ключа, деактивации.

**Решение V3.0**: **SIMPLIFY**.

В V3.0 операции над агентами — это **лёгкий admin surface**:
- `POST /admin/agents` — create agent (returns api_key)
- `DELETE /admin/agents/:id` — remove agent (удаляет workspace или сохраняет через query param)
- `POST /admin/agents/:id/rotate-key` — rotate (returns new api_key, старый мгновенно invalidated)
- `GET /admin/agents` — list agents for operator UI

Без grace period rotation, без permission rules editing (нет permissions в V3.0), без metadata endpoints.

**Размер**: 261 → ~80 LoC.

## 04.5 Permissions middleware (`src/api/middleware/permissions.ts`, 198 LoC)

**Делает**: per-route permission enforcement на основе `agents.permissions JSON`. Parses rules like `{entity: 'tasks', actions: ['read', 'write']}` и checks против current request's (entity, action) пары.

**Решение V3.0**: **DROP полностью**.

В V3.0 permission model = **агент имеет полный доступ в свой home workspace + Claude имеет global read**. Это enforced через:
- Auth middleware устанавливает `auth.workspace_id`
- Все SQL запросы добавляют `WHERE workspace_id = ?` через query helper
- Claude идентифицируется по `agent_type='claude'` или подобному флагу, получает bypass на чтение

**Нет** per-tool ACL, нет per-entity permission rules, нет парсинга JSON rules.

**Экономия**: 198 LoC + упрощение agents table (`permissions JSON` колонка становится пустой или удаляется).

## 04.6 Rate-limit middleware (`src/api/middleware/rate-limit.ts`, 96 LoC)

Token bucket или similar rate limiter per-agent или per-IP.

**Решение V3.0**: **SIMPLIFY** или **DROP**.

Для локальной инсталляции (один агент на одном Mac Mini) — rate limiting имеет смысл только как защита от infinite loop'а в агенте. Можно оставить **минимальный** (max 1000 requests/min per agent) как safety net.

**Размер**: 96 → **~30 LoC** (простой in-memory counter с периодическим сбросом).

**Альтернатива**: **DROP** совсем в V3.0. Добавить в V3.5 если agent infinite loops станут реальной проблемой.

**Рекомендация**: **DROP в V3.0**. Простое правило «агент не должен infinite loop'ить» живёт в инструкциях системного промпта, не в rate limiter.

## 04.7 CORS middleware (`cors.ts`, 38 LoC)

Стандартный CORS handler.

**Решение**: **KEEP** как есть. CORS нужен для dashboard + для cross-origin MCP запросов. 38 LoC — мало, не трогаем.

## 04.8 Idempotency middleware (`idempotency.ts`, 54 LoC)

Проверяет `Idempotency-Key` header, если есть — lookup в `idempotency_keys` таблице, если retry — возвращает кэшированный response.

**Решение**: **KEEP**. Полезно для retry safety агентов. Connected с таблицей `idempotency_keys` (01-schema F2).

## 04.9 Request-ID middleware (`request-id.ts`, 20 LoC)

Генерирует / пропагирует `X-Request-Id` header для трейсинга.

**Решение**: **KEEP**. 20 LoC полезной observability.

## Сводка auth/identity layer

| Файл | V2 LoC | V3.0 LoC | Δ |
|---|---|---|---|
| `handlers/oauth.ts` | **906** | ~180 (opaque tokens path) | **−726** |
| `handlers/auth.ts` | 212 | 0 (drop) | **−212** |
| `handlers/agents.ts` | 261 | ~80 | −181 |
| `middleware/auth.ts` | 106 | ~60 | −46 |
| `middleware/permissions.ts` | 198 | 0 (drop) | **−198** |
| `middleware/rate-limit.ts` | 96 | 0 (drop in V3.0) | −96 |
| `middleware/cors.ts` | 38 | 38 | 0 |
| `middleware/idempotency.ts` | 54 | 54 | 0 |
| `middleware/request-id.ts` | 20 | 20 | 0 |
| **Всего** | **1891** | **~432** | **−1459 (−77%)** |

**Главные источники экономии**:
1. **oauth.ts 906 → 180** — переход с JWT+JWKS+DCR+introspection на opaque tokens
2. **permissions.ts 198 → 0** — нет per-tool ACL
3. **auth.ts handler 212 → 0** — нет magic links / dashboard login

## Risk review

**Риск 1**: «Claude.ai connector перестанет работать без DCR».
- **Mitigation**: Claude.ai не требует DCR. Можно pre-configured client_id/secret через env vars при setup Qoopia. Проверено на других MCP серверах (lcm-mcp Нияза, anthropic-mcp-examples).

**Риск 2**: «Opaque tokens vs JWT — теряем stateless validation».
- **Trade-off**: да, opaque требует DB lookup на каждый validate. Но: (a) это локальная инсталляция, lookup — 1 мс; (b) instant revocation; (c) проще setup (нет JWKS, key rotation); (d) не нужно делиться public key со сторонними.

**Риск 3**: «Без rate limit агент может infinite loop'ить Qoopia».
- **Mitigation**: добавить rate limit в V3.5 если станет реальной проблемой. В локальной single-user среде это маловероятно.

**Риск 4**: «Без permission middleware кто-то получит доступ не в свой workspace».
- **Mitigation**: workspace scoping enforced в auth middleware (устанавливает `auth.workspace_id`) + во всех SQL queries через mandatory WHERE clause. Это **сильнее** per-tool ACL потому что one code-path, невозможно «забыть» добавить permission check.

## Что остаётся в V3.0 auth layer

**Минимальный surface**:

```
POST /oauth/authorize       — PKCE authorization code flow (Claude.ai setup)
POST /oauth/token           — exchange code → token, refresh token → new access
GET  /.well-known/oauth-*   — discovery JSON
POST /oauth/revoke          — instant revoke (update opaque token row)

POST /admin/agents          — create agent, returns api_key
GET  /admin/agents          — list agents
DELETE /admin/agents/:id    — remove agent
POST /admin/agents/:id/rotate-key — new api_key

Middleware:
- auth.ts          — API key (SHA256 lookup) OR opaque token (DB lookup)
- cors.ts          — standard
- idempotency.ts   — standard
- request-id.ts    — standard
```

**Всего**: ~432 LoC вместо 1891. Упрощение mental model auth layer: **один способ аутентификации** для агентов (api_key SHA256), **один способ** для Claude.ai (opaque token), **один способ** для admin (same api_key).
