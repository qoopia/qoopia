import { Hono } from 'hono';
import type { AuthContext } from '../../types/index.js';

const app = new Hono<{ Variables: { auth: AuthContext } }>();

interface BatchOperation {
  method: string;
  path: string;
  body?: unknown;
}

// The main Hono app is passed in so we can route internally
let _rootApp: { fetch: (request: Request) => Promise<Response> } | null = null;

export function setBatchRouter(rootApp: { fetch: (request: Request) => Promise<Response> }) {
  _rootApp = rootApp;
}

app.post('/', async (c) => {
  if (!_rootApp) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Batch router not configured' } }, 500);
  }

  const body = await c.req.json();
  const operations = body.operations as BatchOperation[] | undefined;

  if (!Array.isArray(operations) || operations.length === 0) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'operations array is required and must not be empty' }
    }, 400);
  }

  if (operations.length > 20) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'Maximum 20 operations per batch' }
    }, 400);
  }

  const authHeader = c.req.header('Authorization') || '';
  const results: { status: number; body: unknown }[] = [];

  for (const op of operations) {
    if (!op.method || !op.path) {
      results.push({
        status: 400,
        body: { error: { code: 'VALIDATION_ERROR', message: 'Each operation requires method and path' } },
      });
      continue;
    }

    // Construct internal request
    const url = new URL(op.path, `http://localhost`);
    const headers: Record<string, string> = {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
    };

    const init: RequestInit = {
      method: op.method.toUpperCase(),
      headers,
    };

    if (op.body && ['POST', 'PUT', 'PATCH'].includes(init.method as string)) {
      init.body = JSON.stringify(op.body);
    }

    try {
      const request = new Request(url.toString(), init);
      const response = await _rootApp.fetch(request);
      let responseBody: unknown = null;

      if (response.status !== 204) {
        try {
          responseBody = await response.json();
        } catch {
          responseBody = null;
        }
      }

      results.push({ status: response.status, body: responseBody });
    } catch (err) {
      results.push({
        status: 500,
        body: { error: { code: 'INTERNAL_ERROR', message: 'Operation failed' } },
      });
    }
  }

  return c.json({ results });
});

export default app;
