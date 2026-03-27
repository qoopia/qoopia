/**
 * Tests for unified auto-status sync pipeline.
 * Verifies that detectAndApplyStatusChanges works correctly across all entry points.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { ulid } from 'ulid';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ── DB schema bootstrap ──

const DB_SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
    api_key_hash TEXT NOT NULL, permissions TEXT DEFAULT '{}', active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', revision INTEGER NOT NULL DEFAULT 1,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_by TEXT
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT NOT NULL, title TEXT NOT NULL,
    description TEXT, status TEXT DEFAULT 'todo', priority TEXT DEFAULT 'medium',
    assignee TEXT, due_date TEXT, tags TEXT DEFAULT '[]', notes TEXT,
    source TEXT DEFAULT 'manual', revision INTEGER DEFAULT 1, deleted_at TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_by TEXT
  );
  CREATE TABLE IF NOT EXISTS deals (
    id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
    address TEXT, status TEXT DEFAULT 'active', asking_price REAL, target_price REAL,
    monthly_rent REAL, metadata TEXT DEFAULT '{}', timeline TEXT DEFAULT '[]',
    tags TEXT DEFAULT '[]', notes TEXT, revision INTEGER DEFAULT 1, deleted_at TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_by TEXT
  );
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT,
    company TEXT, email TEXT, phone TEXT, telegram_id TEXT, language TEXT DEFAULT 'EN',
    timezone TEXT, category TEXT, notes TEXT, tags TEXT DEFAULT '[]',
    revision INTEGER DEFAULT 1, deleted_at TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_by TEXT
  );
  CREATE TABLE IF NOT EXISTS activity (
    id TEXT PRIMARY KEY, workspace_id TEXT, timestamp TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    actor TEXT, action TEXT, entity_type TEXT, entity_id TEXT, project_id TEXT, summary TEXT,
    details TEXT DEFAULT '{}', revision_before INTEGER, revision_after INTEGER
  );
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT, agent_name TEXT,
    text TEXT NOT NULL, project_id TEXT, source TEXT DEFAULT 'mcp',
    matched_entities TEXT DEFAULT '[]', auto_updates TEXT DEFAULT '[]', embedding BLOB,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(title, description, notes, content=tasks, content_rowid=rowid);
  CREATE VIRTUAL TABLE IF NOT EXISTS contacts_fts USING fts5(name, role, company, notes, content=contacts, content_rowid=rowid);
  CREATE VIRTUAL TABLE IF NOT EXISTS deals_fts USING fts5(name, address, notes, content=deals, content_rowid=rowid);
  CREATE VIRTUAL TABLE IF NOT EXISTS activity_fts USING fts5(summary, content=activity, content_rowid=rowid);
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(text, content=notes, content_rowid=rowid);
`;

let db: DatabaseType;
let workspaceId: string;
let agentId: string;
let projectId: string;

// Override the DB path for the module under test before any imports
function setTestDb(testDb: DatabaseType) {
  // Monkey-patch the rawDb export by replacing it in the module cache.
  // vitest doesn't support vi.mock for native ESM modules easily here,
  // so we use a direct approach: set QOOPIA_DB_PATH before the module loads.
}

beforeAll(async () => {
  // Use an in-memory SQLite for tests
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoopia-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  // Set env before importing the module
  process.env.QOOPIA_DB_PATH = dbPath;
  process.env.QOOPIA_DATA_DIR = tmpDir;

  // Create and initialise db
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(DB_SCHEMA);

  // Seed workspace/agent/project
  workspaceId = ulid();
  agentId = ulid();
  projectId = ulid();
  const now = new Date().toISOString().replace(/\.\d{3}Z/, 'Z');

  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, 'Test', 'test')").run(workspaceId);
  db.prepare("INSERT INTO agents (id, workspace_id, name, type, api_key_hash) VALUES (?, ?, 'agent', 'test', 'hash')").run(agentId, workspaceId);
  db.prepare("INSERT INTO projects (id, workspace_id, name) VALUES (?, ?, 'Test Project')").run(projectId, workspaceId);
});

// Helper to insert a task and return its id
function insertTask(title: string, status = 'todo'): string {
  const id = ulid();
  const now = new Date().toISOString().replace(/\.\d{3}Z/, 'Z');
  db.prepare(
    `INSERT INTO tasks (id, project_id, workspace_id, title, status, revision, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(id, projectId, workspaceId, title, status, now, now, agentId);
  return id;
}

function getTaskStatus(taskId: string): string {
  const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string };
  return row.status;
}

// ── Dynamically import the module under test after env is set ──
// We delay the actual import so QOOPIA_DB_PATH is set first.
async function getDetectFn() {
  const mod = await import('../../src/core/intelligence.js');
  return mod.detectAndApplyStatusChanges;
}

// ── Tests ──

describe('auto-status sync: detectAndApplyStatusChanges', () => {

  it('test 1: create_activity + "COMPLETE" → task becomes done', async () => {
    const detectAndApplyStatusChanges = await getDetectFn();
    const taskTitle = `Deploy pipeline ${ulid().slice(0, 8)}`;
    const taskId = insertTask(taskTitle, 'in_progress');

    const result = detectAndApplyStatusChanges(
      `COMPLETE: ${taskTitle} has been deployed successfully.`,
      workspaceId,
      agentId,
      'create_activity',
    );

    expect(result.applied.length).toBeGreaterThanOrEqual(1);
    const match = result.applied.find(a => a.id === taskId);
    expect(match).toBeDefined();
    expect(match?.new_status).toBe('done');
    expect(getTaskStatus(taskId)).toBe('done');
  });

  it('test 2: note + "almost finished" → NOT updated (medium confidence, suggested only)', async () => {
    const detectAndApplyStatusChanges = await getDetectFn();
    // Use a short single-word title that will match on a keyword but not hit high-confidence
    const taskTitle = `Budget review ${ulid().slice(0, 8)}`;
    const taskId = insertTask(taskTitle, 'in_progress');

    // "almost finished" is not in STATUS_PATTERNS → no status detected → no changes at all
    const result = detectAndApplyStatusChanges(
      `I'm almost finished with the budget review document.`,
      workspaceId,
      agentId,
      'note',
    );

    // "almost finished" doesn't match any STATUS_PATTERN, so nothing should be applied
    const autoUpdated = result.applied.find(a => a.id === taskId);
    expect(autoUpdated).toBeUndefined();
    // Status remains unchanged
    expect(getTaskStatus(taskId)).toBe('in_progress');
  });

  it('test 3: report_activity + exact title + "done" → updated (high confidence)', async () => {
    const detectAndApplyStatusChanges = await getDetectFn();
    const taskTitle = `Fix authentication bug ${ulid().slice(0, 8)}`;
    const taskId = insertTask(taskTitle, 'in_progress');

    const result = detectAndApplyStatusChanges(
      `${taskTitle} — done. Merged PR and deployed.`,
      workspaceId,
      agentId,
      'report',
    );

    expect(result.applied.length).toBeGreaterThanOrEqual(1);
    const match = result.applied.find(a => a.id === taskId);
    expect(match).toBeDefined();
    expect(match?.new_status).toBe('done');
    expect(getTaskStatus(taskId)).toBe('done');
  });

  it('test 4: brief → stale_warning present when recent activity suggests completion', async () => {
    const mod = await import('../../src/core/intelligence.js');
    const detectStaleTasks = mod.detectStaleTasks;

    const taskTitle = `Onboard new client ${ulid().slice(0, 8)}`;
    const taskId = insertTask(taskTitle, 'in_progress');

    // Insert a recent note that mentions completion
    const noteId = ulid();
    const now = new Date().toISOString().replace(/\.\d{3}Z/, 'Z');
    // Use first word of title for the LIKE match
    const firstWord = taskTitle.toLowerCase().split(/\s+/)[0];
    db.prepare(
      `INSERT INTO notes (id, workspace_id, agent_id, text, project_id, source, created_at) VALUES (?, ?, ?, ?, ?, 'mcp', ?)`
    ).run(noteId, workspaceId, agentId, `Onboard new client completed successfully, all done.`, projectId, now);

    const tasks = [{ id: taskId, title: taskTitle, status: 'in_progress', updated_at: '2024-01-01T00:00:00Z' }];
    const warnings = detectStaleTasks(tasks, workspaceId);

    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0].task_id).toBe(taskId);
    expect(warnings[0].stale_warning).toMatch(/complete|note|activity/i);
  });

  it('test 5: brief → no stale_warning when no conflicting activity', async () => {
    const mod = await import('../../src/core/intelligence.js');
    const detectStaleTasks = mod.detectStaleTasks;

    const taskTitle = `Write quarterly report ${ulid().slice(0, 8)}`;
    const taskId = insertTask(taskTitle, 'todo');

    // No notes that mention completion for this task
    const tasks = [{ id: taskId, title: taskTitle, status: 'todo', updated_at: new Date().toISOString() }];
    const warnings = detectStaleTasks(tasks, workspaceId);

    const warning = warnings.find(w => w.task_id === taskId);
    expect(warning).toBeUndefined();
  });

  it('test 6: detectAndApplyStatusChanges with source="auto-update" → returns empty (recursion guard)', async () => {
    const detectAndApplyStatusChanges = await getDetectFn();
    const taskTitle = `Recursion guard test ${ulid().slice(0, 8)}`;
    insertTask(taskTitle, 'in_progress');

    const result = detectAndApplyStatusChanges(
      `${taskTitle} completed and done.`,
      workspaceId,
      agentId,
      'auto-update',  // recursion guard source
    );

    expect(result.applied).toEqual([]);
    expect(result.suggested).toEqual([]);
  });

});
