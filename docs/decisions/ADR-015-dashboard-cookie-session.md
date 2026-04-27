# ADR-015 — Dashboard session cookie (QDASH-COOKIE)

Status: accepted (2026-04-26)
Context: post-Codex-5 follow-up on QSEC-001 dashboard auth. The browser
dashboard previously held the agent's Bearer api_key in `sessionStorage`,
forcing the user to re-paste it on every browser restart and exposing the
key to any successful XSS. Asking the user to keep retyping the key was
also pushing them toward the obvious-but-wrong fix (`localStorage`), which
keeps the same XSS exposure permanently.

## Decision

The dashboard authenticates with a server-issued **HttpOnly session
cookie** (`qoopia_dash`), not the raw Bearer token.

### Login flow

```
Browser        →  POST /api/dashboard/login
                  Authorization: Bearer <agent_api_key>
Server         →  validates Bearer (steward / standard / claude-privileged)
               →  REQUIRES auth.source === "api-key" (OAuth tokens 401)
               →  re-reads {api_key_hash, session_version} for the same
                  agent row and constant-time-compares row.api_key_hash
                  to sha256(presented bearer); a rotation that committed
                  between authenticate() and this read fails the compare
                  → 401 (QDASHCOOKIE-005)
               →  signs payload {agent_id, sv, exp = now+24h} with HMAC-SHA256
               →  Set-Cookie: qoopia_dash=<payloadB64>.<tagB64>;
                  Path=/api/dashboard; HttpOnly; SameSite=Strict;
                  Max-Age=86400; Secure (over HTTPS)
               →  200 { ok, agent_id, type, isAdmin, expires_in }
Browser        →  discards Bearer; clears the input field; never stores it
```

OAuth access tokens are explicitly rejected at this endpoint
(QDASHCOOKIE-001). An OAuth token is short-lived (1h) and revocable via
`oauth_tokens.revoked`; minting a 24h dashboard cookie from one would let
the cookie outlive the OAuth grant, because the cookie payload does not
back-point at the token row. If we later want OAuth-driven dashboard
sessions, that needs explicit TTL/revocation binding (see Post-merge
hardening below) — separate decision, separate ADR.

### Subsequent reads

`GET /api/dashboard/*` is authenticated by either:

1. `Authorization: Bearer <api_key>` — primary path, used by curl, scripts,
   the login flow itself. Behavior unchanged from QSEC-001.
2. The signed `qoopia_dash` cookie — fallback when the header is absent.
   The cookie's signature is verified, the embedded `agent_id` is looked
   up in the DB, and the agent's `active` flag and `type` are checked on
   every request. A deactivated agent's cookie stops working immediately.

`/mcp` and other non-dashboard routes never read the cookie. The cookie's
`Path=/api/dashboard` keeps it from being attached to those requests in
the first place; even if a client manually forwarded it, the server
ignores it outside the dashboard auth paths.

### Logout

`POST /api/dashboard/logout` is unauthenticated and idempotent. It just
emits `Set-Cookie: qoopia_dash=; Max-Age=0; Path=/api/dashboard`. Worst
case (cross-site forced logout) is annoyance, not breach.

### Origin guard

POST `/login` and `/logout` reject requests whose `Origin` or `Referer`
does not match `env.PUBLIC_URL` or the request's own `Host`. Requests
without `Origin`/`Referer` (curl, server-to-server) are allowed — Bearer
in `Authorization` is itself proof of authenticity, and forcing CSRF
tokens on non-browser callers would just push integrators back onto the
cookie path we're trying to avoid.

### Cookie value is NOT the Bearer

The cookie carries
`base64url(JSON({agent_id, sv, exp})) "." base64url(HMAC)`, not the
api_key. (`sv` is the agent's `session_version` at login — see post-#34
revocation below.) Three consequences:

1. Leaking the cookie does not leak the api_key. An exfiltrated cookie is
   a single 24-hour bearer, not a permanent credential.
2. Deactivating an agent immediately invalidates outstanding cookies via
   the per-request DB check (`agents.active = 1`).
3. The cookie payload is opaque to the dashboard JS (HttpOnly), so an
   XSS cannot read it.

