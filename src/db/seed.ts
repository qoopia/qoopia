import crypto from 'node:crypto';
import { ulid } from 'ulid';
import { rawDb } from './connection.js';
import { runMigrations } from './migrate.js';
import { logger } from '../core/logger.js';

runMigrations();

const wsId = ulid();
rawDb.prepare(
  "INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES (?, 'Default', 'default')"
).run(wsId);

logger.info({ workspace_id: wsId }, 'Created workspace: Default');

// Create agents
const agentNames = [
  { name: 'Aidan', type: 'openclaw' },
  { name: 'Alan', type: 'openclaw' },
  { name: 'Aizek', type: 'openclaw' },
];

for (const agent of agentNames) {
  const agentId = ulid();
  const rawKey = `qp_a_${crypto.randomBytes(32).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');

  rawDb.prepare(
    "INSERT INTO agents (id, workspace_id, name, type, api_key_hash, permissions) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(agentId, wsId, agent.name, agent.type, hash, JSON.stringify({ projects: '*', rules: [{ entity: '*', actions: ['read', 'create', 'update', 'delete'] }] }));

  console.log(`\n  Agent: ${agent.name}`);
  console.log(`  API Key: ${rawKey}`);
  console.log(`  (save this — it won't be shown again)`);
}

// Create user
const userId = ulid();
const userKey = `qp_u_${crypto.randomBytes(32).toString('hex')}`;
const userHash = crypto.createHash('sha256').update(userKey).digest('hex');

rawDb.prepare(
  "INSERT INTO users (id, workspace_id, name, email, role, api_key_hash) VALUES (?, ?, 'Askhat', 'askhat.soltanov.1984@gmail.com', 'owner', ?)"
).run(userId, wsId, userHash);

console.log(`\n  User: Askhat (owner)`);
console.log(`  API Key: ${userKey}`);
console.log(`  (save this — it won't be shown again)\n`);

rawDb.close();
logger.info('Seed complete');
