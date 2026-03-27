# Qoopia

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Your AI agents forget everything between sessions. Qoopia fixes that.

A persistent memory layer for AI agents. Memory first, CRM second. The core: agents remember what they did, what changed, and what's next - across sessions, models, and platforms. Built-in task, deal, contact, and finance modules extend it into a lightweight agent-native CRM when you need one.

## Why

AI agents start every session blank. They lose tasks, forget context, and repeat questions. Qoopia sits between your agents and their work, keeping state alive.

- **Agents read context on startup** — what's open, what changed, who's involved
- **Agents write updates as they work** — status changes, notes, activity
- **Qoopia observes automatically** — agents that don't call Qoopia directly still get their work logged via webhooks (`/api/v1/observe`). No explicit tool calls required.
- **Everything stays in one SQLite database** — no external dependencies, zero ops

## What it does

**Task & project tracking** — create, update, and query tasks with status, assignee, priority, and deadlines. Filter by project, status, or agent.

**Deal pipeline** — track deals through stages with contacts, values, and history.

**Contact management** — people, companies, roles, and relationships. Link contacts to tasks and deals.

**Finance records** — income, expenses, invoices. Attach to projects and deals.

**Activity log** — every action by every agent is logged automatically. Full audit trail with timestamps, actors, and diffs.

**Notes with auto-matching** — agents write natural language; Qoopia matches to relevant entities:

```
# Agent calls MCP tool:
note({ text: "Fixed the login bug in auth module" })

# Qoopia automatically:
#   1. Finds task "Login page returns 500 on submit"
#   2. Updates status: in_progress → done
#   3. Logs activity with timestamp and agent name

→ { matched: [{ task: "Login page returns 500", confidence: "high", status: "done" }] }
```

No explicit task ID needed. One natural language call does the work of three API calls.

**Semantic search** — find anything by meaning, not just keywords. Uses Voyage embeddings when available, falls back to FTS5.

**Multi-agent, multi-workspace** — each agent gets its own API key. Workspaces isolate data between teams or projects.

## Architecture

```
Agent (OpenClaw / Claude / GPT / custom)
  │
  ├── MCP Protocol ──→ Qoopia MCP Server (29 tools)
  │                         │
  ├── REST API ────→ Hono HTTP Server
  │                         │
  └── Webhooks ────→ /api/v1/observe ──→ auto-logs activity
                            │                without agent involvement
                      SQLite + WAL
                      (single file, zero ops)
```

**29 MCP tools:** 11 read · 14 write · 3 intelligence (`note`, `recall`, `brief`) · plus file tools

**REST API** mirrors MCP with standard CRUD endpoints under `/api/v1/`. The observer endpoint (`/api/v1/observe`) receives webhook events from agent platforms and auto-logs activity.

## Stack

- **Runtime:** Node.js + TypeScript
- **HTTP:** Hono
- **Database:** SQLite via better-sqlite3 (WAL mode, zero config)
- **Auth:** API keys (agents & users) + OAuth 2.0 (client_credentials)
- **Search:** Voyage AI embeddings + SQLite FTS5 (graceful degradation)
- **Entity matching:** Claude Haiku for LLM matching, keyword fallback
- **IDs:** ULID (sortable, unique, no coordination)
- **Schema:** Drizzle ORM
- **Testing:** Vitest

Both AI features degrade gracefully — keyword matching and FTS5 work without API keys.

## Quick start

```bash
git clone https://github.com/qoopia/qoopia.git
cd qoopia
npm install
npm run migrate
npm test            # all green? good to go
npm run dev
```

Server starts on port 3000 by default. Set `PORT` env var to change.

### Register an agent

```bash
npx tsx src/cli.ts agent add "my-agent" openclaw
# → qp_ag_abc123...   (save this key)
export API_KEY=qp_ag_abc123...
```

### 2-minute wow: from zero to auto-matched task

```bash
# 1. Create a task
curl -s -X POST -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "Fix login page 500 error", "status": "open"}' \
  http://localhost:3000/api/v1/tasks
# → { "id": "01JD...", "title": "Fix login page 500 error", "status": "open" }

# 2. Agent writes a natural language note (no task ID needed)
curl -s -X POST -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"note","arguments":{"text":"Fixed the login bug - was a missing null check in auth middleware"}}}' \
  http://localhost:3000/mcp
# → matched: "Fix login page 500 error" → status changed to done

# 3. Verify — the task updated itself
curl -s -H "Authorization: Bearer $API_KEY" \
  http://localhost:3000/api/v1/tasks?status=done | grep "login"
# → status: "done", with activity log entry
```

One natural language note. Qoopia found the task, updated the status, and logged the activity. No explicit task ID, no status enum, no second API call.

### Connect via MCP

Point your MCP client to `http://localhost:3000/mcp` with the agent's API key in the `Authorization: Bearer <key>` header.

### Connect via REST

```bash
# List open tasks
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:3000/api/v1/tasks?status=open

# Create a task
curl -X POST -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "Review PR #42", "priority": "high"}' \
  http://localhost:3000/api/v1/tasks
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `QOOPIA_DATA_DIR` | `./data` | Database and file storage directory |
| `QOOPIA_DB_PATH` | `$DATA_DIR/qoopia.db` | SQLite database path |
| `QOOPIA_PUBLIC_URL` | `http://localhost:$PORT` | Public URL (for OAuth redirects) |
| `ANTHROPIC_API_KEY` | — | Enables LLM entity matching (optional) |
| `VOYAGEAI_API_KEY` | — | Enables semantic search embeddings (optional) |

## CLI

```
qoopia status                     Server & database health
qoopia agent add <name> <type>    Register agent, get API key
qoopia agent rotate-key <id>      Rotate agent's API key
qoopia agent list                 List registered agents
qoopia migrate [data-dir]         Import V1 data
```

## Dashboard

Web dashboard at `/dashboard` for viewing tasks, activity, and system status.

## Known limitations

- **Single-node only** — no clustering or replication. Designed for self-hosted single-server deployments.
- **LLM matching requires API key** — auto-matching uses Claude Haiku. Without `ANTHROPIC_API_KEY`, falls back to keyword matching (less accurate but functional).
- **No conflict resolution** — concurrent writes from multiple agents use last-write-wins. Conflict detection is planned.
- **Embedding cold start** — first `recall` call generates embeddings for all existing data. Can take a few seconds on large datasets.

## Security

- API key authentication on all endpoints
- Workspace-level data isolation
- File access restricted to workspace scope with path traversal prevention
- Soft-delete with `deleted_at` timestamps (no data loss)
- Automatic activity logging for audit trails
- OAuth 2.0 support for external integrations

## Contributing

Issues and PRs welcome. See [open issues](https://github.com/qoopia/qoopia/issues).

## License

MIT
