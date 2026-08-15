import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  analyzeDmpPayload: vi.fn(),
  getDmpReportAccessFromToken: vi.fn(),
  validateDmpCanonicalReport: vi.fn(),
  validateDmpRuntimeReport: vi.fn()
}));

vi.mock("@/lib/dmp-runtime", () => ({
  analyzeDmpPayload: mocks.analyzeDmpPayload,
  dmpRuntimeErrorResponse: vi.fn((error: Error) => ({ status: 502, body: { ok: false, code: "API_FAILED", error: error.message } })),
  getDmpRuntimeHealth: vi.fn(() => ({ ok: true, service: "dmp-cloud-runtime", mode: "managed", model: "test-model", analysis_available: true })),
  validateDmpRuntimeReport: mocks.validateDmpRuntimeReport
}));

vi.mock("@/lib/dmp-report-store", () => ({
  getDmpReportAccessFromToken: mocks.getDmpReportAccessFromToken,
  validateDmpCanonicalReport: mocks.validateDmpCanonicalReport
}));

import { GET, POST } from "./route";

const REPORT = { schema_version: "3.0", title: "报告", item_id: "593063365092", period: "近30天", tables: [] };
const context = (action: string) => ({ params: Promise.resolve({ action }) });

describe("DMP cloud runtime", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.getDmpReportAccessFromToken.mockResolvedValue({ userId: "user-a", tenantId: "tenant-a" });
    mocks.validateDmpCanonicalReport.mockReturnValue({ report: REPORT });
    mocks.validateDmpRuntimeReport.mockReturnValue("");
  });

  it("requires the official signed session", async () => {
    mocks.getDmpReportAccessFromToken.mockResolvedValue(null);
    const response = await GET(new Request("https://shaozhuangai.com/api/dmp-runtime/health"), context("health"));
    expect(response.status).toBe(401);
  });

  it("returns managed cloud health without exposing provider keys", async () => {
    const response = await GET(new Request("https://shaozhuangai.com/api/dmp-runtime/health", { headers: { "x-sanjie-session": "signed" } }), context("health"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.mode).toBe("managed");
    expect(JSON.stringify(body)).not.toMatch(/api.?key|secret/i);
  });

  it("validates and echoes canonical reports", async () => {
    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-runtime/report", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sanjie-session": "signed" },
      body: JSON.stringify({ report: REPORT })
    }), context("report"));
    expect(response.status).toBe(200);
    expect((await response.json()).report).toEqual(REPORT);
  });

  it("forwards sanitized analysis batches to the managed analyzer", async () => {
    mocks.analyzeDmpPayload.mockResolvedValue({ ok: true, skipped: true, values_received: 12 });
    const payload = { schema_version: "3.0", subject_item_id: "593063365092", modules: [{ module: "商品概况", responses: [{ payload: { gmv: 1 } }] }] };
    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-runtime/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sanjie-session": "signed" },
      body: JSON.stringify({ payload, report: REPORT })
    }), context("analyze"));
    expect(response.status).toBe(200);
    expect(mocks.analyzeDmpPayload).toHaveBeenCalledWith(payload, REPORT);
  });
});
