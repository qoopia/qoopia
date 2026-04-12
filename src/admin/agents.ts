import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import { generateApiKey, sha256Hex } from "../auth/api-keys.ts";
import { QoopiaError, nowIso } from "../utils/errors.ts";

export function createAgent(opts: {
  name: string;
  workspaceSlug: string;
  type?: "standard" | "claude-privileged";
}): { id: string; name: string; api_key: string; workspace_id: string } {
  const ws = db
    .prepare(`SELECT id FROM workspaces WHERE slug = ?`)
    .get(opts.workspaceSlug) as { id: string } | undefined;
  if (!ws) throw new QoopiaError("NOT_FOUND", `workspace ${opts.workspaceSlug} not found`);

  const existing = db
    .prepare(`SELECT id FROM agents WHERE name = ? AND workspace_id = ?`)
    .get(opts.name, ws.id);
  if (existing)
    throw new QoopiaError(
      "CONFLICT",
      `agent '${opts.name}' already exists in workspace ${opts.workspaceSlug}`,
    );

  const id = ulid();
  const apiKey = generateApiKey();
  db.prepare(
    `INSERT INTO agents (id, workspace_id, name, type, api_key_hash, active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(id, ws.id, opts.name, opts.type || "standard", sha256Hex(apiKey), nowIso());
  return { id, name: opts.name, api_key: apiKey, workspace_id: ws.id };
}

export function listAgents() {
  return db
    .prepare(
      `SELECT a.id, a.name, a.type, a.active, a.last_seen, a.created_at, w.slug as workspace_slug
       FROM agents a JOIN workspaces w ON w.id = a.workspace_id
       ORDER BY w.slug, a.name`,
    )
    .all();
}

export function rotateAgentKey(name: string, workspaceSlug: string): string {
  const ws = db
    .prepare(`SELECT id FROM workspaces WHERE slug = ?`)
    .get(workspaceSlug) as { id: string } | undefined;
  if (!ws) throw new QoopiaError("NOT_FOUND", `workspace ${workspaceSlug} not found`);
  const a = db
    .prepare(`SELECT id FROM agents WHERE name = ? AND workspace_id = ?`)
    .get(name, ws.id) as { id: string } | undefined;
  if (!a) throw new QoopiaError("NOT_FOUND", `agent ${name} not found`);
  const newKey = generateApiKey();
  db.prepare(`UPDATE agents SET api_key_hash = ? WHERE id = ?`).run(
    sha256Hex(newKey),
    a.id,
  );
  return newKey;
}

export function deleteAgent(name: string, workspaceSlug: string) {
  const ws = db
    .prepare(`SELECT id FROM workspaces WHERE slug = ?`)
    .get(workspaceSlug) as { id: string } | undefined;
  if (!ws) throw new QoopiaError("NOT_FOUND", `workspace ${workspaceSlug} not found`);
  const info = db
    .prepare(`UPDATE agents SET active = 0 WHERE name = ? AND workspace_id = ?`)
    .run(name, ws.id);
  if (info.changes === 0)
    throw new QoopiaError("NOT_FOUND", `agent ${name} not found`);
  return { deactivated: true };
}
