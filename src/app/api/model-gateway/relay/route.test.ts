import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(), getRelaySettings: vi.fn(), saveRelaySettings: vi.fn(),
  testRelayConnection: vi.fn(), syncRelayModels: vi.fn()
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/model-gateway/relay-config", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/model-gateway/relay-config")>(),
  getRelaySettings: mocks.getRelaySettings, saveRelaySettings: mocks.saveRelaySettings,
  testRelayConnection: mocks.testRelayConnection, syncRelayModels: mocks.syncRelayModels
}));

import { GET, PUT } from "./route";
import { POST as TEST } from "./test/route";
import { POST as SYNC } from "./sync/route";

const VIEW = { baseUrl: "https://sub.shaozhuangai.com/v1", keyConfigured: true, keySource: "file", models: [], updatedAt: null };
const inputRequest = (body: unknown) => new Request("https://shaozhuangai.com/api/model-gateway/relay", {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
});

describe("relay management API authorization and secret boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: "admin-id", authRole: "admin", role: "operator", status: "active" });
    mocks.getRelaySettings.mockResolvedValue(VIEW);
    mocks.saveRelaySettings.mockResolvedValue(VIEW);
    mocks.testRelayConnection.mockResolvedValue({ ok: true, modelCount: 2, latencyMs: 1 });
    mocks.syncRelayModels.mockResolvedValue({ ...VIEW, syncedCount: 2 });
  });

  it.each([null, { id: "tenant", authRole: "tenant", role: "owner", status: "active" }, { id: "disabled", authRole: "admin", role: "admin", status: "disabled" }, { id: "tenant-view-admin", authRole: "tenant", role: "admin", status: "active" }])(
    "denies every relay endpoint to an unauthenticated, non-admin or disabled user: %j", async (user) => {
      mocks.getCurrentUser.mockResolvedValue(user);
      for (const invoke of [GET, () => PUT(inputRequest({ apiKey: "test-secret" })), TEST, SYNC]) {
        expect((await invoke()).status).toBe(user ? 403 : 401);
      }
      expect(mocks.getRelaySettings).not.toHaveBeenCalled();
      expect(mocks.saveRelaySettings).not.toHaveBeenCalled();
      expect(mocks.testRelayConnection).not.toHaveBeenCalled();
      expect(mocks.syncRelayModels).not.toHaveBeenCalled();
    }
  );

  it("allows an active admin to read and write sanitized config with no caching", async () => {
    const read = await GET();
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(await read.json()).toEqual({ data: VIEW });
    const write = await PUT(inputRequest({ apiKey: "test-secret" }));
    expect(write.status).toBe(200);
    expect(mocks.saveRelaySettings).toHaveBeenCalledWith({ apiKey: "test-secret" });
    expect(JSON.stringify(await write.json())).not.toContain("test-secret");
  });

  it("allows an active admin to test and sync the saved configuration", async () => {
    expect((await TEST()).status).toBe(200);
    expect((await SYNC()).status).toBe(200);
    expect(mocks.testRelayConnection).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.syncRelayModels).toHaveBeenCalledExactlyOnceWith();
  });

  it("never returns a raw exception containing credentials or filesystem paths", async () => {
    mocks.getRelaySettings.mockRejectedValueOnce(new Error("/private/relay.json apiKey=test-secret"));
    expect(await (await GET()).json()).toEqual({ error: "中转站操作失败，请检查配置后重试" });
    mocks.testRelayConnection.mockRejectedValueOnce(new Error("invalid test-secret"));
    expect(await (await TEST()).json()).toEqual({ error: "中转站操作失败，请检查配置后重试" });
  });

  it("rejects oversized configuration input before invoking persistence", async () => {
    const response = await PUT(inputRequest({ apiKey: "x".repeat(1_000_001) }));
    expect(response.status).toBe(413);
    expect(mocks.saveRelaySettings).not.toHaveBeenCalled();
  });
});
