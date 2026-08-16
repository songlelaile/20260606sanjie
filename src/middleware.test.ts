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

  it("sends a logged-out report viewer to the official login and preserves only the report path", async () => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest(`https://shaozhuangai.com/shared/dmp-reports/${TOKEN}`));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`https://shaozhuangai.com/login?returnTo=%2Fshared%2Fdmp-reports%2F${TOKEN}`);
  });

  it("does not expose the shared report interaction API without a website session", async () => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest(`https://shaozhuangai.com/api/shared/dmp-reports/${TOKEN}`));
    expect(response.status).toBe(401);
  });

  it("allows an authenticated role to continue to the report owner check", async () => {
    mocks.parseSession.mockResolvedValue({ username: "owner", name: "Owner", role: "tenant", tenantId: "tenant-a" });
    mocks.canAccess.mockReturnValue(true);
    const response = await middleware(new NextRequest(`https://shaozhuangai.com/shared/dmp-reports/${TOKEN}`));
    expect(response.status).toBe(200);
    expect(mocks.canAccess).toHaveBeenCalledWith("tenant", `/shared/dmp-reports/${TOKEN}`);
  });
});
