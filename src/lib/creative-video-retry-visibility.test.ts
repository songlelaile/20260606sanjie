import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  hidden = false; disabled = false; textContent = ""; title = ""; className = ""; value = "";
  dataset: Record<string, string> = {}; children: Element[] = [];
  style = { display: "", setProperty: vi.fn() };
  classList = { add: vi.fn(), toggle: vi.fn() };
  appendChild(node: Element) { this.children.push(node); return node; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
  querySelector() { return null; } querySelectorAll() { return []; } closest() { return null; }
  setAttribute(name: string, value: string) { if (name === "title") this.title = value; }
  addEventListener() {}
}
type Attempt = { requestId: string; reservedYuan: number; released: boolean };
type Shot = { id: string; status: string; attempts: Attempt[]; error?: string };
type Run = { id: string; taskId: string; purpose: string; accountKey: string; status: string; durationSeconds: number;
  error: string; newPlanRequestedAt?: string;
  plan: { aiSeconds: number; ratio: string; resolution: string; options: { mode: string; budgetYuan: number; maxAttempts: number };
    shots: Array<{ id: string; index: number; kind: string; durationSeconds: number; productKey: string; estimatedYuan: number }> };
  shotRuns: Shot[] };
type Model = { productKey: string; configured: boolean };
type State = { accountKey: string; productionRun: Run | null; history: Run[]; productionBusy: boolean; productionStarting: boolean;
  productionOptions: { maxAttempts: number }; modelCatalog: Model[]; settings: { creativeRoute: string } };
type Api = { state: State; cacheDom(): void; renderProductionRun(): void; retryProductionShot(run: Run, shotId: string): Promise<void> };

function harness(maxAttempts = 1, attemptCount = 1) {
  const base = "../../public/creative/labs/ecommerce-video-studio/";
  const html = readFileSync(new URL(base + "video-studio.html", import.meta.url), "utf8");
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  nodes.get("history-filter")!.value = "all";
  const store = { saveRun: vi.fn(async (run: Run) => run), listRuns: vi.fn(async () => []), saveDraft: vi.fn() };
  const messages = vi.fn((_message: { type: string }, done: (reply: unknown) => void) => done({ ok: false, error: { code: "FIXTURE_NO_PROVIDER", message: "No supplier is called by this fixture" } }));
  const context = vm.createContext({ console, URL, AbortController, CSS: { escape: (value: string) => value }, setTimeout: () => 1, clearTimeout: () => {},
    document: { readyState: "loading", addEventListener: vi.fn(), getElementById: (id: string) => nodes.get(id) ?? null,
      createElement: () => new Element(), querySelector: () => null, querySelectorAll: () => [] },
    __SZ_VIDEO_STUDIO_EXPOSE_TESTING__: true, SZEcommerceVideoStore: store, chrome: { runtime: { sendMessage: messages } } });
  for (const file of ["video-studio-contract.js", "video-production.js", "video-studio.js"]) vm.runInContext(readFileSync(new URL(base + file, import.meta.url), "utf8"), context);
  const api = context.SZEcommerceVideoStudioTesting as Api;
  api.cacheDom(); Object.assign(api.state, { accountKey: "tenant:alice", backendConnected: true, credentialAvailable: true,
    prompt: "商品细节展示", productionOptions: { mode: "quality", totalDurationSeconds: 15, hybridAiSeconds: 0, budgetYuan: 17, maxAttempts } });
  api.state.modelCatalog.find(model => model.productKey === "seedance-2.0")!.configured = true;
  api.state.settings.creativeRoute = "free_direct";
  const run: Run = { id: "old-plan", taskId: "old-plan", purpose: "production", accountKey: "tenant:alice", status: "failed", durationSeconds: 15,
    error: "镜头失败，已完成镜头保留；可手动仅重试失败镜头。",
    plan: { aiSeconds: 15, ratio: "9:16", resolution: "720p", options: { mode: "quality", budgetYuan: 17, maxAttempts },
      shots: ["shot-1", "shot-2", "shot-3"].map((id, index) => ({ id, index, kind: "ai", durationSeconds: 5, productKey: "seedance-2.0", estimatedYuan: 4.97 })) },
    shotRuns: [{ id: "shot-1", status: "failed", attempts: Array.from({ length: attemptCount }, (_, index) => ({ requestId: `old-plan:shot-1:${index + 1}`, reservedYuan: 5.47, released: true })) },
      { id: "shot-2", status: "pending", attempts: [] }, { id: "shot-3", status: "pending", attempts: [] }] };
  api.state.productionRun = run; api.state.history = [run];
  const flatten = (node: Element): Element[] => [node, ...node.children.flatMap(flatten)];
  function retryButton() { return flatten(nodes.get("production-shot-list")!).find(node => node.dataset.productionShotAction === "retry" && node.dataset.shotId === "shot-1"); }
  function firstRowText() { return flatten(nodes.get("production-shot-list")!.children[0]).map(node => node.textContent).join(" "); }
  return { api, nodes, store, messages, run, retryButton, firstRowText };
}

