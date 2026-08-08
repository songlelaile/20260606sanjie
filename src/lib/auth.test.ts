import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canAccess,
  parseSession,
  serializeSession,
  type Session
} from "./auth";

const SESSION: Session = {
  username: "tenant-a",
  name: "租户 A",
  role: "tenant",
  tenantId: "tenant-a-id"
};

const DEV_FALLBACK_SECRET = "sanjie-dev-insecure-secret-change-me";

async function serializeLegacySignedSession(
  claims: object = SESSION
): Promise<string> {
  const payload = encodeURIComponent(JSON.stringify(claims));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(process.env.SESSION_SECRET ?? DEV_FALLBACK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  const hex = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex}.${payload}`;
}

afterEach(() => {
  delete process.env.LEGACY_SESSION_ACCEPT_UNTIL;
  vi.useRealTimers();
});

describe("signed session", () => {
  it("round-trips a valid signed session", async () => {
    const token = await serializeSession(SESSION);
    await expect(parseSession(token)).resolves.toEqual(SESSION);
  });

  it("rejects a tampered payload", async () => {
    const token = await serializeSession(SESSION);
    const tampered = token.replace("tenant-a-id", "tenant-b-id");
    await expect(parseSession(tampered)).resolves.toBeNull();
  });

  it("rejects an unsigned legacy cookie", async () => {
    await expect(parseSession(encodeURIComponent(JSON.stringify(SESSION)))).resolves.toBeNull();
  });

  it("rejects a signed legacy cookie when no migration cutoff is configured", async () => {
    const token = await serializeLegacySignedSession();
    await expect(parseSession(token)).resolves.toBeNull();
  });

  it("temporarily accepts a signed legacy cookie before the configured cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00.000Z"));
    process.env.LEGACY_SESSION_ACCEPT_UNTIL = "2026-07-20T08:00:00.000Z";

    const token = await serializeLegacySignedSession();
    await expect(parseSession(token)).resolves.toEqual(SESSION);
  });

  it("rejects a signed legacy cookie once the configured cutoff has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T08:00:01.000Z"));
    process.env.LEGACY_SESSION_ACCEPT_UNTIL = String(
      Math.floor(new Date("2026-07-20T08:00:00.000Z").getTime() / 1000)
    );

    const token = await serializeLegacySignedSession();
    await expect(parseSession(token)).resolves.toBeNull();
  });

  it("does not treat partially timestamped claims as a legacy session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00.000Z"));
    process.env.LEGACY_SESSION_ACCEPT_UNTIL = "2026-07-20T08:00:00.000Z";

    const token = await serializeLegacySignedSession({
      ...SESSION,
      iat: Math.floor(Date.now() / 1000)
    });
    await expect(parseSession(token)).resolves.toBeNull();
  });

  it("rejects empty tenant and username claims even when signed", async () => {
    const emptyTenant = await serializeSession({ ...SESSION, tenantId: " " });
    const emptyUsername = await serializeSession({ ...SESSION, username: "" });
    await expect(parseSession(emptyTenant)).resolves.toBeNull();
    await expect(parseSession(emptyUsername)).resolves.toBeNull();
  });

  it("rejects an unsupported role even when signed", async () => {
    const token = await serializeSession({ ...SESSION, role: "owner" } as unknown as Session);
    await expect(parseSession(token)).resolves.toBeNull();
  });

  it("enforces signed server-side expiration for replayed tokens", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-20T00:00:00.000Z"));
      const token = await serializeSession(SESSION);
      vi.setSystemTime(new Date("2026-07-20T08:00:01.000Z"));
      await expect(parseSession(token)).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("route access", () => {
  it("keeps tenant users out of admin routes", () => {
    expect(canAccess("tenant", "/dashboards/management")).toBe(true);
    expect(canAccess("tenant", "/management")).toBe(false);
    expect(canAccess("tenant", "/admin")).toBe(false);
    expect(canAccess("tenant", "/models")).toBe(true);
    expect(canAccess("admin", "/models/providers")).toBe(true);
    expect(canAccess("admin", "/management")).toBe(true);
  });
});
