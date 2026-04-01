import { createMiddleware } from 'hono/factory';
import type { AuthContext } from '../../types/index.js';

const READ_LIMIT = 300;   // per minute per API key
const WRITE_LIMIT = 300;  // per minute per API key
const WINDOW_MS = 60_000; // 1 minute

interface RequestRecord {
  timestamp: number;
}

// In-memory sliding window storage: Map<apiKeyId, timestamps[]>
const readWindows = new Map<string, RequestRecord[]>();
const writeWindows = new Map<string, RequestRecord[]>();

function cleanWindow(records: RequestRecord[], now: number): RequestRecord[] {
  const cutoff = now - WINDOW_MS;
  // Find first record within window
  let i = 0;
  while (i < records.length && records[i].timestamp < cutoff) i++;
  return i > 0 ? records.slice(i) : records;
}

function checkLimit(windows: Map<string, RequestRecord[]>, key: string, limit: number, now: number): { allowed: boolean; retryAfter: number; remaining: number } {
  let records = windows.get(key) || [];
  records = cleanWindow(records, now);
  windows.set(key, records);

  if (records.length >= limit) {
    // Calculate when the earliest record expires
    const oldestInWindow = records[0].timestamp;
    const retryAfterMs = (oldestInWindow + WINDOW_MS) - now;
    const retryAfter = Math.ceil(retryAfterMs / 1000);
    return { allowed: false, retryAfter: Math.max(1, retryAfter), remaining: 0 };
  }

  records.push({ timestamp: now });
  return { allowed: true, retryAfter: 0, remaining: limit - records.length };
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const rateLimitMiddleware = createMiddleware<{ Variables: { auth: AuthContext } }>(async (c, next) => {
  const auth = c.get('auth');
  const key = auth.id;
  const method = c.req.method;
  const now = Date.now();

  const isWrite = WRITE_METHODS.has(method);
  const windows = isWrite ? writeWindows : readWindows;
  const limit = isWrite ? WRITE_LIMIT : READ_LIMIT;
  const { allowed, retryAfter, remaining } = checkLimit(windows, key, limit, now);

  // Set rate limit headers
  c.header('X-RateLimit-Limit', String(limit));
  c.header('X-RateLimit-Remaining', String(remaining));

  if (!allowed) {
    c.header('Retry-After', String(retryAfter));
    return c.json({
      error: {
        code: 'RATE_LIMITED',
        message: `${isWrite ? 'Write' : 'Read'} limit exceeded. ${limit} ${isWrite ? 'writes' : 'reads'} per minute per API key.`,
        details: {
          limit,
          window: '1m',
          retry_after_seconds: retryAfter,
        },
      }
    }, 429);
  }

  return next();
});

// For batch operations: count N operations against the write limit
export function countBatchOperations(keyId: string, count: number): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  let records = writeWindows.get(keyId) || [];
  records = cleanWindow(records, now);

  if (records.length + count > WRITE_LIMIT) {
    const oldestInWindow = records.length > 0 ? records[0].timestamp : now;
    const retryAfterMs = (oldestInWindow + WINDOW_MS) - now;
    const retryAfter = Math.ceil(retryAfterMs / 1000);
    writeWindows.set(keyId, records);
    return { allowed: false, retryAfter: Math.max(1, retryAfter) };
  }

  // Add count operations
  for (let i = 0; i < count; i++) {
    records.push({ timestamp: now });
  }
  writeWindows.set(keyId, records);
  return { allowed: true, retryAfter: 0 };
}
