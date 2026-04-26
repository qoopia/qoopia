# ADR-014: MCP memory boundary — workspace shared by default, private opt-in

Status: Accepted (2026-04-25)
Supersedes: nothing
Relates to: ADR-002 (multi-tenant), QSEC-001 (dashboard scope), QRERUN-003 (Codex rerun)

## Context

The Codex GPT-5.5 rerun review (QRERUN-003) flagged an asymmetry:

- The dashboard API (`/api/dashboard/*`) was tightened in QSEC-001 so a
  standard agent can only see its own data; only `steward` and
  `claude-privileged` agents see workspace-wide data.
- The MCP runtime tools (`recall`, `brief`, `note_get`, `note_list`) still
  scope by `workspace_id` only. A standard agent can therefore read another
  agent's notes through MCP even though the dashboard now refuses.

Codex asked: is this intended, or a missed scope?

## Decision

**Both behaviors are intended, and they describe different things.**

- **MCP runtime is a shared workspace memory layer.** Within one workspace
  (which represents one human/customer in Qoopia v3's multi-tenant model —
  see ADR-002), all of that user's agents — Alan, Aizek, Aidan, Dan,
  Claude — are designed to share notes, briefs, and recall results. That
  is the product: Alan writes a note, Aizek's next session sees it. This
  is the same baseline as Qoopia v2 and the reason for the rewrite.

- **Dashboard is an administrative observability view.** It exposes
  per-agent breakdowns of activity, sessions, and notes for inspection,
  audit, and debugging. A standard agent peeking at sibling-agent
  dashboards does not match any product use case; it would only ever be
  reconnaissance. So the dashboard is locked to "self" for standard agents,
  with `steward`/`claude-privileged` retaining workspace-wide read for ops.

The two surfaces serve different purposes, so the asymmetry is correct.

To address the legitimate concern that some notes really should not be
shared (e.g. an agent's own scratchpad, a personal token reminder), the
notes schema gains an opt-in `visibility` column:

| visibility | who can read via MCP |
|---|---|
| `workspace` (default) | any agent in the same workspace |
| `private` | only the owning `agent_id` and `steward` / `claude-privileged` |

A standard agent cannot read another standard agent's `private` notes
through `note_get`, `note_list`, `recall`, or `brief`. Search backends
filter the same way.

`visibility` is per-note and chosen at create time; existing notes
default to `workspace` (no behavior change for any current data).

## Consequences

- Default behavior is unchanged. Existing agents keep sharing memory
  inside a workspace. No migration of existing notes is needed beyond
  the column add.
- New `visibility: 'private'` opt-in for callers who want per-agent
  isolation for a specific note.
- MCP read paths gain a `caller_agent_id` parameter and an `is_admin`
  flag (true for `steward` / `claude-privileged`) that the filter uses
  to decide whether to surface `private` notes owned by other agents.
- The dashboard scope from QSEC-001 stays as-is — administrative view
  remains per-agent for standard, workspace-wide for admin types.

## Test coverage

`tests/mcp-memory-boundary.test.ts` proves both invariants in one place:

1. Standard agent A reads agent B's `workspace` note via MCP — yes.
2. Standard agent A reads agent B's `private` note via MCP — no.
3. Admin agent (`steward`) reads agent B's `private` note via MCP — yes.
4. Standard agent A reads its own `private` note — yes.

The tests deliberately call the service-level functions (`getNote`,
`listNotes`, `recall`, `brief`) with explicit `caller_agent_id` /
`is_admin` so the boundary is verified independently of whichever MCP
transport is in use.

## Operator-facing note

The README and admin docs should call out: "Inside one workspace, agents
share memory by default. Use `visibility: 'private'` on `note_create`
when an agent needs a scratchpad that other agents in the same workspace
should not see."
