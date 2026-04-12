import path from "node:path";
import os from "node:os";

const HOME = os.homedir();

export const env = {
  PORT: parseInt(process.env.QOOPIA_PORT || "3737", 10),
  DATA_DIR: process.env.QOOPIA_DATA_DIR || path.join(HOME, ".qoopia/data"),
  LOG_DIR: process.env.QOOPIA_LOG_DIR || path.join(HOME, ".qoopia/logs"),
  BACKUP_DIR: process.env.QOOPIA_BACKUP_DIR || path.join(HOME, ".qoopia/backups"),
  LOG_LEVEL: (process.env.QOOPIA_LOG_LEVEL || "info") as "debug" | "info" | "warn" | "error",
  PUBLIC_URL: process.env.QOOPIA_PUBLIC_URL || `http://localhost:${parseInt(process.env.QOOPIA_PORT || "3737", 10)}`,
  OAUTH_ISSUER: process.env.QOOPIA_OAUTH_ISSUER || "",
  MAINTENANCE_HOUR: parseInt(process.env.QOOPIA_MAINTENANCE_HOUR || "4", 10),
  BACKUP_KEEP: parseInt(process.env.QOOPIA_BACKUP_KEEP || "7", 10),
  RETENTION_ACTIVITY_DAYS: parseInt(process.env.QOOPIA_RETENTION_ACTIVITY_DAYS || "90", 10),
};

if (!env.OAUTH_ISSUER) env.OAUTH_ISSUER = env.PUBLIC_URL;
