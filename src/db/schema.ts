import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

const utcNow = sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`;

// ============================================================
// Workspaces (multi-tenant isolation)
// ============================================================
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  settings: text('settings').default('{}'),
  created_at: text('created_at').notNull().default(utcNow),
  updated_at: text('updated_at').notNull().default(utcNow),
});

// ============================================================
// Users (humans)
// ============================================================
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  email: text('email').unique(),
  role: text('role').notNull().default('member'),
  api_key_hash: text('api_key_hash'),
  last_seen: text('last_seen'),
  created_at: text('created_at').notNull().default(utcNow),
});

// ============================================================
// Magic Links
// ============================================================
export const magicLinks = sqliteTable('magic_links', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull().references(() => users.id),
  token_hash: text('token_hash').notNull(),
  expires_at: text('expires_at').notNull(),
  used_at: text('used_at'),
  created_at: text('created_at').notNull().default(utcNow),
}, (table) => [
  index('idx_magic_links_user').on(table.user_id),
  index('idx_magic_links_token').on(table.token_hash),
]);

// ============================================================
// Agents (AI systems)
// ============================================================
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  type: text('type').notNull(),
  api_key_hash: text('api_key_hash').notNull(),
  key_rotated_at: text('key_rotated_at'),
  previous_key_hash: text('previous_key_hash'),
  previous_key_expires: text('previous_key_expires'),
  permissions: text('permissions').default('{}'),
  metadata: text('metadata').default('{}'),
  last_seen: text('last_seen'),
  active: integer('active').default(1),
  created_at: text('created_at').notNull().default(utcNow),
}, (table) => [
  index('idx_agents_workspace').on(table.workspace_id),
]);

// ============================================================
// Projects
// ============================================================
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull().default('active'),
  owner_agent_id: text('owner_agent_id').references(() => agents.id),
  color: text('color'),
  tags: text('tags').default('[]'),
  settings: text('settings').default('{}'),
  revision: integer('revision').notNull().default(1),
  deleted_at: text('deleted_at'),
  created_at: text('created_at').notNull().default(utcNow),
  updated_at: text('updated_at').notNull().default(utcNow),
  updated_by: text('updated_by'),
}, (table) => [
  index('idx_projects_workspace').on(table.workspace_id),
  index('idx_projects_updated').on(table.updated_at),
]);

// ============================================================
// Tasks
// ============================================================
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  project_id: text('project_id').notNull().references(() => projects.id),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').notNull().default('todo'),
  priority: text('priority').default('medium'),
  assignee: text('assignee'),
  due_date: text('due_date'),
  blocked_by: text('blocked_by').default('[]'),
  parent_id: text('parent_id'),
  source: text('source').default('manual'),
  tags: text('tags').default('[]'),
  notes: text('notes'),
  attachments: text('attachments').default('[]'),
  revision: integer('revision').notNull().default(1),
  deleted_at: text('deleted_at'),
  created_at: text('created_at').notNull().default(utcNow),
  updated_at: text('updated_at').notNull().default(utcNow),
  updated_by: text('updated_by'),
}, (table) => [
  index('idx_tasks_project').on(table.project_id),
  index('idx_tasks_workspace').on(table.workspace_id, table.status),
  index('idx_tasks_assignee').on(table.assignee),
  index('idx_tasks_due').on(table.due_date),
  index('idx_tasks_updated').on(table.updated_at),
]);

// ============================================================
// Deals
// ============================================================
export const deals = sqliteTable('deals', {
  id: text('id').primaryKey(),
  project_id: text('project_id').notNull().references(() => projects.id),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  address: text('address'),
  status: text('status').notNull().default('active'),
  asking_price: real('asking_price'),
  target_price: real('target_price'),
  monthly_rent: real('monthly_rent'),
  lease_term_months: integer('lease_term_months'),
  metadata: text('metadata').default('{}'),
  documents: text('documents').default('[]'),
  timeline: text('timeline').default('[]'),
  tags: text('tags').default('[]'),
  notes: text('notes'),
  revision: integer('revision').notNull().default(1),
  deleted_at: text('deleted_at'),
  created_at: text('created_at').notNull().default(utcNow),
  updated_at: text('updated_at').notNull().default(utcNow),
  updated_by: text('updated_by'),
}, (table) => [
  index('idx_deals_project').on(table.project_id),
  index('idx_deals_workspace').on(table.workspace_id),
  index('idx_deals_updated').on(table.updated_at),
]);

// ============================================================
// Contacts
// ============================================================
export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  role: text('role'),
  company: text('company'),
  email: text('email'),
  phone: text('phone'),
  telegram_id: text('telegram_id'),
  language: text('language').default('EN'),
  timezone: text('timezone'),
  category: text('category'),
  communication_rules: text('communication_rules'),
  tags: text('tags').default('[]'),
  notes: text('notes'),
  revision: integer('revision').notNull().default(1),
  deleted_at: text('deleted_at'),
  created_at: text('created_at').notNull().default(utcNow),
  updated_at: text('updated_at').notNull().default(utcNow),
  updated_by: text('updated_by'),
}, (table) => [
  index('idx_contacts_workspace').on(table.workspace_id),
  index('idx_contacts_updated').on(table.updated_at),
]);

// ============================================================
// Finances
// ============================================================
export const finances = sqliteTable('finances', {
  id: text('id').primaryKey(),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  project_id: text('project_id').references(() => projects.id),
  type: text('type').notNull(),
  name: text('name').notNull(),
  amount: real('amount').notNull(),
  currency: text('currency').default('USD'),
  recurring: text('recurring').default('none'),
  status: text('status').default('active'),
  tags: text('tags').default('[]'),
  notes: text('notes'),
  revision: integer('revision').notNull().default(1),
  deleted_at: text('deleted_at'),
  created_at: text('created_at').notNull().default(utcNow),
  updated_at: text('updated_at').notNull().default(utcNow),
  updated_by: text('updated_by'),
}, (table) => [
  index('idx_finances_workspace').on(table.workspace_id),
  index('idx_finances_updated').on(table.updated_at),
]);

// ============================================================
// Join Tables
// ============================================================
export const contactProjects = sqliteTable('contact_projects', {
  contact_id: text('contact_id').notNull().references(() => contacts.id),
  project_id: text('project_id').notNull().references(() => projects.id),
  role: text('role'),
}, (table) => [
  primaryKey({ columns: [table.contact_id, table.project_id] }),
  index('idx_contact_projects_project').on(table.project_id),
]);

export const dealContacts = sqliteTable('deal_contacts', {
  deal_id: text('deal_id').notNull().references(() => deals.id),
  contact_id: text('contact_id').notNull().references(() => contacts.id),
  role: text('role'),
}, (table) => [
  primaryKey({ columns: [table.deal_id, table.contact_id] }),
  index('idx_deal_contacts_contact').on(table.contact_id),
]);

// ============================================================
// Activity Log (append-only audit trail)
// ============================================================
export const activity = sqliteTable('activity', {
  id: text('id').primaryKey(),
  workspace_id: text('workspace_id').notNull(),
  timestamp: text('timestamp').notNull().default(utcNow),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entity_type: text('entity_type').notNull(),
  entity_id: text('entity_id'),
  project_id: text('project_id'),
  summary: text('summary').notNull(),
  details: text('details').default('{}'),
  revision_before: integer('revision_before'),
  revision_after: integer('revision_after'),
}, (table) => [
  index('idx_activity_workspace').on(table.workspace_id, table.timestamp),
  index('idx_activity_entity').on(table.entity_type, table.entity_id),
  index('idx_activity_timestamp').on(table.timestamp),
]);

// ============================================================
// Activity Archive
// ============================================================
export const activityArchive = sqliteTable('activity_archive', {
  id: text('id').primaryKey(),
  workspace_id: text('workspace_id').notNull(),
  timestamp: text('timestamp').notNull(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entity_type: text('entity_type').notNull(),
  entity_id: text('entity_id'),
  project_id: text('project_id'),
  summary: text('summary').notNull(),
  details: text('details').default('{}'),
  revision_before: integer('revision_before'),
  revision_after: integer('revision_after'),
}, (table) => [
  index('idx_activity_archive_workspace').on(table.workspace_id, table.timestamp),
]);

// ============================================================
// Idempotency Keys
// ============================================================
export const idempotencyKeys = sqliteTable('idempotency_keys', {
  key_hash: text('key_hash').primaryKey(),
  response: text('response').notNull(),
  created_at: text('created_at').notNull().default(utcNow),
  expires_at: text('expires_at').notNull(),
}, (table) => [
  index('idx_idempotency_expires').on(table.expires_at),
]);

// ============================================================
// Webhook Dead Letters
// ============================================================
export const webhookDeadLetters = sqliteTable('webhook_dead_letters', {
  id: text('id').primaryKey(),
  webhook_url: text('webhook_url').notNull(),
  payload: text('payload').notNull(),
  attempts: integer('attempts').notNull().default(0),
  last_attempt_at: text('last_attempt_at'),
  last_error: text('last_error'),
  created_at: text('created_at').notNull().default(utcNow),
}, (table) => [
  index('idx_dead_letters_created').on(table.created_at),
]);

// ============================================================
// Schema Versions
// ============================================================
export const schemaVersions = sqliteTable('schema_versions', {
  version: integer('version').primaryKey(),
  applied_at: text('applied_at').notNull().default(utcNow),
  description: text('description'),
});
