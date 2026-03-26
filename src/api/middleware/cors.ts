import { createMiddleware } from 'hono/factory';

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim());

export const corsMiddleware = createMiddleware(async (c, next) => {
  const origin = c.req.header('Origin') || '';

  // Determine if origin is allowed
  let allowOrigin = '';
  if (ALLOWED_ORIGINS.includes('*')) {
    allowOrigin = '*';
  } else if (ALLOWED_ORIGINS.includes(origin)) {
    allowOrigin = origin;
  }

  // Handle preflight
  if (c.req.method === 'OPTIONS') {
    c.header('Access-Control-Allow-Origin', allowOrigin || ALLOWED_ORIGINS[0] || '*');
    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, X-Request-ID');
    c.header('Access-Control-Max-Age', '86400');
    if (allowOrigin && allowOrigin !== '*') {
      c.header('Access-Control-Allow-Credentials', 'true');
    }
    return c.body(null, 204);
  }

  // Set CORS headers for actual requests
  if (allowOrigin) {
    c.header('Access-Control-Allow-Origin', allowOrigin);
    c.header('Access-Control-Expose-Headers', 'X-Request-ID, X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After');
    if (allowOrigin !== '*') {
      c.header('Access-Control-Allow-Credentials', 'true');
    }
  }

  return next();
});
