# 01 — Data migration: V2 → V3.0

**Базис**: Phase 2 07-migration-map.md Group 1 (schema migration) + Phase 3 01-schema.md (V3 DDL)

**Это executable spec**. Bun-based script `scripts/migrate-from-v2.ts` реализуется в Phase 5 по этому документу **буквально**.

## Входные данные

**Source**: `~/.openclaw/qoopia/data/qoopia.db` (V2, SQLite, read-only)

Объёмы (prod snapshot 2026-04-11):
- 1 workspace, 1 user, 6 agents
- 200 notes, 133 tasks, 7 deals, 44 contacts, 17 finances, 6 projects
- 2191 activity, 0 activity_archive (unused)
- OAuth tables: зависит от session count (обычно 1-2 active tokens)
- Остальные: short-lived (codes), service (idempotency_keys), dead (magic_links, webhook_dead_letters)

**Target**: `~/.qoopia/data/qoopia.db` (V3, создаётся fresh по DDL из 20-to-be/01-schema.md)

## Главная стратегия

**One-shot transform, non-blocking, idempotent, verifiable**:

1. Open V2 read-only: `new Database(v2Path, {readonly: true})`
2. Open V3 fresh (после install + migrations): `new Database(v3Path)`
3. В одной транзакции V3: transform и вставка по группам
4. После commit — rebuild FTS5 индексов
5. Verify: row counts + sample lookups
6. Log report (в `~/.qoopia/logs/migration-<timestamp>.log`)

**Idempotency**: если script запускается повторно по той же V3 БД — он **детектирует существующие записи** и skip'ает. Это позволяет безопасно re-run при partial failure.

## Row-by-row mapping

### A. Workspaces (1 row)

**V2 `workspaces`**:
```
id | name | slug | settings | created_at | updated_at
```

**V3 `workspaces`** — та же структура + `updated_at` NOT NULL default.

