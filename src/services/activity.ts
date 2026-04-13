import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import { nowIso } from "../utils/errors.ts";
import { assertNoSecrets } from "../utils/secret-guard.ts";

export interface ActivityInput {
  workspace_id: string;
  agent_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  project_id: string | null;
  summary: string;
  details?: Record<string, unknown>;
}

export function logActivity(input: ActivityInput): string {
  // Secret guard: reject if summary or details contain an API key pattern
  assertNoSecrets(input.summary, "activity.summary");
  if (input.details) {
    assertNoSecrets(JSON.stringify(input.details), "activity.details");
  }

  const id = ulid();
  db.prepare(
    `INSERT INTO activity (id, workspace_id, agent_id, action, entity_type, entity_id, project_id, summary, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspace_id,
    input.agent_id,
    input.action,
    input.entity_type,
    input.entity_id,
    input.project_id,
    input.summary,
    JSON.stringify(input.details || {}),
    nowIso(),
  );
  return id;
}

export interface ActivityListParams {
  workspace_id: string;
  entity_type?: string;
  entity_id?: string;
  project_id?: string;
  agent?: string; // by name — resolves via agents
  action?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export function listActivity(p: ActivityListParams) {
  const where: string[] = [`a.workspace_id = ?`];
  const params: any[] = [p.workspace_id];

  if (p.entity_type) {
    where.push(`a.entity_type = ?`);
    params.push(p.entity_type);
  }
  if (p.entity_id) {
    where.push(`a.entity_id = ?`);
    params.push(p.entity_id);
  }
  if (p.project_id) {
    where.push(`a.project_id = ?`);
    params.push(p.project_id);
  }
  if (p.action) {
    where.push(`a.action = ?`);
    params.push(p.action);
  }
  if (p.agent) {
    where.push(
      `a.agent_id IN (SELECT id FROM agents WHERE name = ? AND workspace_id = ?)`,
    );
    params.push(p.agent, p.workspace_id);
  }
  if (p.since) {
    where.push(`a.created_at >= ?`);
    params.push(p.since);
  }
  if (p.until) {
    where.push(`a.created_at <= ?`);
    params.push(p.until);
  }

  const limit = Math.min(Math.max(p.limit || 50, 1), 500);
  const sql = `SELECT a.id, a.action, a.entity_type, a.entity_id, a.project_id, a.agent_id,
                      ag.name as agent_name,
                      a.summary, a.details, a.created_at
               FROM activity a
               LEFT JOIN agents ag ON ag.id = a.agent_id
               WHERE ${where.join(" AND ")}
               ORDER BY a.created_at DESC
               LIMIT ?`;
  const items = db.prepare(sql).all(...params, limit) as Array<{
    id: string;
    action: string;
    entity_type: string;
    entity_id: string | null;
    project_id: string | null;
    agent_id: string | null;
    agent_name: string | null;
    summary: string;
    details: string;
    created_at: string;
  }>;

  const totalRow = db
    .prepare(
      `SELECT COUNT(*) as c FROM activity a WHERE ${where.join(" AND ")}`,
    )
    .get(...params) as { c: number };

  return {
    items: items.map((r) => ({
      ...r,
      details: safeParse(r.details),
    })),
    total: totalRow.c,
    limit,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
