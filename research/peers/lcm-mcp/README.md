# LCM — Long-term Conversation Memory for Claude Code

Persistent memory server for Claude Code agents. Saves every message to SQLite with full-text search, session management, and multi-agent support.

Your agent remembers past conversations across restarts.

## What it does

- **lcm_save** — save every user/assistant message
- **lcm_recent** — load recent messages at session start
- **lcm_search** — full-text search across all history
- **lcm_summarize** — store conversation summaries
- **lcm_expand** — expand a summary back to original messages
- **lcm_sessions** — list sessions
- **lcm_agents** — list registered agents
- **lcm_stats** — database statistics

## Quick Start (macOS)

### 1. Install Bun

```bash
brew install oven-sh/bun/bun
```

### 2. Clone and install

```bash
cd lcm-mcp
bun install
```

### 3. Run

```bash
# Data stored in ./data by default
LCM_DATA_DIR=./data bun run src/index.ts
```

Server starts on `http://localhost:51203`.

### 4. Configure Claude Code

Add to `~/.claude/mcp-servers.json`:

```json
{
  "lcm": {
    "type": "sse",
    "url": "http://localhost:51203/sse"
  }
}
```

### 5. Add to your agent prompt

Add these instructions to your agent file (`~/.claude/agents/my-agent.md`):

```
## Memory

You have persistent memory via LCM MCP server.

On session start:
- Call lcm_recent(agent_id="my-agent", session_id="YYYY-MM-DD") to load today's context

During conversation:
- Save every user message: lcm_save(agent_id="my-agent", session_id="YYYY-MM-DD", role="user", content=<message>)
- Save every response: lcm_save(agent_id="my-agent", session_id="YYYY-MM-DD", role="assistant", content=<summary>)

Every ~20 messages:
- Call lcm_summarize with a summary of the conversation block
```

## Run as background service

### Option A: tmux (simple)

```bash
tmux new-session -d -s lcm 'LCM_DATA_DIR=./data bun run src/index.ts'
```

### Option B: launchd (auto-start on boot)

Create `~/Library/LaunchAgents/com.lcm-mcp.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.lcm-mcp</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/bun</string>
        <string>run</string>
        <string>src/index.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/lcm-mcp</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>LCM_DATA_DIR</key>
        <string>/path/to/lcm-mcp/data</string>
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.lcm-mcp.plist
```

## Health check

```bash
curl http://localhost:51203/health
# {"status":"ok","version":"2.1.0","agents":1,"connections":0}
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| LCM_PORT | 51203 | Server port |
| LCM_HOST | 0.0.0.0 | Bind address |
| LCM_DATA_DIR | /data/lcm | SQLite database directory |

## Tech stack

- **Bun** — runtime (SQLite built-in, no extra dependencies)
- **MCP SDK** — Model Context Protocol server
- **SQLite** — storage with FTS5 full-text search
- **SSE** — Server-Sent Events transport

665 lines of code total. No Docker required on macOS.

---

MIT License. (c) Niyaz Irsaliev, 2026
