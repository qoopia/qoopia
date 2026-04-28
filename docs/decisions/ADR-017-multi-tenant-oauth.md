# ADR-017 — Multi-tenant OAuth via dashboard cookie session

Status: proposed (2026-04-28)
Author: Alan (orchestrator)
Triggered by: friend onboarding (closed beta) — claude.ai web Custom
Connector requires OAuth, current `/oauth/authorize` is single-user.

## Context

Qoopia v3 supports OAuth 2.0 + PKCE today (see ADR-009 opaque tokens,
QSEC-002 owner consent, QRERUN-001 fail-closed approve). The flow ships
with hard single-user assumptions:

1. **`/oauth/register` is gated on `env.ADMIN_SECRET`** (`src/http.ts:341`).
   Anyone registering a client must possess the workspace owner's master
   secret.
2. **`/oauth/authorize` consent form requires `ADMIN_SECRET` in the form
   POST** (`src/http.ts:717-722, 781-788`).
3. **`registerClient()` refuses when `workspaces` has more than one row**
   (`src/auth/oauth.ts:306-313`) and otherwise auto-binds the new client
   to "the first active agent in the default workspace"
   (`src/auth/oauth.ts:317-329`).

Together these turn the OAuth path into "the workspace owner authorizes
themselves." This is fine for me-only deployments. It is the wrong shape
for closed beta:

- Friend registers his own Claude.ai Custom Connector pointing at
  `https://beta.qoopia.ai/mcp`. Claude.ai's connector UI **only**
  supports OAuth 2.0 (Client ID/Secret) — not raw Bearer
  (verified via claude-code-guide review, 2026-04-28).
- For OAuth to issue tokens scoped to *his* workspace, he needs to be
  able to (a) register a client and (b) approve the consent form — both
  without the master `ADMIN_SECRET`, which we will not share.
- Beta DB has 3 workspaces (bravo / charlie / delta). The current
  multi-workspace guard in `registerClient` makes the path unreachable
  even with ADMIN_SECRET.

We already solved a structurally identical problem for the dashboard
in ADR-015 (QDASH-COOKIE): replace ADMIN_SECRET-style gates with a
**signed HttpOnly session cookie** derived from the agent's own api-key
login. Outstanding cookies are revocable on api-key rotation and
deactivation.

ADR-017 reuses that boundary for OAuth.

## Decision

Two-surface design that respects ADR-015's `Path=/api/dashboard` cookie
boundary:

- **`/oauth/register`** (RFC 7591 spec endpoint): authenticate via
  `Authorization: Bearer <api_key>`. Drop the ADMIN_SECRET gate. The
  registering agent's `agent_id` and `workspace_id` are bound onto the
  new client row.
- **`/oauth/authorize`** (browser redirect target from Claude.ai etc.):
  the OAuth surface itself **never reads the dashboard cookie**.
  Instead, when an unauthenticated browser hits it, the server creates
  a server-side `consent_ticket`, redirects the browser to a
  dashboard-scoped consent UI, and waits for the dashboard surface to
  record an approval. After approval the operator is redirected back to
  a `/oauth/authorize/finalize` URL that emits the OAuth code.

