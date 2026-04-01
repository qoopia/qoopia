import type { ToolDefinition, ToolHandler } from '../utils.js';
import { handleTool as handleTasks } from './tasks.js';
import { handleTool as handleDeals } from './deals.js';
import { handleTool as handleContacts } from './contacts.js';
import { handleTool as handleFinances } from './finances.js';
import { handleTool as handleProjects } from './projects.js';
import { handleTool as handleActivity } from './activity.js';

// Entity → handler module mapping
const ENTITY_HANDLERS: Record<string, (name: string, args: Record<string, unknown>, ws: string, actor: string) => Promise<unknown | null>> = {
  tasks: handleTasks,
  deals: handleDeals,
  contacts: handleContacts,
  finances: handleFinances,
  projects: handleProjects,
  activity: handleActivity,
};

// Maps consolidated tool name + entity → original tool name
function resolveToolName(action: string, entity: string): string | null {
  const map: Record<string, Record<string, string>> = {
    list: {
      tasks: 'list_tasks',
      deals: 'list_deals',
      contacts: 'list_contacts',
      finances: 'list_finances',
      projects: 'list_projects',
      activity: 'get_activity',
    },
    get: {
      tasks: 'get_task',
    },
    create: {
      tasks: 'create_task',
      deals: 'create_deal',
      contacts: 'create_contact',
      finances: 'create_finance',
      activity: 'create_activity',
    },
    update: {
      tasks: 'update_task',
      deals: 'update_deal',
      contacts: 'update_contact',
      finances: 'update_finance',
      projects: 'update_project',
    },
    delete: {
      tasks: 'delete_task',
      deals: 'delete_deal',
      contacts: 'delete_contact',
      finances: 'delete_finance',
    },
  };
  return map[action]?.[entity] ?? null;
}

