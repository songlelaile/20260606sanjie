import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  getDmpAutomationAccessForSession: vi.fn(),
  readFile: vi.fn()
}));

vi.mock("@/lib/session-server", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("@/lib/tool-entitlements", () => ({
  getDmpAutomationAccessForSession: mocks.getDmpAutomationAccessForSession
}));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));

import { GET } from "./route";

const SESSION = { username: "paid-user", name: "付费用户", role: "tenant", tenantId: "tenant-a" };

describe("GET /api/tools/dmp/download", () => {
  beforeEach(() => {
    mocks.getServerSession.mockReset();
    mocks.getDmpAutomationAccessForSession.mockReset();
    mocks.readFile.mockReset();
  });

  it("rejects unauthenticated and unentitled downloads without reading the private ZIP", async () => {
    mocks.getServerSession.mockResolvedValueOnce(null);
    await expect(GET()).resolves.toMatchObject({ status: 401 });

    mocks.getServerSession.mockResolvedValueOnce(SESSION);
    mocks.getDmpAutomationAccessForSession.mockResolvedValueOnce({ allowed: false });
    const response = await GET();
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "该账号尚未开通达摩盘 AI 自动化，请联系管理员付费使用"
    });
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("serves the private ZIP only after a database-backed entitlement check", async () => {
    mocks.getServerSession.mockResolvedValueOnce(SESSION);
    mocks.getDmpAutomationAccessForSession.mockResolvedValueOnce({ allowed: true });
    mocks.readFile.mockResolvedValueOnce(Buffer.from("zip-bytes"));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("zip-bytes");
  });
});
