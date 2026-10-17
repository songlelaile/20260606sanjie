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
type Attempt = { requestId: string; taskId?: string; providerTaskId?: string; status?: string; state?: string; reservedYuan: number; estimatedYuan?: number;
  actualCostYuan?: number; costSource?: string; released?: boolean; details?: { stateUncertain?: boolean }; errorCode?: string };
type Shot = { id: string; status: string; attempts: Attempt[]; adoptionStatus?: string; taskId?: string; providerTaskId?: string;
  resultAssetId?: string; resultUrls?: string[]; error?: string; state?: string; details?: unknown; stateUncertain?: boolean; cancelPending?: boolean };
type ShotDefinition = { id: string; index: number; kind: string; durationSeconds: number; productKey: string; estimatedYuan: number;
  sourceAssetId?: string; request?: { resolution: string; ratio: string; productKey: string; durationSeconds: number } };
type Plan = { aiSeconds: number; resolution?: string; options: { mode: string; budgetYuan: number; maxAttempts: number }; shots: ShotDefinition[];
  request?: { images?: Array<{ id: string; kind: string }> }; finalAudio?: { tracks: Array<{ id: string; assetId: string; role: string }> }; musicAssetIds?: string[] };
type Run = { id: string; taskId: string; purpose: string; accountKey: string; status: string; durationSeconds: number; prompt: string; plan: Plan;
  shotRuns: Shot[]; narrationRuns?: Array<{ status: string; stateUncertain?: boolean }>; resolution?: string; stateUncertain?: boolean;
  resultAssetId?: string; newPlanRequestedAt?: string; updatedAt?: string; state?: string };
type Asset = Record<string, unknown>;
type Message = { payload: { requestId?: string; request?: { resolution: string } } };
type State = { accountKey: string; productionRun: Run | null; history: Run[]; productionBusy: boolean; actionPending: boolean;
  assets: { image: Asset[] }; settings: { creativeRoute: string; resolution: string }; productionOptions: { budgetYuan: number };
  modelCatalog: Array<{ productKey: string; configured: boolean }> };
type Api = { state: State; cacheDom(): void; bindProductionEvents(): void; renderProductionRun(): void; draftSnapshot(): unknown;
  canStartNewProductionPlan(run: Run): boolean; startNewProductionPlan(): Promise<boolean>; restoreHistory(): Promise<void>;
  startProductionGeneration(): Promise<void>; executeProductionRun(run: Run | undefined): Promise<unknown>;
  retryProductionShot(run: Run | undefined, shotId: string): Promise<unknown>; productionRetryState(run: Run, shot: Shot): { allowed: boolean; exhausted: boolean };
  productionCostSummary(run: Run): Record<string, number>; removeAsset(kind: string, id: string): Promise<void> };
