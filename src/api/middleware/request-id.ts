import { createMiddleware } from 'hono/factory';
import { ulid } from 'ulid';
import { logger } from '../../core/logger.js';

export const requestIdMiddleware = createMiddleware(async (c, next) => {
  const requestId = ulid();
  c.set('requestId', requestId);

  const start = Date.now();
  await next();
  const duration = Date.now() - start;

  logger.info({
    request_id: requestId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration_ms: duration,
  });
});
