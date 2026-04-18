import { db } from "../db/connection.ts";
import { verifyApiKey, type AgentRecord } from "./api-keys.ts";
import { findActiveToken } from "./oauth.ts";

export interface AuthContext {
  agent_id: string;
  agent_name: string;
  workspace_id: string;
  type: "standard" | "claude-privileged" | string;
  source: "api-key" | "oauth";
}

/**
 * Extracts bearer token from Authorization header and resolves to AuthContext.
 * Returns null for unauth / invalid.
 */
export function authenticate(request: Request): AuthContext | null {
  const header = request.headers.get("authorization") || request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1]!.trim();
  if (!token) return null;

  // Agent API key path (static)
  const agent = verifyApiKey(token);
  if (agent) {
    return agentToContext(agent, "api-key");
  }

  // OAuth access token path — require active=1 so deactivated agents cannot auth
  const oauthRow = findActiveToken(token);
  if (oauthRow && oauthRow.token_type === "access") {
    const a = db
      .prepare(`SELECT * FROM agents WHERE id = ? AND active = 1`)
      .get(oauthRow.agent_id) as AgentRecord | undefined;
    if (a) return agentToContext(a, "oauth");
  }

  return null;
}

function agentToContext(a: AgentRecord, source: "api-key" | "oauth"): AuthContext {
  return {
    agent_id: a.id,
    agent_name: a.name,
    workspace_id: a.workspace_id,
    type: a.type,
    source,
  };
}
