import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthContext } from "../auth/middleware.ts";
import { QoopiaError } from "../utils/errors.ts";
import { logger } from "../utils/logger.ts";
import { NOTE_TYPES } from "../services/notes.ts";
import {
  createNote,
  getNote,
  listNotes,
  updateNote,
  deleteNote,
} from "../services/notes.ts";
import { recall } from "../services/recall.ts";
import { brief } from "../services/brief.ts";
import {
  saveMessage,
  sessionRecent,
  sessionSearch,
  sessionSummarize,
  sessionExpand,
} from "../services/sessions.ts";
import { listActivity } from "../services/activity.ts";
import { registerCompatTools } from "./compat.ts";
import { adminTools } from "./admin-tools.ts";

export type ToolProfile = "memory" | "full";

const MEMORY_TOOLS = new Set([
  "recall",
  "brief",
  "session_save",
  "session_recent",
  "session_search",
]);

interface ToolDef {
  name: string;
  description: string;
  rawSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, auth: AuthContext) => unknown;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function fail(err: unknown) {
  let msg: string;
  if (err instanceof QoopiaError) {
    msg = `${err.code}: ${err.message}`;
  } else if (err instanceof Error) {
    // M4 fix: log internal errors server-side, return stable generic message
    const raw = err.message;
    // Translate SQLite busy/lock errors into retryable domain error
    if (raw.includes("SQLITE_BUSY") || raw.includes("database is locked")) {
      msg = "BUSY: Database busy, please retry";
    } else if (raw.includes("UNIQUE constraint failed") && raw.includes("steward")) {
      msg = "CONFLICT: active steward already exists";
    } else if (raw.includes("UNIQUE constraint failed")) {
      msg = "CONFLICT: a record with the same identifier already exists";
    } else {
      logger.error("MCP tool internal error", { error: raw, stack: err.stack });
      msg = "INTERNAL: unexpected error — check server logs";
    }
  } else {
    logger.error("MCP tool unknown error", { error: String(err) });
    msg = "INTERNAL: unexpected error — check server logs";
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: msg }],
  };
}

const noteTypeEnum = z.enum(NOTE_TYPES);

// QRERUN-003 / ADR-014: agent types that bypass the per-note `private`
// visibility filter on MCP read paths (recall, brief, note_get, note_list).
// Mirrors the admin set used by dashboard-api.ts.
const ADMIN_TYPES = new Set(["steward", "claude-privileged"]);
function isAdmin(auth: AuthContext): boolean {
  return ADMIN_TYPES.has(auth.type);
}

// -------- Tool definitions --------