function harness() {
  const html = readFileSync(new URL("../../public/creative/labs/ecommerce-video-studio/video-studio.html", import.meta.url), "utf8");
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Node()]));
  nodes.get("history-filter")!.value = "all";
  const saved = new Map<string, Run>();
  const store = { saveRun: vi.fn(async (run: Run) => { saved.set(run.id, structuredClone(run)); return run; }),
    listRuns: vi.fn(async () => [...saved.values()].map(run => structuredClone(run))),
    removeAsset: vi.fn(), saveDraft: vi.fn(), deleteAsset: vi.fn(async () => true), deleteDraft: vi.fn(async () => true) };
  const messages = vi.fn((message: Message, done: (reply: unknown) => void) => done({ ok: true, payload: {
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
  const api = context.SZEcommerceVideoStudioTesting as Api;
  api.cacheDom();
  Object.assign(api.state, { accountKey: "tenant:alice", backendConnected: true, credentialAvailable: true,
    prompt: "商品细节展示", productionOptions: { mode: "quality", totalDurationSeconds: 15, hybridAiSeconds: 0, budgetYuan: 17, maxAttempts: 1 } });
  api.state.modelCatalog.find(model => model.productKey === "seedance-2.0")!.configured = true;
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
    expect(h.api.state.productionRun!.id).toBe("old-plan");
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
    const next = h.api.state.productionRun!;
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

function partial(h: ReturnType<typeof harness>): Run {
  // Legacy v1 plan: shot 1 saved at 720p, shot 2 definitively rejected at its 1/1 cap, shot 3 never submitted.
  const old = h.run();
  old.resolution = "720p"; old.plan.resolution = "720p";
  old.plan.shots.forEach(shot => { shot.request = { resolution: "720p", ratio: "9:16", productKey: "seedance-2.0", durationSeconds: 5 }; });
  old.shotRuns = [
    { id: "shot-1", status: "succeeded", adoptionStatus: "accepted", taskId: "task-ok", providerTaskId: "cgt-ok", resultAssetId: "old-plan_shot-1_attempt1",
      resultUrls: ["https://example.com/ok.mp4"], error: "",
      attempts: [{ requestId: "old-plan:shot-1:1", taskId: "task-ok", providerTaskId: "cgt-ok", reservedYuan: 5.47, estimatedYuan: 4.97, actualCostYuan: 4.97, costSource: "provider_receipt" }] },
    { id: "shot-2", status: "failed", adoptionStatus: "accepted", taskId: "task-400", providerTaskId: "cgt-400", resultAssetId: "", resultUrls: [],
      error: "InputImageSensitiveContentDetected.PrivacyInformation",
      attempts: [{ requestId: "old-plan:shot-2:1", taskId: "task-400", providerTaskId: "cgt-400", reservedYuan: 5.47, estimatedYuan: 4.97, released: true }] },
    { id: "shot-3", status: "pending", adoptionStatus: "accepted", attempts: [], taskId: "", resultAssetId: "" }];
  return h.select(old);
}

describe("explicit release of a terminal failed plan with saved successful shots", () => {
  it("offers the new-plan action for a saved success, a spent 1/1 failure and an unsubmitted shot", () => {
    const h = harness(); const old = partial(h); h.api.bindProductionEvents(); h.api.renderProductionRun();
    expect(h.api.productionRetryState(old, old.shotRuns[1])).toMatchObject({ allowed: false, exhausted: true });
    expect(h.api.canStartNewProductionPlan(old)).toBe(true);
    expect(h.nodes.get("production-new-plan")!.hidden).toBe(false);
    expect(h.nodes.get("production-new-plan-help")!.textContent).toContain("已成功镜头");
  });

  it("records only the choice: every request, result, attempt and fee survives, with zero START or delete", async () => {
    const h = harness(); const old = partial(h); const before = structuredClone(old);
    const fees = h.api.productionCostSummary(old);
    expect(await h.api.startNewProductionPlan()).toBe(true);
    expect(h.api.state.productionRun).toBeNull();
    const stored = h.saved.get("old-plan")!;
    expect(stored).toEqual({ ...before, newPlanRequestedAt: expect.any(String), updatedAt: expect.any(String) });
    expect(h.api.productionCostSummary(stored)).toEqual(fees);
    expect(old).toEqual(before);
    expect(h.messages).not.toHaveBeenCalled(); expect(h.store.removeAsset).not.toHaveBeenCalled();
    expect(h.nodes.get("composer-validation")!.textContent).toContain("已成功镜头");
    expect(h.nodes.get("composer-validation")!.textContent).toContain("单独估算");
    await h.api.restoreHistory();
    expect(h.api.state.productionRun).toBeNull();
    expect(h.api.state.history[0].shotRuns).toEqual(before.shotRuns);
    // A released plan never retries or resumes.
    await h.api.retryProductionShot(h.api.state.history[0], "shot-2"); await h.api.executeProductionRun(h.api.state.history[0]);
    expect(h.messages).not.toHaveBeenCalled();
  });

  it("builds a separate 480p plan only after Generate and never transplants the old 720p shot", async () => {
    const h = harness(); partial(h);
    h.api.state.settings.resolution = "480p";
    expect(await h.api.startNewProductionPlan()).toBe(true);
    expect(h.messages).not.toHaveBeenCalled();
    await h.api.startProductionGeneration();
    const next = h.api.state.productionRun!;
    expect(next.id).not.toBe("old-plan");
    expect(next.plan.resolution).toBe("480p");
    expect(next.plan.shots.every(shot => shot.request?.resolution === "480p")).toBe(true);
    expect(next.shotRuns.every(shot => !shot.resultAssetId && shot.attempts.every(attempt => !attempt.requestId.startsWith("old-plan")))).toBe(true);
    expect(h.messages.mock.calls[0][0].payload.request?.resolution).toBe("480p");
    expect(h.messages.mock.calls[0][0].payload.requestId).toContain(next.id);
    expect(h.saved.get("old-plan")!.shotRuns[0].resultAssetId).toBe("old-plan_shot-1_attempt1");
    expect(h.saved.get("old-plan")!.plan.resolution).toBe("720p");
  });

  it.each([
    ["an unsaved success", (r: Run) => { r.shotRuns[0].resultAssetId = ""; }],
    ["an unknown shot", (r: Run) => { r.shotRuns[2].status = "unknown"; }],
    ["conflicting failed status and processing state", (r: Run) => { r.shotRuns[1].state = "processing"; }],
    ["conflicting saved success and unknown state", (r: Run) => { r.shotRuns[0].state = "unknown"; }],
    ["a queued state in a terminal attempt", (r: Run) => { r.shotRuns[0].attempts[0].status = "failed"; r.shotRuns[0].attempts[0].state = "QUEUED"; }],
    ["a run-level running state", (r: Run) => { r.state = "running"; }],
    ["a pending shot with a nested provider task", (r: Run) => { r.shotRuns[2].details = { receipt: { providerTaskId: "cgt-late" } }; }],
    ["a ready shot with nested provider submission", (r: Run) => { r.shotRuns[2].status = "ready"; r.shotRuns[2].details = { providerSubmitted: true }; }],
    ["a pending shot with a nested request identity", (r: Run) => { r.shotRuns[2].details = [{ requestId: "submitted-before-reload" }]; }],
    ["a malformed pending attempt collection", (r: Run) => { r.shotRuns[2].attempts = {} as unknown as Attempt[]; }],
    ["a processing shot", (r: Run) => { r.shotRuns[2].status = "processing"; }],
    ["a cancelled shot", (r: Run) => { r.shotRuns[2].status = "cancelled"; }],
    ["an uncertain success", (r: Run) => { r.shotRuns[0].stateUncertain = true; }],
    ["an uncertain attempt on the success", (r: Run) => { r.shotRuns[0].attempts[0].details = { stateUncertain: true }; }],
    ["a timed-out attempt", (r: Run) => { r.shotRuns[1].attempts[0].errorCode = "PROVIDER_CREATE_TIMEOUT"; }],
    ["a cancellation pending", (r: Run) => { r.shotRuns[0].cancelPending = true; }],
    ["a queued narration", (r: Run) => { r.narrationRuns = [{ status: "queued" }]; }],
    ["a pending shot with prior submission", (r: Run) => { r.shotRuns[2].attempts = [{ requestId: "old-plan:shot-3:1", taskId: "task-x", reservedYuan: 5.47 }]; }],
    ["a ready shot with a task id", (r: Run) => { r.shotRuns[2].status = "ready"; r.shotRuns[2].taskId = "task-y"; }],
    ["a failed shot carrying a result", (r: Run) => { r.shotRuns[1].resultAssetId = "stray"; }],
    ["a run-level result", (r: Run) => { r.resultAssetId = "final"; }],
    ["only successes (composition failure keeps free resume)", (r: Run) => { r.shotRuns = [r.shotRuns[0]]; }]
  ])("fails closed on %s", async (_label, mutate) => {
    const h = harness(); const old = partial(h); mutate(old); h.saved.set(old.id, structuredClone(old));
    expect(await h.api.startNewProductionPlan()).toBe(false);
    expect(h.api.state.productionRun).toBe(old); expect(h.store.saveRun).not.toHaveBeenCalled();
  });

  it("keeps account switches, busy work and a failed save from releasing the partial plan", async () => {
    const h = harness(); const old = partial(h); const before = structuredClone(old);
    h.api.state.accountKey = "tenant:bob"; expect(await h.api.startNewProductionPlan()).toBe(false);
    h.api.state.accountKey = "tenant:alice"; h.api.state.productionBusy = true; expect(await h.api.startNewProductionPlan()).toBe(false);
    h.api.state.productionBusy = false; h.api.state.actionPending = true; expect(await h.api.startNewProductionPlan()).toBe(false);
    h.api.state.actionPending = false; h.store.saveRun.mockRejectedValueOnce(new Error("test storage unavailable"));
    expect(await h.api.startNewProductionPlan()).toBe(false);
    expect(h.api.state.productionRun).toBe(old); expect(old).toEqual(before);
    expect(h.saved.get("old-plan")).toEqual(before);
  });

  it("requires reconciliation again when a late uncertain receipt lands on the released plan", async () => {
    const h = harness(); partial(h); await h.api.startNewProductionPlan();
    h.saved.get("old-plan")!.shotRuns[2].status = "submitting";
    await h.api.restoreHistory(); h.api.renderProductionRun();
    expect(h.api.state.productionRun!.id).toBe("old-plan");
    expect(h.nodes.get("production-resume")!.disabled).toBe(false);
    expect(h.nodes.get("production-new-plan")!.hidden).toBe(true);
    expect(h.messages).not.toHaveBeenCalled();
  });
});

describe("draft source removal never deletes blobs a saved plan still references", () => {
  function withLocalAsset(h: ReturnType<typeof harness>, extra: Asset = {}) {
    const asset = { id: "local-image", kind: "image", name: "p.png", mimeType: "image/png", storageRef: { id: "local-image" }, ...extra };
    h.api.state.assets.image = [asset];
    return asset;
  }
  function deps(h: ReturnType<typeof harness>) { return h.store; }
  it.each([
    ["a local shot source", (r: Run) => { r.plan.shots[0] = { ...r.plan.shots[0], kind: "local", sourceAssetId: "local-image" }; }],
    ["a request image", (r: Run) => { r.plan.request = { images: [{ id: "local-image", kind: "image" }] }; }],
    ["final audio", (r: Run) => { r.plan.finalAudio = { tracks: [{ id: "t1", assetId: "local-image", role: "music" }] }; }],
    ["music", (r: Run) => { r.plan.musicAssetIds = ["local-image"]; }]
  ])("keeps the local copy when %s references it", async (_label, mutate) => {
    const h = harness(); const store = deps(h); const old = h.run(); mutate(old); h.select(old);
    withLocalAsset(h);
    await h.api.removeAsset("image", "local-image");
    expect(h.api.state.assets.image).toHaveLength(0);
    expect(store.deleteAsset).not.toHaveBeenCalled();
  });

  it("deletes an unreferenced local copy and keeps all copies if saved plans cannot be read", async () => {
    const h = harness(); const store = deps(h); h.select();
    withLocalAsset(h);
    await h.api.removeAsset("image", "local-image");
    expect(store.deleteAsset).toHaveBeenCalledWith("local-image");
    store.deleteAsset.mockClear(); h.store.listRuns.mockRejectedValueOnce(new Error("test storage unavailable"));
    withLocalAsset(h);
    await h.api.removeAsset("image", "local-image");
    expect(store.deleteAsset).not.toHaveBeenCalled();
  });
});
