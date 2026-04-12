import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../db/migrate.ts";
import { db } from "../db/connection.ts";
import { createWorkspace } from "./workspaces.ts";
import { createAgent } from "./agents.ts";
import { env } from "../utils/env.ts";

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

export async function install() {
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

  // 4. Admin agent
  let adminKey: string | null = null;
  const adminExists = db
    .prepare(
      `SELECT id FROM agents WHERE name = 'admin' AND workspace_id = (SELECT id FROM workspaces WHERE slug = ?)`,
    )
    .get(workspaceSlug);
  if (!adminExists) {
    const created = createAgent({
      name: "admin",
      workspaceSlug,
      type: "standard",
    });
    adminKey = created.api_key;
    step("Admin agent created");
  } else {
    step("Admin agent already exists (use `qoopia admin rotate-key admin` to get a new key)");
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

  // 8. Banner
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  INSTALLATION COMPLETE — ${elapsed} seconds`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  console.log(`  MCP URL:   http://localhost:${env.PORT}/mcp`);
  if (adminKey) {
    console.log(`  Admin API key:  ${adminKey}`);
    console.log("\n  Save this API key — it won't be shown again.");
    console.log("\n  Add to your MCP client config:\n");
    console.log("  {");
    console.log('    "qoopia": {');
    console.log('      "type": "streamable-http",');
    console.log(`      "url": "http://localhost:${env.PORT}/mcp",`);
    console.log(`      "headers": {"Authorization": "Bearer ${adminKey}"}`);
    console.log("    }");
    console.log("  }");
  }
  console.log("\n  Next steps:");
  console.log("    qoopia admin create-workspace <name>");
  console.log("    qoopia admin create-agent <name> --workspace <slug>");
  console.log("    qoopia status");
  console.log("    qoopia logs\n");
}
