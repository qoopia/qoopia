import { Hono } from 'hono';

const app = new Hono();

// Auto-generated OpenAPI spec from Zod schemas
const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Qoopia API',
    description: 'Shared Truth Layer for AI Agents — REST API',
    version: '2.0.0',
    contact: { name: 'Qoopia', url: 'https://qoopia.ai' },
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local development' },
  ],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http' as const,
        scheme: 'bearer',
        description: 'API key: Bearer qp_a_xxx (agent) or qp_u_xxx (user)',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'VALIDATION_ERROR' },
              message: { type: 'string' },
              details: { type: 'object' },
            },
            required: ['code', 'message'],
          },
        },
      },
      Pagination: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          has_more: { type: 'boolean' },
        },
      },
      Project: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ULID' },
          workspace_id: { type: 'string' },
          name: { type: 'string', maxLength: 200 },
          description: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['active', 'paused', 'archived'] },
          owner_agent_id: { type: 'string', nullable: true },
          color: { type: 'string', nullable: true },
          tags: { type: 'array', items: { type: 'string' } },
          settings: { type: 'object' },
          revision: { type: 'integer' },
          deleted_at: { type: 'string', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
          updated_by: { type: 'string', nullable: true },
        },
      },
      Task: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          project_id: { type: 'string' },
          workspace_id: { type: 'string' },
          title: { type: 'string', maxLength: 500 },
          description: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['todo', 'in_progress', 'waiting', 'done', 'cancelled'] },
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          assignee: { type: 'string', nullable: true },
          due_date: { type: 'string', nullable: true },
          blocked_by: { type: 'array', items: { type: 'string' } },
          parent_id: { type: 'string', nullable: true },
          source: { type: 'string', enum: ['manual', 'agent', 'webhook', 'import'] },
          tags: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string', nullable: true },
          attachments: { type: 'array', items: { type: 'object' } },
          revision: { type: 'integer' },
          deleted_at: { type: 'string', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
          updated_by: { type: 'string', nullable: true },
        },
      },
      Deal: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          project_id: { type: 'string' },
          workspace_id: { type: 'string' },
          name: { type: 'string', maxLength: 500 },
          address: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['active', 'paused', 'archived'] },
          asking_price: { type: 'number', nullable: true },
          target_price: { type: 'number', nullable: true },
          monthly_rent: { type: 'number', nullable: true },
          lease_term_months: { type: 'integer', nullable: true },
          metadata: { type: 'object' },
          documents: { type: 'array', items: { type: 'object' } },
          timeline: { type: 'array', items: { type: 'object' } },
          tags: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string', nullable: true },
          revision: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      Contact: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          workspace_id: { type: 'string' },
          name: { type: 'string', maxLength: 200 },
          role: { type: 'string', nullable: true },
          company: { type: 'string', nullable: true },
          email: { type: 'string', nullable: true },
          phone: { type: 'string', nullable: true },
          telegram_id: { type: 'string', nullable: true },
          language: { type: 'string' },
          timezone: { type: 'string', nullable: true },
          category: { type: 'string', nullable: true },
          tags: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string', nullable: true },
          revision: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      Finance: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          workspace_id: { type: 'string' },
          project_id: { type: 'string', nullable: true },
          type: { type: 'string', enum: ['subscription', 'credit', 'investment', 'budget', 'purchase', 'acquisition'] },
          name: { type: 'string', maxLength: 200 },
          amount: { type: 'number' },
          currency: { type: 'string' },
          recurring: { type: 'string', enum: ['none', 'monthly', 'annual', 'biennial'] },
          status: { type: 'string', enum: ['active', 'trial', 'paused', 'cancelled'] },
          tags: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string', nullable: true },
          revision: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      Activity: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          workspace_id: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
          actor: { type: 'string' },
          action: { type: 'string' },
          entity_type: { type: 'string' },
          entity_id: { type: 'string', nullable: true },
          project_id: { type: 'string', nullable: true },
          summary: { type: 'string' },
          details: { type: 'object' },
          revision_before: { type: 'integer', nullable: true },
          revision_after: { type: 'integer', nullable: true },
        },
      },
      Agent: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          workspace_id: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['openclaw', 'claude', 'chatgpt', 'deepseek', 'custom'] },
          permissions: { type: 'object' },
          metadata: { type: 'object' },
          last_seen: { type: 'string', nullable: true },
          active: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  paths: {
    '/api/v1/health': {
      get: {
        tags: ['System'],
        summary: 'Health check',
        security: [],
        responses: {
          '200': { description: 'Server healthy' },
          '503': { description: 'Server degraded' },
        },
      },
    },
    ...crudPaths('projects', 'Project', ['updated_since']),
    ...crudPaths('tasks', 'Task', ['project_id', 'status', 'assignee', 'priority', 'updated_since']),
    ...crudPaths('deals', 'Deal', ['project_id', 'status', 'updated_since']),
    ...crudPaths('contacts', 'Contact', ['category', 'project_id', 'updated_since']),
    ...crudPaths('finances', 'Finance', ['project_id', 'type', 'status', 'updated_since']),
    '/api/v1/activity': {
      get: {
        tags: ['Activity'],
        summary: 'List activity log (cursor-based)',
        parameters: [
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          { name: 'actor', in: 'query', schema: { type: 'string' } },
          { name: 'entity_type', in: 'query', schema: { type: 'string' } },
          { name: 'project_id', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Activity list with cursor pagination' } },
      },
    },
    '/api/v1/search': {
      get: {
        tags: ['Search'],
        summary: 'Full-text search across entities',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'entities', in: 'query', schema: { type: 'string', description: 'Comma-separated: tasks,deals,contacts,activity' } },
        ],
        responses: { '200': { description: 'Search results by entity type' } },
      },
    },
    '/api/v1/events': {
      get: {
        tags: ['Real-time'],
        summary: 'SSE event stream',
        parameters: [
          { name: 'project_id', in: 'query', schema: { type: 'string' } },
          { name: 'entity_type', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Server-Sent Events stream' } },
      },
    },
    '/api/v1/batch': {
      post: {
        tags: ['Batch'],
        summary: 'Execute multiple operations (max 20)',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { operations: { type: 'array', items: { type: 'object', properties: { method: { type: 'string' }, path: { type: 'string' }, body: { type: 'object' } } } } } } } },
        },
        responses: { '200': { description: 'Array of results' } },
      },
    },
    '/api/v1/agents': {
      get: { tags: ['Agents'], summary: 'List agents', responses: { '200': { description: 'Agent list' } } },
      post: { tags: ['Agents'], summary: 'Register new agent', responses: { '201': { description: 'Agent created with API key (shown once)' } } },
    },
    '/api/v1/agents/{id}': {
      patch: { tags: ['Agents'], summary: 'Update agent', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Updated agent' } } },
      delete: { tags: ['Agents'], summary: 'Deactivate agent', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Agent deactivated' } } },
    },
    '/api/v1/agents/{id}/rotate-key': {
      post: { tags: ['Agents'], summary: 'Rotate API key (24h grace)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'New API key (shown once)' } } },
    },
    '/api/v1/auth/magic-link': {
      post: {
        tags: ['Auth'],
        summary: 'Request magic link',
        security: [],
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } } } },
        responses: { '200': { description: 'Magic link sent (if account exists)' } },
      },
    },
    '/api/v1/auth/verify': {
      get: {
        tags: ['Auth'],
        summary: 'Verify magic link token',
        security: [],
        parameters: [{ name: 'token', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Session created' }, '401': { description: 'Invalid or expired token' } },
      },
    },
    '/api/v1/export': {
      get: { tags: ['System'], summary: 'Full workspace JSON dump (admin only)', responses: { '200': { description: 'Complete workspace export' } } },
    },
  },
};

