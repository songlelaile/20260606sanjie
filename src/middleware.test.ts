import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  parseSession: vi.fn(),
  canAccess: vi.fn()
}));

vi.mock("@/lib/auth", () => ({
  ROLE_HOME: { tenant: "/dashboards/operating-network", admin: "/dashboards/operating-network" },
  SESSION_COOKIE: "sanjie_session",
  parseSession: mocks.parseSession,
  canAccess: mocks.canAccess
}));

import { middleware } from "./middleware";

const TOKEN = "a".repeat(64);

describe("DMP shared report middleware", () => {
  beforeEach(() => {
    mocks.parseSession.mockReset();
    mocks.canAccess.mockReset();
  });

  it.each(["GET", "HEAD"])("allows anonymous %s access to an exact high-entropy report path", async (method) => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest(`https://shaozhuangai.com/shared/dmp-reports/${TOKEN}`, { method }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(mocks.parseSession).not.toHaveBeenCalled();
  });

  it("allows only read semantics on the public report page", async () => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest(`https://shaozhuangai.com/shared/dmp-reports/${TOKEN}`, { method: "POST" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(mocks.parseSession).not.toHaveBeenCalled();
  });

  it.each(["POST", "OPTIONS"])("allows anonymous %s requests to the exact interaction endpoint", async (method) => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest(`https://shaozhuangai.com/api/shared/dmp-reports/${TOKEN}`, { method }));
    expect(response.status).toBe(200);
    expect(mocks.parseSession).not.toHaveBeenCalled();
  });

  it("does not expose the complete report JSON through an anonymous API GET", async () => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest(`https://shaozhuangai.com/api/shared/dmp-reports/${TOKEN}`));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, OPTIONS");
    expect(mocks.parseSession).not.toHaveBeenCalled();
  });

  it.each([
    `/shared/dmp-reports/${"a".repeat(63)}`,
    `/shared/dmp-reports/${TOKEN}/extra`,
    `/shared/dmp-reports/not-a-token`
  ])("keeps malformed report path %s behind page authentication", async (pathname) => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest(`https://shaozhuangai.com${pathname}`));
    expect(response.status).toBe(307);
    expect(mocks.parseSession).toHaveBeenCalledOnce();
  });

  it.each([
    `/api/shared/dmp-reports/${"a".repeat(63)}`,
    `/api/shared/dmp-reports/${TOKEN}/extra`,
    `/api/shared/dmp-reports/not-a-token`
  ])("keeps malformed interaction path %s behind API authentication", async (pathname) => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest(`https://shaozhuangai.com${pathname}`, { method: "POST" }));
    expect(response.status).toBe(401);
    expect(mocks.parseSession).toHaveBeenCalledOnce();
  });
});
