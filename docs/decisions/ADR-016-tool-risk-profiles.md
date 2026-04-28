# ADR-016 — Per-agent tool risk profiles (QSA-F / Codex QSA-004)

Status: accepted (2026-04-28)
Audit reference: Codex gpt-5.5 read-only review, 2026-04-28, finding **QSA-004**.

## Context

Codex QSA-004 flagged that mutating MCP/admin tools have **no second-factor
or human approval gates**. A compromised agent prompt or session can call
`note_delete`, `agent_deactivate`, or (for steward) `agent_onboard`
directly through MCP and there is no way to scope an agent down to a
read-only or non-destructive subset of tools at the server boundary.

The codebase already has a `ToolProfile` enum with values `"memory" | "full"`
in `src/mcp/tools.ts`, but:

- The server hardcodes `"full"` in `src/http.ts:518` (`createMcpServer(..., "full", ...)`).
- The `"memory"` profile still exposes `session_save` (a write tool).
- There is no per-agent way to demote a single agent to a safer profile —
  the choice is global at server boot.

Codex's recommended fix has two halves:
1. **Tool-level risk classes + read-only / write profiles by default.**
2. **Approval gates / nonces for destructive admin operations.**

This ADR addresses (1). Half (2) — real human-in-loop approval gates that
route a destructive request to an out-of-band confirmation channel —
requires a dashboard UI for pending approvals and is deferred to a
follow-up ADR.

## Decision

Two changes, shipped together:

### 1. Tool risk classification (cosmetic + enforcement)

Each tool definition gains a `risk` field with one of four values:

| risk | meaning | examples |
|---|---|---|
| `read` | no DB writes, no external side effects | recall, brief, note_get, note_list, session_recent, session_search, session_expand, activity_list, agent_list |
| `write-low` | additive writes, recoverable via activity log | note_create, note_update, session_save, session_summarize |
| `write-destructive` | hard or impossible to recover | note_delete |
| `admin` | identity / permission changes | agent_onboard, agent_deactivate |

Two consequences:
- Risk class is logged on every successful MCP tool call (extends
  existing access log in `src/http.ts:507-510`). This makes
  destructive operations greppable in stderr.
- Risk class is exposed in `toolNames(profile)` listings so operators can
  audit what each profile actually permits.

### 2. Per-agent `tool_profile` column

Migration `010-tool-profile.sql` adds:

```sql
ALTER TABLE agents
  ADD COLUMN tool_profile TEXT NOT NULL DEFAULT 'full'
  CHECK (tool_profile IN ('read-only', 'no-destructive', 'full'));
```

Profiles:

| profile | exposes |
|---|---|
| `read-only` | only `risk='read'` tools |
| `no-destructive` | `read` + `write-low` (i.e. everything except `write-destructive` and `admin`) |
| `full` | all tools the agent's type qualifies for (current behavior) |

The existing `"memory"` profile (server-boot global) is retained but
deprecated — it is orthogonal to the per-agent profile and the per-agent
profile takes precedence when both are set.

`createMcpServer()` reads `auth.tool_profile` (added to `AuthContext`)
and applies the per-agent filter in addition to the server-level
`profile` argument. When both filters disagree, the **stricter** wins
(intersection, not union).

### V2 compat tools

`registerTools()` calls `registerCompatTools()` (src/mcp/tools.ts:487)
which exposes V2 backward-compat aliases (`note`, `create`, `update`,
`delete`, `get`, `list`). These aliases re-route to the same handlers
as their canonical names and were already gated for the `"memory"`
server profile. **The per-agent filter MUST also reach these aliases**
— otherwise a `read-only` agent could write via the V2 alias name and
the entire boundary is theatrical.

Implementation: `registerCompatTools` accepts the same per-agent filter
predicate as `registerTools`, and only registers an alias when the
canonical tool's risk class is permitted by the agent's profile.

### Out of scope: dashboard endpoints

