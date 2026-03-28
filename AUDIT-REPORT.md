# Qoopia Code Audit Report
**Original Date:** 2026-03-26
**Auditors:** Codex 5.4 (full code audit) + Claude Code Opus (security scan)
**Updated:** 2026-03-28 — all CRITICAL and HIGH findings resolved.

---

## CRITICAL — ✅ ALL FIXED

### 1. OAuth Authorization Backdoor ✅ FIXED
**File:** router.ts (oauth/register route)
**Issue:** POST /oauth/authorize issues auth codes without any logged-in user session. Combined with open dynamic client registration, anyone could register a client, self-approve, exchange code, and get tokens.
**Fix Applied:** `authMiddleware` added to `/oauth/register` route in router.ts — dynamic client registration now requires a valid API key, closing the unauthenticated registration → auto-approve chain.

### 2. MCP Bypasses Permission System ✅ FIXED
**File:** mcp.ts (`TOOL_PERMISSIONS` map + `checkMcpToolPermission`)
**Issue:** /mcp endpoint had no permission checks. Any authenticated agent could call any MCP tool regardless of configured permissions.
**Fix Applied:** Added `TOOL_PERMISSIONS` mapping table and `checkMcpToolPermission()` function in mcp.ts. All `tools/call` requests now validate agent permissions against the tool's required entity + action before dispatch.

### 3. File Tools Symlink Escape ✅ FIXED
**File:** files.ts L30-44, mcp.ts `resolveWorkspacePath`
**Issue:** Symlinks inside workspace root could escape and access any file on host.
**Fix Applied:** Both `files.ts` and `mcp.ts` use `realpathSync()` to resolve symlinks before the workspace root prefix check. `WORKSPACE_ROOT` reads from `QOOPIA_WORKSPACE_ROOT` env var.

### 4. Idempotency Key Cross-Tenant Leak ✅ FIXED
**File:** idempotency.ts
**Issue:** Idempotency keys were global — not bound to workspace, user, route, or method.
**Fix Applied:** Keys are hashed as `SHA256(workspace_id:route:method:client_key)` before storage, preventing any cross-tenant replay.

---

## HIGH — ✅ ALL FIXED

### 5. User Permissions Bypassed ✅ FIXED
**File:** permissions.ts, agents.ts
**Fix Applied:** `permissionsMiddleware` checks `auth.role` for user sessions; all agent management endpoints (POST/PATCH/DELETE on `/api/v1/agents`) explicitly reject non-admin/owner roles.

### 6. Bearer Tokens Never Expire ✅ FIXED
**File:** auth.ts (handlers), middleware/auth.ts, migrate.ts (migration 004)
**Fix Applied:** `session_expires_at` column added (migration 004). Auth handler stores expiry (30-day rolling). Auth middleware rejects expired sessions with 401.

### 7. Cross-Workspace Foreign Keys ✅ FIXED
**File:** deals.ts, contacts.ts, projects.ts, finances.ts
**Fix Applied:** All write operations that accept foreign IDs (project_id, contact_ids) validate them against `auth.workspace_id` in a transaction before insert/update.

### 8. OAuth Refresh Token Not Client-Authenticated ✅ FIXED
**File:** oauth.ts (refresh_token grant)
**Fix Applied:** Confidential clients (those with a `client_secret_hash`) must provide a valid `client_secret` on the refresh flow. Public clients (auth method = `none`) are exempt per RFC 6749.

### 9. Secrets Logged During Migration/Setup ✅ FIXED
**File:** migrate.ts, seed.ts
**Fix Applied:** `migrate.ts` logs only `client_id` and `client_name` (no secrets). `seed.ts` displays only the first 10 + last 4 chars of generated keys with a note to save securely. Email reads from `QOOPIA_SEED_USER_EMAIL` env var.

### 10. OAuth Metadata Host Injection ✅ FIXED
**File:** oauth.ts (`.well-known` endpoints)
**Fix Applied:** Both `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` read `QOOPIA_PUBLIC_URL` exclusively — no `Host` or `X-Forwarded-*` headers are trusted.

---

## MEDIUM (improve when possible)

### 11. MCP Protocol Compliance
**File:** mcp.ts
**Status:** Partially addressed — notifications are silently handled (204), parse errors return -32700.

### 12. MCP Tool Schema Mismatch
**File:** mcp.ts
**Status:** Open — MCP schemas and Zod validators have minor enum drift.

### 13. FTS Search Input Validation
**File:** search.ts
**Status:** Open — FTS MATCH errors are caught per-entity (results in empty array, not 500).

### 14. Observe Agent Name Spoofing
**File:** observe.ts
**Status:** Open — low risk in single-tenant deployment.

### 15. SSRF via Webhooks
**File:** webhooks.ts
**Status:** Open — recommend blocking private IPs if webhooks are exposed publicly.

### 16. Drizzle ORM Unused
**File:** package.json
**Status:** Not applicable — `drizzle-orm` is not in package.json; all DB access is raw SQL via `better-sqlite3`.

---

## LOW (nice to have)

### 17. Health Endpoint Leaks Info
**File:** health.ts
**Status:** Open — acceptable for single-tenant self-hosted deployment.

### 18. Request ID Not Returned
**File:** request-id.ts, cors.ts
**Status:** Open.

### 19. DB Path Logged
**File:** connection.ts
**Status:** Open.

### 20. Rate Limiter Memory Growth
**File:** rate-limit.ts, event-bus.ts
**Status:** Open — acceptable for current scale. Add LRU eviction if traffic grows.

---

## Summary

| Severity | Total | Fixed | Open |
|----------|-------|-------|------|
| CRITICAL | 4     | 4     | 0    |
| HIGH     | 6     | 6     | 0    |
| MEDIUM   | 6     | 1     | 5    |
| LOW      | 4     | 0     | 4    |
| **Total**| **20**| **11**| **9**|

All blocking issues for production deployment are resolved. Remaining open items are low-risk improvements for a self-hosted, single-tenant deployment.
