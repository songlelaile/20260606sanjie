import { afterEach, describe, expect, it, vi } from "vitest";
import { authRedirectUrl } from "./auth-redirect-url";

describe("authentication redirect origin", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("replaces the internal production origin while preserving path and query", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_APP_ORIGIN", "");
    expect(authRedirectUrl(new URL("https://localhost:3040/tools?view=report")).href).toBe(
      "https://shaozhuangai.com/tools?view=report"
    );
  });

  it("accepts an explicitly configured HTTPS public origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_APP_ORIGIN", " https://reports.example.com:8443/ ");
    expect(authRedirectUrl(new URL("https://localhost:3040/tools")).href).toBe(
      "https://reports.example.com:8443/tools"
    );
  });

  it("preserves local development when a public origin is not configured", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PUBLIC_APP_ORIGIN", "");
    expect(authRedirectUrl(new URL("http://localhost:3122/tools?x=1")).href).toBe(
      "http://localhost:3122/tools?x=1"
    );
  });

  it("does not interpret a protocol-relative pathname as an external origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_APP_ORIGIN", "");
    expect(authRedirectUrl({
      origin: "https://localhost:3040",
      pathname: "//attacker.example/path",
      search: "?x=1"
    }).origin).toBe("https://shaozhuangai.com");
  });

  it.each([
    "not-a-url",
    "javascript:alert(1)",
    "http://shaozhuangai.com",
    "https://localhost:3040",
    "https://app.localhost",
    "https://localhost.",
    "https://127.0.0.1",
    "https://127.9.8.7",
    "https://[::1]",
    "https://[::]",
    "https://0.0.0.0",
    "https://user:password@shaozhuangai.com",
    "https://shaozhuangai.com/login",
    "https://shaozhuangai.com?x=1",
    "https://shaozhuangai.com#fragment"
  ])("rejects invalid production origin %s", (origin) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_APP_ORIGIN", origin);
    expect(() => authRedirectUrl(new URL("https://localhost:3040/"))).toThrow(/PUBLIC_APP_ORIGIN/);
  });
});
