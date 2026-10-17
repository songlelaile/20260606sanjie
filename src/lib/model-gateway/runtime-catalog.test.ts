import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/model-gateway/relay-config", () => ({ getRelayRuntime: vi.fn() }));
import { getRelayRuntime } from "@/lib/model-gateway/relay-config";
import { findAvailableGatewayModel, listAvailableGatewayModels } from "@/lib/model-gateway/runtime-catalog";

const runtime = vi.mocked(getRelayRuntime);
const base = { baseUrl: "https://relay.example.com/v1", apiKey: "not-for-clients", shopKeys: [], usdCnyRate: null };

beforeEach(() => { vi.resetAllMocks(); });

describe("gateway runtime catalog", () => {
  it("keeps vendor routes and maps only explicitly enabled, classified relay models", async () => {
    runtime.mockResolvedValue({ ...base, models: [
      { id: "relay-chat", label: "Chat alias", upstreamModel: "chat-upstream", kind: "chat", enabled: true, promptCentsPer1K: 2, completionCentsPer1K: 6 },
      { id: "relay-image", label: "Image alias", upstreamModel: "image-upstream", kind: "image", enabled: true, imageCents: 50 },
      { id: "relay-video", label: "Video alias", upstreamModel: "video-upstream", kind: "video", enabled: true, videoCents: 80 },
      { id: "unknown", label: "Unknown", upstreamModel: "new", kind: "unknown", enabled: false },
      { id: "disabled", label: "Off", upstreamModel: "off", kind: "chat", enabled: false }
    ] });
    const models = await listAvailableGatewayModels();
    expect(models.filter((model) => model.provider === "shaozhuang").map((model) => [model.id, model.endpoint])).toEqual([
      ["relay-chat", "chat.completions"], ["relay-image", "images.generations"], ["relay-video", "videos"]
    ]);
    expect(models.find((model) => model.id === "relay-video")).toMatchObject({ defaultBaseUrl: base.baseUrl, videoCents: 80 });
    expect(models.find((model) => model.id === "deepseek-chat")).toMatchObject({ provider: "deepseek" });
    expect(JSON.stringify(models)).not.toContain(base.apiKey);
  });

  it("prioritizes exact vendor IDs over relay upstream aliases and enforces the endpoint", async () => {
    runtime.mockResolvedValue({ ...base, models: [
      { id: "relay:deepseek-chat", label: "Relay", upstreamModel: "deepseek-chat", kind: "chat", enabled: true, promptCentsPer1K: 1, completionCentsPer1K: 1 }
    ] });
    expect((await findAvailableGatewayModel("deepseek-chat", "chat.completions"))?.provider).toBe("deepseek");
    expect((await findAvailableGatewayModel("relay:deepseek-chat", "chat.completions"))?.provider).toBe("shaozhuang");
    expect(await findAvailableGatewayModel("relay:deepseek-chat", "images.generations")).toBeUndefined();
  });

  it("does not silently reopen default relay models when settings cannot be read", async () => {
    runtime.mockRejectedValue(new Error("invalid private config"));
    await expect(listAvailableGatewayModels()).rejects.toThrow("invalid private config");
  });
});
