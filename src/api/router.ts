import { Hono } from 'hono';
import { corsMiddleware } from './middleware/cors.js';
import { authMiddleware } from './middleware/auth.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { idempotencyMiddleware } from './middleware/idempotency.js';
import { permissionsMiddleware } from './middleware/permissions.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import healthHandler from './handlers/health.js';
import projectsHandler from './handlers/projects.js';
import tasksHandler from './handlers/tasks.js';
import dealsHandler from './handlers/deals.js';
import contactsHandler from './handlers/contacts.js';
import financesHandler from './handlers/finances.js';
import activityHandler from './handlers/activity.js';
import searchHandler from './handlers/search.js';
import eventsHandler from './handlers/events.js';
import batchHandler, { setBatchRouter } from './handlers/batch.js';
import agentsHandler from './handlers/agents.js';
import authHandler from './handlers/auth.js';
import openapiHandler from './handlers/openapi.js';
import mcpHandler from './handlers/mcp.js';
import exportHandler from './handlers/export.js';
import oauthHandler from './handlers/oauth.js';
import observeHandler from './handlers/observe.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const api = new Hono();

// Global middleware
api.use('*', corsMiddleware);
api.use('*', requestIdMiddleware);

// No-auth routes
api.route('/api/v1/health', healthHandler);
api.route('/api/v1/auth', authHandler);
api.route('/api/v1/openapi.json', openapiHandler);

// OAuth 2.0 routes — all public (authorize must be unauthenticated for OAuth flow)
api.route('/', oauthHandler);

// Auth middleware for all protected routes
const protectedRoutes = ['projects', 'tasks', 'deals', 'contacts', 'finances', 'activity', 'search', 'events', 'batch', 'agents', 'export'];
for (const route of protectedRoutes) {
  api.use(`/api/v1/${route}/*`, authMiddleware);
  api.use(`/api/v1/${route}`, authMiddleware);
}

// MCP endpoint (auth required)
api.use('/mcp', authMiddleware);
api.use('/mcp/*', authMiddleware);

// Observe endpoint (auth required)
api.use('/api/v1/observe', authMiddleware);
api.use('/api/v1/observe/*', authMiddleware);

// Rate limiting (after auth, before permissions)
for (const route of protectedRoutes) {
  api.use(`/api/v1/${route}/*`, rateLimitMiddleware);
  api.use(`/api/v1/${route}`, rateLimitMiddleware);
}
api.use('/mcp', rateLimitMiddleware);
api.use('/mcp/*', rateLimitMiddleware);
api.use('/api/v1/observe', rateLimitMiddleware);
api.use('/api/v1/observe/*', rateLimitMiddleware);

// Permissions middleware for entity routes (not agents/export — those have own checks)
const entityRoutes = ['projects', 'tasks', 'deals', 'contacts', 'finances', 'activity', 'search', 'events', 'batch'];
for (const route of entityRoutes) {
  api.use(`/api/v1/${route}/*`, permissionsMiddleware);
  api.use(`/api/v1/${route}`, permissionsMiddleware);
}

// Idempotency middleware for POST endpoints
api.use('/api/v1/projects', idempotencyMiddleware);
api.use('/api/v1/tasks', idempotencyMiddleware);
api.use('/api/v1/deals', idempotencyMiddleware);
api.use('/api/v1/contacts', idempotencyMiddleware);
api.use('/api/v1/finances', idempotencyMiddleware);

// Protected routes
api.route('/api/v1/projects', projectsHandler);
api.route('/api/v1/tasks', tasksHandler);
api.route('/api/v1/deals', dealsHandler);
api.route('/api/v1/contacts', contactsHandler);
api.route('/api/v1/finances', financesHandler);
api.route('/api/v1/activity', activityHandler);
api.route('/api/v1/search', searchHandler);
api.route('/api/v1/events', eventsHandler);
api.route('/api/v1/batch', batchHandler);
api.route('/api/v1/agents', agentsHandler);
api.route('/api/v1/export', exportHandler);
api.route('/mcp', mcpHandler);
api.route('/api/v1/observe', observeHandler);

// Wire batch handler to route internally through the app
setBatchRouter(api);

// Dashboard (static HTML)
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
api.get('/dashboard', (c) => {
  try {
    const html = readFileSync(join(publicDir, 'index.html'), 'utf-8');
    return c.html(html);
  } catch {
    return c.text('Dashboard not found', 404);
  }
});
api.get('/logo.svg', (c) => {
  try {
    const svg = readFileSync(join(publicDir, 'logo.svg'), 'utf-8');
    return c.body(svg, 200, { 'Content-Type': 'image/svg+xml' });
  } catch {
    return c.text('Not found', 404);
  }
});
api.get('/logo-dark.svg', (c) => {
  try {
    const svg = readFileSync(join(publicDir, 'logo-dark.svg'), 'utf-8');
    return c.body(svg, 200, { 'Content-Type': 'image/svg+xml' });
  } catch {
    return c.text('Not found', 404);
  }
});

export default api;
