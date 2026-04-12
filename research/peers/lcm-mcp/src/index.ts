#!/usr/bin/env node
/**
 * LCM MCP Server — Lossless Context Management for Claude Code
 *
 * Multi-agent persistent memory. Runs as HTTP/SSE server on Ryzen,
 * accepts connections from any Claude Code agent over Tailscale.
 *
 * Each agent identifies itself via agent_id. Messages, sessions,
 * and summaries are separated per agent. Cross-agent search is also supported.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import http from "http";
import * as db from "./db.js";

const PORT = parseInt(process.env.LCM_PORT || "51203", 10);
const HOST = process.env.LCM_HOST || "0.0.0.0";
const MAX_CONTENT_LENGTH = 100_000;
const MAX_QUERY_LENGTH = 1_000;
const MAX_LIMIT = 500;

// ─── Build MCP server with tools ───────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({
    name: "lcm",
    version: "2.1.0",
    description:
      "Lossless Context Management — multi-agent persistent conversation memory.",
  });

  // ── lcm_save ──────────────────────────────────────────────────────────

  server.tool(
    "lcm_save",
    `Save a message to persistent history. Call this for every user message and every response. This is your long-term memory — unsaved messages are lost on restart.`,
    {
      agent_id: z.string().min(1).max(100).describe("Your agent identifier (e.g. 'telegram-bot', 'coder', 'dispatcher')."),
      session_id: z.string().min(1).max(100).describe("Session ID. Use today's date (e.g. '2025-07-15') or a stable identifier."),
      role: z.enum(["user", "assistant", "system"]).describe("Who sent this message."),
      content: z.string().min(1).max(MAX_CONTENT_LENGTH).describe("The message content."),
      chat_id: z.string().max(100).optional().describe("Telegram chat ID, if available."),
      message_id: z.string().max(100).optional().describe("Telegram message ID, if available."),
    },
    async (params) => {
      try {
        const id = db.saveMessage({
          session_id: params.session_id,
          agent_id: params.agent_id,
          role: params.role,
          content: params.content,
          chat_id: params.chat_id,
          message_id: params.message_id,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ saved: true, id }) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error saving message: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── lcm_search ────────────────────────────────────────────────────────

  server.tool(
    "lcm_search",
    `Full-text search across ALL stored conversation history and summaries. Searches your own history by default, or across all agents if scope="all".`,
    {
      agent_id: z.string().min(1).max(100).describe("Your agent identifier."),
      query: z.string().min(1).max(MAX_QUERY_LENGTH).describe("Search keywords."),
      scope: z.enum(["own", "all"]).optional().default("own")
        .describe("'own' = only your messages, 'all' = search across all agents."),
      limit: z.number().int().min(1).max(200).optional().default(20).describe("Max results (default 20, max 200)."),
    },
    async (params) => {
      try {
        const agentFilter = params.scope === "all" ? undefined : params.agent_id;
        const results = db.search(params.query, params.limit, agentFilter);
        const total = results.messages.length + results.summaries.length;

        if (total === 0) {
          return {
            content: [{ type: "text" as const, text: `No results for "${params.query}". Try different keywords.` }],
          };
        }

        let output = `Found ${results.messages.length} messages and ${results.summaries.length} summaries:\n\n`;

        if (results.messages.length > 0) {
          output += "=== Messages ===\n";
          for (const m of results.messages) {
            output += `[${m.timestamp}] [${m.agent_id}/${m.role}] (session: ${m.session_id}, id: ${m.id}${m.chat_id ? `, chat: ${m.chat_id}` : ""})\n${m.content}\n---\n`;
          }
        }

        if (results.summaries.length > 0) {
          output += "\n=== Summaries ===\n";
          for (const s of results.summaries) {
            output += `[${s.created_at}] [${s.agent_id}] (session: ${s.session_id}, msgs ${s.msg_start_id}-${s.msg_end_id}, L${s.level})\n${s.content}\n---\n`;
          }
        }

        return { content: [{ type: "text" as const, text: output }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── lcm_recent ────────────────────────────────────────────────────────

  server.tool(
    "lcm_recent",
    `Get recent messages from a session. Use at session start to load previous context.`,
    {
      agent_id: z.string().min(1).max(100).describe("Your agent identifier."),
      session_id: z.string().min(1).max(100).describe("Session ID to fetch."),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional().default(50).describe("Number of messages (default 50, max 500)."),
    },
    async (params) => {
      try {
        const messages = db.getRecent(params.session_id, params.agent_id, params.limit);
        if (messages.length === 0) {
          return { content: [{ type: "text" as const, text: `No messages in session "${params.session_id}" for agent "${params.agent_id}".` }] };
        }
        messages.reverse();
        let output = `Last ${messages.length} messages (${params.agent_id} / ${params.session_id}):\n\n`;
        for (const m of messages) {
          output += `[${m.timestamp}] [${m.role}] (id: ${m.id})\n${m.content}\n---\n`;
        }
        return { content: [{ type: "text" as const, text: output }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error fetching recent: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── lcm_expand ────────────────────────────────────────────────────────

  server.tool(
    "lcm_expand",
    `Expand a summary back to original messages by ID range. Requires agent_id to scope access.`,
    {
      agent_id: z.string().min(1).max(100).describe("Your agent identifier."),
      start_id: z.number().int().min(1).describe("First message ID."),
      end_id: z.number().int().min(1).describe("Last message ID."),
    },
    async (params) => {
      try {
        if (params.start_id > params.end_id) {
          return {
            content: [{ type: "text" as const, text: `Invalid range: start (${params.start_id}) > end (${params.end_id}).` }],
            isError: true,
          };
        }
        const messages = db.expandRange(params.start_id, params.end_id, params.agent_id);
        if (messages.length === 0) {
          return { content: [{ type: "text" as const, text: `No messages in range ${params.start_id}-${params.end_id}.` }] };
        }
        let output = `Expanded ${messages.length} messages:\n\n`;
        for (const m of messages) {
          output += `[${m.timestamp}] [${m.agent_id}/${m.role}] (id: ${m.id})\n${m.content}\n---\n`;
        }
        return { content: [{ type: "text" as const, text: output }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error expanding range: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── lcm_summarize ─────────────────────────────────────────────────────

  server.tool(
    "lcm_summarize",
    `Store a summary you've written for a range of messages. Include key decisions, facts, preferences, action items. Original messages stay searchable via lcm_expand.`,
    {
      agent_id: z.string().min(1).max(100).describe("Your agent identifier."),
      session_id: z.string().min(1).max(100).describe("Session ID."),
      content: z.string().min(1).max(MAX_CONTENT_LENGTH).describe("Your summary text."),
      msg_start_id: z.number().int().min(1).describe("First message ID being summarized."),
      msg_end_id: z.number().int().min(1).describe("Last message ID being summarized."),
      level: z.number().int().min(1).max(10).optional().default(1).describe("1 = message summary, 2 = summary of summaries, etc."),
    },
    async (params) => {
      try {
        const id = db.saveSummary({
          session_id: params.session_id,
          agent_id: params.agent_id,
          content: params.content,
          msg_start_id: params.msg_start_id,
          msg_end_id: params.msg_end_id,
          level: params.level,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ saved: true, summary_id: id, range: `${params.msg_start_id}-${params.msg_end_id}` }) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error saving summary: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── lcm_sessions ──────────────────────────────────────────────────────

  server.tool(
    "lcm_sessions",
    `List conversation sessions. Shows your sessions by default, or all agents' sessions.`,
    {
      agent_id: z.string().min(1).max(100).optional().describe("Filter by agent. Omit to see all agents."),
      limit: z.number().int().min(1).max(100).optional().default(20).describe("Max results (default 20, max 100)."),
    },
    async (params) => {
      try {
        const sessions = db.getSessions(params.limit, params.agent_id);
        if (sessions.length === 0) {
          return { content: [{ type: "text" as const, text: "No sessions found." }] };
        }
        let output = `${sessions.length} sessions:\n\n`;
        for (const s of sessions) {
          output += `- ${s.agent_id} / ${s.id} | created: ${s.created_at} | active: ${s.last_active} | msgs: ${s.message_count}\n`;
        }
        return { content: [{ type: "text" as const, text: output }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error listing sessions: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── lcm_agents ────────────────────────────────────────────────────────

  server.tool(
    "lcm_agents",
    `List all registered agents with their message counts and session counts.`,
    {},
    async () => {
      try {
        const agents = db.getAgents();
        if (agents.length === 0) {
          return { content: [{ type: "text" as const, text: "No agents registered yet." }] };
        }
        let output = `${agents.length} agents:\n\n`;
        for (const a of agents) {
          output += `- ${a.id}${a.name ? ` (${a.name})` : ""} | sessions: ${a.session_count} | messages: ${a.message_count} | last seen: ${a.last_seen}\n`;
        }
        return { content: [{ type: "text" as const, text: output }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error listing agents: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── lcm_stats ─────────────────────────────────────────────────────────

  server.tool(
    "lcm_stats",
    `Database statistics. Pass agent_id to see stats for one agent, or omit for global stats.`,
    {
      agent_id: z.string().min(1).max(100).optional().describe("Filter by agent. Omit for global."),
    },
    async (params) => {
      try {
        const s = db.stats(params.agent_id);
        const lines = [
          `LCM Stats${params.agent_id ? ` (agent: ${params.agent_id})` : " (global)"}:`,
        ];
        if (!params.agent_id && s.total_agents !== undefined) {
          lines.push(`  Agents:    ${s.total_agents}`);
        }
        lines.push(
          `  Sessions:  ${s.total_sessions}`,
          `  Messages:  ${s.total_messages}`,
          `  Summaries: ${s.total_summaries}`,
          `  Earliest:  ${s.earliest_message || "n/a"}`,
          `  Latest:    ${s.latest_message || "n/a"}`,
        );
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error fetching stats: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// ─── HTTP/SSE Transport ─────────────────────────────────────────────────────

async function main() {
  const transports = new Map<string, { transport: SSEServerTransport; server: McpServer }>();

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      // Health check
      if (url.pathname === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: "2.1.0", agents: db.getAgentCount(), connections: transports.size }));
        return;
      }

      // SSE endpoint — client connects here, each gets its own McpServer instance
      if (url.pathname === "/sse" && req.method === "GET") {
        const transport = new SSEServerTransport("/messages", res);
        const sessionId = transport.sessionId;
        const mcpServer = createServer();
        transports.set(sessionId, { transport, server: mcpServer });

        res.on("close", () => {
          transports.delete(sessionId);
          mcpServer.close().catch(() => {});
        });

        await mcpServer.connect(transport);
        return;
      }

      // Message endpoint — client POSTs MCP messages here
      if (url.pathname === "/messages" && req.method === "POST") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId || !transports.has(sessionId)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid or missing sessionId" }));
          return;
        }

        const entry = transports.get(sessionId)!;
        await entry.transport.handlePostMessage(req, res);
        return;
      }

      // 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err: any) {
      console.error("HTTP handler error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.error("Shutting down...");
    for (const [id, entry] of transports) {
      entry.server.close().catch(() => {});
      transports.delete(id);
    }
    httpServer.close(() => {
      db.close();
      console.error("LCM server stopped.");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  httpServer.listen(PORT, HOST, () => {
    console.error(`LCM MCP server v2.1.0 listening on http://${HOST}:${PORT}`);
    console.error(`  SSE endpoint: http://${HOST}:${PORT}/sse`);
    console.error(`  Health check: http://${HOST}:${PORT}/health`);
    console.error(`  Data dir:     ${db.DATA_DIR}`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
