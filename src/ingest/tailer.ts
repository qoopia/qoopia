#!/usr/bin/env bun
/**
 * src/ingest/tailer.ts — Phase 7a
 *
 * Standalone Bun process. Watches ~/.claude/projects/*\/*.jsonl,
 * filters user+assistant text turns, deduplicates by (session_id, uuid),
 * and POSTs them to Qoopia /ingest/session with cross-attribution.
 *
 * Auth: uses ingest-daemon key from ~/.qoopia/ingest.key
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const QOOPIA_URL = process.env.QOOPIA_URL ?? "http://localhost:3737";
const INGEST_KEY_PATH =
  process.env.QOOPIA_INGEST_KEY_PATH ??
  path.join(os.homedir(), ".qoopia", "ingest.key");
const CLAUDE_PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR ??
  path.join(os.homedir(), ".claude", "projects");
const CURSORS_PATH =
  process.env.QOOPIA_CURSORS_PATH ??
  path.join(os.homedir(), ".qoopia", "tailer-cursors.json");

// Retry / backoff settings
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;
const RETRY_JITTER = 0.2;
const QUEUE_FLUSH_INTERVAL_MS = 500;
const CURSORS_PERSIST_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Dialogue tool whitelist — only these tool_use names count as dialogue text.
// Everything else (note_create, session_save, react, etc.) is dropped.
// ---------------------------------------------------------------------------

const DIALOGUE_TOOL_WHITELIST = new Set([
  "mcp__plugin_telegram_telegram__reply",
  "mcp__plugin_telegram_telegram__edit_message",
]);

// ---------------------------------------------------------------------------
// Secret patterns — extracted text matching any of these is skipped entirely.
// We use known-prefix patterns to minimise false positives (no generic base64).
// The server has a second layer (assertNoSecrets), so we stay conservative here.
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS: RegExp[] = [
  /\bq_[A-Za-z0-9_\-]{30,}/,          // Qoopia API keys
  /\bqcs_[A-Za-z0-9_\-]{30,}/,        // Qoopia client secrets
  /\bsk-ant-[A-Za-z0-9_\-]{30,}/,     // Anthropic API keys
  /Bearer\s+[A-Za-z0-9_\-.]{20,}/i,   // Generic bearer tokens
  /\bghp_[A-Za-z0-9]{30,}/,           // GitHub PATs
  /\bAIza[A-Za-z0-9_\-]{30,}/,        // Google API keys
  /api[_\-]?key\s*[:=]\s*\S{20,}/i,   // Generic api_key = ...
  /password\s*[:=]\s*\S{8,}/i,        // Generic password = ...
  /secret\s*[:=]\s*\S{20,}/i,         // Generic secret = ...
];

function containsSecret(text: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Channel XML parser — extracts inner text + metadata from Telegram channel tags.
// Input: '<channel source="plugin:telegram:telegram" chat_id="..." ...>text</channel>'
// Output: { text: "text", metadata: { source: "...", chat_id: "...", ... } }
// If the string is not a channel tag, returns it as-is with empty metadata.
// ---------------------------------------------------------------------------

function parseChannelText(raw: string): { text: string; metadata: Record<string, unknown> } {
  const tagMatch = raw.match(/^<channel\s([^>]*)>([\s\S]*?)<\/channel>$/s);
  if (!tagMatch) return { text: raw, metadata: {} };

  const attrsStr = tagMatch[1]!;
  const innerText = tagMatch[2]!.trim();

  const metadata: Record<string, unknown> = {};
  const attrRe = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(attrsStr)) !== null) {
    metadata[m[1]!] = m[2]!;
  }

  return { text: innerText, metadata };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AllowlistEntry {
  cwd_prefix: string;
  agent_id: string;
  autosession_enabled: number;
}

interface IngestPayload {
  attributed_agent_id: string;
  session_id: string;
  uuid: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  cwd: string;
  metadata?: Record<string, unknown>;
}

interface QueueEntry {
  payload: IngestPayload;
  attempts: number;
  next_attempt_at: number;
}

// ---------------------------------------------------------------------------
// Dedup store — in-memory, keyed by "session_id:uuid"
// Survives until process restart (acceptable for MVP; 7b can add persistence)
// ---------------------------------------------------------------------------

const seenKeys = new Set<string>();

function dedupKey(sessionId: string, uuid: string): string {
  return `${sessionId}:${uuid}`;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

const queue: QueueEntry[] = [];
// Set to true when a new entry is enqueued; cleared by persistCursors() flush.
let pendingPersist = false;

function enqueue(payload: IngestPayload) {
  const key = dedupKey(payload.session_id, payload.uuid);
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  queue.push({ payload, attempts: 0, next_attempt_at: Date.now() });
  pendingPersist = true;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

let ingestKey: string | null = null;

/**
 * Валидация пути ingest-key:
 *  - должен быть абсолютным (path.isAbsolute)
 *  - не должен содержать .. сегментов (path.normalize === запрос)
 *  - владельцем должен быть текущий пользователь
 *  - права доступа group/other должны быть 0 (mode & 0o077 === 0), иначе
 *    агент может подмонтировать чужие ключи через env.
 */
