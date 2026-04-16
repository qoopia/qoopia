-- migrations/004_claude_code_agents.sql
-- Phase 7a: Claude Code agent allowlist for auto-session ingestion
-- Created: 2026-04-16

-- Allowlist of Claude Code project directories whose JSONL transcripts
-- the ingest-daemon is permitted to tail and ingest.
-- cwd_prefix: absolute path prefix (e.g. /Users/askhatsoltanov/qoopia-v3)
--             matched with LIKE cwd_prefix || '%' against project directory name
-- agent_id: FK to agents table — the Qoopia agent that owns sessions from this cwd
-- autosession_enabled: 1 = tailer ingests new turns automatically; 0 = registered but paused
CREATE TABLE claude_code_agents (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
  agent_id         TEXT NOT NULL REFERENCES agents(id),
  cwd_prefix       TEXT NOT NULL,
  autosession_enabled INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(workspace_id, cwd_prefix)
);

CREATE INDEX idx_claude_code_agents_agent ON claude_code_agents(agent_id);
CREATE INDEX idx_claude_code_agents_ws    ON claude_code_agents(workspace_id);