function crudPaths(resource: string, schemaName: string, listFilters: string[]) {
  const tag = schemaName + 's';
  const params = [
    { name: 'offset', in: 'query' as const, schema: { type: 'integer' as const, default: 0 } },
    { name: 'limit', in: 'query' as const, schema: { type: 'integer' as const, default: 50 } },
    ...listFilters.map(f => ({ name: f, in: 'query' as const, schema: { type: 'string' as const } })),
  ];
  return {
    [`/api/v1/${resource}`]: {
      get: { tags: [tag], summary: `List ${resource}`, parameters: params, responses: { '200': { description: `Paginated ${resource}` } } },
      post: {
        tags: [tag], summary: `Create ${resource.slice(0, -1)}`,
        requestBody: { content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } } },
        responses: { '201': { description: `${schemaName} created` } },
      },
    },
    [`/api/v1/${resource}/{id}`]: {
      get: { tags: [tag], summary: `Get ${resource.slice(0, -1)}`, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: schemaName }, '404': { description: 'Not found' } } },
      patch: { tags: [tag], summary: `Update ${resource.slice(0, -1)}`, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Updated' }, '409': { description: 'Revision conflict' } } },
      delete: { tags: [tag], summary: `Soft delete ${resource.slice(0, -1)}`, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Deleted' } } },
    },
  };
}

app.get('/', (c) => {
  return c.json(spec);
});

export default app;