function validateIngestKeyPath(p: string): void {
  if (!path.isAbsolute(p)) {
    throw new Error(`QOOPIA_INGEST_KEY_PATH must be absolute, got: ${p}`);
  }
  const normalized = path.normalize(p);
  if (normalized !== p || normalized.split(path.sep).includes("..")) {
    throw new Error(`QOOPIA_INGEST_KEY_PATH must not contain .. segments, got: ${p}`);
  }
  if (!fs.existsSync(p)) {
    throw new Error(`Ingest key not found at ${p}. Run: qoopia admin register-ingest-daemon`);
  }
  const st = fs.statSync(p);
  if (!st.isFile()) {
    throw new Error(`QOOPIA_INGEST_KEY_PATH must be a regular file, got: ${p}`);
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`Ingest key ${p} is owned by uid=${st.uid}, expected current user uid=${process.getuid()}`);
  }
  // mode & 0o077 must be zero (no group/other read/write/exec bits)
  if ((st.mode & 0o077) !== 0) {
    throw new Error(
      `Ingest key ${p} has unsafe permissions ${(st.mode & 0o777).toString(8)}; ` +
      `expected 0600 (run: chmod 600 ${p})`,
    );
  }
}

function getIngestKey(): string {
  if (ingestKey) return ingestKey;
  validateIngestKeyPath(INGEST_KEY_PATH);
  ingestKey = fs.readFileSync(INGEST_KEY_PATH, "utf8").trim();
  return ingestKey;
}