describe("visible retry limits on production shots", () => {
  it.each([{ maximum: 1, used: 1 }, { maximum: 2, used: 2 }])("shows a disabled retry with an accurate explanation for $used/$maximum", async ({ maximum, used }) => {
    const h = harness(maximum, used), before = JSON.stringify(h.run); h.api.renderProductionRun();
    expect(h.retryButton()).toBeDefined(); expect(h.retryButton()!.textContent).toBe("仅重试此镜");
    expect(h.retryButton()!.disabled).toBe(true); expect(h.retryButton()!.title).toContain("尝试上限");
    expect(h.firstRowText()).toContain(`尝试 ${used} / ${maximum}`); expect(h.firstRowText()).toContain("尝试上限");
    expect(h.firstRowText()).not.toContain("失败，可手动重试");
    expect(h.nodes.get("production-run-notice")!.textContent).toContain("尝试上限");
    expect(h.nodes.get("production-run-notice")!.textContent).not.toContain("可手动仅重试失败镜头");
    await h.api.retryProductionShot(h.run, "shot-1");
    expect(h.messages).not.toHaveBeenCalled(); expect(h.store.saveRun).not.toHaveBeenCalled(); expect(JSON.stringify(h.run)).toBe(before);
  });
  it("keeps a failed 1/2 shot available and stops the fixture at persistence before any supplier dispatch", async () => {
    const h = harness(2, 1); h.api.renderProductionRun();
    expect(h.retryButton()).toBeDefined(); expect(h.retryButton()!.disabled).toBe(false);
    expect(h.firstRowText()).toContain("尝试 1 / 2"); expect(h.firstRowText()).not.toContain("尝试上限");
    const snapshot = JSON.stringify(h.run.plan), identity = h.run.shotRuns[0].attempts[0].requestId;
    h.store.saveRun.mockRejectedValueOnce(new Error("Fixture stops before video dispatch"));
    await expect(h.api.retryProductionShot(h.run, "shot-1")).rejects.toThrow("Fixture stops before video dispatch");
    expect(h.store.saveRun).toHaveBeenCalledTimes(1); expect(h.messages).not.toHaveBeenCalled();
    expect(JSON.stringify(h.run.plan)).toBe(snapshot); expect(h.run.shotRuns[0].attempts[0].requestId).toBe(identity);
  });
  it("does not unlock an exhausted original 1/1 plan when the current draft attempts setting changes to two", async () => {
    const h = harness(1, 1), before = JSON.stringify(h.run);
    h.api.state.productionOptions.maxAttempts = 2; h.api.renderProductionRun();
    expect(h.retryButton()!.disabled).toBe(true); expect(h.retryButton()!.title).toContain("1/1");
    expect(h.firstRowText()).toContain("尝试 1 / 1"); expect(h.firstRowText()).toContain("尝试上限");
    await h.api.retryProductionShot(h.run, "shot-1");
    expect(JSON.stringify(h.run)).toBe(before); expect(h.run.plan.options.maxAttempts).toBe(1);
    expect(h.messages).not.toHaveBeenCalled(); expect(h.store.saveRun).not.toHaveBeenCalled();
  });
  it("preserves a specific supplier error rather than replacing it with generic attempt-limit guidance", () => {
    const h = harness(1, 1);
    h.run.error = "视频供应商请求失败（HTTP 400）：UnsupportedParameter.Resolution；request_id=fixture-diagnostic";
    const before = JSON.stringify(h.run); h.api.renderProductionRun();
    expect(h.nodes.get("production-run-notice")!.textContent).toBe(h.run.error);
    expect(JSON.stringify(h.run)).toBe(before); expect(h.store.saveRun).not.toHaveBeenCalled(); expect(h.messages).not.toHaveBeenCalled();
    expect(h.retryButton()!.disabled).toBe(true);
  });
  it.each(["busy", "starting", "released", "account", "succeeded", "unknown"])("keeps %s work from changing or dispatching the original shot", async protection => {
    const h = harness(2, 1);
    if (protection === "busy") h.api.state.productionBusy = true;
    if (protection === "starting") h.api.state.productionStarting = true;
    if (protection === "released") h.run.newPlanRequestedAt = new Date().toISOString();
    if (protection === "account") h.api.state.accountKey = "tenant:bob";
    if (protection === "succeeded" || protection === "unknown") h.run.shotRuns[0].status = protection;
    const before = JSON.stringify(h.run); h.api.renderProductionRun();
    if (protection === "busy" || protection === "starting") expect(h.retryButton()!.disabled).toBe(true);
    if (protection === "succeeded" || protection === "unknown") expect(h.retryButton()).toBeUndefined();
    await h.api.retryProductionShot(h.run, "shot-1").catch(error => { expect(String(error.message)).toContain("账号"); });
    expect(h.messages).not.toHaveBeenCalled(); expect(h.store.saveRun).not.toHaveBeenCalled(); expect(JSON.stringify(h.run)).toBe(before);
  });
});
