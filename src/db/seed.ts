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
  console.log(`  API Key: ${rawKey.slice(0, 10)}...${rawKey.slice(-4)}`);
  console.log(`  (save the full key from your secure config — it won't be shown again)`);
}

// Create user
const userId = ulid();
const userKey = `qp_u_${crypto.randomBytes(32).toString('hex')}`;
const userHash = crypto.createHash('sha256').update(userKey).digest('hex');

const seedUserName = process.env.QOOPIA_SEED_USER_NAME || 'Admin';
const seedUserEmail = process.env.QOOPIA_SEED_USER_EMAIL || 'admin@localhost';

rawDb.prepare(
  "INSERT INTO users (id, workspace_id, name, email, role, api_key_hash) VALUES (?, ?, ?, ?, 'owner', ?)"
).run(userId, wsId, seedUserName, seedUserEmail, userHash);

console.log(`\n  User: ${seedUserName} (owner)`);
console.log(`  API Key: ${userKey.slice(0, 10)}...${userKey.slice(-4)}`);
console.log(`  (save the full key from your secure config — it won't be shown again)\n`);

rawDb.close();
logger.info('Seed complete');
