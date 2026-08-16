import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getPublicAppOrigin, toPublicAppUrl } from "@/lib/dmp-public-origin";

describe("DMP canonical public origin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the fixed official origin instead of an inbound request host", () => {
    vi.stubEnv("PUBLIC_APP_ORIGIN", "");
    expect(getPublicAppOrigin()).toBe("https://shaozhuangai.com");
    expect(toPublicAppUrl(`/shared/dmp-reports/${"a".repeat(64)}`)).toBe(
      `https://shaozhuangai.com/shared/dmp-reports/${"a".repeat(64)}`
    );
  });

  it("accepts an explicit development origin and removes its trailing slash", () => {
    vi.stubEnv("PUBLIC_APP_ORIGIN", "http://localhost:3122/");
    expect(getPublicAppOrigin()).toBe("http://localhost:3122");
  });

  it("rejects unsafe origins and protocol-relative public paths", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_APP_ORIGIN", "http://reports.example.com");
    expect(() => getPublicAppOrigin()).toThrow(/HTTPS/);

    vi.stubEnv("PUBLIC_APP_ORIGIN", "https://localhost:3122");
    expect(() => getPublicAppOrigin()).toThrow(/非本机/);

    for (const localOrigin of ["https://127.0.0.1", "https://127.9.8.7"]) {
      vi.stubEnv("PUBLIC_APP_ORIGIN", localOrigin);
      expect(() => getPublicAppOrigin()).toThrow(/非本机/);
    }

    vi.stubEnv("PUBLIC_APP_ORIGIN", "https://shaozhuangai.com/private");
    expect(() => getPublicAppOrigin()).toThrow(/只能包含/);

    vi.stubEnv("PUBLIC_APP_ORIGIN", "https://shaozhuangai.com");
    expect(() => toPublicAppUrl("//attacker.example/report")).toThrow(/站内绝对路径/);
  });
});