`tool_profile` constrains **MCP tools only**. The `/api/dashboard/*`
HTTP endpoints (rotate key, deactivate agent, etc.) authenticate via
the `qoopia_dash` session cookie and have their own admin-type gate
(`ADMIN_TYPES`). A `read-only` agent that *also* logs into the
dashboard with a valid steward Bearer is still subject to the dashboard's
own admin checks, not to `tool_profile`. This is intentional: the
dashboard is a human surface; its boundary is the cookie, not the agent
profile. Operators who want both must either restrict dashboard login
(`POST /api/dashboard/login` accepts only `auth.source === "api-key"`)
or downgrade the agent to a non-admin type — both already exist.

This must be stated in the migration comment and the dashboard help
copy so an operator demoting an agent to `read-only` doesn't expect it
to also lock the dashboard surface.

### Backwards compatibility

The migration default (`'full'`) preserves current behavior for every
existing agent. Operators opt specific agents into a stricter profile
via a new admin-only mutator (see "Surface" below) or via the dashboard.

### Fail-closed on null / unknown profile

The CHECK constraint in the migration prevents writes of invalid
values, but the loaded `AuthContext` still passes through code that
might encounter:

- a freshly upgraded DB where `tool_profile` is somehow null on a row
  that pre-dated the column (CHECK + DEFAULT prevents this in normal
  flow but defense in depth),
- a future profile name added by a newer DB schema talking to an older
  binary (rolling deploy edge case).

Behavior: when `auth.tool_profile` is null, undefined, empty, or not
in the known enum `{'read-only', 'no-destructive', 'full'}`, the
filter MUST treat it as `'read-only'` and emit a single WARN line per
request:

```
WARN agent=<name> tool_profile=<raw> unknown — degraded to read-only (fail-closed)
```

This is the same posture as the QSA-D startup gate: when in doubt,
refuse, and make the doubt loud.

### Self-demote and last-steward guards

`agent_set_profile` is steward-only but that alone is not enough:

1. **Self-demote guard.** A steward calling
   `agent_set_profile({agent_id: caller.agent_id, tool_profile: 'read-only'})`
   would lock themselves out of every admin tool, including the
   ability to call `agent_set_profile` to undo it. The endpoint
   refuses with `FORBIDDEN: cannot demote self — use a different
   steward or DB-level escalation`.
2. **Last-active-steward guard.** Even if a steward demotes a
   *different* steward, if the workspace would end up with zero
   `tool_profile='full' AND type='steward' AND active=1` agents, the
   call is refused (`FORBIDDEN: cannot demote the last full-profile
   steward in workspace <id>`). This mirrors the existing single-
   steward unique constraint logic in admin/agents.ts and prevents
   workspace-level admin lockout via tool-profile demotion.

Both guards live in `agent_set_profile`'s handler, not in the schema —
the schema cannot express "must have ≥1 row matching predicate" without
a deferred trigger that costs more than it earns here.

### Surface for changing an agent's profile

- **Steward MCP tool** `agent_set_profile(agent_id, tool_profile)` —
  steward-only, logs an activity row of type `admin`.
- **Dashboard UI** — out of scope for this PR; a follow-up ticket adds
  a profile selector to the agent detail panel. Until then, steward
  agents change profiles via MCP.

### What this does NOT address

- **Approval gates / nonces / human-in-loop confirmation.** Destructive
  tools still execute immediately for agents whose profile permits them.
  This is a deliberate scoping choice — real approval gates require a
  separate channel (dashboard pending-requests queue + websocket or
  long-poll) and a longer ADR. Tracked as `QSA-F-followup`.
- **Workspace-level deletion** (drop_workspace, etc.) — there is no such
  tool today; if one is added later, it MUST default to `risk='admin'`
  and require explicit operator profile escalation.
- **OAuth-issued tokens.** OAuth tokens get the same profile as the
  agent they bind to — no separate path.

## Alternatives considered

### A. Read-only by default, write requires opt-in

