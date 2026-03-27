# Qoopia Use Cases — Summary

6 concrete use cases for Qoopia (agent-native memory layer / lightweight CRM):

1. **Multi-agent handoff** — Agent A researches a lead, Agent B picks it up cold. With Qoopia: Agent B calls `brief` on startup, gets full context instantly. No message passing between agents required.

2. **Cross-session memory** — Agent calls `recall("API redesign discussion")` at session start, gets notes and decisions from 3 sessions ago. Semantic search (Voyage or FTS5 fallback) — no exact keyword match needed.

3. **Activity audit trail** — Every agent action auto-logged with actor, timestamp, before/after diff. Agents on external platforms feed in via `/api/v1/observe` webhook. Full timeline without digging through logs.

4. **Deal pipeline tracking** — Multiple parallel agents (research, outreach, follow-up) work the same pipeline. All write to shared deal records via MCP tools. `note` auto-links updates to deals without explicit IDs.

5. **Agent onboarding (`brief` as boot sequence)** — New specialized agent calls `brief` once, gets: open tasks, active deals, key contacts, recent decisions. Operational immediately, no manual context injection.

6. **Natural language task updates** — One `note("Fixed the login bug")` call replaces: find task ID → PATCH status → POST activity. LLM matching (Claude Haiku, degrades to keyword FTS5) handles entity resolution automatically.

**Stack:** Node.js + SQLite (single file, zero ops). LLM matching and semantic search are optional — everything works without API keys.
**GitHub:** github.com/qoopia/qoopia | MIT license | 29 MCP tools
