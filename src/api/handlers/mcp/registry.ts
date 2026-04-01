import type { ToolDefinition, ToolHandler } from './utils.js';

import * as crud from './tools/crud.js';
import * as memory from './tools/memory.js';

// All tool modules in handler order
const TOOL_MODULES: Array<{ definitions: ToolDefinition[]; handler: ToolHandler }> = [
  { definitions: crud.TOOL_DEFINITIONS, handler: crud.handleTool },
  { definitions: memory.TOOL_DEFINITIONS, handler: memory.handleTool },
];

// Flat array of all tool definitions
export const TOOLS: ToolDefinition[] = TOOL_MODULES.flatMap(m => m.definitions);

// Tool profiles: let MCP clients declare which tools they need
export const TOOL_PROFILES: Record<string, string[]> = {
  memory: ['note', 'recall', 'brief'],
  crm: [
    'note', 'recall', 'brief',
    'list', 'get', 'create', 'update', 'delete',
  ],
  full: [], // empty = all tools
};

// Permission map for agent permission enforcement
// Static permissions for memory tools
export const TOOL_PERMISSIONS: Record<string, [string, string]> = {
  note: ['activity', 'create'],
  recall: ['task', 'read'],
  brief: ['activity', 'read'],
};

// Dynamic permission resolution for consolidated CRUD tools
export function resolveToolPermission(toolName: string, args?: Record<string, unknown>): [string, string] | null {
  // Static permission
  if (TOOL_PERMISSIONS[toolName]) return TOOL_PERMISSIONS[toolName];

  // Dynamic permission for CRUD tools
  if (['list', 'get', 'create', 'update', 'delete'].includes(toolName) && args?.entity) {
    return crud.resolvePermission(toolName, args.entity as string);
  }

  return null;
}

// Dispatch tool call to the first module that handles it
export async function handleToolCall(name: string, args: Record<string, unknown>, workspaceId: string, actorId: string): Promise<unknown> {
  for (const mod of TOOL_MODULES) {
    const result = await mod.handler(name, args, workspaceId, actorId);
    if (result !== null) return result;
  }
  return null;
}
