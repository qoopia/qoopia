# Qoopia Code Audit Report
**Date:** 2026-03-26
**Auditors:** Codex 5.4 (full code audit) + Claude Code Opus (security scan)

---

## CRITICAL (must fix before public release)

### 1. OAuth Authorization Backdoor
**File:** oauth.ts L180, L257, L541
**Issue:** POST /oauth/authorize issues auth codes without any logged-in user session. Combined with open dynamic client registration, anyone can register a client, self-approve, exchange code, and get tokens.
**Fix:** Require authenticated resource owner session before issuing auth codes.

### 2. MCP Bypasses Permission System
**File:** router.ts L65/L91, mcp.ts L753/L1215
**Issue:** /mcp endpoint has no permissionsMiddleware. Any authenticated agent can call any MCP tool regardless of configured permissions.
**Fix:** Apply permissionsMiddleware to /mcp route or implement tool-level permission checks.

### 3. File Tools Symlink Escape
**File:** mcp.ts L440/L715, files.ts L8/L25
**Issue:** File read/write uses naive prefix check. Symlinks inside workspace root can escape and access any file on host. Hardcoded personal path leaks machine details.
**Fix:** Use fs.realpathSync() to resolve symlinks before prefix check. Use env var for workspace root.

### 4. Idempotency Key Cross-Tenant Leak
**File:** idempotency.ts L11/L19/L40
**Issue:** Idempotency keys are global — not bound to workspace, user, route, or method. Reused key replays another caller's cached response across tenants.
**Fix:** Hash key with workspace_id + route + method.

---

## HIGH (should fix soon)

### 5. User Permissions Bypassed
**File:** permissions.ts L111, agents.ts L26/L84/L193
**Issue:** permissionsMiddleware bypasses all users. Any member-level user can create agents, rotate keys, deactivate agents.
**Fix:** Implement role-based access control for user actions.

### 6. Bearer Tokens Never Expire
**File:** auth.ts L133/L140, middleware/auth.ts L50
**Issue:** Magic-link creates bearer tokens with no server-side expiry. SESSION_EXPIRY_HOURS only used for cookie. Also silently revokes previous API key on each login.
**Fix:** Store token expiry in DB, check on each request.

### 7. Cross-Workspace Foreign Keys
**File:** deals.ts L100/L174, contacts.ts L91/L164, projects.ts L73, finances.ts L141
**Issue:** Write operations accept arbitrary IDs without verifying they belong to the same workspace. Creates cross-tenant links.
**Fix:** Validate all referenced IDs belong to auth.workspace_id before write.

### 8. OAuth Refresh Token Not Client-Authenticated
**File:** oauth.ts L458
**Issue:** Refresh flow only checks refresh_token + client_id. No client_secret verification for confidential clients.
**Fix:** Require client authentication for confidential clients on refresh.

### 9. Secrets Logged During Migration/Setup
**File:** migrate.ts L68/L89, seed.ts L32/L43
**Issue:** OAuth client secrets and agent API keys printed to console during setup. Personal email hardcoded in seed.
**Fix:** Never log secrets. Use env vars for seed data. Redact in output.

### 10. OAuth Metadata Host Injection
**File:** oauth.ts L145/L165
**Issue:** OAuth metadata endpoints trust Host/X-Forwarded-* headers blindly. Attacker can poison issuer URLs.
**Fix:** Use QOOPIA_PUBLIC_URL exclusively, never derive from headers.

---

## MEDIUM (improve when possible)

### 11. MCP Protocol Compliance
**File:** mcp.ts L1215/L1235
**Issue:** Invalid JSON throws instead of returning JSON-RPC parse error. notifications/initialized gets response instead of being silent.
**Fix:** Wrap parse in try/catch, return -32700. Don't respond to notifications.

### 12. MCP Tool Schema Mismatch
**File:** mcp.ts L48/L648/L756/L1107
**Issue:** MCP tool schemas advertise different status values than Zod validators. Creates invalid state that REST layer rejects.
**Fix:** Align MCP schemas with Zod validators. Validate through same path.

### 13. FTS Search Input Validation
**File:** search.ts L19
**Issue:** Only strips quotes before FTS MATCH. Malformed FTS syntax causes 500 errors.
**Fix:** Wrap FTS query in try/catch, return 400 on syntax error.

### 14. Observe Agent Name Spoofing
**File:** observe.ts L27/L84/L151
**Issue:** Callers can spoof agent names in persisted activity. Global in-memory buffer for all workspaces.
**Fix:** Derive agent name from auth context, not request body. Per-workspace buffers.

### 15. SSRF via Webhooks
**File:** webhooks.ts L48/L61
**Issue:** Webhook URLs posted to without private-network blocking or allowlisting.
**Fix:** Block private IPs (127.x, 10.x, 192.168.x, etc.) before sending webhooks.

### 16. Drizzle ORM Unused
**File:** package.json, connection.ts L27
**Issue:** drizzle-orm/drizzle-kit installed but all DB access is raw SQL. Dead dependency weight.
**Fix:** Remove drizzle or migrate raw SQL to use it. Pick one.

---

## LOW (nice to have)

### 17. Health Endpoint Leaks Info
**File:** health.ts L33/L78
**Issue:** Unauthenticated health endpoint exposes DB size, agent activity, litestream status. Reports RAM as disk_free_mb (incorrect label).
**Fix:** Minimal public health (up/down). Detailed health behind auth.

### 18. Request ID Not Returned
**File:** request-id.ts, cors.ts L28
**Issue:** CORS exposes X-Request-ID header but it's never actually set on responses.
**Fix:** Set X-Request-ID on response in middleware.

### 19. DB Path Logged
**File:** connection.ts L25
**Issue:** Absolute filesystem path logged on startup.
**Fix:** Log relative path or just "database connected".

### 20. Rate Limiter Memory Growth
**File:** rate-limit.ts, event-bus.ts L29
**Issue:** In-memory rate limiters and event subscriber maps have no eviction strategy. Can grow unbounded.
**Fix:** Add periodic cleanup or use LRU cache with max size.

---

## Claude Code Security Scan — Additional Findings

### Files Created
- `.env.example` — all env vars documented, no real values
- `.gitignore` — covers secrets, node_modules, dist, .env, *.db

### Hardcoded Paths Found
- `src/api/handlers/files.ts L8`: hardcoded `/Users/askhatsoltanov/` path
- `src/api/handlers/mcp.ts L440`: hardcoded workspace path
- `src/db/seed.ts`: hardcoded personal email

### Git History
- No secrets found in git history (repo is clean)

---

## Priority Order for Fixes

1. **#1 OAuth Backdoor** — BLOCKING for public release
2. **#3 Symlink Escape** — BLOCKING for public release  
3. **#9 Secrets in Logs** — BLOCKING for public release
4. **#4 Idempotency Cross-Tenant** — BLOCKING for multi-tenant
5. **#2 MCP Permissions** — HIGH priority
6. **#7 Cross-Workspace FK** — HIGH priority
7. **#6 Token Expiry** — HIGH priority
8. Rest can be addressed post-launch
