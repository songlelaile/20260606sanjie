import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  archiveDmpReport: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/app/api/dmp-reports/route", () => ({
  POST: mocks.archiveDmpReport
}));
vi.mock("@/lib/dmp-report-store", () => ({
  DMP_REPORT_ARCHIVE_MAX_BODY_BYTES: 2 * 1024 * 1024
}));

import { OPTIONS, POST } from "./route";

describe("POST /api/dmp-market-reports isolated category contract", () => {
  beforeEach(() => {
    mocks.archiveDmpReport.mockReset();
    mocks.archiveDmpReport.mockResolvedValue(new Response(JSON.stringify({ data: { archived: true } }), {
      status: 201,
      headers: { "content-type": "application/json" }
    }));
  });

  it("forwards an explicitly typed category-market report to the shared library", async () => {
    const response = await POST(request({
      reportType: "market",
      report: { report_type: "market", item_id: "50015382" },
      subjectItemId: "50015382",
      competitorItemId: ""
    }));

    expect(response.status).toBe(201);
    expect(mocks.archiveDmpReport).toHaveBeenCalledTimes(1);
    const forwarded = mocks.archiveDmpReport.mock.calls[0]?.[0] as Request;
    await expect(forwarded.json()).resolves.toMatchObject({
      reportType: "market",
      report: { report_type: "market", item_id: "50015382" },
      competitorItemId: ""
    });
  });

  it.each([
    { body: { report: { report_type: "market" } }, label: "missing envelope" },
    { body: { reportType: "market", report: {} }, label: "missing canonical type" },
    { body: { reportType: "growth", report: { report_type: "growth" } }, label: "product payload" }
  ])("rejects $label before the product archive handler", async ({ body }) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "该接口仅接收类目大盘报告，未进入商品 ID 校验"
    });
    expect(mocks.archiveDmpReport).not.toHaveBeenCalled();
  });

  it("allows the market-only CORS preflight", () => {
    const response = OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  });
});

function request(body: unknown) {
  return new Request("https://shaozhuangai.com/api/dmp-market-reports", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sanjie-session": "extension-token"
    },
    body: JSON.stringify(body)
  });
}