This bridge pattern means:
- `qoopia_dash` cookie keeps `Path=/api/dashboard`. ADR-015's defense-
  in-depth invariant ("the cookie is never attached outside dashboard
  routes") is preserved unchanged.
- The `/oauth/*` surface trusts only one thing: a server-side
  consent_ticket row whose `approved_by_agent_id` is non-NULL. It does
  not read cookies, headers from operator sessions, or any browser-
  carried state beyond the ticket id (which is itself opaque + signed).
- Browser CSRF amplification through dashboard XSS is bounded by the
  same surface that ADR-015 already secured: nonce + Origin/Referer
  check + SameSite=Strict on the approval POST. No new amplification.

Concretely:

### 1. `/oauth/register` (POST) — Bearer only

- Auth: `Authorization: Bearer <api_key>` (the same auth path every
  other Qoopia endpoint accepts). ADMIN_SECRET path **removed**.
- Cookie is intentionally NOT honored on `/oauth/register` — the
  endpoint sits outside `Path=/api/dashboard`, and minting a registration
  endpoint that reads cookies would force broadening the cookie path
  (the very regression ADR-015 protects against). Browser-initiated
  client registration belongs on the dashboard surface (see §1b below)
  not on the spec endpoint.
- The registering agent **must** be steward or claude-privileged in its
  workspace — standard agents cannot create connectors. (Standard-agent-
  creates-connector is a quiet privilege escalation: a compromised
  standard agent could mint an OAuth surface targeting its own workspace
  data.)
- `oauth_clients.agent_id` and `oauth_clients.workspace_id` come from
  the authenticated `AuthContext`. The current schema already stores
  `agent_id`; a new `workspace_id` column is added by migration 011
  (denormalization for the consent-ticket workspace check — saves a
  join on every authorize-redirect).
- The multi-workspace guard at `oauth.ts:306-313` is **removed**.
  Multi-tenant is the new shape; the guard becomes a regression.

### 1b. `POST /api/dashboard/oauth/clients` — dashboard-side wrapper

Browser-initiated registration (operator clicking "Add Connector" in
the dashboard UI) hits a dashboard-scoped endpoint authenticated via
the existing `qoopia_dash` cookie. It calls `registerClient()` with the
cookie's `AuthContext`. Pure ergonomic delegation — no new policy
beyond §1's steward/claude-priv check. Lives on `Path=/api/dashboard`
where the cookie is already valid.

The dashboard UI itself is out of scope for this PR (tracked
separately). The endpoint ships now so the cookie/UI path exists
when the UI lands; for the friend's first onboarding, registration
goes through curl + Bearer per §1.

### 2. `/oauth/authorize` (browser redirect from Claude.ai et al.)

The flow has three hops, plus a finalize step:

```
   ┌───────────┐   GET /oauth/authorize?client_id=...&...
   │ Claude.ai │─────────────────────────────────────────────┐
   └───────────┘                                             │
                                                             ▼
                                         ┌────────────────────────────────────┐
                                         │ /oauth/authorize (no auth read)    │
                                         │ - validate OAuth params + client   │
                                         │ - load oauth_clients.workspace_id  │
                                         │ - INSERT consent_ticket row        │
                                         │   (state_id, client_id, all OAuth  │
                                         │    params, expires=now+10m)        │
                                         │ - 302 → /api/dashboard/oauth-      │
                                         │   consent?ticket=<state_id>        │
                                         └─────────────┬──────────────────────┘
                                                       │
                                                       ▼
                                         ┌────────────────────────────────────┐
                                         │ /api/dashboard/oauth-consent (GET) │
                                         │ - cookie attaches (Path matches)   │
                                         │ - require cookie session, else 302 │
                                         │   → /dashboard?next=oauth-consent  │
                                         │   ?ticket=<state_id>               │
                                         │ - cookie.workspace_id ===          │
                                         │   ticket.client.workspace_id?      │
                                         │   no → render "wrong workspace"    │
                                         │   page (no approve button)         │
                                         │ - render consent UI: "Authorize    │
                                         │   <client_name> for workspace X"   │
                                         │   + Approve / Deny + nonce         │
                                         └─────────────┬──────────────────────┘
                                                       │
                                          POST /api/dashboard/oauth-consent/approve
                                            (or /deny)  + nonce + Origin check
                                                       ▼
                                         ┌────────────────────────────────────┐
                                         │ /api/dashboard/oauth-consent/      │
                                         │   approve (POST)                   │
                                         │ - cookie auth re-checked           │
                                         │ - nonce one-time consumed          │
                                         │ - Origin/Referer match PUBLIC_URL  │
                                         │ - workspace match re-verified      │
                                         │ - UPDATE consent_ticket SET        │
                                         │     approved_by_agent_id =         │
                                         │     cookie.agent_id, approved_at = │
                                         │     now                            │
                                         │ - 302 → /oauth/authorize/finalize  │
                                         │   ?ticket=<state_id>               │
                                         └─────────────┬──────────────────────┘
                                                       │
                                                       ▼
                                         ┌────────────────────────────────────┐
                                         │ /oauth/authorize/finalize          │
                                         │ - load consent_ticket              │
                                         │ - require approved_by_agent_id     │
                                         │   non-NULL, expires > now,         │
                                         │   redeemed = 0                     │
                                         │ - workspace match re-verified      │
                                         │ - mark redeemed=1 (single-use)     │
                                         │ - emit OAuth `code` (existing      │
                                         │   issueCode flow), bind code →     │
                                         │   approved_by_agent_id             │
                                         │ - 302 → client.redirect_uri        │
                                         │   ?code=...&state=...              │
                                         └────────────────────────────────────┘
```

Notes:

- **No cookie reads on `/oauth/*`.** The `/oauth/authorize` GET, the
  `/oauth/authorize/finalize` GET, and the `/oauth/token` POST never
  inspect the dashboard cookie. They read only the consent_ticket row
  and the canonical OAuth state.
- **Single-use ticket.** `consent_ticket.redeemed = 1` once finalize
  completes. Replaying the finalize URL is a no-op (returns
  `invalid_request: ticket already redeemed`).
- **TTL.** 10 minutes. Long enough that an operator can log into the
  dashboard mid-flow if they aren't already. Short enough that a
  leaked URL is dead by the time it lands somewhere.
- **Wrong-workspace cookie.** If the cookie's workspace doesn't match
  the client's, the consent UI renders a "you are signed in to
  workspace X but this client belongs to workspace Y" page with a
  switch-account hint. No approve button — the cross-workspace surface
  is architecturally unreachable, not just blocked at submit time.
- **Deny path.** POST `/api/dashboard/oauth-consent/deny` marks the
  ticket `denied=1` and 302s back to `client.redirect_uri` with
  `error=access_denied&state=...`. Mirrors the existing deny flow.
- **Audit rows.** Approve, deny, and any cross-workspace mismatch all
  write activity rows of class `admin` with the operator's agent_id +
  client_id + ticket_id.

### 2a. Why not just use the cookie on `/oauth/authorize` directly

Considered and rejected — see "Alternatives considered" §E below.
Short version: it requires either widening cookie path (regresses
ADR-015 §"`/mcp` and other non-dashboard routes never read the cookie")
or minting a parallel cookie (two surfaces to harden, two TTLs to
align, two revocation paths). The bridge has one cookie surface
(unchanged) and one server-side state surface (new but small).

### 3. Approval scope

Approvals are workspace-scoped, not global. A steward in workspace A
cannot approve clients targeting workspace B even if A's steward also
holds ADMIN_SECRET. ADMIN_SECRET stops being the OAuth approval
identity entirely. (It remains the dashboard-key-rotation tool and the
session-signing-key fallback per ADR-015.)

### 4. Resulting token binding

The `oauth_tokens` row already binds to the client's `agent_id`. After
the migration, the agent_id is the registering operator's agent_id,
which means tokens issued through OAuth are scoped to that operator's
workspace. The client cannot escape its workspace by exchanging codes
because `exchangeCodeForTokens` reads `oauth_clients.agent_id` directly
(`src/auth/oauth.ts:94, 172`). This is a no-code-change benefit of the
schema we already have.

### 5. Tool profile inheritance

OAuth tokens inherit the agent's `tool_profile` (per ADR-016 §"Out of
scope — OAuth-issued tokens"). A friend approving a connector for his
steward agent gets full-profile tokens; if the operator wants to
restrict the connector, he creates or demotes a separate agent first
and approves under that agent's cookie. No new flag needed.

## Migration

`migrations/011-oauth-multitenant.sql`:

```sql
-- (a) Denormalize workspace_id onto oauth_clients for fast workspace-match
-- checks on the consent-ticket path without joining agents on every request.
ALTER TABLE oauth_clients ADD COLUMN workspace_id TEXT;

-- Backfill for existing rows (prod has only the AMA workspace today; beta
-- has 3 workspaces but no OAuth clients yet). NULL stays allowed for one
-- release so the constraint can be added strictly in 012 once the codebase
-- guarantees population.
UPDATE oauth_clients
SET workspace_id = (SELECT workspace_id FROM agents WHERE agents.id = oauth_clients.agent_id)
WHERE workspace_id IS NULL;

-- (b) New table: server-side consent tickets. Each row is one in-flight
-- /oauth/authorize attempt waiting for an operator to approve via the
-- dashboard surface.
CREATE TABLE consent_tickets (
  id                    TEXT PRIMARY KEY,           -- random 128-bit, base64url
  client_id             TEXT NOT NULL,              -- references oauth_clients.id
  workspace_id          TEXT NOT NULL,              -- snapshot of client.workspace_id at ticket creation
  redirect_uri          TEXT NOT NULL,              -- copy of OAuth params (server is source of truth, not browser-carried)
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  scope                 TEXT NOT NULL DEFAULT '',
  state                 TEXT NOT NULL DEFAULT '',
  approved_by_agent_id  TEXT,                       -- NULL until /api/dashboard/oauth-consent/approve writes it
  denied                INTEGER NOT NULL DEFAULT 0,
  redeemed              INTEGER NOT NULL DEFAULT 0, -- set when /oauth/authorize/finalize emits the code
  approve_nonce         TEXT NOT NULL,              -- one-time, consumed by approve POST
  created_at            TEXT NOT NULL,
  expires_at            TEXT NOT NULL,              -- now + 10 minutes
  FOREIGN KEY (client_id) REFERENCES oauth_clients(id) ON DELETE CASCADE
);
CREATE INDEX consent_tickets_expires ON consent_tickets(expires_at);
CREATE INDEX consent_tickets_client ON consent_tickets(client_id);
```

A `pruneConsentTickets()` housekeeping pass runs once per minute alongside
the existing OAuth code/nonce GC (`src/auth/oauth.ts` periodic), deleting
rows where `expires_at < now() OR redeemed = 1 OR denied = 1` and
older than 1h (audit-trail grace window before hard delete).

Migration 012 (next release after 011 is shipped and validated):

```sql
-- Defensive integrity once the write path is known to populate the column.
-- Done via table rewrite because SQLite ALTER cannot add NOT NULL.
-- (Pattern used by migrations 003, 007.)
ALTER TABLE oauth_clients RENAME TO oauth_clients_old;
CREATE TABLE oauth_clients (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  agent_id            TEXT NOT NULL,
  workspace_id        TEXT NOT NULL,        -- now NOT NULL
  client_secret_hash  TEXT NOT NULL,
  redirect_uris       TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);
INSERT INTO oauth_clients SELECT id, name, agent_id, workspace_id, client_secret_hash, redirect_uris, created_at FROM oauth_clients_old;
DROP TABLE oauth_clients_old;
```

## Code touch points

| File | Change |
|---|---|
| `src/http.ts:338-348` (`/oauth/register` route) | Drop `checkAdminSecret`. Authenticate via `Authorization: Bearer` only. Call `assertCanRegisterOAuth(auth)`. Pass `auth` to `registerClient`. |
| `src/http.ts:324-332` (`/oauth/authorize` GET+POST routes) | Replace `handleAuthorizeGet`/`handleAuthorizePost` with a single `handleAuthorizeRedirect` that creates a `consent_ticket` and 302s to the dashboard surface. The old POST handler is deleted (POST `/oauth/authorize` becomes 405). |
| `src/http.ts:781-788` (`verifyConsentSecret`) | **Deleted.** The function and the form field disappear. |
| `src/http.ts` (new route) | `GET /oauth/authorize/finalize` — reads ticket, requires `approved_by_agent_id` non-NULL, marks `redeemed=1`, emits OAuth code, redirects to `client.redirect_uri`. |
| `src/http.ts` (new route, dashboard scope) | `GET /api/dashboard/oauth-consent?ticket=` — cookie auth required (existing dashboard middleware), workspace match check, render consent UI. |
| `src/http.ts` (new route, dashboard scope) | `POST /api/dashboard/oauth-consent/approve` — cookie + nonce + Origin check, writes `approved_by_agent_id`, 302 to finalize. |
| `src/http.ts` (new route, dashboard scope) | `POST /api/dashboard/oauth-consent/deny` — sets `denied=1`, 302 to client `redirect_uri` with `error=access_denied`. |
| `src/http.ts` (new route, dashboard scope) | `POST /api/dashboard/oauth/clients` — cookie auth wrapper around `registerClient`. |
| `src/auth/oauth.ts:272-367` (`registerClient`) | Take `auth: AuthContext` instead of inferring "first active agent." Remove `wsCount > 1` guard. Bind `agent_id`/`workspace_id` from `auth`. |
| `src/auth/oauth.ts` (new) | `assertCanRegisterOAuth(auth)` — type ∈ {steward, claude-privileged}. Throws QoopiaError("FORBIDDEN") otherwise. |
| `src/auth/oauth.ts` (new) | `createConsentTicket()`, `getConsentTicket()`, `approveConsentTicket()`, `denyConsentTicket()`, `redeemConsentTicket()`, `pruneConsentTickets()`. |

## Tests

`tests/oauth-register.test.ts` (new or extend existing):

- standard agent Bearer cannot register a client (403 FORBIDDEN)
- steward in workspace A registers → row has correct `agent_id`,
  `workspace_id`, `client_secret_hash`
- claude-privileged in workspace A registers → row has correct
  `agent_id`, `workspace_id`
- ADMIN_SECRET header alone (no Bearer) → 401 (regression: ADMIN_SECRET
  is no longer the auth identity)
- regression: `wsCount > 1` no longer blocks registration in beta-style
  multi-workspace DBs

`tests/oauth-consent-bridge.test.ts` (new):

- `/oauth/authorize` with valid params + missing/invalid cookie → 302 to
  `/api/dashboard/oauth-consent?ticket=...` (NOT a 401, NOT a consent UI)
- `/oauth/authorize` with malformed params → 400 (no ticket created)
- `/oauth/authorize` with unknown `client_id` → 400 (no ticket created)
- `/oauth/authorize` with `redirect_uri` not in client's allowlist → 400
- `/api/dashboard/oauth-consent` GET without cookie → 302 to
  `/dashboard?next=...`
- `/api/dashboard/oauth-consent` GET with cookie for workspace A and
  ticket for workspace B → 200 with "wrong workspace" page (no approve
  button rendered, no nonce issued)
- `/api/dashboard/oauth-consent` GET with matching cookie + valid ticket
  → 200 with approve button + nonce
- `/api/dashboard/oauth-consent/approve` with mismatched workspace → 403
  (defense in depth even though the GET hides the button)
- `/api/dashboard/oauth-consent/approve` with reused/expired nonce → 403
- `/api/dashboard/oauth-consent/approve` with Origin/Referer not matching
  PUBLIC_URL → 403
- `/api/dashboard/oauth-consent/approve` happy path → ticket
  `approved_by_agent_id` set, 302 to `/oauth/authorize/finalize?ticket=...`
- `/oauth/authorize/finalize` without approval → 400 ("ticket not approved")
- `/oauth/authorize/finalize` after redeem → 400 ("ticket already
  redeemed") (replay attempt)
- `/oauth/authorize/finalize` after expiry → 400 ("ticket expired")
- `/oauth/authorize/finalize` happy path → 302 to client `redirect_uri`
  with `code` + `state` echoed back; `oauth_codes` row bound to ticket's
  `approved_by_agent_id`
- deny: `/api/dashboard/oauth-consent/deny` → 302 to client
  `redirect_uri` with `error=access_denied&state=...`; ticket marked
  `denied=1`; finalize on the denied ticket returns 400

`tests/oauth-token-scope.test.ts` (extend):

- end-to-end: registerClient under steward A → consent ticket → approve
  by A's cookie → finalize → exchangeCodeForTokens → token has
  `agent_id` of A and `workspace_id` of A
- end-to-end attempt with cookie for B against ticket for A: token never
  minted (no row in `oauth_tokens` after 403 on approve)

## Rollout

1. Land migration 011 + code changes (register Bearer, consent_tickets,
   bridge endpoints) on beta first.
2. Beta restart applies migration. Existing OAuth path on prod is
   untouched until prod restart — the migration is additive (new
   nullable column + new table), so a prod with old code on a 011-DB is
   safe.
3. Friend onboarding flow:
   - Friend curls `POST /oauth/register` with his api-key Bearer →
     receives `client_id` + `client_secret`.
   - Friend pastes those into Claude.ai Custom Connector setup, with
     `Authorization URL = https://beta.qoopia.ai/oauth/authorize`,
     `Token URL = https://beta.qoopia.ai/oauth/token`.
   - Friend clicks "Connect" in Claude.ai — browser redirects to
     `/oauth/authorize?client_id=...`, which 302s him to
     `/api/dashboard/oauth-consent?ticket=...`.
   - If not yet logged into beta dashboard, he's redirected to
     `/dashboard?next=...`, pastes his Bearer once, gets cookie, lands
     back on consent page.
   - Sees "Authorize <Claude.ai client name> for workspace DELTA",
     clicks Approve. Browser is redirected back through finalize to
     Claude.ai with the OAuth code. Claude.ai exchanges code for token.
4. Verify on beta: friend's claude.ai issues `tools/list` against
   DELTA-bound MCP, gets DELTA workspace tools, cannot see BRAVO or
   CHARLIE (existing workspace isolation). Confirm via `oauth_tokens`
   and activity log.
5. Migration 012 (NOT NULL on `oauth_clients.workspace_id`) ships in the
   release after 011 is in production with no observed NULL writes.

## Alternatives considered

### A. Per-workspace `ADMIN_SECRET`s

Add a `workspaces.admin_secret_hash` column; each workspace owner gets
their own secret to type into the consent form. Rejected: copies the
ADMIN_SECRET ergonomic problem (operators do not like typing master
secrets in browsers — that is exactly why ADR-015 exists), and creates
a second, parallel auth surface that has to be hardened independently.

### B. RFC 7591 dynamic registration without auth (open)

OAuth spec permits anonymous client registration. Rejected: the actual
threat is not a stranger registering a client (clients only get tokens
if a real operator approves consent), but the consent UI then becomes
the only line of defense and runs in the operator's browser. A misclick
on a phishing-shaped consent screen would mint a real OAuth token. The
registration-time admin gate keeps the attack surface narrow — only
*known operators* can put clients in front of consent UIs.

### C. Re-use the OAuth access token for registration

"Register a client by sending an existing OAuth Bearer." Rejected:
circular — the friend has no OAuth token until he registers a client,
and the api-key Bearer already covers headless registration via curl.

### D. Defer until dashboard UI ships

Wait for the dashboard to gain a "Connect Claude.ai" button and avoid
wire-protocol multi-tenancy entirely. Rejected: the same cookie auth
work is on the critical path for the UI anyway, and the friend wants to
connect now. Better to ship the boundary first and add UI atop it.

### E. Read `qoopia_dash` cookie directly on `/oauth/authorize`

Drafted in v1 of this ADR; rejected after self-review (2026-04-28).
Two real problems:

1. **Cookie scope mismatch.** ADR-015 deliberately scopes `qoopia_dash`
   to `Path=/api/dashboard` ("the cookie's `Path=/api/dashboard` keeps
   it from being attached to those requests in the first place"). The
   browser would not send it to `/oauth/authorize`. Fixing this by
   widening to `Path=/` regresses ADR-015's defense-in-depth; minting a
   parallel cookie scoped to `/oauth` doubles the cookie surface
   (two TTLs to align, two revocation paths to maintain, two signing-
   key consumers).
2. **XSS amplification.** ADMIN_SECRET was a typed-each-time secret. A
   dashboard XSS could not get it and could not approve OAuth clients.
   Replacing it with a same-origin auto-attached cookie means dashboard
   XSS can drive a `GET /oauth/authorize` → `POST /oauth/authorize`
   sequence and mint a connector token. The bridge pattern routes
   approval through a dashboard endpoint that is *already* the
   ADR-015-secured surface (nonce + Origin check + SameSite=Strict),
   so XSS amplification is bounded by the same surface dashboard XSS
   could already abuse — no new amplification.

The bridge pattern keeps `/oauth/*` cookie-free, leaves ADR-015 untouched,
and routes browser approval through the existing dashboard surface where
nonce/Origin/Referer protections are already shipped. Net diff: one new
table, four new endpoints (one OAuth-side, three dashboard-side), zero
cookie-scope changes.

## Out of scope

- **Refresh-token rotation telemetry** — already shipped in earlier OAuth
  PR; no change here.
- **Self-service client deregistration UI** — operator can revoke via
  `/oauth/revoke` per token; full client deletion is a separate ticket.
- **Per-client `tool_profile` overrides** — ADR-016 says OAuth inherits
  agent profile; revisit only if a real per-client need appears.
- **Approving OAuth flows for *other* people in the same workspace** —
  current model is one workspace = one operator identity (the agent that
  logged into the dashboard). Multi-operator-per-workspace is a future
  ADR if Qoopia grows team workspaces.

## Consequences

- One column added (`oauth_clients.workspace_id`), one new table
  (`consent_tickets`), one ergonomic guard removed (`wsCount > 1`), one
  obsolete check deleted (`verifyConsentSecret`), cookie session reused
  via dashboard-side bridge endpoints — `/oauth/*` itself remains
  cookie-free.
- ADR-015's `Path=/api/dashboard` invariant is preserved. The `/mcp`
  surface and the `/oauth` surface both remain outside the cookie's
  reach.
- Friend can connect Claude.ai web to his own beta workspace without
  ever touching ADMIN_SECRET.
- ADMIN_SECRET's blast radius shrinks: it no longer participates in
  OAuth registration or approval. Remaining roles: dashboard
  session-signing-key fallback (ADR-015 §Signing key tier 2), key
  rotation tool, install bootstrap.
- Cross-workspace OAuth consent becomes architecturally impossible at
  three layers: (1) `consent_tickets.workspace_id` snapshot on creation,
  (2) workspace match check on dashboard consent GET, (3) workspace
  match re-check on approve POST, (4) consent_ticket binding propagates
  into the issued OAuth code's `agent_id`, which `exchangeCodeForTokens`
  uses for the resulting `oauth_tokens` row. A break at any one layer is
  caught by the next.
- XSS-amplification risk versus the v1 draft: bounded by the existing
  ADR-015 protections (nonce + SameSite=Strict + Origin/Referer check).
  Approving an OAuth client via XSS requires forging a cross-origin POST
  on `/api/dashboard/oauth-consent/approve` with a fresh nonce that the
  attacker has not seen — same surface dashboard XSS already had to
  break in ADR-015.

## Verification

- `bun run typecheck` clean.
- `bun test` — new tests in oauth-multitenant.test.ts + extended scope
  tests pass; no regression in `tests/oauth-*.test.ts` already present.
- Codex gpt-5.5 read-only review before merge.
- Smoke test on beta: friend registers a client under DELTA, approves
  consent under DELTA cookie, exchanges code → token, calls
  `tools/list` and `brief` from claude.ai web Custom Connector. Confirm
  no BRAVO / CHARLIE visibility.

## QSA-H — codex review findings (2026-04-28)

Independent gpt-5.4 review caught four real issues in the v2 draft. All
fixed in the same PR before merge; tests pinned in
`tests/oauth-bridge-eligibility.test.ts` (11 cases, all pass).

1. **CRITICAL — `/oauth/register` accepted OAuth access tokens.**
   `authenticate()` resolves both static api_keys and OAuth access tokens.
   The first version of `assertCanRegisterOAuth` only checked agent type,
   so any valid OAuth bearer issued to a steward could mint new clients
   forever — one approved connector becomes self-replicating OAuth sprawl.
   **Fix:** `assertCanRegisterOAuth` now also requires `auth.source === "api-key"`.
   Registration is api-key only.

2. **CRITICAL — consent surface accepted OAuth bearers.**
   `checkDashboardAuth()` falls back to Bearer when no cookie is present, and
   the Bearer path goes through `authenticate()`, which accepts OAuth tokens.
   That meant a third-party app holding any active OAuth access token in the
   workspace could `GET /api/dashboard/oauth-consent`, read the rotated nonce,
   and `POST /approve` — defeating the bridge pattern entirely.
   **Fix:** propagate `source` ("api-key" | "oauth" | "cookie") into
   `DashboardAuth`, and have all three consent handlers (GET, approve POST,
   deny POST) call `oauthConsentRejection(auth)` first. OAuth source → 403.

3. **HIGH — consent allowed any dashboard-eligible agent type, including
   `standard`.** Registration was admin-only, but consent was not. A standard
   agent in the same workspace could approve a pending ticket and mint OAuth
   tokens bound to itself.
   **Fix:** `oauthConsentRejection` also requires `isAdmin` (steward or
   claude-privileged). Consent is strictly admin-tier, symmetric with
   registration.

4. **HIGH — finalize re-checked the wrong workspace.** The defense-in-depth
   re-check called `clientWorkspace(ticket.client_id)`, which resolves the
   *registering client owner's* workspace. The actual drift case is the
   *approving agent's* workspace changing between approve and finalize, which
   that lookup doesn't cover.
   **Fix:** finalize now SELECTs the approving agent's current
   `workspace_id` and `active` flag and refuses if either drifted from the
   ticket. Audit row written on mismatch.

5. **MED — cross-workspace `deny` was not audited.** GET/approve mismatches
   wrote a `workspace_mismatch` audit row; deny did not.
   **Fix:** parity audit row added on the deny path.

6. **MED — ticket GC anchored on `created_at`.** Retention drifted with how
   long the operator took to approve.
   **Fix:** `pruneConsentTickets` now anchors on `expires_at`. Retention is
   deterministic: TTL + grace from creation, regardless of when the ticket
   transitioned to a terminal state. No schema churn.
