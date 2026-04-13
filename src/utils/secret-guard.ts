/**
 * Reject any text that contains a Qoopia API key pattern.
 * Defense-in-depth: prevents accidental leakage into activity logs,
 * notes, session messages, or any other persisted text field.
 */
import { QoopiaError } from "./errors.ts";

// Matches: q_ (API keys), qa_ (access tokens), qr_ (refresh tokens), qc_ (auth codes/client IDs), qcs_ (OAuth client secrets)
const SECRET_RE = /(?:q_|qa_|qr_|qc_|qcs_)[A-Za-z0-9_\-]{16,}/;

export function assertNoSecrets(text: string, context: string): void {
  if (SECRET_RE.test(text)) {
    throw new QoopiaError(
      "INVALID_INPUT",
      `Secret pattern detected in ${context} — refused. Never store plaintext keys/tokens in Qoopia.`,
    );
  }
}
