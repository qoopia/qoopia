import path from "node:path";
import os from "node:os";

const HOME = os.homedir();

function requireInt(value: string | undefined, name: string, defaultVal: number): number {
  if (value === undefined || value === "") return defaultVal;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid numeric env var ${name}=${value} — expected integer`);
  }
  return parsed;
}

export const env = {
  PORT: requireInt(process.env.QOOPIA_PORT, "QOOPIA_PORT", 3737),
  // Bind address. Default = loopback only. Production behind cloudflared/nginx
  // also stays on 127.0.0.1 (the proxy is local). Set QOOPIA_HOST=0.0.0.0 only
  // when you explicitly want LAN exposure — every auth surface (Bearer + OAuth)
  // assumes it can trust the network it listens on, so this is opt-in by design.
  HOST: process.env.QOOPIA_HOST || "127.0.0.1",
  DATA_DIR: process.env.QOOPIA_DATA_DIR || path.join(HOME, ".qoopia/data"),
  LOG_DIR: process.env.QOOPIA_LOG_DIR || path.join(HOME, ".qoopia/logs"),
  BACKUP_DIR: process.env.QOOPIA_BACKUP_DIR || path.join(HOME, ".qoopia/backups"),
  LOG_LEVEL: (process.env.QOOPIA_LOG_LEVEL || "info") as "debug" | "info" | "warn" | "error",
  PUBLIC_URL: process.env.QOOPIA_PUBLIC_URL || `http://localhost:${requireInt(process.env.QOOPIA_PORT, "QOOPIA_PORT", 3737)}`,
  OAUTH_ISSUER: process.env.QOOPIA_OAUTH_ISSUER || "",
  ADMIN_SECRET: process.env.QOOPIA_ADMIN_SECRET || "",
  MAINTENANCE_HOUR: requireInt(process.env.QOOPIA_MAINTENANCE_HOUR, "QOOPIA_MAINTENANCE_HOUR", 4),
  BACKUP_KEEP: requireInt(process.env.QOOPIA_BACKUP_KEEP, "QOOPIA_BACKUP_KEEP", 7),
  RETENTION_ACTIVITY_DAYS: requireInt(process.env.QOOPIA_RETENTION_ACTIVITY_DAYS, "QOOPIA_RETENTION_ACTIVITY_DAYS", 90),
  // Когда true, запросы от доверенных прокси могут нести клиентский IP в
  // cf-connecting-ip / x-forwarded-for. Default=false: небезопасные дефолты
  // не должны включаться сами. Поднимая Qoopia за cloudflared / nginx на
  // loopback — выставляй TRUST_PROXY=true в окружении (см. launchd plist).
  TRUST_PROXY: (process.env.TRUST_PROXY ?? "false") === "true",
  // Comma-separated список IP, которым доверяем хедеры. Запрос считается
  // пришедшим через доверенный прокси, только если socket.remoteAddress ∈ этому
  // списку. Default = loopback (нормальный случай за cloudflared/nginx).
  TRUSTED_PROXIES: (process.env.TRUSTED_PROXIES ?? "127.0.0.1,::1,::ffff:127.0.0.1")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

if (!env.OAUTH_ISSUER) env.OAUTH_ISSUER = env.PUBLIC_URL;
