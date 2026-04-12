/**
 * Admin MCP tools — available only to agents with type="steward".
 *
 * Three tools:
 *   agent_onboard  — create agent + bootstrap notes in one transaction
 *   agent_list     — list all agents in workspace
 *   agent_deactivate — soft-delete an agent (with self-guard)
 *
 * Design decisions (ADR-012):
 *   - Bootstrap notes are created with agent_id = new agent (owner),
 *     NOT steward's agent_id. This ensures the new agent sees them
 *     via brief() which filters by agent_id.
 *   - Activity log uses steward's agent_id (actor) for audit trail.
 *   - Plaintext API key is returned in tool response only, never logged.
 *   - Self-guard: steward cannot deactivate itself.
 *   - UNIQUE partial index prevents creating a second active steward.
 */
import { z } from "zod";
import { db } from "../db/connection.ts";
import type { AuthContext } from "../auth/middleware.ts";
import { QoopiaError, nowIso } from "../utils/errors.ts";
import { createAgent, listAgents } from "../admin/agents.ts";
import { logActivity } from "../services/activity.ts";
import { getRolePreset, ROLE_PRESET_NAMES } from "../admin/templates.ts";
import { ulid } from "ulid";

export interface AdminToolDef {
  name: string;
  description: string;
  rawSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, auth: AuthContext) => unknown;
}

function assertSteward(auth: AuthContext) {
  if (auth.type !== "steward") {
    throw new QoopiaError("FORBIDDEN", "This tool requires steward privileges.");
  }
}

export const adminTools: AdminToolDef[] = [
  // --- agent_onboard ---
  {
    name: "agent_onboard",
    description:
      "Create a new agent with optional bootstrap notes from a role preset. " +
      "Returns the API key ONCE — it is never stored or logged in plaintext. " +
      "If a role preset is specified, bootstrap notes are created and a thin " +
      "system prompt is returned ready for copy-paste.",
    rawSchema: {
      name: z
        .string()
        .min(1)
        .max(64)
        .describe("Agent name (unique within workspace)"),
      role: z
        .string()
        .optional()
        .describe(
          `Optional role preset for bootstrap notes. Available: ${ROLE_PRESET_NAMES.join(", ")}`,
        ),
    },
    handler(args, auth) {
      assertSteward(auth);

      const name = args.name as string;
      const roleName = args.role as string | undefined;

      // Resolve workspace slug from steward's workspace_id
      const ws = db
        .prepare(`SELECT slug FROM workspaces WHERE id = ?`)
        .get(auth.workspace_id) as { slug: string } | undefined;
      if (!ws)
        throw new QoopiaError("NOT_FOUND", "workspace not found");

      // Run everything in a transaction — all or nothing
      const txn = db.transaction(() => {
        // 1. Create agent (type=standard, never steward via MCP)
        const created = createAgent({
          name,
          workspaceSlug: ws.slug,
          type: "standard",
        });

        // 2. Bootstrap notes from role preset (if specified)
        let bootstrapCount = 0;
        let systemPrompt: string | null = null;

        if (roleName) {
          const preset = getRolePreset(roleName);
          const now = nowIso();

          for (const note of preset.bootstrapNotes) {
            const noteId = ulid();
            db.prepare(
              `INSERT INTO notes (id, workspace_id, agent_id, type, text, metadata, tags, source, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, '{}', ?, 'steward', ?, ?)`,
            ).run(
              noteId,
              created.workspace_id,
              created.id, // owner = new agent, NOT steward
              note.type,
              note.text,
              JSON.stringify(note.tags),
              now,
              now,
            );
            bootstrapCount++;
          }

          systemPrompt = preset.systemPrompt;
        }

        // 3. Activity log (steward = actor, no key in details)
        logActivity({
          workspace_id: auth.workspace_id,
          agent_id: auth.agent_id, // steward is the actor
          action: "agent_onboarded",
          entity_type: "agent",
          entity_id: created.id,
          project_id: null,
          summary: `Steward onboarded agent '${name}'${roleName ? ` with role '${roleName}'` : ""}`,
          details: {
            agent_name: name,
            role: roleName || null,
            bootstrap_notes: bootstrapCount,
          },
        });

        return {
          agent_id: created.id,
          agent_name: name,
          api_key: created.api_key,
          workspace_id: created.workspace_id,
          bootstrap_notes_created: bootstrapCount,
          system_prompt: systemPrompt,
        };
      });

      return txn();
    },
  },

  // --- agent_list ---
  {
    name: "agent_list",
    description:
      "List all agents in the workspace (or all workspaces for privileged steward). " +
      "Returns name, type, active status, and last_seen.",
    rawSchema: {},
    handler(_args, auth) {
      assertSteward(auth);
      // listAgents returns all agents across workspaces (admin view)
      const all = listAgents() as Array<{
        id: string;
        name: string;
        type: string;
        active: number;
        last_seen: string | null;
        created_at: string;
        workspace_slug: string;
      }>;
      return {
        agents: all.map((a) => ({
          name: a.name,
          type: a.type,
          active: !!a.active,
          last_seen: a.last_seen,
          created_at: a.created_at,
          workspace: a.workspace_slug,
        })),
        total: all.length,
      };
    },
  },

  // --- agent_deactivate ---
  {
    name: "agent_deactivate",
    description:
      "Deactivate (soft-delete) an agent. All API keys and OAuth tokens " +
      "become immediately invalid. Self-guard: steward cannot deactivate itself.",
    rawSchema: {
      name: z.string().min(1).describe("Name of the agent to deactivate"),
    },
    handler(args, auth) {
      assertSteward(auth);

      const targetName = args.name as string;

      // Self-guard: steward cannot deactivate itself
      if (targetName === auth.agent_name) {
        throw new QoopiaError(
          "FORBIDDEN",
          "Steward cannot deactivate itself. Use CLI: qoopia admin delete-agent",
        );
      }

      const ws = db
        .prepare(`SELECT slug FROM workspaces WHERE id = ?`)
        .get(auth.workspace_id) as { slug: string } | undefined;
      if (!ws)
        throw new QoopiaError("NOT_FOUND", "workspace not found");

      const info = db
        .prepare(
          `UPDATE agents SET active = 0 WHERE name = ? AND workspace_id = ? AND active = 1`,
        )
        .run(targetName, auth.workspace_id);

      if (info.changes === 0) {
        throw new QoopiaError(
          "NOT_FOUND",
          `Active agent '${targetName}' not found in workspace`,
        );
      }

      logActivity({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        action: "agent_deactivated",
        entity_type: "agent",
        entity_id: null,
        project_id: null,
        summary: `Steward deactivated agent '${targetName}'`,
        details: { agent_name: targetName },
      });

      return { deactivated: true, agent_name: targetName };
    },
  },
];
