import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdminResponse: vi.fn(),
  getAnalytics: vi.fn(),
  revokeShare: vi.fn()
}));

vi.mock("@/lib/route-guards", () => ({
  requireAdminResponse: mocks.requireAdminResponse
}));
vi.mock("@/lib/dmp-report-share", () => ({
  getDmpReportShareManagementAnalytics: mocks.getAnalytics,
  revokeDmpReportShare: mocks.revokeShare
}));

import { DELETE, GET } from "./route";

describe("administrator-only DMP propagation analytics API", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.requireAdminResponse.mockResolvedValue(null);
  });

  it("returns cross-tenant analytics to a database-validated administrator", async () => {
    const analytics = { days: 30, overview: { pageViews: 12, uniqueVisitors: 5 } };
    mocks.getAnalytics.mockResolvedValue(analytics);
    const response = await GET(new Request(
      "https://shaozhuangai.com/api/management/dmp-report-share-analytics"
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireAdminResponse).toHaveBeenCalledOnce();
    expect(mocks.getAnalytics).toHaveBeenCalledWith(30);
    expect(await response.json()).toEqual({ data: { analytics } });
  });

  it.each(["tenant", "stale or disabled administrator"])(
    "returns 403 to a %s before querying analytics",
    async () => {
      mocks.requireAdminResponse.mockResolvedValue(NextResponse.json(
        { error: "仅管理员可执行此操作" },
        { status: 403 }
      ));
      const response = await GET(new Request(
        "https://shaozhuangai.com/api/management/dmp-report-share-analytics?days=7"
      ));
      expect(response.status).toBe(403);
      expect(mocks.getAnalytics).not.toHaveBeenCalled();
    }
  );

  it("accepts only the documented 7, 30, and 90 day windows", async () => {
    const response = await GET(new Request(
      "https://shaozhuangai.com/api/management/dmp-report-share-analytics?days=365"
    ));
    expect(response.status).toBe(400);
    expect(mocks.getAnalytics).not.toHaveBeenCalled();
  });

  it("allows only a validated administrator to revoke a public link", async () => {
    mocks.revokeShare.mockResolvedValue({
      id: "share-public-1",
      revokedAt: "2026-08-17T01:00:00.000Z"
    });
    const response = await DELETE(new Request(
      "https://shaozhuangai.com/api/management/dmp-report-share-analytics?shareId=share-public-1",
      { method: "DELETE" }
    ));
    expect(response.status).toBe(200);
    expect(mocks.requireAdminResponse).toHaveBeenCalledOnce();
    expect(mocks.revokeShare).toHaveBeenCalledWith("share-public-1");
  });

  it("does not reveal whether a link exists to a non-administrator", async () => {
    mocks.requireAdminResponse.mockResolvedValue(NextResponse.json(
      { error: "仅管理员可执行此操作" },
      { status: 403 }
    ));
    const response = await DELETE(new Request(
      "https://shaozhuangai.com/api/management/dmp-report-share-analytics?shareId=share-public-1",
      { method: "DELETE" }
    ));
    expect(response.status).toBe(403);
    expect(mocks.revokeShare).not.toHaveBeenCalled();
  });
});
