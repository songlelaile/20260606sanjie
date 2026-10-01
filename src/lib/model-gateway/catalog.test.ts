import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  GATEWAY_MODELS,
  findGatewayModel,
  gatewayProviderLabel,
  listGatewayModelsByProvider
} from "@/lib/model-gateway/catalog";

describe("model gateway catalog", () => {
  it("registers 少壮中转站 chat and image models", () => {
    const chat = findGatewayModel("chatGPT5.5", "chat.completions");
    const image = findGatewayModel("image2", "images.generations");

    expect(chat).toMatchObject({
      id: "chatGPT5.5",
      provider: "shaozhuang",
      upstreamModel: "chatGPT5.5",
      defaultBaseUrl: "https://sub.shaozhuangai.com/v1",
      baseUrlEnv: "MODEL_GATEWAY_SHAOZHUANG_BASE_URL",
      apiKeyEnv: "MODEL_GATEWAY_SHAOZHUANG_API_KEY"
    });
    expect(image).toMatchObject({
      id: "image2",
      provider: "shaozhuang",
      upstreamModel: "image2",
      endpoint: "images.generations",
      defaultBaseUrl: "https://sub.shaozhuangai.com/v1"
    });
    expect(gatewayProviderLabel("shaozhuang")).toBe("少壮中转站");
    expect(listGatewayModelsByProvider("shaozhuang").map((item) => item.id)).toEqual([
      "chatGPT5.5",
      "image2"
    ]);
  });

  it("keeps direct vendor models and rejects cross-endpoint lookups", () => {
    expect(findGatewayModel("deepseek-chat", "chat.completions")?.provider).toBe("deepseek");
    expect(findGatewayModel("gpt-image-1", "images.generations")?.provider).toBe("openai");
    expect(findGatewayModel("chatGPT5.5", "images.generations")).toBeUndefined();
    expect(findGatewayModel("image2", "chat.completions")).toBeUndefined();
    expect(GATEWAY_MODELS.some((item) => item.provider === "openai")).toBe(true);
    expect(GATEWAY_MODELS.some((item) => item.provider === "zhipu")).toBe(true);
  });
});
