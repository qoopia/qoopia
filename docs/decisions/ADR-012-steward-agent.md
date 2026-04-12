# ADR-012: Steward Agent Type and Admin MCP Tools

**Status:** accepted
**Date:** 2026-04-12
**Deciders:** Askhat (owner), Claude (implementer)

## Context

Qoopia V3 administration (creating agents, rotating keys, managing onboarding) requires SSH access and CLI commands. This is friction for the primary user who interacts with agents through chat. We need a way for one designated agent to handle all admin operations through the standard MCP interface.

## Decision

### 1. New agent type: "steward"

- `agents.type = "steward"` — a third type alongside "standard" and "claude-privileged"
- At most one active steward per workspace, enforced by a partial unique index:
  ```sql
  CREATE UNIQUE INDEX idx_one_steward ON agents(workspace_id)
    WHERE type = 'steward' AND active = 1;
  ```
- Steward gets all standard MCP tools + 3 admin tools
- CLI remains the escape hatch (`qoopia admin promote-steward`, `delete-agent`)

### 2. Three admin MCP tools (steward-only)

- `agent_onboard(name, role?)` — create agent + bootstrap notes in one SQLite transaction
- `agent_list()` — list all agents across workspaces
- `agent_deactivate(name)` — soft-delete an agent

`agent_rotate_key` deliberately excluded from MCP tools (CLI only) to limit blast radius.

### 3. Bootstrap notes: owner vs actor separation

When steward creates bootstrap notes for a new agent:
- `notes.agent_id = new_agent.id` (owner) — so the new agent sees them via `brief()`
- `activity.agent_id = steward.id` (actor) — for audit trail

This is correct because `brief()` filters notes by `agent_id` (src/services/brief.ts). If we used steward's agent_id, the new agent would never see its own bootstrap notes.

### 4. Role presets as code

Templates are TypeScript objects in `src/admin/templates.ts`, versioned in git. No new DB table. Rationale:
- H3 budget is exactly 10 real tables, no room for another
- Templates change quarterly, git is natural versioning
- No runtime editing needed — this is configuration, not data

### 5. Self-guards

- Steward cannot deactivate itself (handler checks `target_name !== auth.agent_name`)
- Steward cannot create another steward (UNIQUE partial index rejects at DB level)
- Steward cannot create agents with type="steward" (handler hardcodes type="standard")

### 6. Secret guard for API keys

- `assertNoSecrets()` rejects text matching `q_[A-Za-z0-9_-]{32,}` in:
  - `logActivity()` summary and details
  - `saveMessage()` content
  - `createNote()` text and metadata
  - `updateNote()` text and metadata
- Plaintext key returned only in `agent_onboard` tool response, never persisted

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| RBAC permissions table | One type with 3 tools doesn't justify a permissions system |
| Admin tools visible to all agents (gated in handler) | Noise in tools/list for standard agents |
| Templates in DB (type='template' notes) | Pollutes FTS index, exceeds table budget, rare changes don't justify DB storage |
| `prompt_absorb` MCP tool | Needs LLM for parsing; V3 has 0 external API deps. Steward-agent IS the parser |
| Separate `/admin/*` HTTP endpoints | Duplicates auth/routing; MCP is the single channel |

## Consequences

- H8 budget moves from 13 → 16 tools (within ≤15+1 tolerance, justified by removing SSH dependency)
- H1 core LoC increases by ~350 (within extended 2050 tolerance)
- CLI remains required for: key rotation, steward promotion/demotion, emergency recovery
- Non-steward agents see zero change in behavior