async function postIngest(payload: IngestPayload): Promise<void> {
  const key = getIngestKey();
  const res = await fetch(`${QOOPIA_URL}/ingest/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      attributed_agent_id: payload.attributed_agent_id,
      session_id: payload.session_id,
      uuid: payload.uuid,
      role: payload.role,
      content: payload.content,
      timestamp: payload.timestamp,
      cwd: payload.cwd,
      metadata: payload.metadata ?? {},
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`POST /ingest/session → ${res.status}: ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Allowlist cache — refreshed every 60s
// ---------------------------------------------------------------------------

let allowlistCache: AllowlistEntry[] = [];
let allowlistLoadedAt = 0;
const ALLOWLIST_TTL_MS = 60_000;

async function fetchAllowlist(): Promise<AllowlistEntry[]> {
  const now = Date.now();
  if (now - allowlistLoadedAt < ALLOWLIST_TTL_MS) return allowlistCache;
  try {
    const key = getIngestKey();
    const res = await fetch(`${QOOPIA_URL}/ingest/allowlist`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`GET /ingest/allowlist → ${res.status}`);
    allowlistCache = (await res.json()) as AllowlistEntry[];
    allowlistLoadedAt = now;
  } catch (err) {
    console.error("[tailer] allowlist fetch failed:", err);
    // Return stale cache rather than crashing
  }
  return allowlistCache;
}

function resolveAgent(cwd: string, list: AllowlistEntry[]): string | null {
  // Find the most specific (longest) matching cwd_prefix
  let best: AllowlistEntry | null = null;
  for (const entry of list) {
    if (!entry.autosession_enabled) continue;
    // cwd_prefix match: the project dir name encodes the path as -Users-foo-bar
    // We match by checking if the real cwd starts with cwd_prefix
    if (cwd.startsWith(entry.cwd_prefix)) {
      if (!best || entry.cwd_prefix.length > best.cwd_prefix.length) {
        best = entry;
      }
    }
  }
  return best?.agent_id ?? null;
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

interface JsonlBlock {
  type: string;
  text?: string;
  name?: string;                       // tool_use: tool name
  input?: Record<string, unknown>;     // tool_use: arguments
}

interface JsonlEntry {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: string | JsonlBlock[];
  };
}

export type ExtractResult = {
  role: "user" | "assistant";
  text: string;
  metadata: Record<string, unknown>;
  entry: JsonlEntry;
  source: "text" | "channel" | "tool_use";
};

/**
 * Extract dialogue text from a JSONL entry.
 *
 * Handles three sources:
 *   1. "text" blocks   — existing behaviour (user + assistant plain text)
 *   2. "channel" tags  — user messages wrapped in <channel source="plugin:telegram:telegram"...>
 *   3. tool_use blocks — assistant outgoing messages via DIALOGUE_TOOL_WHITELIST
 *
 * Returns null when nothing extractable or if a secret is detected.
 */
export function extractText(raw: string): ExtractResult | null {
  let entry: JsonlEntry;
  try {
    entry = JSON.parse(raw) as JsonlEntry;
  } catch {
    return null;
  }

  const { type, uuid, sessionId, message } = entry;
  if (!type || !uuid || !sessionId || !message) return null;
  if (type !== "user" && type !== "assistant") return null;

  const role = type as "user" | "assistant";
  const content = message.content;

  // ---- 1. Plain string content (may be a channel tag) ----
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("<channel ")) {
      const parsed = parseChannelText(trimmed);
      if (!parsed.text) return null;
      if (containsSecret(parsed.text)) {
        console.warn(`[tailer] skip ${uuid}: potential secret detected in channel text`);
        return null;
      }
      return { role, text: parsed.text, metadata: parsed.metadata, entry, source: "channel" };
    }
    if (containsSecret(trimmed)) {
      console.warn(`[tailer] skip ${uuid}: potential secret detected`);
      return null;
    }
    return { role, text: trimmed, metadata: {}, entry, source: "text" };
  }

  if (!Array.isArray(content)) return null;

  // ---- 2. Text blocks (may contain channel XML) ----
  const textParts: string[] = [];
  let channelMeta: Record<string, unknown> = {};
  let hasChannel = false;

  for (const block of content) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    const raw = block.text.trim();
    if (!raw) continue;
    if (raw.startsWith("<channel ")) {
      const parsed = parseChannelText(raw);
      textParts.push(parsed.text);
      channelMeta = parsed.metadata;
      hasChannel = true;
    } else {
      textParts.push(raw);
    }
  }

  if (textParts.length > 0) {
    const text = textParts.join("\n").trim();
    if (!text) return null;
    if (containsSecret(text)) {
      console.warn(`[tailer] skip ${uuid}: potential secret detected`);
      return null;
    }
    return {
      role,
      text,
      metadata: hasChannel ? channelMeta : {},
      entry,
      source: hasChannel ? "channel" : "text",
    };
  }

  // ---- 3. tool_use blocks (assistant outgoing messages) ----
  if (role === "assistant") {
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      if (!block.name || !DIALOGUE_TOOL_WHITELIST.has(block.name)) continue;
      const inputText = block.input?.text;
      if (typeof inputText !== "string" || !inputText.trim()) continue;
      const text = inputText.trim();
      if (containsSecret(text)) {
        console.warn(`[tailer] skip ${uuid}: potential secret in tool_use.input.text`);
        return null;
      }
      return {
        role,
        text,
        metadata: { tool: block.name },
        entry,
        source: "tool_use",
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Per-file tail state — track byte offset so we only read new data.
// Persisted to ~/.qoopia/tailer-cursors.json so restarts don't cause data loss.
// ---------------------------------------------------------------------------

const fileCursors = new Map<string, number>();

function loadCursors() {
  try {
    if (!fs.existsSync(CURSORS_PATH)) return;
    const raw = fs.readFileSync(CURSORS_PATH, "utf8");
    const obj = JSON.parse(raw) as Record<string, number>;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "number") fileCursors.set(k, v);
    }
    console.log(`[tailer] loaded ${fileCursors.size} cursors from ${CURSORS_PATH}`);
  } catch (err) {
    console.error("[tailer] failed to load cursors (starting fresh):", err);
  }
}

