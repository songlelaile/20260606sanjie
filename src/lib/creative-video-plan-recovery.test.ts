import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Node {
  hidden = false; disabled = false; textContent = ""; className = ""; value = "";
  dataset: Record<string, string> = {}; children: Node[] = [];
  style: Record<string, string> = {};
  listeners = new Map<string, () => unknown>();
  classList = { add: vi.fn(), toggle: vi.fn() };
  appendChild(node: Node) { this.children.push(node); return node; }
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  setAttribute() {}
  addEventListener(name: string, fn: () => unknown) { this.listeners.set(name, fn); }
}
type Run = Record<string, any>;
function harness() {
  const html = readFileSync(new URL("../../public/creative/labs/ecommerce-video-studio/video-studio.html", import.meta.url), "utf8");
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Node()]));
  nodes.get("history-filter")!.value = "all";
  const saved = new Map<string, Run>();
  const store = { saveRun: vi.fn(async (run: Run) => { saved.set(run.id, structuredClone(run)); return run; }),
    listRuns: vi.fn(async () => [...saved.values()].map(run => structuredClone(run))),
    removeAsset: vi.fn(), saveDraft: vi.fn() };
  const messages = vi.fn((message: any, done: (reply: unknown) => void) => done({ ok: true, payload: {
    task: { id: `test-${messages.mock.calls.length}`, status: "failed", providerSubmitted: false,
      error: { code: "TEST_ONLY_REJECTION", message: "No supplier call is made by this fixture." } }
  } }));
  const context = vm.createContext({ console, URL, AbortController,
    setTimeout: () => 1, clearTimeout: () => {},
    document: { readyState: "loading", addEventListener: vi.fn(), getElementById: (id: string) => nodes.get(id) ?? null,
      createElement: () => new Node(), querySelector: () => null },
    __SZ_VIDEO_STUDIO_EXPOSE_TESTING__: true, SZEcommerceVideoStore: store,
    chrome: { runtime: { sendMessage: messages } } });
  for (const file of ["video-studio-contract.js", "video-production.js", "video-studio.js"]) {
    vm.runInContext(readFileSync(new URL(`../../public/creative/labs/ecommerce-video-studio/${file}`, import.meta.url), "utf8"), context);
  }
  const api = context.SZEcommerceVideoStudioTesting as any;
  api.cacheDom();
  Object.assign(api.state, { accountKey: "tenant:alice", backendConnected: true, credentialAvailable: true,
    prompt: "商品细节展示", productionOptions: { mode: "quality", totalDurationSeconds: 15, hybridAiSeconds: 0, budgetYuan: 17, maxAttempts: 1 } });
  api.state.modelCatalog.find((model: any) => model.productKey === "seedance-2.0").configured = true;
  api.state.settings.creativeRoute = "free_direct";
  function run(): Run {
    return { id: "old-plan", taskId: "old-plan", purpose: "production", accountKey: "tenant:alice", status: "failed",
      durationSeconds: 15, prompt: "原计划", plan: { aiSeconds: 15, options: { mode: "quality", budgetYuan: 17, maxAttempts: 1 },
        shots: ["shot-1", "shot-2", "shot-3"].map((id, index) => ({ id, index, kind: "ai", durationSeconds: 5, productKey: "seedance-2.0", estimatedYuan: 4.97 })) },
      shotRuns: [{ id: "shot-1", status: "failed", attempts: [{ requestId: "old-plan:shot-1:1", reservedYuan: 5.47, released: true }] },
        { id: "shot-2", status: "pending", attempts: [] }, { id: "shot-3", status: "pending", attempts: [] }] };
  }
  function select(old = run()) { api.state.productionRun = old; api.state.history = [old]; saved.set(old.id, structuredClone(old)); return old; }
  return { api, nodes, store, messages, saved, run, select };
}

