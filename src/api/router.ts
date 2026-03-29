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
import mcpHandler, { mcpPostHandler } from './handlers/mcp.js';
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
api.route('/health', healthHandler);
api.route('/api/v1/auth', authHandler);
api.route('/api/v1/openapi.json', openapiHandler);

// OAuth 2.0 routes — authorize/token/revoke/register are public (MCP spec requires open registration)
// Rate limiting on register prevents abuse; auto-approve is scoped to single-user server.
api.route('/', oauthHandler);

// Auth middleware for all protected routes
const protectedRoutes = ['projects', 'tasks', 'deals', 'contacts', 'finances', 'activity', 'search', 'events', 'batch', 'agents', 'export'];
for (const route of protectedRoutes) {
  api.use(`/api/v1/${route}/*`, authMiddleware);
  api.use(`/api/v1/${route}`, authMiddleware);
}

// MCP endpoint (auth required) — /mcp and POST / (Claude.ai sends MCP requests to root)
api.use('/mcp', authMiddleware);
api.use('/mcp/*', authMiddleware);
api.on('POST', '/', authMiddleware);

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
api.on('POST', '/', rateLimitMiddleware);
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
// Mount MCP handler on POST / for Claude.ai MCP connector compatibility
// (Claude.ai sends MCP requests to root URL, not /mcp)
api.post('/', mcpPostHandler);
api.route('/api/v1/observe', observeHandler);

// Wire batch handler to route internally through the app
setBatchRouter(api);

// Static files from public/ directory
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Landing page
api.get('/', (c) => {
  try {
    const html = readFileSync(join(publicDir, 'index.html'), 'utf-8');
    return c.html(html);
  } catch {
    return c.text('Not found', 404);
  }
});

// Dashboard
api.get('/dashboard', (c) => {
  try {
    const html = readFileSync(join(publicDir, 'dashboard.html'), 'utf-8');
    return c.html(html);
  } catch {
    return c.text('Dashboard not found', 404);
  }
});

// Generic static asset handler for public/ (svg, png, ico, css, js, etc.)
const staticMimeTypes: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  ico: 'image/x-icon',
  css: 'text/css',
  js: 'application/javascript',
  woff: 'font/woff',
  woff2: 'font/woff2',
  webp: 'image/webp',
};
api.get('/:file{[^/]+\\.(svg|png|jpg|jpeg|ico|css|woff|woff2|webp)}', (c) => {
  const filename = c.req.param('file');
  try {
    const ext = filename.split('.').pop() ?? '';
    const content = readFileSync(join(publicDir, filename));
    const mime = staticMimeTypes[ext] ?? 'application/octet-stream';
    return c.body(content.toString('binary'), 200, { 'Content-Type': mime });
  } catch {
    return c.text('Not found', 404);
  }
});

export default api;
