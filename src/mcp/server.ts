import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type ToolProfile } from "./tools.ts";
import type { AuthContext } from "../auth/middleware.ts";

export function createMcpServer(
  authProvider: () => AuthContext | null,
  profile: ToolProfile = "full",
): McpServer {
  const server = new McpServer({
    name: "qoopia",
    version: "3.0.0",
  });
  registerTools(server, authProvider, profile);
  return server;
}
