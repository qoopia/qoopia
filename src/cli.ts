#!/usr/bin/env node

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { ulid } from 'ulid';

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

const DATA_DIR = process.env.QOOPIA_DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = process.env.QOOPIA_DB_PATH || path.join(DATA_DIR, 'qoopia.db');
const PORT = process.env.PORT || '3000';
const BASE_URL = process.env.QOOPIA_URL || `http://localhost:${PORT}`;

function usage() {
  console.log(`
  qoopia — CLI for Qoopia V2

  Commands:
    status                         Show server & database status
    agent add <name> <type>        Register a new agent (requires user API key)
    agent rotate-key <id>          Rotate an agent's API key
    agent list                     List all agents
    migrate [data-dir]             Run V1 → V2 migration

  Environment variables:
    QOOPIA_API_KEY                 API key for authenticated operations
    QOOPIA_URL                     Server URL (default: http://localhost:3000)
    QOOPIA_DB_PATH                 Database path (for direct DB commands)
    PORT                           Server port (default: 3000)
  `);
}

async function fetchApi(path: string, options: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const apiKey = process.env.QOOPIA_API_KEY;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } catch (err) {
    return { status: 0, body: { error: { message: err instanceof Error ? err.message : String(err) } } };
  }
}

async function status() {
  console.log('Checking Qoopia server...\n');

  const { status, body } = await fetchApi('/api/v1/health');
  if (status === 0 || !body) {
    console.log(`  Server:   OFFLINE (${BASE_URL})`);

    // Try direct DB check
    if (fs.existsSync(DB_PATH)) {
      const stats = fs.statSync(DB_PATH);
      console.log(`  Database: ${DB_PATH} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
    } else {
      console.log(`  Database: not found at ${DB_PATH}`);
    }
    process.exit(1);
  }

  const data = body as Record<string, unknown>;
  const db = data.database as Record<string, unknown> | undefined;

  console.log(`  Server:     ${data.status === 'healthy' ? 'HEALTHY' : 'DEGRADED'}`);
  console.log(`  Version:    ${data.version}`);
  console.log(`  Uptime:     ${formatUptime(data.uptime_seconds as number)}`);
  console.log(`  Database:   ${db?.status || data.database} (${db?.size_mb || '?'} MB)`);
  console.log(`  Disk free:  ${data.disk_free_mb} MB`);
  if (data.litestream) {
    console.log(`  Litestream: ${data.litestream}`);
  }
  console.log(`  Timestamp:  ${data.timestamp}`);
  console.log();
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

async function agentAdd(name: string, type: string) {
  if (!process.env.QOOPIA_API_KEY) {
    console.error('Error: QOOPIA_API_KEY environment variable required (user API key)');
    process.exit(1);
  }

  if (!name || !type) {
    console.error('Usage: qoopia agent add <name> <type>');
    console.error('Types: openclaw, claude, chatgpt, deepseek, custom');
    process.exit(1);
  }

  console.log(`Registering agent "${name}" (${type})...\n`);

  const { status, body } = await fetchApi('/api/v1/agents', {
    method: 'POST',
    body: JSON.stringify({ name, type }),
  });

  if (status === 201) {
    const data = (body as { data: Record<string, unknown> }).data;
    console.log(`  Agent ID:  ${data.id}`);
    console.log(`  Name:      ${data.name}`);
    console.log(`  Type:      ${data.type}`);
    console.log(`  API Key:   ${data.api_key}`);
    console.log(`\n  Save this API key — it will not be shown again.\n`);
  } else {
    const err = body as { error?: { message?: string } };
    console.error(`Error (${status}): ${err?.error?.message || JSON.stringify(body)}`);
    process.exit(1);
  }
}

async function agentRotateKey(agentId: string) {
  if (!process.env.QOOPIA_API_KEY) {
    console.error('Error: QOOPIA_API_KEY environment variable required (user API key)');
    process.exit(1);
  }

  if (!agentId) {
    console.error('Usage: qoopia agent rotate-key <agent-id>');
    process.exit(1);
  }

  console.log(`Rotating key for agent ${agentId}...\n`);

  const { status, body } = await fetchApi(`/api/v1/agents/${agentId}/rotate-key`, {
    method: 'POST',
  });

  if (status === 200) {
    const data = body as Record<string, unknown>;
    console.log(`  New API Key:             ${data.api_key}`);
    console.log(`  Old key valid until:     ${data.previous_key_expires}`);
    console.log(`\n  Save this API key — it will not be shown again.\n`);
  } else {
    const err = body as { error?: { message?: string } };
    console.error(`Error (${status}): ${err?.error?.message || JSON.stringify(body)}`);
    process.exit(1);
  }
}

async function agentList() {
  if (!process.env.QOOPIA_API_KEY) {
    console.error('Error: QOOPIA_API_KEY environment variable required');
    process.exit(1);
  }

  const { status, body } = await fetchApi('/api/v1/agents');

  if (status === 200) {
    const data = (body as { data: Record<string, unknown>[] }).data;
    if (data.length === 0) {
      console.log('No agents registered.');
      return;
    }

    console.log(`\n  Agents (${data.length}):\n`);
    for (const agent of data) {
      const activeStr = agent.active ? 'active' : 'inactive';
      console.log(`  ${agent.id}  ${agent.name} (${agent.type}) [${activeStr}]`);
      if (agent.last_seen) {
        console.log(`    Last seen: ${agent.last_seen}`);
      }
    }
    console.log();
  } else {
    const err = body as { error?: { message?: string } };
    console.error(`Error (${status}): ${err?.error?.message || JSON.stringify(body)}`);
    process.exit(1);
  }
}

async function migrate(dataDir?: string) {
  const dir = dataDir || path.join(process.cwd(), '..', 'stepper', 'data');

  if (!fs.existsSync(dir)) {
    console.error(`Data directory not found: ${dir}`);
    console.error('Usage: qoopia migrate [path/to/v1/data]');
    process.exit(1);
  }

  console.log(`Running V1 → V2 migration from ${dir}...\n`);

  // Run migration via subprocess to avoid import issues
  try {
    const { execSync } = await import('node:child_process');
    execSync(`npx tsx src/migration/import-v1.ts "${dir}"`, {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
  } catch (err) {
    console.error('Migration failed.');
    process.exit(1);
  }
}

// Main router
async function main() {
  if (!command || command === '--help' || command === '-h') {
    usage();
    process.exit(0);
  }

  switch (command) {
    case 'status':
      await status();
      break;

    case 'agent':
      switch (subcommand) {
        case 'add':
          await agentAdd(args[2], args[3]);
          break;
        case 'rotate-key':
          await agentRotateKey(args[2]);
          break;
        case 'list':
          await agentList();
          break;
        default:
          console.error(`Unknown agent subcommand: ${subcommand}`);
          console.error('Available: add, rotate-key, list');
          process.exit(1);
      }
      break;

    case 'migrate':
      await migrate(args[1]);
      break;

    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
