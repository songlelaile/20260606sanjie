import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordEvent: vi.fn()
}));

vi.mock("@/lib/dmp-report-share", () => ({
  recordDmpPublicShareEvent: mocks.recordEvent
}));

import { GET, OPTIONS, POST } from "./route";

const TOKEN = "a".repeat(64);
const CONTEXT = { params: Promise.resolve({ token: TOKEN }) };
const IDENTITY = {
  eventId: "event-1234567890abcdef",
  visitorId: "visitor-1234567890abcdef",
  sessionId: "session-1234567890abcdef"
};

function eventRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://shaozhuangai.com/api/shared/dmp-reports/${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

describe("public DMP shared report interaction API", () => {
  beforeEach(() => {
    mocks.recordEvent.mockReset();
  });

  it("never exposes the complete report JSON through GET", async () => {
    const response = GET();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, OPTIONS");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  it("advertises only the anonymous event methods", () => {
    const response = OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("allow")).toBe("POST, OPTIONS");
  });

  it("accepts a normalized anonymous view without a website session", async () => {
    mocks.recordEvent.mockResolvedValue({ accepted: 1 });
    const response = await POST(eventRequest({
      type: "view",
      ...IDENTITY,
      sourceDomain: "https://weixin.qq.com/private/path",
      utmSource: "wechat"
    }), CONTEXT);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { accepted: 1 } });
    expect(mocks.recordEvent).toHaveBeenCalledWith(TOKEN, {
      type: "view",
      ...IDENTITY,
      source: "wechat",
      medium: "",
      campaign: "",
      referrerHost: "weixin.qq.com"
    });
  });

  it("returns the same 404 for an invalid, missing, or revoked share token", async () => {
    mocks.recordEvent.mockResolvedValue(null);
    const response = await POST(eventRequest({ type: "view", ...IDENTITY }), CONTEXT);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "分享报告不存在或已失效" });
  });

  it("rejects unsupported or incomplete public events before touching storage", async () => {
    const response = await POST(eventRequest({ type: "download", ...IDENTITY }), CONTEXT);
    expect(response.status).toBe(400);
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  it("rejects event bodies over 64KB using the declared or actual byte size", async () => {
    const declared = await POST(eventRequest(
      { type: "view", ...IDENTITY },
      { "content-length": String(64 * 1024 + 1) }
    ), CONTEXT);
    expect(declared.status).toBe(413);

    const actual = await POST(eventRequest({
      type: "view",
      ...IDENTITY,
      padding: "x".repeat(64 * 1024)
    }), CONTEXT);
    expect(actual.status).toBe(413);
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  it("requires JSON and rejects malformed JSON", async () => {
    const wrongType = await POST(new Request(`https://shaozhuangai.com/api/shared/dmp-reports/${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "view"
    }), CONTEXT);
    expect(wrongType.status).toBe(415);

    const malformed = await POST(new Request(`https://shaozhuangai.com/api/shared/dmp-reports/${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    }), CONTEXT);
    expect(malformed.status).toBe(400);
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });
});