function persistCursors() {
  try {
    const obj: Record<string, number> = {};
    for (const [k, v] of fileCursors) obj[k] = v;
    const tmp = CURSORS_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, CURSORS_PATH); // atomic on POSIX
  } catch (err) {
    console.error("[tailer] failed to persist cursors:", err);
  }
}

/**
 * QSEC-006: defense against a local attacker that can write under
 * ~/.claude/projects (or wherever CLAUDE_PROJECTS_DIR points). Without
 * containment, a symlinked .jsonl could cause the tailer to ingest content
 * from arbitrary paths into Qoopia memory.
 *
 * Rules:
 *  1. Reject symlinks (lstat — does NOT follow links).
 *  2. Require regular file.
 *  3. realpath(file) must live under realpath(CLAUDE_PROJECTS_DIR) + sep.
 *
 * Returns true if safe to ingest. Logs and returns false otherwise.
 */
let _projectsRootResolved: string | null = null;
function projectsRootResolved(): string {
  if (_projectsRootResolved) return _projectsRootResolved;
  try {
    _projectsRootResolved = fs.realpathSync(CLAUDE_PROJECTS_DIR);
  } catch {
    _projectsRootResolved = path.resolve(CLAUDE_PROJECTS_DIR);
  }
  return _projectsRootResolved;
}

