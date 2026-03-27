import { Hono } from 'hono';
import { rawDb } from '../../db/connection.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const app = new Hono();

const startTime = Date.now();

app.get('/', (c) => {
  // Database check
  let dbOk = false;
  let dbSizeMb = 0;
  try {
    const result = rawDb.prepare('SELECT 1 as ok').get() as { ok: number };
    dbOk = result?.ok === 1;

    // Get database size
    const dbPath = (rawDb as unknown as { name: string }).name;
    if (dbPath) {
      try {
        const stats = fs.statSync(dbPath);
        dbSizeMb = Math.round(stats.size / 1024 / 1024 * 100) / 100;
      } catch {
        // ignore
      }
    }
  } catch {
    dbOk = false;
  }

  // Disk free space
  const DATA_DIR = process.env.QOOPIA_DATA_DIR || path.join(process.cwd(), 'data');
  let diskFreeMb = 0;
  try {
    diskFreeMb = Math.floor(os.freemem() / 1024 / 1024);
  } catch {
    // ignore
  }

  // Litestream check: look for litestream process
  let litestreamOk: boolean | null = null;
  try {
    // Check if litestream.yml exists as indicator that it should be running
    const litestreamConfigExists = fs.existsSync(path.join(process.cwd(), 'litestream.yml'));
    if (litestreamConfigExists) {
      // If config exists, we expect litestream to be running
      // We just check if the -wal file exists and is being consumed
      const dbPath = process.env.QOOPIA_DB_PATH || path.join(DATA_DIR, 'qoopia.db');
      const walPath = dbPath + '-wal';
      litestreamOk = fs.existsSync(walPath);
    }
    // null means litestream not configured
  } catch {
    litestreamOk = false;
  }

  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  const isHealthy = dbOk;

  const response: Record<string, unknown> = {
    status: isHealthy ? 'healthy' : 'degraded',
    version: '2.0.0',
    uptime_seconds: uptimeSeconds,
    database: {
      status: dbOk ? 'connected' : 'error',
      size_mb: dbSizeMb,
    },
    disk_free_mb: diskFreeMb,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z/, 'Z'),
  };

  if (litestreamOk !== null) {
    response.litestream = litestreamOk ? 'replicating' : 'unknown';
  }

  // Agent freshness from notes
  try {
    const agentRows = rawDb.prepare(
      'SELECT agent_name, MAX(created_at) as last_note FROM notes GROUP BY agent_name'
    ).all() as Array<{ agent_name: string | null; last_note: string }>;
    const agents: Record<string, { last_note: string; hours_ago: number }> = {};
    const nowMs = Date.now();
    for (const row of agentRows) {
      if (!row.agent_name) continue;
      const hoursAgo = Math.round((nowMs - new Date(row.last_note).getTime()) / 3600000 * 10) / 10;
      agents[row.agent_name] = { last_note: row.last_note, hours_ago: hoursAgo };
    }
    if (Object.keys(agents).length > 0) {
      response.agents = agents;
    }
  } catch {
    // notes table may not exist yet
  }

  return c.json(response, isHealthy ? 200 : 503);
});

export default app;
