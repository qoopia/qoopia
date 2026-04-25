/**
 * Note service tests — exercise createNote / getNote / listNotes /
 * updateNote / deleteNote against a fresh in-temp-dir SQLite (set by
 * tests/setup.ts).  Each test file gets its own workspace+agent so suites
 * don't collide.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import {
  createNote,
  getNote,
  listNotes,
  updateNote,
  deleteNote,
} from "../src/services/notes.ts";
import { QoopiaError } from "../src/utils/errors.ts";

let WORKSPACE_ID = "";
let AGENT_ID = "";

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "Notes Test", slug: "notes-test" });
  WORKSPACE_ID = ws.id;
  const ag = createAgent({ name: "notes-tester", workspaceSlug: ws.slug });
  AGENT_ID = ag.id;
});

afterAll(() => {
  // setup.ts unlinks the temp dir on process exit; nothing to do here.
});

describe("createNote", () => {
  test("creates a basic note and assigns an id", () => {
    const result = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "first note",
    });
    expect(result.created).toBe(true);
    expect(result.id).toMatch(/^[0-9A-Z]{26}$/); // ULID format
    expect(result.type).toBe("note");

    const fetched = getNote(WORKSPACE_ID, result.id);
    expect(fetched.text).toBe("first note");
    expect(fetched.workspace_id).toBe(WORKSPACE_ID);
    expect(fetched.deleted_at).toBeNull();
  });

  test("rejects empty text", () => {
    expect(() =>
      createNote({ workspace_id: WORKSPACE_ID, agent_id: AGENT_ID, text: "" }),
    ).toThrow(QoopiaError);
  });

  test("rejects text containing a Qoopia secret", () => {
    expect(() =>
      createNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        text: "leaked q_ABCDEFGHIJKLMNOPQRSTUVWX",
      }),
    ).toThrow(QoopiaError);
  });

  test("rejects unknown project_id", () => {
    expect(() =>
      createNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        text: "with bogus project",
        project_id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
      }),
    ).toThrow(/project_id not found/);
  });

  test("typed notes are persisted with their type", () => {
    const r = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "remember the milk",
      type: "memory",
      tags: ["chore"],
    });
    const fetched = getNote(WORKSPACE_ID, r.id);
    expect(fetched.type).toBe("memory");
    expect(fetched.tags).toEqual(["chore"]);
  });
});

describe("listNotes", () => {
  test("filters by type and respects limit", () => {
    for (let i = 0; i < 3; i++) {
      createNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        text: `task #${i}`,
        type: "task",
      });
    }

    const result = listNotes({
      workspace_id: WORKSPACE_ID,
      type: "task",
      limit: 2,
    });
    expect(result.items.length).toBe(2);
    expect(result.items.every((n) => n.type === "task")).toBe(true);
    expect(result.total).toBeGreaterThanOrEqual(3);
    expect(result.has_more).toBe(true);
  });
});

describe("updateNote", () => {
  test("merges metadata by default and replaces with metadata_replace", () => {
    const r = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "merge target",
      metadata: { a: 1, b: 2 },
    });

    updateNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      id: r.id,
      metadata: { b: 99, c: 3 },
    });
    const merged = getNote(WORKSPACE_ID, r.id);
    expect(merged.metadata).toEqual({ a: 1, b: 99, c: 3 });

    updateNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      id: r.id,
      metadata_replace: { only: "this" },
    });
    const replaced = getNote(WORKSPACE_ID, r.id);
    expect(replaced.metadata).toEqual({ only: "this" });
  });

  test("rejects mutually exclusive metadata args", () => {
    const r = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "exclusive args",
    });
    expect(() =>
      updateNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        id: r.id,
        metadata: { x: 1 },
        metadata_replace: { y: 2 },
      }),
    ).toThrow(/mutually exclusive/);
  });
});

describe("deleteNote", () => {
  test("soft-deletes the note and hides it from getNote", () => {
    const r = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "to be deleted",
    });
    const result = deleteNote(WORKSPACE_ID, AGENT_ID, r.id);
    expect(result.deleted).toBe(true);
    expect(() => getNote(WORKSPACE_ID, r.id)).toThrow(/not found/);
  });

  test("listNotes hides soft-deleted notes by default", () => {
    const r = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "hide-after-delete",
      type: "decision",
    });
    deleteNote(WORKSPACE_ID, AGENT_ID, r.id);
    const visible = listNotes({ workspace_id: WORKSPACE_ID, type: "decision" });
    expect(visible.items.find((n) => n.id === r.id)).toBeUndefined();
  });
});
