import { describe, expect, test } from "bun:test";
import { assertNoSecrets } from "../src/utils/secret-guard.ts";
import { QoopiaError } from "../src/utils/errors.ts";

const SAMPLE_BODY = "ABCDEFGHIJKLMNOPQRSTUVWX"; // 24 chars, satisfies {16,}

describe("assertNoSecrets", () => {
  test.each([
    ["q_", "q_" + SAMPLE_BODY],
    ["qa_", "qa_" + SAMPLE_BODY],
    ["qr_", "qr_" + SAMPLE_BODY],
    ["qc_", "qc_" + SAMPLE_BODY],
    ["qcs_", "qcs_" + SAMPLE_BODY],
  ])("rejects %s tokens", (_label, secret) => {
    expect(() => assertNoSecrets(secret, "test")).toThrow(QoopiaError);
  });

  test("rejects secret embedded in surrounding text", () => {
    const text = `here is a token q_${SAMPLE_BODY} and some trailing text`;
    expect(() => assertNoSecrets(text, "note.text")).toThrow(QoopiaError);
  });

  test("rejects secret with hyphens and underscores in body", () => {
    const text = "qa_AB-CD_EF-GH_IJ-KL_MN-OP";
    expect(() => assertNoSecrets(text, "test")).toThrow(QoopiaError);
  });

  test("accepts plain text without token prefixes", () => {
    expect(() => assertNoSecrets("hello world this is a normal note", "note.text")).not.toThrow();
  });

  test("accepts text with q_ prefix but body too short", () => {
    // body < 16 chars → does not match
    expect(() => assertNoSecrets("q_short", "test")).not.toThrow();
  });

  test("accepts empty string", () => {
    expect(() => assertNoSecrets("", "test")).not.toThrow();
  });

  test("error includes context label", () => {
    try {
      assertNoSecrets("q_" + SAMPLE_BODY, "note.metadata");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(QoopiaError);
      expect((e as QoopiaError).code).toBe("INVALID_INPUT");
      expect((e as Error).message).toContain("note.metadata");
    }
  });
});