// Exported for QRERUN-002 regression tests; not part of the public API.
export function isSafeWatchPath(p: string): boolean {
  try {
    const lst = fs.lstatSync(p);
    if (lst.isSymbolicLink()) {
      console.warn(`[tailer] refusing symlink: ${p}`);
      return false;
    }
    if (!lst.isFile()) {
      // Directories handled separately; this guards file paths only.
      return false;
    }
    const real = fs.realpathSync(p);
    const root = projectsRootResolved() + path.sep;
    if (!real.startsWith(root)) {
      console.warn(
        `[tailer] refusing out-of-tree path: ${p} -> ${real} (root=${root})`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[tailer] isSafeWatchPath check failed for ${p}:`, err);
    return false;
  }
}

function isSafeWatchDir(p: string): boolean {
  try {
    const lst = fs.lstatSync(p);
    if (lst.isSymbolicLink()) {
      console.warn(`[tailer] refusing symlinked dir: ${p}`);
      return false;
    }
    if (!lst.isDirectory()) return false;
    const real = fs.realpathSync(p);
    const root = projectsRootResolved();
    // Allow root itself OR a subdir of root.
    if (real !== root && !real.startsWith(root + path.sep)) {
      console.warn(
        `[tailer] refusing out-of-tree dir: ${p} -> ${real} (root=${root})`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[tailer] isSafeWatchDir check failed for ${p}:`, err);
    return false;
  }
}

/**
 * QRERUN-002: re-validate path before open, use O_NOFOLLOW to refuse
 * mid-flight symlink swaps, then compare fd identity (ino+dev) with a
 * fresh lstat to detect a race where the regular file was replaced
 * between the watcher event and our open().
 *
 * Drops the event silently (no enqueue) on any mismatch — the watcher
 * will fire again if the legitimate file keeps changing.
 */
async function processNewLines(filePath: string) {
  const allowlist = await fetchAllowlist();
  // Re-run path-safety check immediately before open (was previously only
  // done in watchFile() at watch-time, leaving a TOCTOU window).
  if (!isSafeWatchPath(filePath)) return;

  let fd: fs.promises.FileHandle | null = null;
  try {
    // O_NOFOLLOW forces open() to fail with ELOOP if filePath is now a
    // symlink — closes the race window between isSafeWatchPath() above
    // and the actual open syscall.
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
    fd = await fs.promises.open(filePath, flags);

    // Confirm the fd we opened still points at the regular file we
    // validated, not at a swapped-in target. Compare device + inode of
    // the fd against a fresh lstat of the path.
    const fdStat = await fd.stat();
    let pathStat: fs.Stats;
    try {
      pathStat = fs.lstatSync(filePath);
    } catch {
      return; // path vanished between open and lstat — drop
    }
    if (
      pathStat.isSymbolicLink() ||
      !fdStat.isFile() ||
      pathStat.ino !== fdStat.ino ||
      pathStat.dev !== fdStat.dev
    ) {
      console.warn(
        `[tailer] dropping event: identity changed for ${filePath} ` +
          `(symlink=${pathStat.isSymbolicLink()} ino_match=${pathStat.ino === fdStat.ino} dev_match=${pathStat.dev === fdStat.dev})`,
      );
      return;
    }

    const stat = fdStat;
    const cursor = fileCursors.get(filePath) ?? 0;
    if (stat.size <= cursor) return; // Nothing new

    const newBytes = stat.size - cursor;
    const buf = Buffer.allocUnsafe(newBytes);
    await fd.read(buf, 0, newBytes, cursor);
    fileCursors.set(filePath, stat.size);

    const chunk = buf.toString("utf8");
    const lines = chunk.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const result = extractText(trimmed);
      if (!result) continue;

      const { role, text, metadata, entry } = result;
      const cwd = entry.cwd ?? "";
      const agentId = resolveAgent(cwd, allowlist);
      if (!agentId) continue; // cwd not in allowlist or autosession disabled

      enqueue({
        attributed_agent_id: agentId,
        session_id: entry.sessionId!,
        uuid: entry.uuid!,
        role,
        content: text,
        timestamp: entry.timestamp ?? new Date().toISOString(),
        cwd,
        metadata,
      });
    }
  } catch (err) {
    console.error(`[tailer] processNewLines error for ${filePath}:`, err);
  } finally {
    await fd?.close();
  }
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

const watchers = new Map<string, fs.FSWatcher>();

function watchFile(filePath: string) {
  if (watchers.has(filePath)) return;
  // QSEC-006: refuse symlinks and out-of-tree paths before opening anything.
  if (!isSafeWatchPath(filePath)) return;
  // Init cursor at current file size (don't replay history). lstat to avoid
  // following any symlink that could appear here later.
  try {
    const size = fs.lstatSync(filePath).size;
    fileCursors.set(filePath, size);
  } catch {
    fileCursors.set(filePath, 0);
  }

  const watcher = fs.watch(filePath, async (event) => {
    if (event === "change") {
      await processNewLines(filePath);
    }
  });
  watcher.on("error", (err) => {
    console.error(`[tailer] watcher error for ${filePath}:`, err);
    watchers.delete(filePath);
    watcher.close();
  });
  watchers.set(filePath, watcher);
  console.log(`[tailer] watching ${filePath}`);
}

function watchProjectsDir() {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    console.warn(`[tailer] projects dir not found: ${CLAUDE_PROJECTS_DIR}`);
    return;
  }

  // Watch existing JSONL files. QSEC-006: skip symlinked dirs/files.
  for (const projectDir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
    const fullProjectDir = path.join(CLAUDE_PROJECTS_DIR, projectDir);
    if (!isSafeWatchDir(fullProjectDir)) continue;
    for (const file of fs.readdirSync(fullProjectDir)) {
      if (file.endsWith(".jsonl")) {
        watchFile(path.join(fullProjectDir, file));
      }
    }
  }

  // Watch for new project dirs / new JSONL files. watchFile() does the
  // symlink/realpath rejection per-file.
  fs.watch(CLAUDE_PROJECTS_DIR, { recursive: true }, (event, filename) => {
    if (!filename?.endsWith(".jsonl")) return;
    const fullPath = path.join(CLAUDE_PROJECTS_DIR, filename);
    if (!watchers.has(fullPath)) {
      // Small delay to let the file be created fully
      setTimeout(() => {
        if (fs.existsSync(fullPath)) watchFile(fullPath);
      }, 200);
    }
  });

  console.log(`[tailer] watching projects dir: ${CLAUDE_PROJECTS_DIR}`);
}

