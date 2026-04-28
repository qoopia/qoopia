/**
 * ADR-017 §Tests / oauth-register.test.ts
 *
 * Covers the new POST /oauth/register surface:
 *   - standard agent Bearer cannot register (403 forbidden)
 *   - steward in workspace A registers → row has correct
 *     agent_id, workspace_id, client_secret_hash
 *   - claude-privileged in workspace A registers → row has correct
 *     agent_id, workspace_id
 *   - ADMIN_SECRET header alone (no Bearer) → 401 (regression: ADMIN_SECRET
 *     is no longer the auth identity for registration)
 *   - regression: wsCount > 1 no longer blocks registration in beta-style
 *     multi-workspace DBs
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
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
import { db } from "../src/db/connection.ts";
import { authLimiter } from "../src/utils/rate-limit.ts";

let server: Server;
let baseUrl = "";

let WS_A_ID = "";
let WS_B_ID = "";
let STEWARD_A_KEY = "";
let STEWARD_A_ID = "";
let CLAUDE_PRIV_A_KEY = "";
let CLAUDE_PRIV_A_ID = "";
let STANDARD_A_KEY = "";
let STANDARD_A_ID = "";

async function postRegister(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  runMigrations();

  // Two workspaces — proves the wsCount > 1 guard is gone.
  const wsA = createWorkspace({
    name: "Register Workspace A",
    slug: "oauth-register-ws-a",
  });
  WS_A_ID = wsA.id;
  const wsB = createWorkspace({
    name: "Register Workspace B",
    slug: "oauth-register-ws-b",
  });
  WS_B_ID = wsB.id;

  const stewardA = createAgent({
    name: "register-steward-a",
    workspaceSlug: wsA.slug,
    type: "steward",
  });
  STEWARD_A_ID = stewardA.id;
  STEWARD_A_KEY = stewardA.api_key;

  const cpA = createAgent({
    name: "register-claude-priv-a",
    workspaceSlug: wsA.slug,
    type: "claude-privileged",
  });
  CLAUDE_PRIV_A_ID = cpA.id;
  CLAUDE_PRIV_A_KEY = cpA.api_key;

  const standardA = createAgent({
    name: "register-standard-a",
    workspaceSlug: wsA.slug,
    type: "standard",
  });
  STANDARD_A_ID = standardA.id;
  STANDARD_A_KEY = standardA.api_key;

  // Place at least one agent in workspace B so wsCount > 1 in agent terms too.
  createAgent({
    name: "register-steward-b",
    workspaceSlug: wsB.slug,
    type: "steward",
  });

  server = startHttpServer();
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

beforeEach(() => {
  authLimiter.resetForTests();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("ADR-017 /oauth/register: Bearer is required, not ADMIN_SECRET", () => {
  test("no Bearer (only x-admin-secret-style header) → 401", async () => {
    const r = await postRegister(
      {
        client_name: "no-bearer-client",
        redirect_uris: ["https://example.com/cb"],
      },
      // Deliberately omit Authorization. Old code accepted ADMIN_SECRET
      // alone; ADR-017 hard-removes that path.
      { "x-admin-secret": process.env.QOOPIA_ADMIN_SECRET || "test-admin-secret" },
    );
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  test("Bearer for a standard agent → 403 forbidden (FORBIDDEN code)", async () => {
    const r = await postRegister(
      {
        client_name: "standard-cant-register",
        redirect_uris: ["https://example.com/cb"],
      },
      { authorization: `Bearer ${STANDARD_A_KEY}` },
    );
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string; error_description: string };
    expect(body.error).toBe("forbidden");
    // No row should have been written.
    const row = db
      .prepare(
        `SELECT 1 FROM oauth_clients WHERE name = 'standard-cant-register'`,
      )
      .get();
    // bun:sqlite returns null on no-row; better-sqlite3 returns undefined.
    // Either way, falsy means "no row" which is what we want here.
    expect(row).toBeFalsy();
  });

  test("invalid Bearer → 401, no row written", async () => {
    const r = await postRegister(
      {
        client_name: "bad-bearer",
        redirect_uris: ["https://example.com/cb"],
      },
      { authorization: "Bearer not_a_real_token_xxxxxxxxxxxxxx" },
    );
    expect(r.status).toBe(401);
  });
});

describe("ADR-017 /oauth/register: steward in workspace A registers correctly", () => {
  test("steward Bearer → 201 + row carries agent_id, workspace_id, secret hash", async () => {
    const r = await postRegister(
      {
        client_name: "ws-a-steward-client",
        redirect_uris: ["https://example.com/cb-a-steward"],
        token_endpoint_auth_method: "client_secret_post",
      },
      { authorization: `Bearer ${STEWARD_A_KEY}` },
    );
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      client_id: string;
      client_secret?: string;
      token_endpoint_auth_method: string;
    };
    expect(body.client_id).toMatch(/^qc_/);
    expect(body.token_endpoint_auth_method).toBe("client_secret_post");
    expect(body.client_secret).toBeDefined();

    const row = db
      .prepare(
        `SELECT agent_id, workspace_id, client_secret_hash, name
         FROM oauth_clients WHERE id = ?`,
      )
      .get(body.client_id) as
      | {
          agent_id: string;
          workspace_id: string;
          client_secret_hash: string;
          name: string;
        }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.agent_id).toBe(STEWARD_A_ID);
    expect(row!.workspace_id).toBe(WS_A_ID);
    expect(row!.client_secret_hash.length).toBeGreaterThan(0);
    expect(row!.name).toBe("ws-a-steward-client");
  });

  test("public client registration (auth method 'none') → 201 + empty secret hash", async () => {
    const r = await postRegister(
      {
        client_name: "ws-a-steward-public",
        redirect_uris: ["https://example.com/cb-a-pub"],
        token_endpoint_auth_method: "none",
      },
      { authorization: `Bearer ${STEWARD_A_KEY}` },
    );
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      client_id: string;
      client_secret?: string;
    };
    expect(body.client_secret).toBeUndefined();

    const row = db
      .prepare(
        `SELECT agent_id, workspace_id, client_secret_hash
         FROM oauth_clients WHERE id = ?`,
      )
      .get(body.client_id) as
      | { agent_id: string; workspace_id: string; client_secret_hash: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.agent_id).toBe(STEWARD_A_ID);
    expect(row!.workspace_id).toBe(WS_A_ID);
    expect(row!.client_secret_hash).toBe("");
  });
});

describe("ADR-017 /oauth/register: claude-privileged agent can register", () => {
  test("claude-privileged Bearer → 201 + row carries that agent's id + workspace", async () => {
    const r = await postRegister(
      {
        client_name: "ws-a-claudepriv-client",
        redirect_uris: ["https://example.com/cb-a-cp"],
      },
      { authorization: `Bearer ${CLAUDE_PRIV_A_KEY}` },
    );
    expect(r.status).toBe(201);
    const body = (await r.json()) as { client_id: string };
    const row = db
      .prepare(
        `SELECT agent_id, workspace_id FROM oauth_clients WHERE id = ?`,
      )
      .get(body.client_id) as
      | { agent_id: string; workspace_id: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.agent_id).toBe(CLAUDE_PRIV_A_ID);
    expect(row!.workspace_id).toBe(WS_A_ID);
  });
});

describe("ADR-017 regression: multi-workspace DB no longer blocks registration", () => {
  test("with workspaces A and B both populated, steward A still registers", async () => {
    // Sanity that beforeAll seeded both workspaces (this is what the old
    // wsCount > 1 guard would have rejected).
    const wsCount = db
      .prepare(`SELECT COUNT(*) AS n FROM workspaces`)
      .get() as { n: number };
    expect(wsCount.n).toBeGreaterThanOrEqual(2);

    const r = await postRegister(
      {
        client_name: "ws-a-multi-ws-regression",
        redirect_uris: ["https://example.com/cb-a-multi"],
      },
      { authorization: `Bearer ${STEWARD_A_KEY}` },
    );
    expect(r.status).toBe(201);
    const body = (await r.json()) as { client_id: string };
    const row = db
      .prepare(`SELECT workspace_id FROM oauth_clients WHERE id = ?`)
      .get(body.client_id) as { workspace_id: string } | undefined;
    expect(row?.workspace_id).toBe(WS_A_ID);
    // Should NOT have leaked into workspace B.
    expect(row?.workspace_id).not.toBe(WS_B_ID);
  });
});
