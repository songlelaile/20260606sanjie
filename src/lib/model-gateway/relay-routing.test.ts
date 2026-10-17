import { describe, expect, it } from "vitest";
import { parseUpstreamUsdCost, selectRelayApiKey, usdToCnyCents } from "./relay-routing";

const keys = [
  { shopName: "西西礼", purpose: "default" as const, apiKey: "xixi-key" },
  { shopName: "少壮", purpose: "default" as const, apiKey: "text-key" },
  { shopName: "少壮", purpose: "image" as const, apiKey: "gemini-key" }
];

describe("relay shop key selection", () => {
  it("uses the shop key, and a shop image key only for image calls", () => {
    expect(selectRelayApiKey({ platformKey: "platform", shopKeys: keys, shopName: "西西礼", kind: "chat" })).toBe("xixi-key");
    expect(selectRelayApiKey({ platformKey: "platform", shopKeys: keys, shopName: "少壮", kind: "chat" })).toBe("text-key");
    expect(selectRelayApiKey({ platformKey: "platform", shopKeys: keys, shopName: "少壮", kind: "image" })).toBe("gemini-key");
    expect(selectRelayApiKey({ platformKey: "platform", shopKeys: keys, shopName: "少壮", kind: "video" })).toBe("text-key");
  });

  it("keeps the platform key when the shop has no saved route", () => {
    expect(selectRelayApiKey({ platformKey: "platform", shopKeys: keys, shopName: "未配置店", kind: "image" })).toBe("platform");
    expect(selectRelayApiKey({ platformKey: "platform", shopName: "", kind: "chat" })).toBe("platform");
  });
});

describe("upstream dollar settlement", () => {
  it("reads actual_cost before cost and ignores quota-like fields", () => {
    expect(parseUpstreamUsdCost({ usage: { actual_cost: 0.01, cost: 0.02, quota: 500000 } })).toBe(0.01);
    expect(parseUpstreamUsdCost({ usage: { cost: 0 } })).toBe(0);
    expect(parseUpstreamUsdCost({ usage: { prompt_tokens: 20 } })).toBeNull();
    expect(parseUpstreamUsdCost({ cost: 9 })).toBeNull();
  });

  it("converts dollars to RMB cents and rounds upward", () => {
    expect(usdToCnyCents(0.01, 7.2)).toBe(8);
    expect(usdToCnyCents(1, 7.2)).toBe(720);
    expect(usdToCnyCents(0, 7.2)).toBe(0);
    expect(usdToCnyCents(0.01, 0)).toBeNull();
  });
});
