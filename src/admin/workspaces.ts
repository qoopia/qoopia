import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import { QoopiaError } from "../utils/errors.ts";

export function createWorkspace(opts: { name: string; slug?: string }): {
  id: string;
  name: string;
  slug: string;
} {
  const slug =
    opts.slug ||
    opts.name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const existing = db
    .prepare(`SELECT id FROM workspaces WHERE slug = ?`)
    .get(slug);
  if (existing) throw new QoopiaError("CONFLICT", `workspace slug '${slug}' exists`);
  const id = ulid();
  db.prepare(`INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)`).run(
    id,
    opts.name,
    slug,
  );
  return { id, name: opts.name, slug };
}

export function listWorkspaces() {
  return db
    .prepare(
      `SELECT id, name, slug, created_at FROM workspaces ORDER BY created_at ASC`,
    )
    .all();
}
