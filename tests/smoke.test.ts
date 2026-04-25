/**
 * End-to-end smoke test: boot the HTTP server on an ephemeral port, create a
 * workspace + agent in-process, then exercise the public endpoints (/health,
 * /api/v1/notes via Bearer auth) and confirm a saved note can be recalled.
 *
 * The server listens on QOOPIA_PORT=0 (set by tests/setup.ts) so the OS
 * assigns a free port and parallel test runs never collide.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";
import { createNote } from "../src/services/notes.ts";

let server: Server;
let baseUrl = "";
let API_KEY = "";
let WORKSPACE_ID = "";
let AGENT_ID = "";

beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({ name: "Smoke Test", slug: "smoke-test" });
  WORKSPACE_ID = ws.id;
  const ag = createAgent({ name: "smoke-tester", workspaceSlug: ws.slug });
  AGENT_ID = ag.id;
  API_KEY = ag.api_key;

  server = startHttpServer();
  // Wait for the listener to actually bind.
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  // Only stop the HTTP listener — leave the SQLite singleton open. Other test
  // files that ran first (notes, auth) still hold module references to it via
  // their own beforeAll(), and Bun's test runner spawns one process per glob
  // match, so closing here would break sibling files when ordering changes.
  // setup.ts cleans the temp dir on process exit.
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("smoke: HTTP boot", () => {
  test("/health returns 200 ok", async () => {
    const r = await fetch(`${baseUrl}/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
    expect(body.version).toBe("3.0.0");
  });

  test("dashboard API requires Bearer auth", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/agents`);
    expect(r.status).toBe(401);
  });

  test("dashboard API with valid agent key returns its workspace", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/agents`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: Array<{ id: string; workspace_id: string; name: string }>;
      total: number;
    };
    const found = body.items.find((a) => a.id === AGENT_ID);
    expect(found).toBeDefined();
    expect(found?.workspace_id).toBe(WORKSPACE_ID);
  });
});

describe("smoke: save → recall round-trip", () => {
  test("a note created in-process is visible via dashboard notes endpoint", async () => {
    const created = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "smoke memory: boot succeeded",
      type: "memory",
    });

    const r = await fetch(
      `${baseUrl}/api/dashboard/agents/${AGENT_ID}/notes?type=memory&limit=10`,
      { headers: { authorization: `Bearer ${API_KEY}` } },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: Array<{ id: string; text: string; type: string }>;
    };
    const found = body.items.find((n) => n.id === created.id);
    expect(found).toBeDefined();
    expect(found?.text).toBe("smoke memory: boot succeeded");
    expect(found?.type).toBe("memory");
  });
});