describe("explicit recovery from a definitively failed video plan", () => {
  it("offers the shipped button only for a failed plan without successful or uncertain receipts", () => {
    const h = harness(); const run = h.select(); h.api.bindProductionEvents(); h.api.renderProductionRun();
    expect(h.nodes.get("production-new-plan")!.hidden).toBe(false);
    expect(h.nodes.get("production-new-plan")!.listeners.has("click")).toBe(true);
    run.shotRuns[1].status = "succeeded"; h.api.renderProductionRun();
    expect(h.nodes.get("production-new-plan")!.hidden).toBe(true);
  });

  it("releases only the active plan and persists the choice across reload without submitting or deleting anything", async () => {
    const h = harness(); const original = h.select(); const before = structuredClone(original);
    h.api.state.assets.image = [{ id: "preserved-image", kind: "image", remoteUrl: "https://example.com/product.png" }];
    const draft = JSON.stringify(h.api.draftSnapshot());
    expect(await h.api.startNewProductionPlan()).toBe(true);
    expect(h.api.state.productionRun).toBeNull();
    expect(h.api.state.history).toHaveLength(1);
    expect(h.saved.get(original.id)).toMatchObject({ ...before, newPlanRequestedAt: expect.any(String) });
    expect(original).toEqual(before);
    expect(JSON.stringify(h.api.draftSnapshot())).toBe(draft);
    expect(h.messages).not.toHaveBeenCalled(); expect(h.store.removeAsset).not.toHaveBeenCalled();
    await h.api.restoreHistory();
    expect(h.api.state.productionRun).toBeNull(); expect(h.api.state.history).toHaveLength(1);
    expect(JSON.stringify(h.api.state.history[0].shotRuns)).toBe(JSON.stringify(before.shotRuns));
  });

  it.each(["succeeded", "processing", "submitting", "unknown", "queued", "cancelled"])("keeps a %s shot in the original plan", async status => {
    const h = harness(); const run = h.select(); run.shotRuns[1].status = status;
    expect(await h.api.startNewProductionPlan()).toBe(false);
    expect(h.api.state.productionRun).toBe(run); expect(h.store.saveRun).not.toHaveBeenCalled();
  });

  it.each(["run", "shot", "attempt", "narration"])("rejects uncertainty on the %s receipt", async level => {
    const h = harness(); const run = h.select();
    if (level === "run") run.stateUncertain = true;
    if (level === "shot") run.shotRuns[0].stateUncertain = true;
    if (level === "attempt") run.shotRuns[0].attempts[0].details = { stateUncertain: true };
    if (level === "narration") run.narrationRuns = [{ status: "failed", stateUncertain: true }];
    expect(await h.api.startNewProductionPlan()).toBe(false); expect(h.store.saveRun).not.toHaveBeenCalled();
  });

  it("keeps account switches, busy work, and a failed persistence from releasing the old plan", async () => {
    const h = harness(); const run = h.select(); h.api.state.accountKey = "tenant:bob";
    expect(await h.api.startNewProductionPlan()).toBe(false);
    h.api.state.accountKey = "tenant:alice"; h.api.state.productionBusy = true;
    expect(await h.api.startNewProductionPlan()).toBe(false);
    h.api.state.productionBusy = false; h.store.saveRun.mockRejectedValueOnce(new Error("test storage unavailable"));
    expect(await h.api.startNewProductionPlan()).toBe(false);
    expect(h.api.state.productionRun).toBe(run); expect(run.newPlanRequestedAt).toBeUndefined();
  });

  it("restores the original recovery entry if a released plan later contains an uncertain receipt", async () => {
    const h = harness(); h.select(); await h.api.startNewProductionPlan();
    h.saved.get("old-plan")!.shotRuns[0].status = "unknown";
    await h.api.restoreHistory(); h.api.renderProductionRun();
    expect(h.api.state.productionRun.id).toBe("old-plan");
    expect(h.nodes.get("production-resume")!.disabled).toBe(false);
    expect(h.nodes.get("production-new-plan")!.hidden).toBe(true);
    expect(h.messages).not.toHaveBeenCalled();
  });

  it("does not create a new snapshot without the explicit recovery action, then preserves budget and rights checks", async () => {
    const h = harness(); const run = h.select();
    await h.api.startProductionGeneration();
    expect(h.store.saveRun).not.toHaveBeenCalled(); expect(h.messages).not.toHaveBeenCalled();
    expect(h.nodes.get("composer-validation")!.textContent).toContain("已有未完成");
    await h.api.startNewProductionPlan(); const count = h.store.saveRun.mock.calls.length;
    h.api.state.productionOptions.budgetYuan = 10;
    await h.api.startProductionGeneration();
    expect(h.store.saveRun).toHaveBeenCalledTimes(count); expect(h.messages).not.toHaveBeenCalled();
    expect(h.nodes.get("composer-validation")!.textContent).toContain("预算");
    h.api.state.productionOptions.budgetYuan = 17;
    h.api.state.assets.image = [{ id: "new-image", kind: "image", remoteUrl: "https://example.com/new.png", mimeType: "image/png", width: 720, height: 1280 }];
    await h.api.startProductionGeneration();
    expect(h.store.saveRun).toHaveBeenCalledTimes(count); expect(h.messages).not.toHaveBeenCalled();
    expect(h.nodes.get("composer-validation")!.textContent).toContain("素材权利");
    expect(h.saved.get(run.id)!.shotRuns[0].attempts).toHaveLength(1);
  });

  it("creates a distinct snapshot only when generation is clicked and never reuses the old attempt identity", async () => {
    const h = harness(); const old = h.select();
    await h.api.startNewProductionPlan();
    await h.api.startProductionGeneration();
    const next = h.api.state.productionRun;
    expect(next.id).not.toBe(old.id); expect(h.api.state.history).toHaveLength(2);
    expect(next.plan.options.maxAttempts).toBe(1); expect(next.plan.options.budgetYuan).toBe(17);
    expect(h.messages).toHaveBeenCalledTimes(1);
    expect(h.messages.mock.calls[0][0].payload.requestId).toContain(next.id);
    expect(h.saved.get(old.id)!.shotRuns[0].attempts[0].requestId).toBe("old-plan:shot-1:1");
    const count = h.messages.mock.calls.length;
    await h.api.executeProductionRun(h.saved.get(old.id)); await h.api.retryProductionShot(h.saved.get(old.id), "shot-1");
    expect(h.messages).toHaveBeenCalledTimes(count);
  });
});
