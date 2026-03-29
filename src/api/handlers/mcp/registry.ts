import type { ToolDefinition, ToolHandler } from './utils.js';

import * as memory from './tools/memory.js';
import * as tasks from './tools/tasks.js';
import * as deals from './tools/deals.js';
import * as contacts from './tools/contacts.js';
import * as finances from './tools/finances.js';
import * as projects from './tools/projects.js';
import * as activity from './tools/activity.js';
import * as files from './tools/files.js';
import * as search from './tools/search.js';

// All tool modules in handler order
const TOOL_MODULES: Array<{ definitions: ToolDefinition[]; handler: ToolHandler }> = [
  { definitions: projects.TOOL_DEFINITIONS, handler: projects.handleTool },
  { definitions: tasks.TOOL_DEFINITIONS, handler: tasks.handleTool },
  { definitions: deals.TOOL_DEFINITIONS, handler: deals.handleTool },
  { definitions: contacts.TOOL_DEFINITIONS, handler: contacts.handleTool },
  { definitions: finances.TOOL_DEFINITIONS, handler: finances.handleTool },
  { definitions: activity.TOOL_DEFINITIONS, handler: activity.handleTool },
  { definitions: search.TOOL_DEFINITIONS, handler: search.handleTool },
  { definitions: files.TOOL_DEFINITIONS, handler: files.handleTool },
  { definitions: memory.TOOL_DEFINITIONS, handler: memory.handleTool },
];

// Flat array of all tool definitions
export const TOOLS: ToolDefinition[] = TOOL_MODULES.flatMap(m => m.definitions);

// Tool profiles: let MCP clients declare which tools they need
export const TOOL_PROFILES: Record<string, string[]> = {
  memory: ['note', 'recall', 'brief'],
  crm: [
    'note', 'recall', 'brief',
    'list_projects', 'update_project',
    'list_tasks', 'get_task', 'create_task', 'update_task', 'delete_task',
    'list_deals', 'create_deal', 'update_deal', 'delete_deal',
    'list_contacts', 'create_contact', 'update_contact', 'delete_contact',
    'list_finances', 'create_finance', 'update_finance', 'delete_finance',
    'get_activity', 'create_activity', 'report_activity',
    'search',
  ],
  full: [], // empty = all tools
};

// Permission map for agent permission enforcement
export const TOOL_PERMISSIONS: Record<string, [string, string]> = {
  list_projects: ['project', 'read'],
  create_project: ['project', 'create'],
  update_project: ['project', 'update'],
  delete_project: ['project', 'delete'],
  list_tasks: ['task', 'read'],
  get_task: ['task', 'read'],
  create_task: ['task', 'create'],
  update_task: ['task', 'update'],
  delete_task: ['task', 'delete'],
  list_deals: ['deal', 'read'],
  create_deal: ['deal', 'create'],
  update_deal: ['deal', 'update'],
  delete_deal: ['deal', 'delete'],
  list_contacts: ['contact', 'read'],
  create_contact: ['contact', 'create'],
  update_contact: ['contact', 'update'],
  delete_contact: ['contact', 'delete'],
  list_finances: ['finance', 'read'],
  create_finance: ['finance', 'create'],
  update_finance: ['finance', 'update'],
  delete_finance: ['finance', 'delete'],
  get_activity: ['activity', 'read'],
  note: ['activity', 'create'],
  report_activity: ['activity', 'create'],
  get_dashboard_brief: ['activity', 'read'],
  semantic_search: ['task', 'read'],
  get_embeddings_capabilities: ['task', 'read'],
  read_file: ['file', 'read'],
  write_file: ['file', 'create'],
  list_files: ['file', 'read'],
};

// Dispatch tool call to the first module that handles it
export async function handleToolCall(name: string, args: Record<string, unknown>, workspaceId: string, actorId: string): Promise<unknown> {
  for (const mod of TOOL_MODULES) {
    const result = await mod.handler(name, args, workspaceId, actorId);
    if (result !== null) return result;
  }
  return null;
}
