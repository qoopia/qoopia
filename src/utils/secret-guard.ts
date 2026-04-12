/**
 * Reject any text that contains a Qoopia API key pattern.
 * Defense-in-depth: prevents accidental leakage into activity logs,
 * notes, session messages, or any other persisted text field.
 */
import { QoopiaError } from "./errors.ts";

const API_KEY_RE = /q_[A-Za-z0-9_\-]{32,}/;

export function assertNoSecrets(text: string, context: string): void {
  if (API_KEY_RE.test(text)) {
    throw new QoopiaError(
      "INVALID_INPUT",
      `API key pattern detected in ${context} — refused. Never store plaintext keys in Qoopia.`,
    );
  }
}