Inverts the migration default to `'read-only'` and forces every existing
agent to be re-permissioned. Cleaner security stance, but breaks every
running integration on the next restart with no graceful migration. The
`'full'` default keeps the QSA-D startup gate philosophy: hardening
should fail loud, not fail silent — and "all your agents stop working
after `bun run migrate`" is silent failure for the operator who didn't
see the ADR.

Rejected for now. Once `read-only` is the documented default for new
agent creation flows in the dashboard, a future ADR can flip the
migration default — that's a smaller break.

### B. Two-call nonce protocol for destructive tools

`note_delete` returns `NEEDS_APPROVAL` + a token; agent re-calls within
N seconds with the token. Rejected: for an autonomous agent with a
compromised prompt, the second call is trivial (the same prompt makes
both calls). Real protection requires the second factor to live on a
**different identity** (human, dashboard, separate steward agent).
That is the QSA-F-followup work.

### C. Risk classes only (no per-agent profile)

Just tag and log. Rejected as insufficient — codex QSA-004 explicitly
asks for read-only / write profiles by default, and tagging without
enforcement adds zero security boundary.

## Consequences

- One DB migration, applied via `bun run migrate` (gated by QSA-D).
- `AuthContext` gains a `tool_profile` field; downstream code that
  builds an AuthContext (auth middleware, tests) updates to populate it.
- New steward tool `agent_set_profile` registered in admin-tools.ts.
- Tests:
  - read-only profile: GET-only tools listed; mutator calls return
    `FORBIDDEN: tool blocked by agent profile`.
  - no-destructive profile: note_create works, note_delete blocked.
  - default 'full' profile: no behavior change vs. main.
  - agent_set_profile: steward-only, validates enum, logs activity.

## Codex review responses (2026-04-28)

Codex gpt-5.5 reviewed the implementation branch and raised four points.
Responses recorded here for the audit trail:

1. **note_update is not write-low** — accepted. Bumped to
   `write-destructive` because text replacement and `metadata_replace`
   are non-recoverable from audit (activity log records field names,
   not prior values). The V2 `update` alias mirrors this. Effect:
   `no-destructive` agents lose `note_update` / `update` along with
   delete-class tools. Tests cover both the canonical and alias paths.

2. **V2 `create entity:activity` bypass for admin agents on
   no-destructive** — accepted. Even though `create` is correctly
   classified as write-low for tasks/deals/contacts/finances/projects,
   the `entity:activity` branch is admin-class (audit-log integrity).
   `v2Create` now requires `tool_profile === 'full'` in addition to
   the existing `isAdmin(auth)` check, so a steward demoted to
   `no-destructive` cannot forge audit rows. Two new tests assert this
   for `no-destructive` and `read-only` admin callers.

3. **`riskOf("create")` always logs write-low, masking
   activity-forging risk** — accepted as-is. The access log is by tool
   name only (params are not inspected at log time). The hardened
   handler in (2) makes the access-log understatement non-load-bearing
   — the runtime gate refuses the call regardless of what the access
   log says. A future enhancement could log resolved entity post-
   handler, but that is not required for correctness.

4. **`agents.last_seen` UPDATE on every authenticated request, even
   for read-only profile** — accepted as a documented non-issue.
   `read-only` is defined as "no mutating MCP tools," not "no DB
   writes ever." `last_seen` is a metering write owned by the auth
   layer (not exposed as an MCP tool), and disabling it would mean
   read-only agents stop appearing in the dashboard's "active agents"
   list — a regression. Documented here so future readers don't read
   the absence of a fix as an oversight.

## Verification plan

- `bun run typecheck` clean.
- `bun test` 154+ pass (new tests added).
- Codex gpt-5.5 review.
- Smoke test against `mcp-beta:3738` before prod restart.

## Rollout

1. Merge this ADR (proposed → accepted).
2. Ship implementation PR (separate from ADR commit).
3. Codex review.
4. CI green.
5. Single prod restart applies migration + activates filter.
6. Operator chooses 1–2 low-risk agents (e.g. read-only dashboards) to
   demote to `read-only` and confirms via activity log that destructive
   calls are now blocked.
