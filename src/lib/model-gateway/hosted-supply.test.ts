import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/model-gateway/store", () => ({ assertGatewayBalance: vi.fn(), recordGatewayUsage: vi.fn() }));
vi.mock("@/lib/model-gateway/billing", () => ({ getGatewayBillingSnapshot: vi.fn() }));
vi.mock("@/lib/model-gateway/runtime-catalog", () => ({ findAvailableGatewayModel: vi.fn() }));

import { hostedSupplyKind, readHostedSupplyRequest, replaceSupplyModel, reserveHostedSupply, settleHostedSupply } from "@/lib/model-gateway/hosted-supply";
import { getGatewayBillingSnapshot } from "@/lib/model-gateway/billing";
import { assertGatewayBalance, recordGatewayUsage } from "@/lib/model-gateway/store";
import { findAvailableGatewayModel } from "@/lib/model-gateway/runtime-catalog";

describe("hosted supply request classification", () => {
  it("bills only official generation posts and leaves polling alone", () => {
    expect(hostedSupplyKind("https://sub.shaozhuangai.com/v1/chat/completions", "POST")).toBe("chat.completions");
    expect(hostedSupplyKind("https://sub.shaozhuangai.com/v1/images/generations", "POST")).toBe("images.generations");
    expect(hostedSupplyKind("https://sub.shaozhuangai.com/v1/images/edits", "POST")).toBe("images.edits");
    expect(hostedSupplyKind("https://sub.shaozhuangai.com/v1/videos", "POST")).toBe("videos");
    expect(hostedSupplyKind("https://sub.shaozhuangai.com/v1/videos/task_1", "GET")).toBeNull();
    expect(hostedSupplyKind("https://api.openai.com/v1/chat/completions", "POST")).toBeNull();
  });

  it("reads the public model and rewrites the outbound body to the supply model", () => {
    const source = JSON.stringify({ model: "chatGPT5.5", messages: [{ role: "user", content: "你好" }] });
    expect(readHostedSupplyRequest({ bodyText: source }).modelName).toBe("chatGPT5.5");
    expect(JSON.parse(String(replaceSupplyModel(source, "gpt-5.6-sol")))).toMatchObject({
      model: "gpt-5.6-sol", messages: [{ role: "user", content: "你好" }]
    });
  });

  it("preserves the selected immutable credential and base URL in accepted video ownership", async () => {
    vi.mocked(findAvailableGatewayModel).mockResolvedValue({ id: "video-alias", provider: "shaozhuang", upstreamModel: "provider-video", videoCents: 120 } as never);
    vi.mocked(getGatewayBillingSnapshot).mockResolvedValue({ userId: "user-1", multiplierBps: 10000 } as never);
    vi.mocked(assertGatewayBalance).mockResolvedValue(true);
    const hold = await reserveHostedSupply({ user: { id: "user-1", username: "user" }, kind: "videos", modelName: "video-alias", body: { model: "video-alias", prompt: "video" }, usdCnyRate: null });
    hold.credentialId = "old-backup";
    hold.baseUrl = "https://sub.shaozhuangai.com/v1";
    await settleHostedSupply(hold, { status: 202, contentType: "application/json", bytes: new TextEncoder().encode(JSON.stringify({ id: "task_1", status: "pending" })) });
    expect(recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: "task_1", status: "ok", costCents: 120,
      metadata: expect.objectContaining({ credentialId: "old-backup", baseUrl: "https://sub.shaozhuangai.com/v1" }) }));
  });
});
