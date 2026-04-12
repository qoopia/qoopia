import { QoopiaError } from "../utils/errors.ts";

/**
 * Workspace scope assertion. Every service call MUST receive an AuthContext
 * and enforce workspace_id in its WHERE clause. This helper is a runtime check
 * rather than a SQL builder — each service keeps its own queries for clarity.
 */
export function assertScope(workspaceId: string | null | undefined): string {
  if (!workspaceId) {
    throw new QoopiaError("FORBIDDEN", "Workspace scope missing");
  }
  return workspaceId;
}
