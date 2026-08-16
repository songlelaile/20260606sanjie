import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDmpReportAccess: vi.fn(),
  getDmpSharedReport: vi.fn(),
  recordView: vi.fn(),
  recordClicks: vi.fn()
}));

vi.mock("@/lib/dmp-report-store", () => ({ getDmpReportAccess: mocks.getDmpReportAccess }));
vi.mock("@/lib/dmp-report-share", () => ({
  getDmpSharedReport: mocks.getDmpSharedReport,
  recordDmpSharedReportView: mocks.recordView,
  recordDmpSharedReportClicks: mocks.recordClicks
}));

import { GET, POST } from "./route";

const ACCESS = { userId: "owner-a", tenantId: "tenant-a" };
const TOKEN = "a".repeat(64);
const CONTEXT = { params: Promise.resolve({ token: TOKEN }) };

describe("authenticated DMP shared report API", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it("requires the official-site paid account before reading a report", async () => {
    mocks.getDmpReportAccess.mockResolvedValue(null);
    const response = await GET(new Request(`https://shaozhuangai.com/api/shared/dmp-reports/${TOKEN}`), CONTEXT);
    expect(response.status).toBe(401);
    expect(mocks.getDmpSharedReport).not.toHaveBeenCalled();
  });

  it("returns 404 when the token does not belong to the logged-in account", async () => {
    mocks.getDmpReportAccess.mockResolvedValue(ACCESS);
    mocks.getDmpSharedReport.mockResolvedValue(null);
    const response = await GET(new Request(`https://shaozhuangai.com/api/shared/dmp-reports/${TOKEN}`), CONTEXT);
    expect(response.status).toBe(404);
    expect(mocks.getDmpSharedReport).toHaveBeenCalledWith(ACCESS, TOKEN);
  });

  it("records only normalized interaction payloads after the account check", async () => {
    mocks.getDmpReportAccess.mockResolvedValue(ACCESS);
    mocks.recordClicks.mockResolvedValue({ accepted: 2 });
    const events = [{ sectionKey: "hero", elementKey: "copy-link", x: 0.2, y: 0.3 }];
    const response = await POST(new Request(`https://shaozhuangai.com/api/shared/dmp-reports/${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "click", events })
    }), CONTEXT);
    expect(response.status).toBe(200);
    expect(mocks.recordClicks).toHaveBeenCalledWith(ACCESS, TOKEN, events);
  });
});
