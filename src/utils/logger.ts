import { env } from "./env.ts";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
const threshold = LEVELS[env.LOG_LEVEL] ?? LEVELS.info;

function fmt(level: string, msg: string, ctx?: unknown): string {
  const stamp = new Date().toISOString();
  const ctxStr = ctx ? " " + JSON.stringify(ctx) : "";
  return `${stamp} ${level.toUpperCase()} ${msg}${ctxStr}`;
}

export const logger = {
  debug(msg: string, ctx?: unknown) {
    if (threshold <= LEVELS.debug) console.log(fmt("debug", msg, ctx));
  },
  info(msg: string, ctx?: unknown) {
    if (threshold <= LEVELS.info) console.log(fmt("info", msg, ctx));
  },
  warn(msg: string, ctx?: unknown) {
    if (threshold <= LEVELS.warn) console.warn(fmt("warn", msg, ctx));
  },
  error(msg: string, ctx?: unknown) {
    if (threshold <= LEVELS.error) console.error(fmt("error", msg, ctx));
  },
};
