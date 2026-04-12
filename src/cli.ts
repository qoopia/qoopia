#!/usr/bin/env bun
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { install } from "./admin/install.ts";
import { runMigrations } from "./db/migrate.ts";
import {
  createAgent,
  listAgents,
  rotateAgentKey,
  deleteAgent,
} from "./admin/agents.ts";
import { createWorkspace, listWorkspaces } from "./admin/workspaces.ts";
import { env } from "./utils/env.ts";
import { db, closeDb } from "./db/connection.ts";

const argv = process.argv.slice(2);
const cmd = argv[0];

function usage() {
  console.log(`Usage: qoopia <command> [args]

Commands:
  install                                       Run first-time installer
  uninstall                                     Stop service + unload plist
  status                                        Health check
  logs [--follow]                               Tail server log
  version                                       Print version and DB schema version
  backup [--to <path>]                          Manual SQLite backup
  admin create-workspace <name> [--slug <slug>]
  admin list-workspaces
  admin create-agent <name> --workspace <slug> [--type standard|claude-privileged]
  admin list-agents
  admin rotate-key <name> --workspace <slug>
  admin delete-agent <name> --workspace <slug>
`);
}

function arg(name: string, def?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return argv[i + 1];
}

function need(name: string, value: string | undefined): string {
  if (!value) {
    console.error(`Missing --${name}`);
    process.exit(2);
  }
  return value;
}

async function main() {
  // Always run pending migrations before any CLI command touches the DB
  try {
    runMigrations();
  } catch (err) {
    // Non-fatal for version/status/logs commands; log and continue
    if (cmd !== "version" && cmd !== "status" && cmd !== "logs") {
      throw err;
    }
  }
  try {
    switch (cmd) {
      case undefined:
      case "-h":
      case "--help":
      case "help":
        usage();
        return;
      case "version": {
        const ver = db
          .prepare(`SELECT version FROM schema_versions ORDER BY version DESC LIMIT 1`)
          .get() as { version: number } | undefined;
        console.log(`qoopia 3.0.0  schema ${ver?.version ?? 0}`);
        return;
      }
      case "status": {
        try {
          const res = await fetch(`http://localhost:${env.PORT}/health`);
          if (res.ok) {
            const body = (await res.json()) as Record<string, unknown>;
            console.log(`running  port=${env.PORT}  uptime=${body.uptime}s`);
          } else {
            console.log(`stopped  (HTTP ${res.status})`);
          }
        } catch {
          console.log(`stopped  (no response on port ${env.PORT})`);
        }
        return;
      }
      case "logs": {
        const follow = argv.includes("--follow");
        const file = path.join(env.LOG_DIR, "qoopia.stdout.log");
        if (!fs.existsSync(file)) {
          console.log(`(no log file at ${file})`);
          return;
        }
        if (follow) {
          execSync(`tail -f "${file}"`, { stdio: "inherit" });
        } else {
          execSync(`tail -n 50 "${file}"`, { stdio: "inherit" });
        }
        return;
      }
      case "install":
        await install();
        return;
      case "uninstall": {
        const plistPath = path.join(
          os.homedir(),
          "Library/LaunchAgents/com.qoopia.mcp.plist",
        );
        try {
          execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
        } catch {}
        if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
        console.log("Service stopped and plist removed.");
        console.log(`Data at ${env.DATA_DIR} preserved (rm -rf ~/.qoopia to delete).`);
        return;
      }
      case "backup": {
        const to = arg("to", path.join(env.BACKUP_DIR, `qoopia-manual-${Date.now()}.db`));
        db.exec(`VACUUM INTO '${to!.replace(/'/g, "''")}'`);
        console.log(`Backup written to ${to}`);
        return;
      }
      case "admin": {
        const sub = argv[1];
        switch (sub) {
          case "create-workspace": {
            const name = argv[2];
            if (!name) return console.error("Missing workspace name");
            const ws = createWorkspace({ name, slug: arg("slug") });
            console.log(`Created workspace ${ws.slug} (${ws.id})`);
            return;
          }
          case "list-workspaces": {
            for (const w of listWorkspaces() as Array<{ name: string; slug: string; id: string }>) {
              console.log(`${w.slug.padEnd(20)} ${w.name}  (${w.id})`);
            }
            return;
          }
          case "create-agent": {
            const name = argv[2];
            if (!name) return console.error("Missing agent name");
            const workspace = need("workspace", arg("workspace"));
            const type = (arg("type", "standard") as "standard" | "claude-privileged");
            const created = createAgent({
              name,
              workspaceSlug: workspace,
              type,
            });
            console.log(`Created agent '${name}' in ${workspace}`);
            console.log(`API key: ${created.api_key}`);
            console.log("(Save this — it won't be shown again.)");
            return;
          }
          case "list-agents": {
            for (const a of listAgents() as Array<any>) {
              console.log(
                `${a.workspace_slug.padEnd(18)} ${a.name.padEnd(16)} ${a.type.padEnd(18)} active=${a.active} last_seen=${a.last_seen || "-"}`,
              );
            }
            return;
          }
          case "rotate-key": {
            const name = argv[2];
            if (!name) return console.error("Missing agent name");
            const workspace = need("workspace", arg("workspace"));
            const key = rotateAgentKey(name, workspace);
            console.log(`New API key for ${name}: ${key}`);
            return;
          }
          case "delete-agent": {
            const name = argv[2];
            if (!name) return console.error("Missing agent name");
            const workspace = need("workspace", arg("workspace"));
            deleteAgent(name, workspace);
            console.log(`Agent ${name} deactivated.`);
            return;
          }
          default:
            usage();
            return;
        }
      }
      default:
        console.error(`Unknown command: ${cmd}`);
        usage();
        process.exit(2);
    }
  } finally {
    closeDb();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  closeDb();
  process.exit(1);
});
