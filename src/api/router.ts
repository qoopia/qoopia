import { Hono } from 'hono';
import { authMiddleware } from './middleware/auth.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import healthHandler from './handlers/health.js';
import projectsHandler from './handlers/projects.js';
import tasksHandler from './handlers/tasks.js';
import dealsHandler from './handlers/deals.js';
import contactsHandler from './handlers/contacts.js';
import financesHandler from './handlers/finances.js';
import activityHandler from './handlers/activity.js';
import searchHandler from './handlers/search.js';

const api = new Hono();

// Global middleware
api.use('*', requestIdMiddleware);

// Health (no auth required)
api.route('/api/v1/health', healthHandler);

// Auth middleware for all protected routes
const protectedRoutes = ['projects', 'tasks', 'deals', 'contacts', 'finances', 'activity', 'search'];
for (const route of protectedRoutes) {
  api.use(`/api/v1/${route}/*`, authMiddleware);
  api.use(`/api/v1/${route}`, authMiddleware);
}

// Protected routes
api.route('/api/v1/projects', projectsHandler);
api.route('/api/v1/tasks', tasksHandler);
api.route('/api/v1/deals', dealsHandler);
api.route('/api/v1/contacts', contactsHandler);
api.route('/api/v1/finances', financesHandler);
api.route('/api/v1/activity', activityHandler);
api.route('/api/v1/search', searchHandler);

export default api;
