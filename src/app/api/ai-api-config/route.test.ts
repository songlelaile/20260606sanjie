import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireShopScope: vi.fn(),
  getAiApiConfig: vi.fn(),
  updateAiApiConfig: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/store/runtime-store", () => ({
  requireShopScope: mocks.requireShopScope,
  getAiApiConfig: mocks.getAiApiConfig,
  updateAiApiConfig: mocks.updateAiApiConfig
}));

import { GET, PATCH } from "./route";

const CURRENT = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5.5",
  enabled: true,
  hasApiKey: true,
  apiKeyHint: "sk-***"
};

describe("PATCH /api/ai-api-config", () => {
  beforeEach(() => {
    mocks.requireShopScope.mockReset();
    mocks.getAiApiConfig.mockReset();
    mocks.updateAiApiConfig.mockReset();
    mocks.requireShopScope.mockResolvedValue({
      tenantId: "tenant-a",
      shopId: "shop-a",
      user: { role: "owner" },
      isAdmin: false
    });
    mocks.getAiApiConfig.mockResolvedValue(CURRENT);
    mocks.updateAiApiConfig.mockResolvedValue(CURRENT);
  });

  it("returns only credential status and never exposes key tail or saver identity", async () => {
    mocks.getAiApiConfig.mockResolvedValueOnce({
      ...CURRENT,
      apiKeyHint: "•••• 1234",
      updatedBy: "店铺所有者"
    });
    const response = await GET();
    await expect(response.json()).resolves.toMatchObject({
      data: {
        config: {
          hasApiKey: true,
          apiKeyHint: "已保存",
          updatedBy: ""
        }
      }
    });
  });

  it("refuses to send a stored key to a changed provider or origin", async () => {
    const response = await PATCH(jsonRequest({
      provider: "custom",
      baseUrl: "https://example.com/v1",
      model: "custom-model",
      enabled: true
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("重新填写对应 API Key")
    });
    expect(mocks.updateAiApiConfig).not.toHaveBeenCalled();
  });

  it("allows changing the model while the credential origin remains unchanged", async () => {
    const response = await PATCH(jsonRequest({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1/",
      model: "gpt-next",
      enabled: true
    }));
    expect(response.status).toBe(200);
    expect(mocks.updateAiApiConfig).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-next" }));
  });

  it("allows an origin change only when a replacement key is supplied", async () => {
    const response = await PATCH(jsonRequest({
      provider: "custom",
      baseUrl: "https://example.com/v1",
      model: "custom-model",
      enabled: true,
      apiKey: "replacement-key"
    }));
    expect(response.status).toBe(200);
    expect(mocks.updateAiApiConfig).toHaveBeenCalledWith(expect.objectContaining({
      provider: "custom",
      apiKey: "replacement-key"
    }));
  });

  it("fills the hosted preset and canonical model alias server-side", async () => {
    const response = await PATCH(jsonRequest({
      provider: "shaozhuang",
      baseUrl: "",
      model: "gpt-5.5",
      enabled: true,
      apiKey: "hosted-key"
    }));
    expect(response.status).toBe(200);
    expect(mocks.updateAiApiConfig).toHaveBeenCalledWith(expect.objectContaining({
      provider: "shaozhuang",
      baseUrl: "https://sub.shaozhuangai.com/v1",
      model: "chatGPT5.5",
      apiKey: "hosted-key"
    }));
  });

  it("rejects unknown providers and Base URLs with query credentials", async () => {
    const unknown = await PATCH(jsonRequest({
      provider: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-flash",
      enabled: false
    }));
    expect(unknown.status).toBe(400);

    const query = await PATCH(jsonRequest({
      provider: "custom",
      baseUrl: "https://example.com/v1?api_key=unsafe",
      model: "custom-model",
      enabled: true,
      apiKey: "replacement-key"
    }));
    expect(query.status).toBe(400);
    await expect(query.json()).resolves.toMatchObject({
      error: expect.stringContaining("查询参数")
    });
  });
});

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/ai-api-config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
