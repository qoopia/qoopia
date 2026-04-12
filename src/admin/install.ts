import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { runMigrations } from "../db/migrate.ts";
import { db } from "../db/connection.ts";
import { createWorkspace } from "./workspaces.ts";
import { createAgent } from "./agents.ts";
import { env } from "../utils/env.ts";
import { getRolePreset, ROLE_PRESET_NAMES, listRolePresets } from "./templates.ts";
import { ulid } from "ulid";
import { nowIso } from "../utils/errors.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");

function banner(title: string) {
  console.log("\n┌─────────────────────────────────────────────┐");
  console.log(`│  ${title.padEnd(43)}│`);
  console.log("└─────────────────────────────────────────────┘\n");
}

function step(msg: string) {
  console.log(`✓ ${msg}`);
}

function findBun(): string {
  try {
    return execSync("which bun", { encoding: "utf8" }).trim();
  } catch {
    // Fallback guesses
    for (const candidate of [
      path.join(os.homedir(), ".bun/bin/bun"),
      "/opt/homebrew/bin/bun",
      "/usr/local/bin/bun",
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error("bun not found — install Bun first (https://bun.sh)");
  }
}

// ---- Interactive prompt helpers ----

function isInteractive(): boolean {
  return process.stdin.isTTY === true;
}

async function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

async function choose(question: string, options: string[]): Promise<string> {
  console.log(`\n  ${question}`);
  for (let i = 0; i < options.length; i++) {
    console.log(`    (${i + 1}) ${options[i]}`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("  Choice: ", (answer) => {
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      if (idx >= 0 && idx < options.length) {
        resolve(options[idx]!);
      } else {
        resolve(options[0]!); // default to first
      }
    });
  });
}

export interface InstallOpts {
  stewardName?: string;
  stewardRole?: string;
  yes?: boolean;
}

export async function install(opts: InstallOpts = {}) {
  const start = Date.now();
  banner("Qoopia V3.0 installer");

  // 1. Directories
  fs.mkdirSync(env.DATA_DIR, { recursive: true });
  fs.chmodSync(env.DATA_DIR, 0o700);
  fs.mkdirSync(env.LOG_DIR, { recursive: true });
  fs.mkdirSync(env.BACKUP_DIR, { recursive: true });
  step(`Data directory: ${env.DATA_DIR}`);
  step(`Logs directory: ${env.LOG_DIR}`);
  step(`Backups directory: ${env.BACKUP_DIR}`);

  // 2. Migrations (connection.ts already opened DB; runMigrations applies)
  runMigrations();
  step("Migrations applied");

  // 3. Default workspace
  let workspaceSlug = "default";
  const existing = db
    .prepare(`SELECT id FROM workspaces WHERE slug = ?`)
    .get(workspaceSlug);
  if (!existing) {
    createWorkspace({ name: "Default", slug: workspaceSlug });
    step(`Workspace created: ${workspaceSlug}`);
  } else {
    step(`Workspace already exists: ${workspaceSlug}`);
  }

  // 4. Steward setup (interactive or via flags)
  let stewardName = opts.stewardName;
  let stewardRole = opts.stewardRole;

  if (!stewardName && isInteractive() && !opts.yes) {
    console.log("\n  ─── Steward Agent Setup ───\n");
    console.log("  The steward manages Qoopia through chat (create agents, onboard, etc.).\n");
    stewardName = await ask("Primary agent name (will become steward)", "Alan");
    const presets = listRolePresets();
    stewardRole = await choose(
      "Select steward's role preset:",
      presets.map((p) => `${p.name} — ${p.displayName}`),
    );
    // Extract preset name from "name — displayName" format
    stewardRole = stewardRole.split(" — ")[0]!;
  }

  // Create steward agent (or fallback admin agent)
  let agentKey: string | null = null;
  let agentName: string;
  let agentType: string;
  let bootstrapCount = 0;
  let systemPrompt: string | null = null;

  if (stewardName) {
    agentName = stewardName;
    agentType = "steward";
  } else {
    agentName = "admin";
    agentType = "standard";
  }

  const agentExists = db
    .prepare(
      `SELECT id FROM agents WHERE name = ? AND workspace_id = (SELECT id FROM workspaces WHERE slug = ?)`,
    )
    .get(agentName, workspaceSlug);

  if (!agentExists) {
    const created = createAgent({
      name: agentName,
      workspaceSlug,
      type: agentType as "standard" | "claude-privileged" | "steward",
    });
    agentKey = created.api_key;

    // Bootstrap notes from role preset (if steward with role)
    if (agentType === "steward" && stewardRole) {
      try {
        const preset = getRolePreset(stewardRole);
        const now = nowIso();
        for (const note of preset.bootstrapNotes) {
          const noteId = ulid();
          db.prepare(
            `INSERT INTO notes (id, workspace_id, agent_id, type, text, metadata, tags, source, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, '{}', ?, 'installer', ?, ?)`,
          ).run(
            noteId,
            created.workspace_id,
            created.id,
            note.type,
            note.text,
            JSON.stringify(note.tags),
            now,
            now,
          );
          bootstrapCount++;
        }
        systemPrompt = preset.systemPrompt;
        step(`Steward '${agentName}' created with role '${stewardRole}' (${bootstrapCount} bootstrap notes)`);
      } catch (e) {
        step(`Steward '${agentName}' created (role preset '${stewardRole}' failed: ${e})`);
      }
    } else {
      step(`Agent '${agentName}' created (type: ${agentType})`);
    }
  } else {
    step(`Agent '${agentName}' already exists (use \`qoopia admin rotate-key ${agentName}\` to get a new key)`);
  }

  // 5. launchd plist
  const bunPath = findBun();
  const qoopiaEntry = path.join(PROJECT_ROOT, "src/index.ts");
  const plistTemplate = fs.readFileSync(
    path.join(PROJECT_ROOT, "templates/com.qoopia.mcp.plist"),
    "utf8",
  );
  const plist = plistTemplate
    .replace(/{{BUN_PATH}}/g, bunPath)
    .replace(/{{QOOPIA_ENTRY}}/g, qoopiaEntry)
    .replace(/{{QOOPIA_DATA_DIR}}/g, env.DATA_DIR)
    .replace(/{{QOOPIA_PORT}}/g, String(env.PORT))
    .replace(/{{LOG_DIR}}/g, env.LOG_DIR)
    .replace(/{{BACKUP_DIR}}/g, env.BACKUP_DIR)
    .replace(/{{QOOPIA_PUBLIC_URL}}/g, env.PUBLIC_URL)
    .replace(/{{WORKING_DIR}}/g, PROJECT_ROOT);

  const plistDir = path.join(os.homedir(), "Library/LaunchAgents");
  fs.mkdirSync(plistDir, { recursive: true });
  const plistPath = path.join(plistDir, "com.qoopia.mcp.plist");
  fs.writeFileSync(plistPath, plist, "utf8");
  step(`LaunchAgent plist written: ${plistPath}`);

  // 6. Load service (unload first if already loaded)
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
  } catch {}
  try {
    execSync(`launchctl load "${plistPath}"`, { stdio: "ignore" });
    step("LaunchAgent loaded");
  } catch (err) {
    console.warn(
      `⚠ launchctl load failed (you can run the server manually with \`bun run src/index.ts\`): ${err}`,
    );
  }

  // 7. Health probe
  const probeStart = Date.now();
  let up = false;
  while (Date.now() - probeStart < 15_000) {
    try {
      const resp = await fetch(`http://localhost:${env.PORT}/health`);
      if (resp.ok) {
        up = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  if (up) step(`Server responding on http://localhost:${env.PORT}`);
  else
    console.warn(
      `⚠ Server not reachable after 15s. Check logs at ${env.LOG_DIR}/qoopia.stderr.log`,
    );

  // 8. Summary
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log("\n━━━━━━━━━━━━━━━��━━━━━━━━━━━━━��━━━━━━━━━━━━━━━");
  console.log(`  INSTALLATION COMPLETE — ${elapsed} seconds`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  console.log(`  MCP URL:   http://localhost:${env.PORT}/mcp`);
  if (agentKey) {
    console.log(`\n  ${agentType === "steward" ? "Steward" : "Admin"} API key:  ${agentKey}`);
    console.log("\n  ⚠ Save this API key — it won't be shown again.\n");
    console.log("  MCP config (copy to ~/.claude.json or your MCP client):\n");
    console.log("  {");
    console.log('    "qoopia": {');
    console.log('      "type": "streamable-http",');
    console.log(`      "url": "http://localhost:${env.PORT}/mcp",`);
    console.log(`      "headers": {"Authorization": "Bearer ${agentKey}"}`);
    console.log("    }");
    console.log("  }\n");
    console.log(`  Claude Code CLI:`);
    console.log(`  claude mcp add qoopia --transport streamable-http \\`);
    console.log(`    --url http://localhost:${env.PORT}/mcp \\`);
    console.log(`    --header "Authorization: Bearer ${agentKey}"\n`);
  }
  if (systemPrompt) {
    console.log("  ─── System Prompt (copy to agent config) ───\n");
    console.log(systemPrompt);
    console.log("  ─── End System Prompt ───\n");
  }
  if (agentType === "steward") {
    console.log("  Next steps:");
    console.log("    1. Copy the API key to your password manager");
    console.log("    2. Add the MCP config to your agent's settings");
    console.log("    3. Copy the system prompt to your agent's config");
    console.log(`    4. Start a chat with ${agentName} — it can now manage Qoopia`);
    console.log(`    5. Try: "show all agents in Qoopia"\n`);
  } else {
    console.log("  Next steps:");
    console.log("    qoopia admin create-agent <name> --workspace default [--type steward]");
    console.log("    qoopia status");
    console.log("    qoopia logs\n");
  }
}
