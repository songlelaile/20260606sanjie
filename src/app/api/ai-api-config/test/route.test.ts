import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireShopScope: vi.fn(),
  getAiApiRuntimeConfig: vi.fn(),
  requestAiChat: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/store/runtime-store", () => ({
  requireShopScope: mocks.requireShopScope,
  getAiApiRuntimeConfig: mocks.getAiApiRuntimeConfig
}));
vi.mock("@/lib/ai-chat-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-chat-client")>();
  return { ...actual, requestAiChat: mocks.requestAiChat };
});

import { POST } from "./route";

const CONFIG = {
  provider: "shaozhuang",
  baseUrl: "https://sub.shaozhuangai.com/v1",
  model: "chatGPT5.5",
  enabled: true,
  hasApiKey: true,
  apiKeyHint: "已保存",
  updatedAt: "",
  updatedBy: "",
  apiKey: "secret-key"
};

describe("POST /api/ai-api-config/test", () => {
  beforeEach(() => {
    mocks.requireShopScope.mockReset();
    mocks.getAiApiRuntimeConfig.mockReset();
    mocks.requestAiChat.mockReset();
    mocks.requireShopScope.mockResolvedValue({
      tenantId: "tenant-a",
      shopId: "shop-a",
      user: { role: "owner" },
      isAdmin: false
    });
    mocks.getAiApiRuntimeConfig.mockResolvedValue(CONFIG);
    mocks.requestAiChat.mockResolvedValue({
      content: "OK",
      provider: "shaozhuang",
      model: "chatGPT5.5"
    });
  });

  it("allows only credential managers", async () => {
    mocks.requireShopScope.mockResolvedValueOnce({
      tenantId: "tenant-a",
      shopId: "shop-a",
      user: { role: "operator" },
      isAdmin: false
    });
    const response = await POST();
    expect(response.status).toBe(403);
    expect(mocks.requestAiChat).not.toHaveBeenCalled();
  });

  it("requires a server-side saved key", async () => {
    mocks.getAiApiRuntimeConfig.mockResolvedValueOnce({ ...CONFIG, hasApiKey: false, apiKey: null });
    const response = await POST();
    expect(response.status).toBe(409);
    expect(mocks.requestAiChat).not.toHaveBeenCalled();
  });

  it("sends only a fixed probe and returns no key or model response content", async () => {
    const response = await POST();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requestAiChat).toHaveBeenCalledWith(
      CONFIG,
      expect.objectContaining({
        messages: [
          expect.objectContaining({ content: expect.stringContaining("连通性检查") }),
          { role: "user", content: "OK" }
        ],
        maxTokens: 8,
        timeoutMs: 15_000
      })
    );
    const text = await response.text();
    expect(text).toContain('"ok":true');
    expect(text).not.toContain("secret-key");
    expect(text).not.toContain('"content"');
  });
});
