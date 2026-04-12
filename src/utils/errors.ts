export type QoopiaErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "SIZE_LIMIT"
  | "UNAUTHORIZED"
  | "INTERNAL";

export class QoopiaError extends Error {
  constructor(public code: QoopiaErrorCode, message: string) {
    super(message);
    this.name = "QoopiaError";
  }

  toString() {
    return `${this.code}: ${this.message}`;
  }
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function safeJsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