// Permission mapping for consolidated tools: [entity_perm, action_perm]
export function resolvePermission(action: string, entity: string): [string, string] | null {
  const entityMap: Record<string, string> = {
    tasks: 'task', deals: 'deal', contacts: 'contact',
    finances: 'finance', projects: 'project', activity: 'activity',
  };
  const actionMap: Record<string, string> = {
    list: 'read', get: 'read', create: 'create', update: 'update', delete: 'delete',
  };
  const permEntity = entityMap[entity];
  const permAction = actionMap[action];
  if (!permEntity || !permAction) return null;
  return [permEntity, permAction];
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'list',
    description: `List entities by type. Supported entities and filters:
- tasks: project_id (string), status (todo|in_progress|waiting|done|cancelled), assignee (agent ID), limit (number, default 50)
- deals: project_id, status (active|paused|archived), limit
- contacts: category (string), limit
- finances: type (subscription|credit|investment|budget|purchase|acquisition), status, limit
- projects: status (active|paused|archived), limit
- activity: entity_type (task|deal|contact|etc), project_id, limit (default 20)`,
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', enum: ['tasks', 'deals', 'contacts', 'finances', 'projects', 'activity'], description: 'Entity type to list' },
        project_id: { type: 'string', description: 'Filter by project ID (tasks, deals, activity)' },
        status: { type: 'string', description: 'Filter by status' },
        assignee: { type: 'string', description: 'Filter tasks by assignee agent ID' },
        category: { type: 'string', description: 'Filter contacts by category' },
        type: { type: 'string', description: 'Filter finances by type' },
        entity_type: { type: 'string', description: 'Filter activity by entity type' },
        limit: { type: 'number', description: 'Max results' },
      },
      required: ['entity'],
    },
  },
  {
    name: 'get',
    description: `Get a single entity by ID. Supported entities:
- tasks: returns full task details (title, description, status, priority, assignee, due_date, tags, notes)`,
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', enum: ['tasks'], description: 'Entity type' },
        id: { type: 'string', description: 'Entity ID' },
      },
      required: ['entity', 'id'],
    },
  },
  {
    name: 'create',
    description: `Create a new entity. Required and optional fields by type:
- tasks: title (required), project_id (required), status (todo|in_progress|waiting|done|cancelled, default: todo), priority (low|medium|high|critical, default: medium), assignee, due_date (YYYY-MM-DD), notes, tags, description
- deals: name (required), project_id (required), address, status (active|paused|archived, default: active), asking_price, target_price, monthly_rent, notes, tags, metadata (object), timeline (array of {date, event})
- contacts: name (required), role, company, email, phone, telegram_id, language (default: EN), timezone, category, notes, tags
- finances: type (required: subscription|credit|investment|budget|purchase|acquisition), name (required), amount (required), currency (default: USD), recurring (none|monthly|annual|biennial), status (active|trial|paused|cancelled), project_id, notes, tags
- activity: entity_type (required), action (required), summary (required), entity_id, project_id, details (object)`,
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', enum: ['tasks', 'deals', 'contacts', 'finances', 'activity'], description: 'Entity type to create' },
        // Task fields
        title: { type: 'string', description: 'Task title' },
        project_id: { type: 'string', description: 'Project ID (tasks, deals, finances)' },
        status: { type: 'string', description: 'Status' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Task priority' },
        assignee: { type: 'string', description: 'Task assignee agent ID' },
        due_date: { type: 'string', description: 'Task due date (YYYY-MM-DD)' },
        description: { type: 'string', description: 'Task description' },
        // Deal fields
        name: { type: 'string', description: 'Name (deals, contacts, finances)' },
        address: { type: 'string', description: 'Deal address' },
        asking_price: { type: 'number', description: 'Deal asking price' },
        target_price: { type: 'number', description: 'Deal target price' },
        monthly_rent: { type: 'number', description: 'Deal monthly rent' },
        metadata: { type: 'object', description: 'Deal metadata' },
        timeline: { type: 'array', items: { type: 'object' }, description: 'Deal timeline [{date, event}]' },
        // Contact fields
        role: { type: 'string', description: 'Contact role' },
        company: { type: 'string', description: 'Contact company' },
        email: { type: 'string', description: 'Contact email' },
        phone: { type: 'string', description: 'Contact phone' },
        telegram_id: { type: 'string', description: 'Contact Telegram ID' },
        language: { type: 'string', description: 'Contact language (default: EN)' },
        timezone: { type: 'string', description: 'Contact timezone' },
        category: { type: 'string', description: 'Contact category' },
        // Finance fields
        type: { type: 'string', description: 'Finance type' },
        amount: { type: 'number', description: 'Finance amount' },
        currency: { type: 'string', description: 'Finance currency (default: USD)' },
        recurring: { type: 'string', enum: ['none', 'monthly', 'annual', 'biennial'], description: 'Finance recurring period' },
        // Activity fields
        entity_type: { type: 'string', description: 'Activity entity type' },
        entity_id: { type: 'string', description: 'Activity entity ID' },
        action: { type: 'string', description: 'Activity action' },
        summary: { type: 'string', description: 'Activity summary' },
        details: { type: 'object', description: 'Activity details' },
        // Shared
        notes: { type: 'string', description: 'Notes' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
      },
      required: ['entity'],
    },
  },
  {
    name: 'update',
    description: `Update an existing entity. Pass id and any fields to change:
- tasks: id (required). Updatable: title, status (todo|in_progress|waiting|done|cancelled), priority, assignee, due_date, notes, tags, description
- deals: id (required). Updatable: name, address, status (active|paused|archived), asking_price, target_price, monthly_rent, notes, tags, metadata, timeline
- contacts: id (required). Updatable: name, role, company, email, phone, telegram_id, language, timezone, category, notes, tags
- finances: id (required). Updatable: type, name, amount, currency, recurring, status, notes, tags
- projects: id (required). Updatable: description, status (active|paused|archived), tags, color`,
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', enum: ['tasks', 'deals', 'contacts', 'finances', 'projects'], description: 'Entity type to update' },
        id: { type: 'string', description: 'Entity ID (required)' },
        title: { type: 'string' },
        status: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        assignee: { type: 'string' },
        due_date: { type: 'string' },
        description: { type: 'string' },
        name: { type: 'string' },
        address: { type: 'string' },
        asking_price: { type: 'number' },
        target_price: { type: 'number' },
        monthly_rent: { type: 'number' },
        metadata: { type: 'object' },
        timeline: { type: 'array', items: { type: 'object' } },
        role: { type: 'string' },
        company: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        telegram_id: { type: 'string' },
        language: { type: 'string' },
        timezone: { type: 'string' },
        category: { type: 'string' },
        type: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string' },
        recurring: { type: 'string', enum: ['none', 'monthly', 'annual', 'biennial'] },
        color: { type: 'string', description: 'Project color' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['entity', 'id'],
    },
  },
  {
    name: 'delete',
    description: `Soft-delete an entity. Supported entities: tasks, deals, contacts, finances`,
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', enum: ['tasks', 'deals', 'contacts', 'finances'], description: 'Entity type to delete' },
        id: { type: 'string', description: 'Entity ID' },
      },
      required: ['entity', 'id'],
    },
  },
];

export const handleTool: ToolHandler = async (name, args, workspaceId, actorId) => {
  if (!['list', 'get', 'create', 'update', 'delete'].includes(name)) return null;

  const entity = args.entity as string;
  if (!entity) return { content: [{ type: 'text', text: 'Missing required parameter: entity' }], isError: true };

  const handler = ENTITY_HANDLERS[entity];
  if (!handler) return { content: [{ type: 'text', text: `Unknown entity type: ${entity}. Valid: tasks, deals, contacts, finances, projects, activity` }], isError: true };

  const originalToolName = resolveToolName(name, entity);
  if (!originalToolName) return { content: [{ type: 'text', text: `Action '${name}' is not supported for entity '${entity}'` }], isError: true };

  // Pass all args except 'entity' to the original handler
  const { entity: _entity, ...handlerArgs } = args;
  return handler(originalToolName, handlerArgs, workspaceId, actorId);
};
