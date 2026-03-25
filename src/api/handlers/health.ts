import { Hono } from 'hono';
import { rawDb } from '../../db/connection.js';
import os from 'node:os';

const app = new Hono();

const startTime = Date.now();

app.get('/', (c) => {
  let dbOk = false;
  try {
    const result = rawDb.prepare('SELECT 1 as ok').get() as { ok: number };
    dbOk = result?.ok === 1;
  } catch {
    dbOk = false;
  }

  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

  return c.json({
    status: dbOk ? 'healthy' : 'degraded',
    version: '2.0.0',
    uptime_seconds: uptimeSeconds,
    database: dbOk ? 'connected' : 'error',
    disk_free_mb: Math.floor(os.freemem() / 1024 / 1024),
    timestamp: new Date().toISOString().replace(/\.\d{3}Z/, 'Z'),
  });
});

export default app;
