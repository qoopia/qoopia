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

function getIngestKey(): string {
  if (ingestKey) return ingestKey;
  if (!fs.existsSync(INGEST_KEY_PATH)) {
    throw new Error(`Ingest key not found at ${INGEST_KEY_PATH}. Run: qoopia admin register-ingest-daemon`);
  }
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
    body: JSON.stringify(payload),
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

interface JsonlEntry {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
}

/**
 * Extract plain text from a JSONL entry.
 * Returns null if the entry is not a whitelisted user/assistant text turn.
 */
function extractText(raw: string): { role: "user" | "assistant"; text: string; entry: JsonlEntry } | null {
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

  let text: string | null = null;
  if (typeof content === "string") {
    text = content.trim();
  } else if (Array.isArray(content)) {
    // Concatenate all text blocks; skip thinking/tool_use/tool_result
    const parts = content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string);
    if (parts.length > 0) text = parts.join("\n").trim();
  }

  if (!text) return null;
  return { role, text, entry };
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

async function processNewLines(filePath: string) {
  const allowlist = await fetchAllowlist();
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(filePath, "r");
    const stat = await fd.stat();
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

      const { role, text, entry } = result;
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
  // Init cursor at current file size (don't replay history)
  try {
    const size = fs.statSync(filePath).size;
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

  // Watch existing JSONL files
  for (const projectDir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
    const fullProjectDir = path.join(CLAUDE_PROJECTS_DIR, projectDir);
    try {
      if (!fs.statSync(fullProjectDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of fs.readdirSync(fullProjectDir)) {
      if (file.endsWith(".jsonl")) {
        watchFile(path.join(fullProjectDir, file));
      }
    }
  }

  // Watch for new project dirs / new JSONL files
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