**Transform**:
```typescript
const v2Workspaces = v2.prepare('SELECT * FROM workspaces').all();
for (const w of v2Workspaces) {
  // Drop webhooks from settings — V3 has no webhooks (NG from Phase 2)
  let settings = {};
  try {
    const s = JSON.parse(w.settings || '{}');
    delete s.webhooks;
    settings = s;
  } catch {}

  v3.prepare(`
    INSERT INTO workspaces (id, name, slug, settings, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(w.id, w.name, w.slug, JSON.stringify(settings), w.created_at, w.updated_at || w.created_at);
}
report.workspaces = v2Workspaces.length;
```

### B. Users (1 row)

**V2 → V3**:
```typescript
const v2Users = v2.prepare('SELECT * FROM users').all();
for (const u of v2Users) {
  v3.prepare(`
    INSERT INTO users (id, workspace_id, name, email, role, api_key_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(u.id, u.workspace_id, u.name, u.email, u.role, u.api_key_hash, u.created_at);
  // Drop: last_seen, session_expires_at (V2 specific, see 01-schema.md users)
}
report.users = v2Users.length;
```

### C. Agents (6 rows)

**V2 drops**: `key_rotated_at`, `previous_key_hash`, `previous_key_expires` (grace-period rotation simplified in V3), `permissions` → `metadata` merged.

```typescript
const v2Agents = v2.prepare('SELECT * FROM agents').all();
for (const a of v2Agents) {
  // Merge V2 permissions JSON and metadata JSON into new metadata
  const oldMeta = safeJsonParse(a.metadata, {});
  const oldPerms = safeJsonParse(a.permissions, {});
  const newMeta = {
    ...oldMeta,
    legacy_permissions: oldPerms,  // kept for audit, not enforced
  };

  // Agent type: infer from name if known
  let type = 'standard';
  if (/claude/i.test(a.name)) type = 'claude-privileged';

  v3.prepare(`
    INSERT INTO agents (id, workspace_id, name, type, api_key_hash, active, last_seen, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    a.id, a.workspace_id, a.name, type,
    a.api_key_hash, a.active ?? 1,
    a.last_seen, JSON.stringify(newMeta), a.created_at
  );
}
report.agents = v2Agents.length;
```

**Важно**: `api_key_hash` переносится **как есть** — агенты продолжают использовать свои существующие API keys для auth. Это ключевой момент для zero-downtime.

### D. Notes (200 rows) — existing notes into extended notes

V2 `notes` → V3 `notes` (расширенная таблица).

**V2 drops**: `embedding`, `matched_entities`, `auto_updates` (все связаны с Layer B и auto-magic, выкинуты per ADR-002/004).

```typescript
const v2Notes = v2.prepare('SELECT * FROM notes').all();
for (const n of v2Notes) {
  // V2 note has type = rule|memory|knowledge|context|NULL
  // V3 uses same enum expanded (adds note as default fallback)
  const type = n.type || 'memory';

  // Metadata carries over minimal (was empty in V2)
  const metadata = {
    source: n.source || 'migration',
    v2_agent_name: n.agent_name,  // preserved for audit
  };

  v3.prepare(`
    INSERT INTO notes (id, workspace_id, agent_id, type, text, metadata, project_id, source, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'migration', '[]', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    n.id, n.workspace_id, n.agent_id, type, n.text,
    JSON.stringify(metadata), n.project_id,
    n.created_at, n.created_at
  );
}
report.notes_original = v2Notes.length;
```

### E. Tasks (133 rows) → notes with type='task'

**Это самая большая transformation**. V2 `tasks` table → rows в V3 `notes`.

```typescript
const v2Tasks = v2.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL OR deleted_at IS NOT NULL').all();
for (const t of v2Tasks) {
  // Compose text: title as first line, description underneath
  const text = t.description
    ? `${t.title}\n\n${t.description}`
    : t.title;

  // Pack task-specific fields into metadata
  const metadata = {
    status: t.status || 'todo',
    priority: t.priority || 'medium',
    assignee: t.assignee,
    due_date: t.due_date,
    blocked_by: safeJsonParse(t.blocked_by, []),
    parent_id: t.parent_id,
    attachments: safeJsonParse(t.attachments, []),
    tags: safeJsonParse(t.tags, []),
    inline_notes: t.notes,  // V2 field 'notes' (free text) kept
    v2_revision: t.revision,
    v2_source: t.source,
    v2_updated_by: t.updated_by,
  };

  v3.prepare(`
    INSERT INTO notes (id, workspace_id, agent_id, type, text, metadata, project_id, source, tags, deleted_at, created_at, updated_at)
    VALUES (?, ?, NULL, 'task', ?, ?, ?, 'migration', ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    t.id, t.workspace_id,
    text, JSON.stringify(metadata),
    t.project_id,
    JSON.stringify(safeJsonParse(t.tags, [])),
    t.deleted_at,
    t.created_at, t.updated_at || t.created_at
  );
}
report.tasks_migrated = v2Tasks.length;
```

**Примечание**: `agent_id = NULL` потому что V2 tasks не имели прямого agent link (они создавались через REST / MCP с `updated_by` string, а не agent_id FK). Если нужно позже — восстанавливается через lookup activity log.

### F. Deals (7 rows) → notes with type='deal'

```typescript
const v2Deals = v2.prepare('SELECT * FROM deals').all();

// Preload deal-contact junctions
const dealContactsMap = new Map();
const v2DealContacts = v2.prepare('SELECT * FROM deal_contacts').all();
for (const dc of v2DealContacts) {
  if (!dealContactsMap.has(dc.deal_id)) dealContactsMap.set(dc.deal_id, []);
  dealContactsMap.get(dc.deal_id).push({ contact_id: dc.contact_id, role: dc.role });
}

for (const d of v2Deals) {
  const metadata = {
    status: d.status,
    address: d.address,
    asking_price: d.asking_price,
    target_price: d.target_price,
    monthly_rent: d.monthly_rent,
    lease_term_months: d.lease_term_months,
    documents: safeJsonParse(d.documents, []),
    timeline: safeJsonParse(d.timeline, []),
    tags: safeJsonParse(d.tags, []),
    inline_notes: d.notes,
    contacts: dealContactsMap.get(d.id) || [],
    ...safeJsonParse(d.metadata, {}),  // V2 had metadata JSON already
    v2_revision: d.revision,
    v2_updated_by: d.updated_by,
  };

  v3.prepare(`
    INSERT INTO notes (id, workspace_id, agent_id, type, text, metadata, project_id, source, tags, deleted_at, created_at, updated_at)
    VALUES (?, ?, NULL, 'deal', ?, ?, ?, 'migration', ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    d.id, d.workspace_id, d.name, JSON.stringify(metadata),
    d.project_id, JSON.stringify(safeJsonParse(d.tags, [])),
    d.deleted_at, d.created_at, d.updated_at || d.created_at
  );
}
report.deals_migrated = v2Deals.length;
```

**Key insight**: `deal_contacts` junction collapses into `metadata.contacts` JSON array. Query pattern changes from JOIN to `json_each(metadata, '$.contacts')`. Для 7 deals это instant.

### G. Contacts (44 rows) → notes with type='contact'

```typescript
const v2Contacts = v2.prepare('SELECT * FROM contacts').all();

// Preload contact-project junctions
const contactProjectsMap = new Map();
const v2ContactProjects = v2.prepare('SELECT * FROM contact_projects').all();
for (const cp of v2ContactProjects) {
  if (!contactProjectsMap.has(cp.contact_id)) contactProjectsMap.set(cp.contact_id, []);
  contactProjectsMap.get(cp.contact_id).push({ project_id: cp.project_id, role: cp.role });
}

for (const c of v2Contacts) {
  const metadata = {
    role: c.role,
    company: c.company,
    email: c.email,
    phone: c.phone,
    telegram_id: c.telegram_id,
    language: c.language || 'EN',
    timezone: c.timezone,
    category: c.category,
    communication_rules: c.communication_rules,
    tags: safeJsonParse(c.tags, []),
    inline_notes: c.notes,
    projects: contactProjectsMap.get(c.id) || [],
    v2_revision: c.revision,
    v2_updated_by: c.updated_by,
  };

  v3.prepare(`
    INSERT INTO notes (id, workspace_id, agent_id, type, text, metadata, project_id, source, tags, deleted_at, created_at, updated_at)
    VALUES (?, ?, NULL, 'contact', ?, ?, NULL, 'migration', ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    c.id, c.workspace_id, c.name, JSON.stringify(metadata),
    JSON.stringify(safeJsonParse(c.tags, [])),
    c.deleted_at, c.created_at, c.updated_at || c.created_at
  );
}
report.contacts_migrated = v2Contacts.length;
```

### H. Finances (17 rows) → notes with type='finance'

```typescript
const v2Finances = v2.prepare('SELECT * FROM finances').all();
for (const f of v2Finances) {
  const metadata = {
    finance_type: f.type,  // renamed: V2 has 'type' for financial type, V3 has 'type' for note type
    amount: f.amount,
    currency: f.currency || 'USD',
    recurring: f.recurring || 'none',
    status: f.status || 'active',
    tags: safeJsonParse(f.tags, []),
    inline_notes: f.notes,
    v2_revision: f.revision,
    v2_updated_by: f.updated_by,
  };

  v3.prepare(`
    INSERT INTO notes (id, workspace_id, agent_id, type, text, metadata, project_id, source, tags, deleted_at, created_at, updated_at)
    VALUES (?, ?, NULL, 'finance', ?, ?, ?, 'migration', ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    f.id, f.workspace_id, f.name, JSON.stringify(metadata),
    f.project_id, JSON.stringify(safeJsonParse(f.tags, [])),
    f.deleted_at, f.created_at, f.updated_at || f.created_at
  );
}
report.finances_migrated = v2Finances.length;
```

### I. Projects (6 rows) → notes with type='project'

```typescript
const v2Projects = v2.prepare('SELECT * FROM projects').all();
for (const p of v2Projects) {
  const metadata = {
    description: p.description,
    status: p.status,
    owner_agent_id: p.owner_agent_id,
    color: p.color,
    tags: safeJsonParse(p.tags, []),
    settings: safeJsonParse(p.settings, {}),
    v2_revision: p.revision,
    v2_updated_by: p.updated_by,
  };

  v3.prepare(`
    INSERT INTO notes (id, workspace_id, agent_id, type, text, metadata, project_id, source, tags, deleted_at, created_at, updated_at)
    VALUES (?, ?, NULL, 'project', ?, ?, NULL, 'migration', ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    p.id, p.workspace_id, p.name, JSON.stringify(metadata),
    JSON.stringify(safeJsonParse(p.tags, [])),
    p.deleted_at, p.created_at, p.updated_at || p.created_at
  );
}
report.projects_migrated = v2Projects.length;
```

**Важно**: project notes имеют `project_id = NULL` сами по себе (project не ссылается на другой project). Остальные notes (tasks, deals) ссылаются на project-note через `notes.project_id` — та же схема что и в V2, работает из коробки потому что ULIDs сохраняются.

### J. Activity (2191 rows) → activity (simplified)

```typescript
const v2Activity = v2.prepare('SELECT * FROM activity').all();
for (const a of v2Activity) {
  // Skip fields: revision_before, revision_after, timestamp (renamed to created_at)
  v3.prepare(`
    INSERT INTO activity (id, workspace_id, agent_id, action, entity_type, entity_id, project_id, summary, details, created_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    a.id, a.workspace_id,
    a.action, a.entity_type, a.entity_id, a.project_id,
    a.summary, a.details || '{}', a.timestamp
  );
}
report.activity_migrated = v2Activity.length;
```

**Note**: `agent_id = NULL` потому что V2 activity имел поле `actor` как string, не FK. В V3 мы могли бы lookup agents by name, но это extra work без пользы (activity log — read-only аудит).

### K. Activity archive — SKIP (explicitly dropped)

V2 `activity_archive` → **не переносится**. Дропается per Phase 2 01-schema.md D2.

```typescript
report.activity_archive_skipped = v2.prepare('SELECT COUNT(*) as c FROM activity_archive').get().c;
```

### L. OAuth clients → KEEP

```typescript
const v2Clients = v2.prepare('SELECT * FROM oauth_clients').all();
for (const c of v2Clients) {
  v3.prepare(`
    INSERT INTO oauth_clients (id, name, agent_id, client_secret_hash, redirect_uris, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(c.id, c.name, c.agent_id, c.client_secret_hash, c.redirect_uris || '[]', c.created_at);
}
report.oauth_clients_migrated = v2Clients.length;
```

### M. OAuth tokens → KEEP active only

```typescript
const now = new Date().toISOString().replace(/\.\d{3}Z/, 'Z');
const v2Tokens = v2.prepare('SELECT * FROM oauth_tokens WHERE revoked = 0 AND expires_at > ?').all(now);
for (const t of v2Tokens) {
  // V3 has unified oauth_tokens with token_type ∈ {access, refresh, code}
  v3.prepare(`
    INSERT INTO oauth_tokens (token_hash, client_id, agent_id, workspace_id, token_type, expires_at, revoked, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(token_hash) DO NOTHING
  `).run(
    t.token_hash, t.client_id, t.agent_id, t.workspace_id,
    t.token_type || 'refresh',  // V2 default was refresh
    t.expires_at, t.created_at
  );
}
report.oauth_tokens_migrated = v2Tokens.length;
```

**Trade-off**: **Active OAuth tokens сохраняются** чтобы Claude.ai connector продолжил работать без re-auth. Если это не cluster-critical — можно force re-auth (принудительно пропустить этот step).

### N. OAuth codes → SKIP (short-lived)

V2 `oauth_codes` — short-lived authorization codes (PKCE flow), TTL ~10 минут. Миграция их бессмысленна.

```typescript
report.oauth_codes_skipped = true;
```

### O. Magic links → SKIP (dropped per Phase 2 01-schema E4)

```typescript
report.magic_links_dropped = v2.prepare('SELECT COUNT(*) as c FROM magic_links').get().c;
```

### P. Idempotency keys → KEEP active

```typescript
const v2IdempKeys = v2.prepare('SELECT * FROM idempotency_keys WHERE expires_at > ?').all(now);
for (const k of v2IdempKeys) {
  v3.prepare(`
    INSERT INTO idempotency_keys (key_hash, workspace_id, response, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key_hash) DO NOTHING
  `).run(k.key_hash, 'default-workspace-id', k.response, k.created_at, k.expires_at);
  // V2 has no workspace_id on idempotency_keys; V3 adds it. Use default.
}
report.idempotency_keys_migrated = v2IdempKeys.length;
```

**Caveat**: V2 `idempotency_keys` не привязан к workspace, V3 добавляет `workspace_id NOT NULL`. Fallback на default workspace ID.

### Q. Webhook dead letters → SKIP (dropped)

```typescript
report.webhook_dead_letters_dropped = v2.prepare('SELECT COUNT(*) as c FROM webhook_dead_letters').get().c;
```

### R. Schema versions → SKIP (V3 начинает с 1)

V3 initial migration сама записывает version 1 в `schema_versions`. Не нужно переносить историю V2 миграций.

### S. Sessions / session_messages / summaries → NEW, empty after migration

Эти таблицы **новые** в V3. После миграции они **пустые** — агенты начнут их населять через `session_save()` при первом использовании V3.

**Нет loss** от этого: V2 не имела session memory, её и не было что переносить.

## Final steps

### Rebuild FTS5

После всех INSERT'ов:

```typescript
v3.exec(`INSERT INTO notes_fts(notes_fts) VALUES('rebuild')`);
// session_messages_fts is empty, no rebuild needed
```

Это пересобирает FTS5 index по всем перенесённым notes включая migrated tasks/deals/contacts/finances/projects.

### VACUUM и optimize

```typescript
v3.exec('VACUUM');
v3.exec('ANALYZE');
```

Это compacts DB file и обновляет query planner statistics.

### Write migration report

```typescript
const reportJson = JSON.stringify({
  timestamp: new Date().toISOString(),
  source: v2Path,
  target: v3Path,
  duration_ms: Date.now() - startTime,
  counts: report,
  warnings: warnings,
}, null, 2);

fs.writeFileSync(
  path.join(logDir, `migration-${Date.now()}.log.json`),
  reportJson
);
console.log('Migration report:');
console.log(reportJson);
```

## Verification script

Отдельный скрипт `scripts/verify-migration.ts`:

```typescript
// Counts comparison
function assertCount(v2table, v2filter, v3table, v3filter, label) {
  const v2c = v2.prepare(`SELECT COUNT(*) as c FROM ${v2table} ${v2filter}`).get().c;
  const v3c = v3.prepare(`SELECT COUNT(*) as c FROM ${v3table} ${v3filter}`).get().c;
  if (v2c !== v3c) {
    throw new Error(`${label}: V2=${v2c}, V3=${v3c}`);
  }
  console.log(`✓ ${label}: ${v2c} rows`);
}

assertCount('workspaces', '', 'workspaces', '', 'workspaces');
assertCount('users', '', 'users', '', 'users');
assertCount('agents', '', 'agents', '', 'agents');
assertCount('notes', '', 'notes', `WHERE type IN ('memory','rule','knowledge','context','note') AND metadata NOT LIKE '%v2_revision%'`, 'notes (original)');
assertCount('tasks', '', 'notes', `WHERE type='task'`, 'tasks');
assertCount('deals', '', 'notes', `WHERE type='deal'`, 'deals');
assertCount('contacts', '', 'notes', `WHERE type='contact'`, 'contacts');
assertCount('finances', '', 'notes', `WHERE type='finance'`, 'finances');
assertCount('projects', '', 'notes', `WHERE type='project'`, 'projects');
assertCount('activity', '', 'activity', '', 'activity');

// Sample spot-checks
const sampleTask = v2.prepare('SELECT * FROM tasks LIMIT 1').get();
if (sampleTask) {
  const migrated = v3.prepare(`SELECT * FROM notes WHERE id = ?`).get(sampleTask.id);
  if (!migrated) throw new Error(`Sample task ${sampleTask.id} not found in V3`);
  if (migrated.type !== 'task') throw new Error(`Sample task wrong type: ${migrated.type}`);
  const meta = JSON.parse(migrated.metadata);
  if (meta.status !== sampleTask.status) throw new Error(`Sample task status mismatch`);
  console.log(`✓ Sample task verified: ${sampleTask.title}`);
}

// FTS5 works
const ftsTest = v3.prepare(`
  SELECT n.id FROM notes_fts f JOIN notes n ON n.rowid = f.rowid
  WHERE notes_fts MATCH 'migration*' LIMIT 1
`).get();
console.log(`✓ FTS5 functional (sample match: ${ftsTest ? 'yes' : 'no data'})`);

// Cross-references
const orphanProjectRefs = v3.prepare(`
  SELECT COUNT(*) as c FROM notes
  WHERE project_id IS NOT NULL
    AND project_id NOT IN (SELECT id FROM notes WHERE type = 'project')
`).get().c;
if (orphanProjectRefs > 0) {
  console.warn(`⚠ ${orphanProjectRefs} notes reference missing projects`);
}
```

## Helpers

```typescript
function safeJsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
```

## Idempotency

Каждый INSERT использует `ON CONFLICT(id) DO NOTHING` (или `(token_hash)`, `(key_hash)` для соответствующих таблиц). Это позволяет **повторные запуски** script'а без ошибок:

- Первый запуск: создаёт все rows
- Второй запуск: ничего не делает (все ID уже есть)
- После ручной правки V3: script не перезатирает (idempotent)

## Transactional safety

Всё в одной транзакции:

```typescript
v3.exec('BEGIN');
try {
  // ... all inserts in order A through P
  v3.exec('COMMIT');
} catch (err) {
  v3.exec('ROLLBACK');
  logger.error({err}, 'Migration failed, rolled back');
  throw err;
}
```

Если любая вставка падает — ВСЯ миграция откатывается, V3 DB остаётся в состоянии до migration start (empty или с прошлой частичной migration).

## Edge cases и warnings

### E1: soft-deleted entities

V2 имеет `deleted_at` на tasks/deals/contacts/finances/projects/notes. **Мы переносим их тоже** (с `deleted_at` в V3 схеме) чтобы не терять исторический audit log. `WHERE deleted_at IS NULL` применится в runtime queries.

### E2: project_id в soft-deleted tasks

Если task имеет `project_id`, указывающий на soft-deleted project — оба переносятся, связь сохраняется. FK в V3 схеме не имеет `ON DELETE CASCADE`.

### E3: agents с previous_key_hash

V3 не имеет grace period rotation (ADR упрощение). Если агент в момент миграции использовал previous_key — он получит 401 после migration. **Mitigation**: не проводить миграцию в момент когда Aidan активно пишет (редкое окно, легко избежать).

### E4: Long `details` JSON в activity

V2 activity.details может быть большим (до мегабайт если кто-то вставил file content). V3 не меняет размер, просто переносит. Можно ограничить 100 KB per row в validation.

### E5: Null handling

Все V2 nullable fields остаются nullable в V3 где совместимо. Скрипт использует `?? null` для явной обработки undefined.

## Оценка времени выполнения

На prod snapshot (2623 rows total + 6 agents + 1 workspace + ~50 junction rows):

- Workspaces/users/agents: < 10 мс
- Notes (200): ~50 мс
- Tasks (133): ~50 мс
- Deals/contacts/finances/projects (74): ~30 мс
- Activity (2191): ~400 мс
- OAuth tables: < 10 мс
- FTS5 rebuild: ~100 мс
- VACUUM: ~200 мс

**Total: ~1 секунда**. Миграция — мгновенная для prod объёмов.

## LoC estimate

| Script | LoC |
|---|---|
| `scripts/migrate-from-v2.ts` | ~400 |
| `scripts/verify-migration.ts` | ~100 |
| Helpers в shared utils | ~30 |
| **Total** | **~530 LoC** |

Это **одноразовый скрипт**, не part of core server. Живёт в `scripts/`, не в `src/`. Бюджет H1 не затрагивается.

## Что готово к Phase 5

Этот документ — **executable spec**. В Phase 5 developer:

1. Создаёт `scripts/migrate-from-v2.ts`
2. Копирует каждую секцию (A-R) как TypeScript функцию
3. Оборачивает в транзакцию + idempotency wrapper
4. Пишет `scripts/verify-migration.ts` по указанной структуре
5. Тестирует на копии prod DB

Нет design вопросов которые блокируют написание.