**Cookie revocation surface (post-#34):**

- Agent deactivation (per-request `active=1` check on the cookie path,
  plus a `session_version` bump for defense in depth).
- **api_key rotation** — `rotateAgentKey()` increments
  `agents.session_version`, and the cookie payload carries the
  `session_version` snapshot from login as `sv`. Cookie auth requires
  `payload.sv === agents.session_version`, so a stolen cookie dies on
  the next request after rotation.
- Rotation of `QOOPIA_SESSION_SECRET` (or process restart on the
  ephemeral fallback key) — invalidates every outstanding cookie at once,
  workspace-wide.
- Cookie expiry (24h Max-Age + payload `exp`).
- Logout — clears the *browser's* cookie copy only; the signed value
  remains valid elsewhere until one of the conditions above fires. We
  could add a server-side revocation list later, but that adds DB write
  load on every logout and does not close any meaningful threat that
  rotation/expiry doesn't already close.

### Signing key

`sessionKey()` resolves in this order:

1. `QOOPIA_SESSION_SECRET` — explicit env, recommended for prod.
2. `QOOPIA_ADMIN_SECRET` — already in the LaunchAgent plist;
   domain-separated via `HMAC(admin_secret, "qoopia-dashboard-session-v1")`.
3. Ephemeral random (32 bytes) — generated once per process. Acceptable
   for dev / single-user deployments; cookies invalidate on restart.

### Proxy / Secure-cookie semantics (QDASHCOOKIE-004)

The `Secure` attribute on `qoopia_dash` is set only when the request
reached us over HTTPS. `isHttps(req)` decides this:

- If the underlying socket is TLS-encrypted (`socket.encrypted === true`),
  return true.
- Otherwise honor `x-forwarded-proto: https` ONLY when both
  `TRUST_PROXY=true` AND the upstream peer (`req.socket.remoteAddress`)
  is in `TRUSTED_PROXIES`. An attacker reaching the listener directly
  cannot spoof the header into Secure.
- Otherwise return false (no Secure flag).

**Production deployment requirements** (cloudflared / nginx in front of
the loopback listener):

- `TRUST_PROXY=true` in the LaunchAgent plist environment.
- `TRUSTED_PROXIES` contains the actual upstream peer address. Default
  is `127.0.0.1,::1,::ffff:127.0.0.1`, which is correct for the standard
  cloudflared-on-the-same-host topology.
- The proxy must set `x-forwarded-proto: https` for HTTPS-terminated
  requests. cloudflared does this by default.

If any of those is missing, the dashboard cookie ships **without**
`Secure` even when the public hostname is HTTPS. This is fail-closed (no
secret leakage) but breaks the principle of defense-in-depth, so a
deploy-time check should confirm all three are set.

### HMAC tag comparison (QDASHCOOKIE-003)

Tags are compared via `crypto.timingSafeEqual` over fixed-length raw
HMAC-SHA256 buffers (32 bytes). Tags whose decoded length is not exactly
32 bytes are rejected before the compare runs; the compare itself never
sees a length mismatch and never throws. The previous hand-rolled string
compare worked but was avoidably non-standard; the platform primitive
is the authoritative implementation.

### Why HMAC + DB lookup, not JWT-only

Pure JWT (signature-only) cannot revoke: a stolen 24-hour token is valid
for 24 hours regardless of agent deactivation. The per-request DB lookup
is one indexed read on `agents.id` — cheap — and means deactivation is
instant. The signature still gates DB access (so a tampered cookie never
reaches the lookup).

## Consequences

- The browser dashboard never sees the raw Bearer after login (and the
  login page wipes the input field). XSS impact: limited to whatever the
  authenticated session can do for ≤ 24h, no permanent credential leak.
- The api_key flow for curl / scripts is unchanged.
- Single-restart cookie invalidation is acceptable (the ephemeral key
  fallback). Operators wanting persistent sessions across restarts set
  `QOOPIA_SESSION_SECRET` in the plist.
- A new test suite (`tests/dashboard-cookie-auth.test.ts`) pins all the
  invariants: login issues HttpOnly+SameSite=Strict cookie, cookie value
  contains zero bytes of the raw Bearer, cookie auth works without
  Authorization, /mcp does not honor the cookie, Origin mismatch is
  rejected, deactivation kills outstanding cookies, tampered cookies
  return 401, and OAuth access tokens cannot mint a dashboard cookie.

## Post-merge hardening (status)

| Item | Status |
|------|--------|
| QDASHCOOKIE-003: `crypto.timingSafeEqual` on fixed-length buffers | **Done** (post-merge PR) |
| QDASHCOOKIE-004: TRUST_PROXY/Secure semantics + tests | **Done** (post-merge PR) |
| #34: instant revocation on api_key rotation (`session_version`) | **Done** (post-merge PR) |
| #35: expired/malformed/Referer-only/replay-after-logout tests | **Done** (post-merge PR) |
| OAuth-driven dashboard sessions (separate ADR) | Not started — explicit non-goal |
| Server-side revocation list / logout-all | Not planned — rotation+expiry covers the threat |

## Alternatives rejected

- `localStorage`: persists across restarts but XSS-exfiltrates the raw
  Bearer permanently. Rejected by Асхат explicitly.
- JWT (signature only, no DB lookup): cannot revoke before expiry.
- Per-session opaque ID stored in a new DB table: extra schema, extra
  state, no upside over a signed payload that points at an existing
  `agents.id`.
