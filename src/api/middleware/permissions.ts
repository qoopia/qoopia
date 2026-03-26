import { createMiddleware } from 'hono/factory';
import { rawDb } from '../../db/connection.js';
import type { AuthContext } from '../../types/index.js';

interface PermissionRule {
  entity: string;
  actions: string[];
}

interface AgentPermissions {
  projects: string | string[];  // '*' or array of project IDs
  rules: PermissionRule[];
  filters?: Record<string, { op: string; values: string[] }>;
}

const METHOD_TO_ACTION: Record<string, string> = {
  GET: 'read',
  POST: 'create',
  PATCH: 'update',
  PUT: 'update',
  DELETE: 'delete',
};

const PATH_TO_ENTITY: Record<string, string> = {
  projects: 'project',
  tasks: 'task',
  deals: 'deal',
  contacts: 'contact',
  finances: 'finance',
  activity: 'activity',
};

function resolveAction(method: string): string {
  return METHOD_TO_ACTION[method] || 'read';
}

function resolveEntity(path: string): string | null {
  const match = path.match(/\/api\/v1\/(\w+)/);
  if (!match) return null;
  const resource = match[1];
  return PATH_TO_ENTITY[resource] || resource;
}

function expandActions(actions: string[]): string[] {
  const expanded: string[] = [];
  for (const action of actions) {
    if (action === 'write') {
      expanded.push('create', 'update', 'delete');
    } else {
      expanded.push(action);
    }
  }
  return expanded;
}

function getPermissions(agentId: string): AgentPermissions | null {
  const row = rawDb.prepare(
    'SELECT permissions FROM agents WHERE id = ? AND active = 1'
  ).get(agentId) as { permissions: string } | undefined;

  if (!row) return null;

  try {
    return JSON.parse(row.permissions);
  } catch {
    return null;
  }
}

function checkEntityPermission(perms: AgentPermissions, entityType: string, action: string): boolean {
  for (const rule of perms.rules) {
    if (rule.entity === '*' || rule.entity === entityType || rule.entity === entityType + 's') {
      const actions = expandActions(rule.actions);
      if (actions.includes(action)) return true;
    }
  }
  return false;
}

function checkProjectScope(perms: AgentPermissions, projectId: string | null): boolean {
  if (perms.projects === '*') return true;
  if (!projectId) return true; // no project context (e.g. contacts list)
  if (Array.isArray(perms.projects)) {
    return perms.projects.includes(projectId);
  }
  return false;
}

export function getProjectFilter(perms: AgentPermissions): string[] | null {
  if (perms.projects === '*') return null;
  if (Array.isArray(perms.projects)) return perms.projects;
  return null;
}

export function getEntityFilters(perms: AgentPermissions, entityType: string): Record<string, string[]> | null {
  if (!perms.filters) return null;
  const result: Record<string, string[]> = {};
  const prefix = entityType + 's.';
  for (const [key, filter] of Object.entries(perms.filters)) {
    if (key.startsWith(prefix) && filter.op === 'IN') {
      const field = key.slice(prefix.length);
      result[field] = filter.values;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

export const permissionsMiddleware = createMiddleware<{ Variables: { auth: AuthContext } }>(async (c, next) => {
  const auth = c.get('auth');

  // Users (humans) bypass granular permissions — they use role-based access
  if (auth.type === 'user') {
    return next();
  }

  const perms = getPermissions(auth.id);
  if (!perms || !perms.rules || perms.rules.length === 0) {
    return c.json({
      error: {
        code: 'FORBIDDEN',
        message: 'Agent has no permissions configured',
      }
    }, 403);
  }

  const method = c.req.method;
  const path = c.req.path;
  const action = resolveAction(method);
  const entityType = resolveEntity(path);

  if (!entityType) {
    return next();
  }

  // Check entity-level permission
  if (!checkEntityPermission(perms, entityType, action)) {
    return c.json({
      error: {
        code: 'FORBIDDEN',
        message: `Agent '${auth.name}' does not have '${action}' permission for '${entityType}'`,
      }
    }, 403);
  }

  // Check project scope for write operations and specific entity GETs
  if (action !== 'read') {
    // For POST, check project_id in body (will be validated later)
    // For PATCH/PUT/DELETE, check the entity's project_id
    const entityId = c.req.param('id');
    if (entityId && perms.projects !== '*') {
      const projectId = getEntityProjectId(entityType, entityId, auth.workspace_id);
      if (!checkProjectScope(perms, projectId)) {
        return c.json({
          error: {
            code: 'FORBIDDEN',
            message: `Agent '${auth.name}' does not have access to this project`,
          }
        }, 403);
      }
    }
  }

  // Store permissions in context for list filtering
  c.set('auth', { ...auth, permissions: perms } as AuthContext & { permissions: AgentPermissions });

  return next();
});

function getEntityProjectId(entityType: string, entityId: string, workspaceId: string): string | null {
  const tables: Record<string, string> = {
    task: 'tasks',
    deal: 'deals',
    finance: 'finances',
    project: 'projects',
  };

  const table = tables[entityType];
  if (!table) return null;

  if (entityType === 'project') {
    // The entity IS the project
    return entityId;
  }

  const row = rawDb.prepare(
    `SELECT project_id FROM ${table} WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
  ).get(entityId, workspaceId) as { project_id: string } | undefined;

  return row?.project_id ?? null;
}
