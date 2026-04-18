# Qoopia

Persistent memory and context server for Claude Code agents. Gives your agents a shared brain — notes, tasks, sessions, and recall — so they remember what matters across restarts and conversations.

## What it does

- **Persistent memory** — notes, tasks, contacts, deals all live in SQLite, survive process restarts
- **Session continuity** — agents save and restore conversation context so compaction doesn't lose history
- **Full-text search** — `recall("topic")` finds relevant entries across all memory types
- **Multi-agent** — each agent gets its own API key, workspace-scoped access, and activity log
- **MCP server** — connects to Claude Code agents via a local HTTP endpoint (no cloud required)

## Requirements

- macOS (tested on Mac Mini M-series)
- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- [Claude Code](https://claude.ai/download) with Max subscription

## Install

```bash
git clone https://github.com/qoopia/qoopia.git
cd qoopia
bun install
bun run install-service   # installs as a launchd service, starts on login
```

Check it's running:

```bash
curl http://localhost:3737/health
```

## Connect an agent

In your agent's `.md` file (e.g. `~/.claude/agents/myagent.md`), add an MCP server block:

```yaml
---
name: myagent
model: claude-opus-4-7
mcpServers:
  qoopia:
    type: http
    url: http://localhost:3737/mcp
    headers:
      Authorization: "Bearer YOUR_API_KEY"
---
```

Get a new API key via the dashboard at `http://localhost:3737/dashboard` or via CLI:

```bash
bun run qoopia agent:create --name myagent
```

## Memory protocol (recommended)

Paste this into your agent's system prompt to get automatic session continuity:

```
On session start:
1. recall("CONTEXT") — load your rules and context
2. brief() — see open tasks and recent activity
3. session_recent(session_id='agentname-YYYY-MM-DD') — restore last conversation

During conversation:
- session_save(...) after each user message and assistant reply

On session end:
- note_create (type=memory) — save decisions and non-obvious discoveries
```

## MCP tools

| Tool | What it does |
|------|-------------|
| `recall(query)` | Full-text search across all notes and memory |
| `brief()` | Open tasks, recent activity, pending items |
| `note_create(content, type, tags)` | Create a persistent note |
| `note_list(type?, tags?)` | List notes with optional filters |
| `note_get(id)` | Get a single note by ID |
| `note_update(id, content)` | Update note content |
| `note_delete(id)` | Delete a note |
| `session_save(session_id, role, content)` | Save a conversation turn |
| `session_recent(session_id)` | Restore recent session context |
| `session_summarize(session_id)` | Compress session into a summary block |
| `create(type, data)` | Create task / contact / deal / project |
| `list(type, filters?)` | List entities with filters |
| `get(type, id)` | Get single entity |
| `update(type, id, data)` | Update entity |
| `delete(type, id)` | Delete entity |
| `activity_list(agent_id?, limit?)` | See agent activity log |

## Service management

```bash
# Status
launchctl print gui/$(id -u)/com.qoopia.server

# Restart
launchctl kickstart -k gui/$(id -u)/com.qoopia.server

# Stop
launchctl unload ~/Library/LaunchAgents/com.qoopia.server.plist

# Logs
tail -f ~/.qoopia/logs/qoopia.log
```

## Dashboard

Open `http://localhost:3737/dashboard` in your browser to see:
- All agents and their last activity
- Notes and tasks
- Session history
- API key management

## License

MIT