// ---------------------------------------------------------------------------
// Queue flush loop
// ---------------------------------------------------------------------------

async function flushQueue() {
  const now = Date.now();
  const ready = queue.filter((e) => e.next_attempt_at <= now);
  let anySuccess = false;

  for (const entry of ready) {
    const idx = queue.indexOf(entry);
    try {
      await postIngest(entry.payload);
      queue.splice(idx, 1);
      anySuccess = true;
      console.log(`[tailer] POST ok: ${entry.payload.session_id} uuid=${entry.payload.uuid} role=${entry.payload.role}`);
    } catch (err) {
      entry.attempts += 1;
      const backoff = Math.min(
        RETRY_BASE_MS * Math.pow(2, entry.attempts - 1),
        RETRY_MAX_MS,
      );
      const jitter = backoff * RETRY_JITTER * (Math.random() * 2 - 1);
      entry.next_attempt_at = now + backoff + jitter;
      console.error(
        `[tailer] POST failed (attempt ${entry.attempts}), retry in ${Math.round(backoff / 1000)}s:`,
        err,
      );
    }
  }

  // Persist cursors after successful delivery — ensures restarts don't lose progress
  if (anySuccess && pendingPersist) {
    persistCursors();
    pendingPersist = false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("[tailer] starting Phase 7a ingest daemon");
console.log(`[tailer] Qoopia URL: ${QOOPIA_URL}`);
console.log(`[tailer] ingest key: ${INGEST_KEY_PATH}`);
console.log(`[tailer] cursors: ${CURSORS_PATH}`);

// Load persisted cursors BEFORE starting watchers so we resume from last known positions
loadCursors();

watchProjectsDir();

// Periodic queue flush (also persists cursors after successful delivery)
setInterval(flushQueue, QUEUE_FLUSH_INTERVAL_MS);

// Periodic allowlist refresh (TTL is handled inside fetchAllowlist)
setInterval(() => fetchAllowlist().catch(console.error), ALLOWLIST_TTL_MS);

// Periodic cursor persist safety net (in case queue stays empty but cursors moved)
setInterval(() => {
  if (pendingPersist) {
    persistCursors();
    pendingPersist = false;
  }
}, CURSORS_PERSIST_INTERVAL_MS);

// Persist on process exit (SIGTERM, SIGINT)
process.on("SIGTERM", () => { persistCursors(); process.exit(0); });
process.on("SIGINT",  () => { persistCursors(); process.exit(0); });

console.log("[tailer] ready");
