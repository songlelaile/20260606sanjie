import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/model-gateway/store", () => ({
  authenticateGatewayKey: vi.fn(),
  assertGatewayBalance: vi.fn(),
  recordGatewayUsage: vi.fn()
}));

import { findGatewayModel } from "@/lib/model-gateway/catalog";
import {
  buildGatewayUpstreamUrl,
  getMissingUpstreamApiKeyError,
  resolveGatewayUpstreamApiKey
} from "@/lib/model-gateway/proxy";

describe("model gateway proxy upstream helpers", () => {
  const chat = findGatewayModel("chatGPT5.5", "chat.completions");
  const image = findGatewayModel("image2", "images.generations");

  it("builds chat and image upstream URLs from default and override base", () => {
    expect(chat).toBeTruthy();
    expect(image).toBeTruthy();
    if (!chat || !image) return;

    expect(buildGatewayUpstreamUrl(chat, {})).toBe(
      "https://sub.shaozhuangai.com/v1/chat/completions"
    );
    expect(buildGatewayUpstreamUrl(image, {})).toBe(
      "https://sub.shaozhuangai.com/v1/images/generations"
    );
    expect(
      buildGatewayUpstreamUrl(chat, {
        MODEL_GATEWAY_SHAOZHUANG_BASE_URL: "https://sub.shaozhuangai.com/v1/"
      })
    ).toBe("https://sub.shaozhuangai.com/v1/chat/completions");
    expect(
      buildGatewayUpstreamUrl(image, {
        MODEL_GATEWAY_SHAOZHUANG_BASE_URL: "https://relay.example.com/openai/v1"
      })
    ).toBe("https://relay.example.com/openai/v1/images/generations");
  });

  it("fail-closes when 少壮中转站 API key is missing", () => {
    expect(chat).toBeTruthy();
    if (!chat) return;

    expect(resolveGatewayUpstreamApiKey(chat, {})).toBe("");
    expect(getMissingUpstreamApiKeyError(chat, {})).toBe(
      "上游 shaozhuang 还没有配置 API Key"
    );
    expect(
      getMissingUpstreamApiKeyError(chat, {
        MODEL_GATEWAY_SHAOZHUANG_API_KEY: "   "
      })
    ).toBe("上游 shaozhuang 还没有配置 API Key");
    expect(
      getMissingUpstreamApiKeyError(chat, {
        MODEL_GATEWAY_SHAOZHUANG_API_KEY: "test-placeholder-key"
      })
    ).toBeNull();
    expect(
      resolveGatewayUpstreamApiKey(chat, {
        MODEL_GATEWAY_SHAOZHUANG_API_KEY: "test-placeholder-key"
      })
    ).toBe("test-placeholder-key");
  });
});
