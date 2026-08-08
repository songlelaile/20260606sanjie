import { describe, expect, it } from "vitest";
import { resolveAiEncryptionKeySource } from "@/lib/ai-encryption-key";

describe("AI API encryption key policy", () => {
  it.each([undefined, "short", "change-me-to-a-third-long-random-string"])(
    "rejects missing, weak or example production keys: %s",
    (value) => {
      expect(() => resolveAiEncryptionKeySource({
        NODE_ENV: "production",
        AI_API_ENCRYPTION_KEY: value,
        SHARE_ENCRYPTION_KEY: "share-key-that-must-not-be-reused-in-production",
        SESSION_SECRET: "session-key-that-must-not-be-reused-in-production"
      })).toThrow(/AI_API_ENCRYPTION_KEY/);
    }
  );

  it("accepts a dedicated production key", () => {
    const key = "a".repeat(64);
    expect(resolveAiEncryptionKeySource({
      NODE_ENV: "production",
      AI_API_ENCRYPTION_KEY: key,
      SHARE_ENCRYPTION_KEY: "different-share-key",
      SESSION_SECRET: "different-session-key"
    })).toBe(key);
  });

  it("rejects reuse of the session or share key", () => {
    const reused = "b".repeat(64);
    expect(() => resolveAiEncryptionKeySource({
      NODE_ENV: "production",
      AI_API_ENCRYPTION_KEY: reused,
      SHARE_ENCRYPTION_KEY: reused,
      SESSION_SECRET: "c".repeat(64)
    })).toThrow(/AI_API_ENCRYPTION_KEY/);
  });
});
