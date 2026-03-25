import { createMiddleware } from 'hono/factory';
import crypto from 'node:crypto';
import { rawDb } from '../../db/connection.js';

export const idempotencyMiddleware = createMiddleware(async (c, next) => {
  // Only applies to POST requests
  if (c.req.method !== 'POST') {
    return next();
  }

  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!idempotencyKey) {
    return next();
  }

  const keyHash = crypto.createHash('sha256').update(idempotencyKey).digest('hex');

  // Check if key already exists and not expired
  const existing = rawDb.prepare(
    "SELECT response, expires_at FROM idempotency_keys WHERE key_hash = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"
  ).get(keyHash) as { response: string; expires_at: string } | undefined;

  if (existing) {
    // Return cached response
    const cached = JSON.parse(existing.response) as { status: number; body: unknown };
    return c.json(cached.body, cached.status as 200 | 201);
  }

  // Process the request
  await next();

  // Cache the response (only for successful 2xx responses)
  const status = c.res.status;
  if (status >= 200 && status < 300) {
    try {
      const body = await c.res.clone().json();
      const responseJson = JSON.stringify({ status, body });

      // Expire in 24 hours
      rawDb.prepare(
        "INSERT OR IGNORE INTO idempotency_keys (key_hash, response, expires_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+24 hours'))"
      ).run(keyHash, responseJson);
    } catch {
      // If we can't cache, that's okay — idempotency is best-effort
    }
  }
});
