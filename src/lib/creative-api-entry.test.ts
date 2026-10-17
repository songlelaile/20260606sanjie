import { afterEach, describe, expect, it, vi } from "vitest";
import { openCreativeApiConfig } from "./creative-api-entry";

function fixture() {
  const account = { key: "tenant:alice" };
  const control = { disabled: false };
  const bridge = {
    archiveContext: () => ({ accountKey: account.key }),
    getAccountKey: vi.fn(async () => "tenant:alice"),
    openConfig: vi.fn((): { ok: boolean; error?: string } => ({ ok: true }))
  };
  const video = { ready: vi.fn(() => true), openConfig: vi.fn(() => ({ ok: true })) };
  const document = { documentElement: { dataset: { labStartup: "ready" }, classList: { contains: () => false } },
    getElementById: () => ({}), querySelector: () => control };
  const frame = { contentDocument: document, contentWindow: { SZ_CREATIVE_TOOLS_BRIDGE: bridge, SanjieVideoSettingsBridge: video } } as unknown as HTMLIFrameElement;
  return { account, control, bridge, video, document, frame, abort: new AbortController() };
}
afterEach(() => vi.useRealTimers());

describe("account menu opens the original API settings safely", () => {
  it("rejects an already cancelled request without starting timers or opening configuration", async () => {
    vi.useFakeTimers();
    const h = fixture(); h.abort.abort();
    await expect(openCreativeApiConfig(() => h.frame, h.abort.signal)).rejects.toThrow("已取消");
    expect(h.bridge.getAccountKey).not.toHaveBeenCalled(); expect(h.bridge.openConfig).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("validates the account and opens the existing image settings once", async () => {
    const h = fixture();
    await openCreativeApiConfig(() => h.frame, h.abort.signal);
    expect(h.bridge.getAccountKey).toHaveBeenCalledOnce();
    expect(h.bridge.openConfig).toHaveBeenCalledOnce();
    expect(h.video.openConfig).not.toHaveBeenCalled();
  });
  it("rejects stale account bindings without opening private configuration", async () => {
    const h = fixture(); h.bridge.getAccountKey.mockResolvedValue("tenant:bob");
    await expect(openCreativeApiConfig(() => h.frame, h.abort.signal)).rejects.toThrow("登录账号已变化");
    expect(h.bridge.openConfig).not.toHaveBeenCalled();
  });
  it("preserves the UI task lock and bridge config lock", async () => {
    const h = fixture(); h.control.disabled = true;
    await expect(openCreativeApiConfig(() => h.frame, h.abort.signal)).rejects.toThrow("请等待当前任务");
    expect(h.bridge.openConfig).not.toHaveBeenCalled();
    h.control.disabled = false;
    h.bridge.openConfig.mockReturnValue({ ok: false, error: "任务回执待确认" });
    await expect(openCreativeApiConfig(() => h.frame, h.abort.signal)).rejects.toThrow("任务回执待确认");
  });
  it("waits for startup and cancels without opening after leaving", async () => {
    vi.useFakeTimers();
    const h = fixture(); h.document.documentElement.dataset.labStartup = "pending";
    const opened = openCreativeApiConfig(() => h.frame, h.abort.signal);
    const rejected = expect(opened).rejects.toThrow("已取消");
    await vi.advanceTimersByTimeAsync(100); expect(h.bridge.getAccountKey).not.toHaveBeenCalled();
    h.abort.abort(); await rejected;
    h.document.documentElement.dataset.labStartup = "ready";
    await vi.advanceTimersByTimeAsync(200);
    expect(h.bridge.openConfig).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not open after a delayed identity lookup times out", async () => {
    vi.useFakeTimers();
    const h = fixture(); let resolve!: (key: string) => void;
    h.bridge.getAccountKey.mockImplementation(() => new Promise(done => { resolve = done; }));
    const rejected = expect(openCreativeApiConfig(() => h.frame, h.abort.signal, "image", 200)).rejects.toThrow("暂未就绪");
    await vi.advanceTimersByTimeAsync(200); await rejected;
    resolve("tenant:alice"); await Promise.resolve();
    expect(h.bridge.openConfig).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("uses the video workbench's original opener and its own account validation", async () => {
    const h = fixture();
    await openCreativeApiConfig(() => h.frame, h.abort.signal, "video");
    expect(h.video.openConfig).toHaveBeenCalledOnce();
    expect(h.bridge.getAccountKey).not.toHaveBeenCalled();
    expect(h.bridge.openConfig).not.toHaveBeenCalled();
  });
});
