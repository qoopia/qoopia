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
  // When true (default), loopback requests may carry trusted proxy headers (cf-connecting-ip, x-forwarded-for).
  // Set TRUST_PROXY=false if Qoopia is exposed directly (no Cloudflare tunnel / reverse proxy).
  TRUST_PROXY: (process.env.TRUST_PROXY ?? "true") !== "false",
};

if (!env.OAUTH_ISSUER) env.OAUTH_ISSUER = env.PUBLIC_URL;
