import { rawDb } from './connection.js';
import { logger } from '../core/logger.js';

const CURRENT_VERSION = 1;

export function runMigrations() {
  const currentVersion = rawDb.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_versions'"
  ).get();

  if (!currentVersion) {
    logger.info('Running initial migration...');
    rawDb.exec(MIGRATION_001);
    rawDb.prepare('INSERT INTO schema_versions (version, description) VALUES (?, ?)').run(
      1,
      'Initial schema with all tables, indexes, FTS5, and triggers'
    );
    logger.info('Migration 001 applied');
  } else {
    const latest = rawDb.prepare('SELECT MAX(version) as v FROM schema_versions').get() as { v: number };
    if (latest.v >= CURRENT_VERSION) {
      logger.info({ version: latest.v }, 'Database schema up to date');
      return;
    }
  }
}

const MIGRATION_001 = `
-- ============================================================
-- Core Tables
-- ============================================================
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  settings TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'member',
  api_key_hash TEXT,
  last_seen TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS magic_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_magic_links_user ON magic_links(user_id) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_magic_links_token ON magic_links(token_hash) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  key_rotated_at TEXT,
  previous_key_hash TEXT,
  previous_key_expires TEXT,
  permissions TEXT DEFAULT '{}',
  metadata TEXT DEFAULT '{}',
  last_seen TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  owner_agent_id TEXT REFERENCES agents(id),
  color TEXT,
  tags TEXT DEFAULT '[]',
  settings TEXT DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT DEFAULT 'medium',
  assignee TEXT,
  due_date TEXT,
  blocked_by TEXT DEFAULT '[]',
  parent_id TEXT REFERENCES tasks(id),
  source TEXT DEFAULT 'manual',
  tags TEXT DEFAULT '[]',
  notes TEXT,
  attachments TEXT DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  asking_price REAL,
  target_price REAL,
  monthly_rent REAL,
  lease_term_months INTEGER,
  metadata TEXT DEFAULT '{}',
  documents TEXT DEFAULT '[]',
  timeline TEXT DEFAULT '[]',
  tags TEXT DEFAULT '[]',
  notes TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  role TEXT,
  company TEXT,
  email TEXT,
  phone TEXT,
  telegram_id TEXT,
  language TEXT DEFAULT 'EN',
  timezone TEXT,
  category TEXT,
  communication_rules TEXT,
  tags TEXT DEFAULT '[]',
  notes TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS finances (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT REFERENCES projects(id),
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'USD',
  recurring TEXT DEFAULT 'none',
  status TEXT DEFAULT 'active',
  tags TEXT DEFAULT '[]',
  notes TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by TEXT
);

-- Join Tables
CREATE TABLE IF NOT EXISTS contact_projects (
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  role TEXT,
  PRIMARY KEY (contact_id, project_id)
);

CREATE TABLE IF NOT EXISTS deal_contacts (
  deal_id TEXT NOT NULL REFERENCES deals(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  role TEXT,
  PRIMARY KEY (deal_id, contact_id)
);

-- Activity Log
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  project_id TEXT,
  summary TEXT NOT NULL,
  details TEXT DEFAULT '{}',
  revision_before INTEGER,
  revision_after INTEGER
);

CREATE TABLE IF NOT EXISTS activity_archive (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  project_id TEXT,
  summary TEXT NOT NULL,
  details TEXT DEFAULT '{}',
  revision_before INTEGER,
  revision_after INTEGER
);

-- Idempotency Keys
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key_hash TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at TEXT NOT NULL
);

-- Webhook Dead Letters
CREATE TABLE IF NOT EXISTS webhook_dead_letters (
  id TEXT PRIMARY KEY,
  webhook_url TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Schema Versions
CREATE TABLE IF NOT EXISTS schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  description TEXT
);

-- ============================================================
-- Performance Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id) WHERE deleted_at IS NULL AND status != 'cancelled';
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee) WHERE status IN ('todo','in_progress','waiting') AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date) WHERE status IN ('todo','in_progress','waiting') AND due_date IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_deals_project ON deals(project_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_workspace ON deals(workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_updated ON deals(updated_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_workspace ON contacts(workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_updated ON contacts(updated_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_finances_workspace ON finances(workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_finances_updated ON finances(updated_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_activity_workspace ON activity(workspace_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity(timestamp);

CREATE INDEX IF NOT EXISTS idx_activity_archive_workspace ON activity_archive(workspace_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id) WHERE active = 1;

CREATE INDEX IF NOT EXISTS idx_contact_projects_project ON contact_projects(project_id);
CREATE INDEX IF NOT EXISTS idx_deal_contacts_contact ON deal_contacts(contact_id);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);
CREATE INDEX IF NOT EXISTS idx_dead_letters_created ON webhook_dead_letters(created_at);

-- ============================================================
-- FTS5 Virtual Tables
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(title, description, notes, content=tasks, content_rowid=rowid);
CREATE VIRTUAL TABLE IF NOT EXISTS contacts_fts USING fts5(name, role, company, notes, content=contacts, content_rowid=rowid);
CREATE VIRTUAL TABLE IF NOT EXISTS deals_fts USING fts5(name, address, notes, content=deals, content_rowid=rowid);
CREATE VIRTUAL TABLE IF NOT EXISTS activity_fts USING fts5(summary, content=activity, content_rowid=rowid);

-- ============================================================
-- FTS5 Sync Triggers (ALL 12)
-- ============================================================

-- TASKS FTS TRIGGERS (3)
CREATE TRIGGER IF NOT EXISTS tasks_fts_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, title, description, notes)
  VALUES (new.rowid, new.title, new.description, new.notes);
END;

CREATE TRIGGER IF NOT EXISTS tasks_fts_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description, notes)
  VALUES ('delete', old.rowid, old.title, old.description, old.notes);
END;

CREATE TRIGGER IF NOT EXISTS tasks_fts_au AFTER UPDATE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description, notes)
  VALUES ('delete', old.rowid, old.title, old.description, old.notes);
  INSERT INTO tasks_fts(rowid, title, description, notes)
  VALUES (new.rowid, new.title, new.description, new.notes);
END;

-- CONTACTS FTS TRIGGERS (3)
CREATE TRIGGER IF NOT EXISTS contacts_fts_ai AFTER INSERT ON contacts BEGIN
  INSERT INTO contacts_fts(rowid, name, role, company, notes)
  VALUES (new.rowid, new.name, new.role, new.company, new.notes);
END;

CREATE TRIGGER IF NOT EXISTS contacts_fts_ad AFTER DELETE ON contacts BEGIN
  INSERT INTO contacts_fts(contacts_fts, rowid, name, role, company, notes)
  VALUES ('delete', old.rowid, old.name, old.role, old.company, old.notes);
END;

CREATE TRIGGER IF NOT EXISTS contacts_fts_au AFTER UPDATE ON contacts BEGIN
  INSERT INTO contacts_fts(contacts_fts, rowid, name, role, company, notes)
  VALUES ('delete', old.rowid, old.name, old.role, old.company, old.notes);
  INSERT INTO contacts_fts(rowid, name, role, company, notes)
  VALUES (new.rowid, new.name, new.role, new.company, new.notes);
END;

-- DEALS FTS TRIGGERS (3)
CREATE TRIGGER IF NOT EXISTS deals_fts_ai AFTER INSERT ON deals BEGIN
  INSERT INTO deals_fts(rowid, name, address, notes)
  VALUES (new.rowid, new.name, new.address, new.notes);
END;

CREATE TRIGGER IF NOT EXISTS deals_fts_ad AFTER DELETE ON deals BEGIN
  INSERT INTO deals_fts(deals_fts, rowid, name, address, notes)
  VALUES ('delete', old.rowid, old.name, old.address, old.notes);
END;

CREATE TRIGGER IF NOT EXISTS deals_fts_au AFTER UPDATE ON deals BEGIN
  INSERT INTO deals_fts(deals_fts, rowid, name, address, notes)
  VALUES ('delete', old.rowid, old.name, old.address, old.notes);
  INSERT INTO deals_fts(rowid, name, address, notes)
  VALUES (new.rowid, new.name, new.address, new.notes);
END;

-- ACTIVITY FTS TRIGGERS (3)
CREATE TRIGGER IF NOT EXISTS activity_fts_ai AFTER INSERT ON activity BEGIN
  INSERT INTO activity_fts(rowid, summary)
  VALUES (new.rowid, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS activity_fts_ad AFTER DELETE ON activity BEGIN
  INSERT INTO activity_fts(activity_fts, rowid, summary)
  VALUES ('delete', old.rowid, old.summary);
END;

CREATE TRIGGER IF NOT EXISTS activity_fts_au AFTER UPDATE ON activity BEGIN
  INSERT INTO activity_fts(activity_fts, rowid, summary)
  VALUES ('delete', old.rowid, old.summary);
  INSERT INTO activity_fts(rowid, summary)
  VALUES (new.rowid, new.summary);
END;
`;
