import { Hono } from 'hono';
import { authMiddleware } from './middleware/auth.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { idempotencyMiddleware } from './middleware/idempotency.js';
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

const api = new Hono();

// Global middleware
api.use('*', requestIdMiddleware);

// Health (no auth required)
api.route('/api/v1/health', healthHandler);

// Auth middleware for all protected routes
const protectedRoutes = ['projects', 'tasks', 'deals', 'contacts', 'finances', 'activity', 'search', 'events', 'batch'];
for (const route of protectedRoutes) {
  api.use(`/api/v1/${route}/*`, authMiddleware);
  api.use(`/api/v1/${route}`, authMiddleware);
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

// Wire batch handler to route internally through the app
setBatchRouter(api);

export default api;
