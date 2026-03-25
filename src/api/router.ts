import { Hono } from 'hono';
import { authMiddleware } from './middleware/auth.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import healthHandler from './handlers/health.js';
import projectsHandler from './handlers/projects.js';
import tasksHandler from './handlers/tasks.js';
import activityHandler from './handlers/activity.js';

const api = new Hono();

// Global middleware
api.use('*', requestIdMiddleware);

// Health (no auth required)
api.route('/api/v1/health', healthHandler);

// Auth middleware for protected routes (skip health)
api.use('/api/v1/projects/*', authMiddleware);
api.use('/api/v1/projects', authMiddleware);
api.use('/api/v1/tasks/*', authMiddleware);
api.use('/api/v1/tasks', authMiddleware);
api.use('/api/v1/activity/*', authMiddleware);
api.use('/api/v1/activity', authMiddleware);

// Protected routes
api.route('/api/v1/projects', projectsHandler);
api.route('/api/v1/tasks', tasksHandler);
api.route('/api/v1/activity', activityHandler);

export default api;
