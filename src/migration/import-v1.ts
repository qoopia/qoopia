import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ulid } from 'ulid';
import { rawDb } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { logger } from '../core/logger.js';

const DATA_DIR = process.argv[2] || path.join(process.env.HOME || '', '.openclaw/stepper/data');

if (!fs.existsSync(DATA_DIR)) {
  console.error(`Data directory not found: ${DATA_DIR}`);
  process.exit(1);
}

// ID mapping: old V1 ID → new ULID
const idMap = new Map<string, string>();

function mapId(oldId: string): string {
  if (!idMap.has(oldId)) {
    idMap.set(oldId, ulid());
  }
  return idMap.get(oldId)!;
}

function readJson(filePath: string): unknown[] {
  const full = path.join(DATA_DIR, filePath);
  if (!fs.existsSync(full)) return [];
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function toIsoTimestamp(v: string | undefined | null): string | null {
  if (!v) return null;
  // Already ISO format
  if (v.includes('T')) return v.replace(/\+00:00$/, 'Z').replace(/\.\d+Z$/, 'Z').replace(/\.\d+\+/, '+');
  // Date only (YYYY-MM-DD) → midnight UTC
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00Z`;
  return v;
}

// Map V1 status values to V2 enums
function mapTaskStatus(s: string): string {
  const map: Record<string, string> = {
    'active': 'in_progress',
    'backlog': 'todo',
  };
  return map[s] || s;
}

function generateApiKey(prefix: string): { rawKey: string; hash: string } {
  const rawKey = `${prefix}${crypto.randomBytes(32).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  return { rawKey, hash };
}

// Agent name → agent ID mapping
const agentNameMap = new Map<string, string>();

function main() {
  runMigrations();

  // Check if data already migrated
  const existing = rawDb.prepare('SELECT COUNT(*) as c FROM workspaces').get() as { c: number };
  if (existing.c > 0) {
    console.error('Database already has data. Drop data/qoopia.db first to re-migrate.');
    process.exit(1);
  }

  const migrate = rawDb.transaction(() => {
    // ============================================================
    // 1. Create default workspace
    // ============================================================
    const wsId = ulid();
    rawDb.prepare(
      "INSERT INTO workspaces (id, name, slug) VALUES (?, 'Default', 'default')"
    ).run(wsId);
    logger.info({ workspace_id: wsId }, 'Created workspace: Default');

    // ============================================================
    // 2. Create agents
    // ============================================================
    const agentDefs = [
      { name: 'Aidan', type: 'openclaw', perms: { projects: '*', rules: [{ entity: '*', actions: ['read', 'create', 'update', 'delete'] }] } },
      { name: 'Alan', type: 'openclaw', perms: { projects: ['social'], rules: [{ entity: 'tasks', actions: ['read', 'create', 'update'] }, { entity: 'activity', actions: ['read', 'create'] }] } },
      { name: 'Aizek', type: 'openclaw', perms: { projects: ['happycake-kz'], rules: [{ entity: '*', actions: ['read', 'create', 'update'] }] } },
    ];

    console.log('\n=== API Keys (save these — shown ONCE) ===\n');

    for (const def of agentDefs) {
      const agentId = ulid();
      const { rawKey, hash } = generateApiKey('qp_a_');
      rawDb.prepare(
        'INSERT INTO agents (id, workspace_id, name, type, api_key_hash, permissions) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(agentId, wsId, def.name, def.type, hash, JSON.stringify(def.perms));
      agentNameMap.set(def.name.toLowerCase(), agentId);
      console.log(`  Agent ${def.name}: ${rawKey}`);
    }

    // ============================================================
    // 3. Create user for Askhat
    // ============================================================
    const userId = ulid();
    const { rawKey: userKey, hash: userHash } = generateApiKey('qp_u_');
    rawDb.prepare(
      "INSERT INTO users (id, workspace_id, name, email, role, api_key_hash) VALUES (?, ?, 'Askhat', 'askhat.soltanov.1984@gmail.com', 'owner', ?)"
    ).run(userId, wsId, userHash);
    agentNameMap.set('askhat', userId);
    agentNameMap.set('system', 'system');
    console.log(`  User Askhat: ${userKey}`);
    console.log('');

    // ============================================================
    // 4. Migrate projects
    // ============================================================
    const projects = readJson('projects.json') as Record<string, unknown>[];
    const projectInsert = rawDb.prepare(`
      INSERT INTO projects (id, workspace_id, name, description, status, owner_agent_id, color, tags, settings, revision, created_at, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 1, ?, ?, 'system')
    `);

    for (const p of projects) {
      const newId = mapId(p.id as string);
      const ownerAgent = p.owner_agent ? agentNameMap.get((p.owner_agent as string).toLowerCase()) ?? null : null;
      projectInsert.run(
        newId, wsId,
        p.name as string,
        (p.description as string) || null,
        p.status as string,
        ownerAgent,
        (p.color as string) || null,
        JSON.stringify(p.tags || []),
        toIsoTimestamp(p.created as string) || new Date().toISOString(),
        toIsoTimestamp(p.updated as string) || new Date().toISOString(),
      );
    }
    logger.info({ count: projects.length }, 'Migrated projects');

    // ============================================================
    // 5. Migrate contacts → contacts + contact_projects
    // ============================================================
    const contacts = readJson('contacts.json') as Record<string, unknown>[];
    const contactInsert = rawDb.prepare(`
      INSERT INTO contacts (id, workspace_id, name, role, company, email, phone, telegram_id, language, timezone, category, communication_rules, tags, notes, revision, created_at, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'system')
    `);
    const cpInsert = rawDb.prepare('INSERT INTO contact_projects (contact_id, project_id, role) VALUES (?, ?, NULL)');

    for (const c of contacts) {
      const newId = mapId(c.id as string);
      contactInsert.run(
        newId, wsId,
        c.name as string,
        (c.role as string) || null,
        (c.company as string) || null,
        (c.email as string) || null,
        (c.phone as string) || null,
        (c.telegram_id as string) || null,
        (c.language as string) || 'EN',
        (c.timezone as string) || null,
        (c.category as string) || null,
        (c.communication_rules as string) || null,
        JSON.stringify(c.tags || []),
        (c.notes as string) || null,
        toIsoTimestamp(c.created as string) || new Date().toISOString(),
        toIsoTimestamp(c.updated as string) || new Date().toISOString(),
      );

      // Migrate project_ids → contact_projects join table
      const projectIds = (c.project_ids || []) as string[];
      for (const pid of projectIds) {
        const mappedPid = idMap.get(pid);
        if (mappedPid) {
          cpInsert.run(newId, mappedPid);
        }
      }
    }
    logger.info({ count: contacts.length }, 'Migrated contacts');

    // ============================================================
    // 6. Migrate deals → deals + deal_contacts
    // ============================================================
    const dealDirs = ['flock', 'locations'];
    let dealCount = 0;
    const dealInsert = rawDb.prepare(`
      INSERT INTO deals (id, project_id, workspace_id, name, address, status, asking_price, target_price, monthly_rent, lease_term_months, metadata, documents, timeline, tags, notes, revision, created_at, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'system')
    `);
    const dcInsert = rawDb.prepare('INSERT INTO deal_contacts (deal_id, contact_id, role) VALUES (?, ?, NULL)');

    for (const dir of dealDirs) {
      const deals = readJson(`${dir}/deals.json`) as Record<string, unknown>[];
      for (const d of deals) {
        const newId = mapId(d.id as string);
        const projectNewId = mapId(d.project_id as string);
        const fin = (d.financials || {}) as Record<string, unknown>;

        dealInsert.run(
          newId, projectNewId, wsId,
          d.name as string,
          (d.address as string) || null,
          d.status as string,
          (fin.asking_price as number) ?? null,
          (fin.target_price as number) ?? null,
          // Handle monthly_rent or monthly_rent_min/max
          (fin.monthly_rent as number) ?? (fin.monthly_rent_min as number) ?? null,
          (fin.lease_term_months as number) ?? null,
          // Store remaining financials in metadata
          JSON.stringify(fin),
          JSON.stringify(d.documents || []),
          JSON.stringify(d.timeline || []),
          JSON.stringify(d.tags || []),
          (d.notes as string) || null,
          toIsoTimestamp(d.created as string) || new Date().toISOString(),
          toIsoTimestamp(d.updated as string) || new Date().toISOString(),
        );

        // Migrate contacts → deal_contacts join table
        const contactIds = (d.contacts || []) as string[];
        for (const cid of contactIds) {
          const mappedCid = idMap.get(cid);
          if (mappedCid) {
            dcInsert.run(newId, mappedCid);
          }
        }

        dealCount++;
      }
    }
    logger.info({ count: dealCount }, 'Migrated deals');

    // ============================================================
    // 7. Migrate tasks (per project directory)
    // ============================================================
    const taskDirs = ['flock', 'happycake-kz', 'locations', 'markets', 'social', 'openclaw'];
    const taskFiles = ['tasks.json', 'launch-tasks.json']; // openclaw has launch-tasks.json too
    let taskCount = 0;
    const taskInsert = rawDb.prepare(`
      INSERT INTO tasks (id, project_id, workspace_id, title, description, status, priority, assignee, due_date, blocked_by, parent_id, source, tags, notes, attachments, revision, created_at, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'system')
    `);

    for (const dir of taskDirs) {
      for (const file of taskFiles) {
        const tasks = readJson(`${dir}/${file}`) as Record<string, unknown>[];
        const projectNewId = mapId(dir);

        for (const t of tasks) {
          const newId = mapId(t.id as string);
          const status = mapTaskStatus(t.status as string);
          const assigneeRaw = (t.assignee as string) || null;
          // Map agent names to ULIDs, keep contact IDs mapped
          const assignee = assigneeRaw
            ? (agentNameMap.get(assigneeRaw.toLowerCase()) || (idMap.get(assigneeRaw) ?? assigneeRaw))
            : null;

          const blockedBy = ((t.blocked_by || []) as string[]).map(bid => mapId(bid));
          const parentId = t.parent_id ? mapId(t.parent_id as string) : null;
          const dueDate = (t.due_date as string) || null;

          taskInsert.run(
            newId, projectNewId, wsId,
            t.title as string,
            (t.description as string) || null,
            status,
            (t.priority as string) || 'medium',
            assignee,
            dueDate && dueDate.length > 0 ? dueDate : null,
            JSON.stringify(blockedBy),
            parentId,
            (t.source as string) || 'import',
            JSON.stringify(t.tags || []),
            (t.notes as string) || null,
            JSON.stringify(t.attachments || []),
            toIsoTimestamp(t.created as string) || new Date().toISOString(),
            toIsoTimestamp(t.updated as string) || new Date().toISOString(),
          );

          taskCount++;
        }
      }
    }
    logger.info({ count: taskCount }, 'Migrated tasks');

    // ============================================================
    // 8. Migrate finances
    // ============================================================
    const finances = readJson('finances.json') as Record<string, unknown>[];
    const financeInsert = rawDb.prepare(`
      INSERT INTO finances (id, workspace_id, project_id, type, name, amount, currency, recurring, status, tags, notes, revision, created_at, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'system')
    `);

    for (const f of finances) {
      const newId = mapId(f.id as string);
      const projectNewId = f.project_id ? (idMap.get(f.project_id as string) ?? null) : null;

      financeInsert.run(
        newId, wsId, projectNewId,
        f.type as string,
        f.name as string,
        f.amount as number,
        (f.currency as string) || 'USD',
        (f.recurring as string) || 'none',
        (f.status as string) || 'active',
        JSON.stringify(f.tags || []),
        (f.notes as string) || null,
        toIsoTimestamp(f.created as string) || new Date().toISOString(),
        toIsoTimestamp(f.updated as string) || new Date().toISOString(),
      );
    }
    logger.info({ count: finances.length }, 'Migrated finances');

    // ============================================================
    // 9. Migrate activity log (preserve timestamps)
    // ============================================================
    // Root activity + per-project activity
    const activityFiles = ['activity.json', 'openclaw/activity.json'];
    let activityCount = 0;
    const activityInsert = rawDb.prepare(`
      INSERT INTO activity (id, workspace_id, timestamp, actor, action, entity_type, entity_id, project_id, summary, details, revision_before, revision_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', NULL, NULL)
    `);
    const seenActivityIds = new Set<string>();

    for (const file of activityFiles) {
      const entries = readJson(file) as Record<string, unknown>[];
      for (const a of entries) {
        const newId = mapId(a.id as string);
        if (seenActivityIds.has(newId)) continue;
        seenActivityIds.add(newId);

        const actorRaw = (a.actor as string) || 'system';
        const actor = agentNameMap.get(actorRaw.toLowerCase()) || actorRaw;
        const entityId = a.entity_id ? (idMap.get(a.entity_id as string) ?? (a.entity_id as string)) : null;
        const projectId = a.project_id ? (idMap.get(a.project_id as string) ?? null) : null;

        activityInsert.run(
          newId, wsId,
          toIsoTimestamp(a.timestamp as string) || new Date().toISOString(),
          actor,
          a.action as string,
          a.entity_type as string,
          entityId,
          projectId,
          a.summary as string,
        );

        activityCount++;
      }
    }
    logger.info({ count: activityCount }, 'Migrated activity');

    // ============================================================
    // 10. Validate row counts
    // ============================================================
    const expectedCounts: [string, number][] = [
      ['projects', projects.length],
      ['contacts', contacts.length],
      ['finances', finances.length],
      ['tasks', taskCount],
      ['deals', dealCount],
    ];

    console.log('\n=== Validation ===\n');
    let valid = true;
    for (const [table, expected] of expectedCounts) {
      const actual = (rawDb.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
      const status = actual === expected ? 'OK' : 'MISMATCH';
      if (status === 'MISMATCH') valid = false;
      console.log(`  ${table}: ${actual}/${expected} ${status}`);
    }

    // Join table counts
    const cpCount = (rawDb.prepare('SELECT COUNT(*) as c FROM contact_projects').get() as { c: number }).c;
    const dcCount = (rawDb.prepare('SELECT COUNT(*) as c FROM deal_contacts').get() as { c: number }).c;
    console.log(`  contact_projects: ${cpCount} rows`);
    console.log(`  deal_contacts: ${dcCount} rows`);
    console.log(`  activity: ${activityCount} rows`);
    console.log(`  ID mappings: ${idMap.size} entries`);
    console.log(`\n  Migration ${valid ? 'PASSED' : 'FAILED — check mismatches above'}`);
    console.log('  V1 JSON files are now read-only archive (not deleted).\n');
  });

  migrate();
  rawDb.close();
}

main();
