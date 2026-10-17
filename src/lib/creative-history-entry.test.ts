import { afterEach, describe, expect, it, vi } from "vitest";
import { openCreativeHistory } from "./creative-history-entry";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const account = { key: "tenant:alice" };
  const trigger = {} as HTMLElement;
  const bridge = {
    archiveContext: () => ({ accountKey: account.key }),
    getAccountKey: vi.fn(async () => "tenant:alice"),
    openHistory: vi.fn(async () => ({ ok: true }))
  };
  const document = { documentElement: { dataset: { labStartup: "ready" } },
    getElementById: (id: string) => id === "openArchiveBtn" ? trigger : {} };
  const frame = { contentDocument: document, contentWindow: { SZ_CREATIVE_TOOLS_BRIDGE: bridge } } as unknown as HTMLIFrameElement;
  return { account, trigger, bridge, document, frame, abort: new AbortController() };
}

afterEach(() => vi.useRealTimers());

describe("safe existing generation history entry", () => {
  it("rejects an already cancelled request without starting timers or opening history", async () => {
    vi.useFakeTimers();
    const h = fixture(); h.abort.abort();
    await expect(openCreativeHistory(() => h.frame, h.abort.signal)).rejects.toThrow("已取消");
    expect(h.bridge.getAccountKey).not.toHaveBeenCalled(); expect(h.bridge.openHistory).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses the original dialog opener after validating the bound account", async () => {
    const h = fixture();
    await openCreativeHistory(() => h.frame, h.abort.signal);
    expect(h.bridge.getAccountKey).toHaveBeenCalledOnce();
    expect(h.bridge.openHistory).toHaveBeenCalledExactlyOnceWith(h.trigger);
  });

  it("waits for a real account binding instead of reading the local fallback archive", async () => {
    vi.useFakeTimers();
    const h = fixture(); h.account.key = "local";
    const opened = openCreativeHistory(() => h.frame, h.abort.signal);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.bridge.getAccountKey).not.toHaveBeenCalled();
    expect(h.bridge.openHistory).not.toHaveBeenCalled();
    h.account.key = "tenant:alice";
    await vi.advanceTimersByTimeAsync(100); await opened;
    expect(h.bridge.openHistory).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["session", "binding"])("rejects a changed %s account without opening private history", async kind => {
    const h = fixture(), waiting = deferred<string>();
    h.bridge.getAccountKey.mockImplementation(() => waiting.promise);
    const opened = openCreativeHistory(() => h.frame, h.abort.signal);
    const rejected = expect(opened).rejects.toThrow("登录账号已变化");
    if (kind === "binding") h.account.key = "tenant:bob";
    waiting.resolve(kind === "session" ? "tenant:bob" : "tenant:alice");
    await rejected;
    expect(h.bridge.openHistory).not.toHaveBeenCalled();
  });

  it("does not open a hidden or replaced frame after an identity response arrives", async () => {
    const h = fixture(), waiting = deferred<string>();
    h.bridge.getAccountKey.mockImplementation(() => waiting.promise);
    let current: HTMLIFrameElement | null = h.frame;
    const opened = openCreativeHistory(() => current, h.abort.signal);
    const rejected = expect(opened).rejects.toThrow("创作页面已切换");
    current = null; waiting.resolve("tenant:alice"); await rejected;
    expect(h.bridge.openHistory).not.toHaveBeenCalled();
  });

  it("rejects an iframe reload that retains its element and window while account validation is pending", async () => {
    const h = fixture(), waiting = deferred<string>();
    h.bridge.getAccountKey.mockImplementation(() => waiting.promise);
    const opened = openCreativeHistory(() => h.frame, h.abort.signal);
    const rejected = expect(opened).rejects.toThrow("创作页面已切换");
    Object.defineProperty(h.frame, "contentDocument", { value: { ...h.document } });
    waiting.resolve("tenant:alice"); await rejected;
    expect(h.bridge.openHistory).not.toHaveBeenCalled();
  });

  it.each(["frame", "account"])("rejects a late dialog response after its %s changes", async kind => {
    const h = fixture(), waiting = deferred<{ ok: boolean }>();
    h.bridge.openHistory.mockImplementation(() => waiting.promise);
    let current: HTMLIFrameElement | null = h.frame;
    const opened = openCreativeHistory(() => current, h.abort.signal);
    const rejected = expect(opened).rejects.toThrow(kind === "frame" ? "创作页面已切换" : "登录账号已变化");
    await vi.waitFor(() => expect(h.bridge.openHistory).toHaveBeenCalledOnce());
    if (kind === "frame") current = null; else h.account.key = "tenant:bob";
    waiting.resolve({ ok: true }); await rejected;
  });

  it("stops polling on timeout and cannot open after a late identity response", async () => {
    vi.useFakeTimers();
    const h = fixture(), waiting = deferred<string>();
    h.bridge.getAccountKey.mockImplementation(() => waiting.promise);
    const rejected = expect(openCreativeHistory(() => h.frame, h.abort.signal, 300)).rejects.toThrow("暂未就绪");
    await vi.advanceTimersByTimeAsync(300); await rejected;
    waiting.resolve("tenant:alice"); await Promise.resolve();
    expect(h.bridge.openHistory).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels delayed initialization on navigation or unmount", async () => {
    vi.useFakeTimers();
    const h = fixture(); h.account.key = "local";
    const rejected = expect(openCreativeHistory(() => h.frame, h.abort.signal)).rejects.toThrow("已取消");
    h.abort.abort(); await rejected;
    h.account.key = "tenant:alice"; await vi.advanceTimersByTimeAsync(200);
    expect(h.bridge.openHistory).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a startup or archive failure instead of silently claiming success", async () => {
    const h = fixture(); h.document.documentElement.dataset.labStartup = "error";
    await expect(openCreativeHistory(() => h.frame, h.abort.signal)).rejects.toThrow("加载失败");
    expect(h.bridge.openHistory).not.toHaveBeenCalled();
    h.document.documentElement.dataset.labStartup = "ready";
    h.bridge.openHistory.mockResolvedValue({ ok: false });
    await expect(openCreativeHistory(() => h.frame, h.abort.signal)).rejects.toThrow("读取失败");
  });
});