const tools: ToolDef[] = [
  {
    name: "recall",
    description:
      "Full-text search across notes (and optionally activity). Returns results with complete text (no truncation). Keyword-based, not semantic.",
    rawSchema: {
      query: z.string().min(1).max(1000).describe("Full-text keywords. Use multiple terms to narrow."),
      limit: z.number().int().min(1).max(50).optional(),
      scope: z.enum(["notes", "activity", "all"]).optional(),
      type: noteTypeEnum.optional(),
      project_id: z.string().optional(),
      cross_workspace: z
        .boolean()
        .optional()
        .describe("Honored only for privileged agents (Claude)."),
    },
    handler: (args, auth) => {
      const privileged = auth.type === "claude-privileged";
      return recall({
        workspace_id: auth.workspace_id,
        caller_agent_id: auth.agent_id,
        is_admin: isAdmin(auth),
        query: String(args.query),
        limit: args.limit as number | undefined,
        scope: args.scope as "notes" | "activity" | "all" | undefined,
        type: args.type as string | undefined,
        project_id: args.project_id as string | undefined,
        cross_workspace: args.cross_workspace as boolean | undefined,
        privileged,
      });
    },
  },
  {
    name: "brief",
    description:
      "Workspace snapshot: open tasks, recent notes, active deals, agent activity. Call at session start to restore context.",
    rawSchema: {
      project: z
        .string()
        .optional()
        .describe("Project ULID or exact project note text"),
      agent: z.string().optional(),
      limit_per_section: z.number().int().min(1).max(50).optional(),
    },
    handler: (args, auth) =>
      brief({
        workspace_id: auth.workspace_id,
        caller_agent_id: auth.agent_id,
        is_admin: isAdmin(auth),
        project: args.project as string | undefined,
        agent: args.agent as string | undefined,
        limit_per_section: args.limit_per_section as number | undefined,
      }),
  },
  {
    name: "note_create",
    description:
      "Create a note in the universal notes table. Use type to distinguish task/deal/contact/finance/project/memory/decision/etc.",
    rawSchema: {
      text: z.string().min(1).max(100_000),
      type: noteTypeEnum.optional(),
      metadata: z.record(z.unknown()).optional(),
      project_id: z.string().optional(),
      task_bound_id: z
        .string()
        .optional()
        .describe("Bind this note to a task; auto-purged when task closes."),
      session_id: z.string().optional(),
      tags: z.array(z.string()).optional(),
      visibility: z
        .enum(["workspace", "private"])
        .optional()
        .describe(
          "ADR-014: 'workspace' (default) shares note with all agents in this workspace. 'private' restricts reads to this agent and admin types.",
        ),
    },
    handler: (args, auth) =>
      createNote({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        text: String(args.text),
        type: args.type as string | undefined,
        metadata: args.metadata as Record<string, unknown> | undefined,
        project_id: args.project_id as string | undefined,
        task_bound_id: args.task_bound_id as string | undefined,
        session_id: args.session_id as string | undefined,
        tags: args.tags as string[] | undefined,
        visibility: args.visibility as "workspace" | "private" | undefined,
      }),
  },
  {
    name: "note_get",
    description: "Fetch a single note by ULID.",
    rawSchema: {
      id: z.string().min(1),
    },
    handler: (args, auth) =>
      getNote(auth.workspace_id, String(args.id), auth.agent_id, isAdmin(auth)),
  },
  {
    name: "note_list",
    description:
      "List notes with filters: type, project_id, agent, status (from metadata), tags, date range, session.",
    rawSchema: {
      type: noteTypeEnum.optional(),
      project_id: z.string().optional(),
      agent: z.string().optional(),
      status: z.string().optional(),
      tags: z.array(z.string()).optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      session_id: z.string().optional(),
      task_bound_id: z.string().optional(),
      include_deleted: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
      order: z.enum(["created_desc", "created_asc", "updated_desc"]).optional(),
    },
    handler: (args, auth) =>
      listNotes({
        workspace_id: auth.workspace_id,
        caller_agent_id: auth.agent_id,
        is_admin: isAdmin(auth),
        type: args.type as string | undefined,
        project_id: args.project_id as string | undefined,
        agent: args.agent as string | undefined,
        status: args.status as string | undefined,
        tags: args.tags as string[] | undefined,
        since: args.since as string | undefined,
        until: args.until as string | undefined,
        session_id: args.session_id as string | undefined,
        task_bound_id: args.task_bound_id as string | undefined,
        include_deleted: args.include_deleted as boolean | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
        order: args.order as
          | "created_desc"
          | "created_asc"
          | "updated_desc"
          | undefined,
      }),
  },
  {
    name: "note_update",
    description:
      "Update a note. Metadata merges shallowly by default; use metadata_replace to fully replace.",
    rawSchema: {
      id: z.string().min(1),
      text: z.string().max(100_000).optional(),
      metadata: z.record(z.unknown()).optional(),
      metadata_replace: z.record(z.unknown()).optional(),
      project_id: z.string().nullable().optional(),
      task_bound_id: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
    },
    handler: (args, auth) =>
      updateNote({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        id: String(args.id),
        text: args.text as string | undefined,
        metadata: args.metadata as Record<string, unknown> | undefined,
        metadata_replace: args.metadata_replace as
          | Record<string, unknown>
          | undefined,
        project_id: args.project_id as string | null | undefined,
        task_bound_id: args.task_bound_id as string | null | undefined,
        tags: args.tags as string[] | undefined,
      }),
  },
  {
    name: "note_delete",
    description: "Soft-delete a note (sets deleted_at).",
    rawSchema: {
      id: z.string().min(1),
    },
    handler: (args, auth) =>
      deleteNote(auth.workspace_id, auth.agent_id, String(args.id)),
  },
  {
    name: "session_save",
    description:
      "Append one message to a session. Call after every user message AND every assistant response.",
    rawSchema: {
      session_id: z.string().min(1).max(100),
      role: z.enum(["user", "assistant", "system", "tool"]),
      content: z.string().min(1).max(100_000),
      metadata: z.record(z.unknown()).optional(),
      token_count: z.number().int().positive().optional(),
    },
    handler: (args, auth) =>
      saveMessage({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        session_id: String(args.session_id),
        role: args.role as "user" | "assistant" | "system" | "tool",
        content: String(args.content),
        metadata: args.metadata as Record<string, unknown> | undefined,
        token_count: args.token_count as number | undefined,
      }),
  },
  {
    name: "session_recent",
    description:
      "Load recent messages from a session. Pass session_id='latest' to get the most recent session of this agent.",
    rawSchema: {
      session_id: z.string().min(1),
      limit: z.number().int().min(1).max(500).optional(),
      include_summaries: z.boolean().optional(),
    },
    handler: (args, auth) =>
      sessionRecent({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        session_id: String(args.session_id),
        limit: args.limit as number | undefined,
        include_summaries: args.include_summaries as boolean | undefined,
      }),
  },
  {
    name: "session_search",
    description: "FTS5 search across saved session messages.",
    rawSchema: {
      query: z.string().min(1).max(1000),
      session_id: z.string().optional(),
      scope: z.enum(["own_agent", "workspace", "all"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      since: z.string().optional(),
      until: z.string().optional(),
    },
    handler: (args, auth) => {
      const privileged = auth.type === "claude-privileged";
      return sessionSearch({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        query: String(args.query),
        session_id: args.session_id as string | undefined,
        scope: args.scope as "own_agent" | "workspace" | "all" | undefined,
        limit: args.limit as number | undefined,
        since: args.since as string | undefined,
        until: args.until as string | undefined,
        privileged,
      });
    },
  },
  {
    name: "session_summarize",
    description:
      "Save your own summary of a message range. Qoopia does not generate summaries — you write the text.",
    rawSchema: {
      session_id: z.string().min(1),
      content: z.string().min(1).max(50_000),
      msg_start_id: z.number().int().positive(),
      msg_end_id: z.number().int().positive(),
      level: z.number().int().min(1).max(10).optional(),
      token_count: z.number().int().positive().optional(),
    },
    handler: (args, auth) =>
      sessionSummarize({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        session_id: String(args.session_id),
        content: String(args.content),
        msg_start_id: Number(args.msg_start_id),
        msg_end_id: Number(args.msg_end_id),
        level: args.level as number | undefined,
        token_count: args.token_count as number | undefined,
      }),
  },
  {
    name: "session_expand",
    description: "Fetch raw messages by ID range (expand a prior summary).",
    rawSchema: {
      start_id: z.number().int().positive(),
      end_id: z.number().int().positive(),
      session_id: z.string().optional(),
    },
    handler: (args, auth) =>
      sessionExpand({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        start_id: Number(args.start_id),
        end_id: Number(args.end_id),
        session_id: args.session_id as string | undefined,
      }),
  },
  {
    name: "activity_list",
    description: "Read the activity audit log with filters.",
    rawSchema: {
      entity_type: z.string().optional(),
      entity_id: z.string().optional(),
      project_id: z.string().optional(),
      agent: z.string().optional(),
      action: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    handler: (args, auth) =>
      listActivity({
        workspace_id: auth.workspace_id,
        entity_type: args.entity_type as string | undefined,
        entity_id: args.entity_id as string | undefined,
        project_id: args.project_id as string | undefined,
        agent: args.agent as string | undefined,
        action: args.action as string | undefined,
        since: args.since as string | undefined,
        until: args.until as string | undefined,
        limit: args.limit as number | undefined,
      }),
  },
];

export function registerTools(
  server: McpServer,
  authProvider: () => AuthContext | null,
  profile: ToolProfile = "full",
  opts?: { isSteward?: boolean },
) {
  for (const tool of tools) {
    if (profile === "memory" && !MEMORY_TOOLS.has(tool.name)) continue;
    server.tool(
      tool.name,
      tool.description,
      tool.rawSchema,
      async (args: unknown) => {
        try {
          const auth = authProvider();
          if (!auth) {
            return fail(new QoopiaError("UNAUTHORIZED", "No auth context"));
          }
          const result = tool.handler(
            (args as Record<string, unknown>) || {},
            auth,
          );
          return ok(result);
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  // Admin tools: only registered for steward agents
  if (opts?.isSteward) {
    for (const tool of adminTools) {
      server.tool(
        tool.name,
        tool.description,
        tool.rawSchema,
        async (args: unknown) => {
          try {
            const auth = authProvider();
            if (!auth) {
              return fail(new QoopiaError("UNAUTHORIZED", "No auth context"));
            }
            const result = tool.handler(
              (args as Record<string, unknown>) || {},
              auth,
            );
            return ok(result);
          } catch (err) {
            return fail(err);
          }
        },
      );
    }
  }

  // V2 backward-compatibility aliases: skip for memory-only profile to avoid
  // re-exposing CRUD operations that memory profile is supposed to restrict.
  if (profile !== "memory") {
    registerCompatTools(server, authProvider);
  }
}

export function toolNames(profile: ToolProfile = "full"): string[] {
  return tools
    .filter((t) => profile === "full" || MEMORY_TOOLS.has(t.name))
    .map((t) => t.name);
}
