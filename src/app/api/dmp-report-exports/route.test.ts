import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAndAudit: vi.fn()
}));

vi.mock("@/lib/dmp-report-export-authorization", () => ({
  authorizeAndAuditDmpReportExport: mocks.authorizeAndAudit
}));

import { OPTIONS, POST } from "./route";

const VALID_BODY = {
  reportId: "report-growth-1",
  reportType: "growth",
  format: "xlsx",
  clientVersion: "2.1.3"
};

function exportRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://shaozhuangai.com/api/dmp-report-exports", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sanjie-session": "signed-admin-session",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

describe("POST /api/dmp-report-exports", () => {
  beforeEach(() => {
    mocks.authorizeAndAudit.mockReset();
  });

  it("advertises the extension header and only POST/OPTIONS", () => {
    const response = OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-sanjie-session");
    expect(response.headers.get("allow")).toBe("POST, OPTIONS");
  });

  it("returns the documented 201 authorization only after the audit succeeds", async () => {
    const authorization = {
      authorized: true,
      auditId: "audit-1",
      authorizedAt: "2026-08-17T08:30:00.000Z"
    };
    mocks.authorizeAndAudit.mockResolvedValue({ ok: true, authorization });

    const response = await POST(exportRequest(VALID_BODY));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ data: { authorization } });
    expect(mocks.authorizeAndAudit).toHaveBeenCalledWith("signed-admin-session", VALID_BODY);
  });

  it("accepts the same signed session from a first-party cookie", async () => {
    mocks.authorizeAndAudit.mockResolvedValue({
      ok: false,
      status: 401,
      error: "未登录或会话已失效"
    });
    const request = new Request("https://shaozhuangai.com/api/dmp-report-exports", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "sanjie_session=cookie-session"
      },
      body: JSON.stringify(VALID_BODY)
    });
    await POST(request);
    expect(mocks.authorizeAndAudit).toHaveBeenCalledWith("cookie-session", VALID_BODY);
  });

  it.each([401, 403, 404, 409] as const)("preserves a fail-closed %s authorization result", async (status) => {
    mocks.authorizeAndAudit.mockResolvedValue({ ok: false, status, error: `blocked-${status}` });
    const response = await POST(exportRequest(VALID_BODY));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: `blocked-${status}` });
  });

  it("rejects non-XLSX, malformed, and extra-field bodies before authorization", async () => {
    const invalidBodies = [
      { ...VALID_BODY, format: "json" },
      { ...VALID_BODY, reportType: "unknown" },
      { ...VALID_BODY, report: { tables: [{ cells: ["business value"] }] } }
    ];
    for (const body of invalidBodies) {
      const response = await POST(exportRequest(body));
      expect(response.status).toBe(400);
    }
    expect(mocks.authorizeAndAudit).not.toHaveBeenCalled();
  });

  it("requires JSON and enforces the 8KB body limit", async () => {
    const wrongType = await POST(new Request("https://shaozhuangai.com/api/dmp-report-exports", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "xlsx"
    }));
    expect(wrongType.status).toBe(415);

    const oversized = await POST(exportRequest(VALID_BODY, {
      "content-length": String(8 * 1024 + 1)
    }));
    expect(oversized.status).toBe(413);
    expect(mocks.authorizeAndAudit).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the audit transaction cannot complete", async () => {
    mocks.authorizeAndAudit.mockRejectedValue(new Error("database unavailable"));
    const response = await POST(exportRequest(VALID_BODY));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "导出授权服务暂不可用" });
  });
});
