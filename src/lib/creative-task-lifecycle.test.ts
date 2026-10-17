import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(resolve(process.env.CREATIVE_PROMPTLAB_TEST_PATH || "public/creative/labs/image-prompt-lab/promptlab.js"), "utf8");
function part(start: string, end: string) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function storage() {
  const data = new Map<string, string>();
  return { get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key), data };
}
type RuntimeRequest = { jobId: string; payload: Record<string, unknown>; config?: Record<string, unknown> };
type StoredDelivery = { jobId: string; images: string[]; taskId?: string };
type RuntimeOptions = { receiptKey?: string; onLate?: (response: unknown) => Promise<unknown> };
function deferred() { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(shared = storage(), query = "?mode=main&source=web&layout=1") {
  let seq = 0;
  const callbacks = new Map<string, ReturnType<typeof deferred>>();
  const dispatched: Array<RuntimeRequest & { type: string }> = [], cancelled: string[] = [], deliveries = new Map<string, StoredDelivery>();
  const locks = new Map<string, Promise<void>>();
  const context = createContext({ console, Date, URLSearchParams, Promise, setTimeout, clearTimeout, localStorage: shared,
    location: { search: query }, state: { archiveAccountKey: "account:alice", activeJobIds: {}, cancelledJobs: {}, referenceDetail: {} },
    $: () => null, newJobId: () => `job_fixture_${++seq}`, applyModelFallbackFromResponse: vi.fn(),
    chrome: { runtime: { sendMessage: (request: { jobId: string }, callback: (value?: unknown) => void) => { cancelled.push(request.jobId); callback?.({ ok: true }); } } },
    navigator: { locks: { request: async (key: string, options: { ifAvailable?: boolean }, callback: (lock: { name: string } | null) => unknown) => {
      if (locks.has(key) && options.ifAvailable) return callback(null);
      const previous = locks.get(key) || Promise.resolve();
      let release!: () => void;
      const lock = previous.then(() => new Promise<void>(done => { release = done; }));
      locks.set(key, lock); await previous;
      try { return await callback({ name: key }); } finally { release(); if (locks.get(key) === lock) locks.delete(key); }
    } } },
    promptLabTestSend: (type: string, payload: RuntimeRequest) => {
      dispatched.push({ type, ...payload }); const waiting = deferred(); callbacks.set(payload.jobId, waiting); return waiting.promise;
    },
    promptLabRuntimeFailure: (_: string, message: string) => ({ ok: false, error: message }),
    LEGACY_IMAGE_RECEIPT_PREFIX: "sz.legacy-image-receipt.v1:",
    SZ_SKU_DELIVERY_STORE: {
      save: async (owner: string, key: string, value: StoredDelivery) => { deliveries.set(JSON.stringify([owner, key]), JSON.parse(JSON.stringify(value))); return { ok: true }; },
      read: async (owner: string, key: string) => deliveries.get(JSON.stringify([owner, key])) || null,
      remove: async (owner: string, key: string, jobId: string) => { const id = JSON.stringify([owner, key]); if (deliveries.get(id)?.jobId !== jobId) return { ok: false }; deliveries.delete(id); return { ok: true, removed: true }; }
    }
  });
  context.window = context;
  if (source.includes("// Candidate-only additions:")) runInContext(part("// Candidate-only additions:", "// PROMPT_TASK_LIFECYCLE_V1"), context);
  runInContext(part("// PROMPT_TASK_LIFECYCLE_V1", "\nfunction openBusinessKnowledge()"), context);
  runInContext(part("function legacyImageDefinitelyNotSubmitted", "function legacyImageReceiptIdentity"), context);
  runInContext(part("function legacySavedDeliveryResponse", "function acknowledgeSkuDelivery"), context);
  context.skuWebsiteDurableRequest = () => false;
  context.skuResolvePaidWorkspaceRequest = async (owner: string, request: RuntimeRequest) => ({ request, key: `sz.legacy-image-receipt.v1:${encodeURIComponent(owner)}:${request.payload.prompt}` });
  context.skuSendAuthorizedImage = (request: RuntimeRequest, _owner: string, options: RuntimeOptions) => context.sendRuntime("GENERATE_IMAGE", request, options);
  const send = (id: string, target = id, type = "BUILD_LINK_PROMPT", extra: Record<string, unknown> = {}) => context.sendRuntime(type, { jobId: id, config: { apiKey: "secret-never-journal" }, payload: { linkId: target, ...extra } });
  const image = (id: string, prompt = id) => context.sendLegacyImage({ jobId: id, config: {}, payload: { prompt, labMode: "main" } });
  const finish = async (id: string, response: unknown) => { callbacks.get(id)!.resolve(response); await flush(); };
  return { context, send, image, finish, callbacks, dispatched, cancelled, deliveries, storage: shared };
}
async function flush() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
function taskUi(h: ReturnType<typeof fixture>) {
  const document = { activeElement: null as TaskUiNode | null, querySelector: () => null };
  const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
  const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => entities[entity]);
  class TaskUiNode {
    hidden = false;
    isConnected = true;
    parentNode: TaskUiNode | null = null;
    readonly children: TaskUiNode[] = [];
    private text = "";
    private markup = "";
    markupWrites = 0;
    scrollTop = 0;
    readonly attributes = new Map<string, string>();
    readonly listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
    readonly tagName: string;
    constructor(tagName = "div") { this.tagName = tagName.toUpperCase(); }
    get open() { return this.hasAttribute("open"); }
    set open(value: boolean) { if (value) this.setAttribute("open", ""); else this.removeAttribute("open"); }
    get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
    set textContent(value: string) { this.clear(); this.text = String(value); }
    get innerHTML() { return this.markup; }
    set innerHTML(value: string) {
      this.markupWrites++; this.clear(); this.markup = value;
      const stack: TaskUiNode[] = [this];
      for (const token of value.matchAll(/<\/?([a-z][a-z0-9-]*)([^>]*?)>|([^<]+)/gi)) {
        if (token[3]) { stack[stack.length - 1].text += decode(token[3]); continue; }
        const tag = token[1].toLowerCase();
        if (token[0].startsWith("</")) {
          while (stack.length > 1 && stack.pop()!.tagName.toLowerCase() !== tag) { /* Find the matching parent. */ }
          continue;
        }
        const child = new TaskUiNode(tag);
        for (const attr of token[2].matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) child.setAttribute(attr[1], decode(attr[2] ?? attr[3] ?? attr[4] ?? ""));
        child.parentNode = stack[stack.length - 1]; child.parentNode.children.push(child);
        if (!["input", "img", "br", "hr"].includes(tag) && !token[0].endsWith("/>")) stack.push(child);
      }
    }
    private clear() { for (const descendant of this.descendants()) descendant.isConnected = false; for (const child of this.children) child.parentNode = null; this.children.splice(0); this.text = ""; }
    private descendants(): TaskUiNode[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
    private matches(selector: string): boolean {
      return selector.split(",").some(part => {
        const token = part.trim();
        const chain = token.split(/\s*>\s*/);
        if (chain.length > 1) return this.matches(chain[chain.length - 1]) && !!this.parentNode?.matches(chain.slice(0, -1).join(" > "));
        const tag = token.match(/^[a-z][a-z0-9-]*/i)?.[0];
        if (tag && tag.toUpperCase() !== this.tagName) return false;
        const attrs = [...token.matchAll(/\[([^\s=\]]+)(?:\s*=\s*["']?([^\]"']*)["']?)?\]/g)];
        return !!(tag || attrs.length) && attrs.every(attr => this.hasAttribute(attr[1]) && (attr[2] === undefined || this.getAttribute(attr[1]) === attr[2]));
      });
    }
    readonly querySelector = vi.fn((selector: string): TaskUiNode | null => this.descendants().find(child => child.matches(selector)) || null);
    readonly querySelectorAll = vi.fn((selector: string): TaskUiNode[] => this.descendants().filter(child => child.matches(selector)));
    contains(node: TaskUiNode) { return this === node || this.descendants().includes(node); }
    closest(selector: string): TaskUiNode | null { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
    readonly focus = vi.fn(() => { document.activeElement = this; });
    readonly addEventListener = vi.fn((name: string, callback: (event: Record<string, unknown>) => void) => {
      this.listeners.set(name, [...this.listeners.get(name) || [], callback]);
    });
    readonly showModal = vi.fn(() => { this.open = true; this.setAttribute("open", ""); });
    readonly close = vi.fn(() => {
      this.open = false; this.removeAttribute("open"); this.dispatch("close");
    });
    setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    hasAttribute(name: string) { return this.attributes.has(name); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    getBoundingClientRect() { return { left: 0, top: 0, right: 500, bottom: 800 }; }
    dispatch(name: string, event: Record<string, unknown> = {}) {
      for (const callback of this.listeners.get(name) || []) callback({ target: this, ...event });
    }
  }
  const nodes: Record<string, TaskUiNode> = {};
  const node = (id: string) => nodes[id] ||= new TaskUiNode();
  for (const id of ["promptTaskPanel", "promptTaskOpen", "promptTaskDialog", "promptTaskClose", "promptTaskSummary", "promptTaskCurrent", "promptTaskCurrentElapsed", "promptTaskDetailSummary", "promptTaskList", "promptTaskRecovery", "promptTaskNote"]) node(id);
  h.context.$ = node;
  h.context.document = document;
  return { nodes, document };
}
afterEach(() => { vi.useRealTimers(); });

describe("legacy task waiting and independent receipts", () => {
  it("runs independent targets together, reuses the same target, and ends only the selected request", async () => {
    const h = fixture(), a = h.send("a", "L001"), duplicate = h.send("duplicate", "L001"), b = h.send("b", "L002");
    expect(h.dispatched.map(item => item.jobId)).toEqual(["a", "b"]);
    expect(h.dispatched[0].payload._jobId).toBe("a");
    const active = h.context.promptTaskState(); expect(active.activeCount).toBe(2);
    expect(active.tasks[0].targetLabel).toBe("L001");
    h.context.promptTaskEnd(active.tasks[0].id);
    expect(await a).toMatchObject({ code: "TASK_WAIT_ENDED", ended: true }); expect(await duplicate).toMatchObject({ code: "TASK_WAIT_ENDED" });
    expect(h.cancelled).toEqual(["a"]); expect(h.context.promptTaskState().activeCount).toBe(1);
    await h.finish("a", { ok: true, modelFallback: { from: "old", to: "late" } });
    expect(h.context.applyModelFallbackFromResponse).not.toHaveBeenCalledWith(expect.objectContaining({ modelFallback: expect.anything() }));
    await h.finish("b", { ok: true, data: {} }); expect(await b).toMatchObject({ ok: true });
    expect(h.context.promptTaskState().tasks.map((task: { status: string }) => task.status)).toEqual(["ended", "success"]);
    expect([...h.storage.data.values()].join("")).not.toContain("secret-never-journal");
  });

  it("times out a lost callback and ignores a late prompt without resurrecting a finished task", async () => {
    vi.useFakeTimers(); const h = fixture(); h.context.PROMPT_TASK_TYPES.ANALYZE_IMAGE[1] = 10;
    const request = h.send("lost", "reference", "ANALYZE_IMAGE"); await vi.advanceTimersByTimeAsync(11);
    expect(await request).toMatchObject({ code: "TASK_WAIT_TIMEOUT", timedOut: true });
    expect(h.context.promptTaskState().activeCount).toBe(0); expect(h.cancelled).toEqual(["lost"]);
    await h.finish("lost", { ok: true, data: { 中文提示词: "late" } });
    expect(h.context.promptTaskState().tasks[0].status).toBe("timed_out");
  });

  it("classifies backend failure separately from successful settlement and explicit cancellation", async () => {
    const h = fixture(), request = h.send("failed");
    await h.finish("failed", { ok: false, ended: true, code: "invalid_model" }); await request;
    expect(h.context.promptTaskState().tasks[0].status).toBe("failed");
  });

  it("isolates journals between cached surfaces sharing one owner and storage", async () => {
    const shared = storage(), main = fixture(shared), detail = fixture(shared, "?mode=detail&detailMode=reference&layout=1");
    const a = main.send("main"), b = detail.send("detail");
    expect(main.context.promptTaskState().tasks).toHaveLength(1); expect(detail.context.promptTaskState().tasks).toHaveLength(1);
    await main.finish("main", { ok: true }); await a;
    expect(detail.context.promptTaskState().activeCount).toBe(1);
    await detail.finish("detail", { ok: false, code: "cancelled", ended: true }); await b;
    const restoredMain = fixture(shared), restoredDetail = fixture(shared, "?mode=detail&detailMode=reference&layout=1");
    expect(restoredMain.context.promptTaskState().tasks[0]).toMatchObject({ jobId: "main", status: "success" });
    expect(restoredDetail.context.promptTaskState().tasks[0]).toMatchObject({ jobId: "detail", status: "ended" });
  });

  it.each(["activeJobId", "buildPhase", "confirmationPromise", "_skuPaidAuthorizing", "skuPersistInFlight"])("protects the independent controller's %s stage from unloading", key => {
    const h = fixture();
    if (key === "buildPhase") h.context.state.referenceDetail.buildPhase = "building";
    else if (key === "activeJobId" || key === "confirmationPromise") h.context.state.referenceDetail[key] = key === "activeJobId" ? "blueprint" : Promise.resolve();
    else h.context.state[key] = true;
    expect(h.context.promptTaskState().busy).toBe(true);
  });

  it("persists successful image delivery before returning and recovers the same request without another dispatch", async () => {
    const h = fixture(), result = h.image("paid", "same-image"); await flush();
    await h.finish("paid", { ok: true, images: ["https://fixture.invalid/paid.png"] });
    const delivered = await result; expect(delivered).toMatchObject({ ok: true, _legacyReceipt: { owner: "account:alice", jobId: "paid" } });
    expect(JSON.parse(h.storage.getItem(delivered._legacyReceipt.key)!)).toMatchObject({ state: "delivered", jobId: "paid" });
    expect(await h.image("retry", "same-image")).toMatchObject({ ok: true, recoveredDelivery: true, jobId: "paid" });
    expect(h.dispatched).toHaveLength(1);
  });

  it("preserves an ended image receipt, lets another image run, and stores late pixels under the original owner", async () => {
    const h = fixture(), first = h.image("paid", "image-a"); await flush();
    h.context.promptTaskEnd(h.context.promptTaskState().tasks[0].id); expect(await first).toMatchObject({ stateUncertain: true });
    const second = h.image("other", "image-b"); await flush();
    expect(h.dispatched).toHaveLength(2);
    h.context.state.archiveAccountKey = "account:bob";
    await h.finish("paid", { ok: true, images: ["https://fixture.invalid/late.png"] });
    expect(h.context.promptTaskState().tasks).toHaveLength(0);
    const receiptKey = "sz.legacy-image-receipt.v1:account%3Aalice:image-a";
    expect(await h.context.SZ_SKU_DELIVERY_STORE.read("account:alice", receiptKey)).toMatchObject({ jobId: "paid", images: ["https://fixture.invalid/late.png"] });
    expect(await h.context.SZ_SKU_DELIVERY_STORE.read("account:bob", receiptKey)).toBeNull();
    await h.finish("other", { ok: false, providerSubmitted: false, definitiveFailure: true }); await second;
    h.context.state.archiveAccountKey = "account:alice";
    expect(await h.image("recover", "image-a")).toMatchObject({ ok: true, recoveredDelivery: true, jobId: "paid" });
    expect(h.dispatched).toHaveLength(2);
  });

  it("persists first-arriving success to the original owner after an account transition", async () => {
    const h = fixture(), request = h.image("changed", "old-owner"); await flush();
    h.context.state.archiveAccountKey = "account:bob";
    await h.finish("changed", { ok: true, images: ["https://fixture.invalid/owner.png"] }); await request; await flush();
    expect([...h.deliveries.keys()]).toEqual([JSON.stringify(["account:alice", "sz.legacy-image-receipt.v1:account%3Aalice:old-owner"])]);
    expect(h.context.promptTaskState().tasks).toHaveLength(0);
  });

  it("does not overwrite a newer receipt with a late result or terminal failure", async () => {
    const h = fixture(), request = h.image("old", "same"); await flush();
    h.context.promptTaskEnd(h.context.promptTaskState().tasks[0].id); await request;
    const key = "sz.legacy-image-receipt.v1:account%3Aalice:same";
    h.storage.setItem(key, JSON.stringify({ version: 1, state: "pending", jobId: "new-owner" }));
    await h.finish("old", { ok: true, images: ["https://fixture.invalid/stale.png"] });
    expect(JSON.parse(h.storage.getItem(key)!)).toMatchObject({ jobId: "new-owner" }); expect(h.deliveries.size).toBe(0);
  });

  it("counts only receipts owned by the current cached surface", async () => {
    const shared = storage(), main = fixture(shared), detail = fixture(shared, "?mode=detail&detailMode=reference&layout=1");
    const pending = main.image("main-image", "main-image"); await flush();
    expect(main.context.promptTaskState().pendingReceiptCount).toBe(1);
    expect(detail.context.promptTaskState().pendingReceiptCount).toBe(0);
    await main.finish("main-image", { ok: true, images: ["https://fixture.invalid/main.png"] }); await pending;
    expect(detail.context.promptTaskState().pendingReceiptCount).toBe(0);
  });

  it("renders a restored journal when the asynchronous archive owner becomes ready", async () => {
    const h = fixture(), request = h.send("previous", "L001");
    await h.finish("previous", { ok: false, code: "cancelled", ended: true }); await request;
    h.context.state.archiveAccountKey = "local";
    h.context.archiveAvailable = () => false;
    h.context.currentLabMode = () => "main";
    h.context.releaseArchiveObjectUrls = () => {};
    h.context.renderArchiveHistory = () => {};
    h.context.refreshArchiveHistory = async () => ({ ok: true });
    const render = vi.fn(() => h.context.promptTaskState()); h.context.promptTaskRender = render;
    // This focused fixture executes the account setter in isolation. Install the
    // shipped history state that the complete runtime declares before the setter.
    runInContext(part("var archiveHistoryState =", "function archiveHistoryUpperModal"), h.context);
    h.context.archiveHistoryState.selected = { "previous-owner-original": true };
    h.context.archiveHistoryState.trashSelected = { "previous-owner-trash-original": true };
    h.context.closeArchiveHistory = vi.fn(); // Dialog behavior is covered by studio-history-dialog.test.ts.
    runInContext(part("function setArchiveAccountKey", "function archiveSurfaceForItem"), h.context);
    await h.context.setArchiveAccountKey("account:alice", { deferArchive: true });
    expect(render).toHaveBeenCalled();
    expect(render.mock.results[0].value).toMatchObject({ accountKey: "account:alice", tasks: [expect.objectContaining({ jobId: "previous", status: "ended" })] });
    expect(Object.keys(h.context.archiveHistoryState.selected)).toEqual([]);
    expect(Object.keys(h.context.archiveHistoryState.trashSelected)).toEqual([]);
    await h.context.setArchiveAccountKey("account:bob", { deferArchive: true });
    expect(h.context.promptTaskState()).toMatchObject({ accountKey: "account:bob", tasks: [] });
    expect(h.dispatched).toHaveLength(1); // Restoring history never submits again.
  });

  it.each(["TASK_ACCOUNT_CHANGED", "input_changed", "AUTH_FAILED", "stopped"])("stops the original numbered queue after the safety guard %s", async code => {
    const h = fixture();
    runInContext(part("var GLOBAL_PROMPT_ERROR_CODES", "function promptFailureEntry"), h.context);
    runInContext(part("function promptResponseFailure", "function buildPromptRecordForSelectedLink"), h.context);
    runInContext(part("function runPromptSequence", "function sharedSubjectContextForPromptBatch"), h.context);
    const worker = vi.fn(async () => { throw h.context.promptResponseFailure({ ok: false, code, ended: true, error: "original request ended" }); });
    const result = await h.context.runPromptSequence(["L001", "L002"], worker);
    expect(worker).toHaveBeenCalledTimes(1); expect(result.attempted).toBe(1); expect(result.globalFailure).toBeTruthy();
  });

  it.each(["PROMPT_JOB_TIMEOUT", "TASK_WAIT_TIMEOUT", "TASK_WAIT_ENDED", "cancelled", "TASK_TRANSPORT_FAILED", "network_error", "request_failed", "RESULT_NOT_CONFIRMED"])("allows the next independent item and failed-item retry after %s", async code => {
    const h = fixture();
    runInContext(part("var GLOBAL_PROMPT_ERROR_CODES", "function promptFailureEntry"), h.context);
    runInContext(part("function promptResponseFailure", "function buildPromptRecordForSelectedLink"), h.context);
    runInContext(part("function runPromptSequence", "function sharedSubjectContextForPromptBatch"), h.context);
    const raw = { ok: false, code, stateUncertain: true, global: true, errorMeta: { scope: "global", fatal: true }, error: "old connection failure" };
    const error = h.context.promptResponseFailure(raw);
    expect(h.context.normalizedPromptError(error)).toMatchObject({ scope: "link", retryable: true, action: "retry_link" });
    expect(error.response).toBe(raw);
    const worker = vi.fn(async (_row, index) => { if (index === 0) throw error; return { data: {} }; });
    const result = await h.context.runPromptSequence(["L001", "L002"], worker);
    expect(worker).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ attempted: 2, globalFailure: null });
    expect(result.settled.map((entry: { status: string }) => entry.status)).toEqual(["rejected", "fulfilled"]);
  });

  it("preserves authentication safety when a transport failure also reports HTTP 401", () => {
    const h = fixture();
    runInContext(part("var GLOBAL_PROMPT_ERROR_CODES", "function promptFailureEntry"), h.context);
    const raw = { ok: false, code: "request_failed", status: 401, stateUncertain: true, error: "请重新登录" };
    expect(h.context.promptTaskPromptFailure(raw)).toBe(raw);
    expect(h.context.normalizedPromptError(raw)).toMatchObject({ scope: "global", retryable: false });
  });

  it("ends an uncertain prompt as failure while retaining settlement uncertainty", async () => {
    const h = fixture(), request = h.send("unknown");
    await h.finish("unknown", { ok: false, stateUncertain: true, definitiveFailure: false, providerSubmitted: true, error: "请求结果尚未确认" });
    expect(await request).toMatchObject({ ok: false, code: "REQUEST_UNCERTAIN", stateUncertain: true, definitiveFailure: false, providerSubmitted: true, retryable: true, error: expect.stringContaining("重新跑") });
    expect(h.context.promptTaskState()).toMatchObject({ activeCount: 0, tasks: [expect.objectContaining({ status: "failed", receiptState: "" })] });
  });

  it("uses a fresh job for an explicit same-input retry and ignores the old late prompt", async () => {
    vi.useFakeTimers(); const h = fixture(); h.context.PROMPT_TASK_TYPES.BUILD_LINK_PROMPT[1] = 10;
    const first = h.send("reused", "L001"); await vi.advanceTimersByTimeAsync(11);
    expect(await first).toMatchObject({ code: "TASK_WAIT_TIMEOUT", stateUncertain: true, global: false, retryable: true });
    const retry = h.send("reused", "L001");
    expect(h.dispatched).toHaveLength(2);
    const retryId = h.dispatched[1].jobId;
    expect(retryId).not.toBe("reused");
    expect(h.dispatched[1].payload._jobId).toBe(retryId);
    await h.finish("reused", { ok: true, data: { 中文提示词: "old late prompt" } });
    expect(h.context.promptTaskState().activeCount).toBe(1);
    await h.finish(retryId, { ok: true, data: { 中文提示词: "fresh prompt" } });
    expect(await retry).toMatchObject({ ok: true, data: { 中文提示词: "fresh prompt" } });
    expect(h.context.promptTaskState().tasks.map((task: { status: string }) => task.status)).toEqual(["timed_out", "success"]);
  });

  it.each(["timeout", "network_error", "PROMPT_JOB_TIMEOUT", "TASK_TRANSPORT_FAILED"])("does not fabricate local success after %s", code => {
    const h = fixture();
    runInContext(part("function promptCanUseLocalFallback", "function buildPromptForLink"), h.context);
    expect(h.context.promptCanUseLocalFallback({ ok: false, code })).toBe(false);
  });

  it("renders timeout failure and the explicit image retry hook without replaying old prompt inputs", async () => {
    const h = fixture();
    const { nodes } = taskUi(h);
    h.context.promptTaskJournal("account:alice").push(
      { id: "prompt-ended", jobId: "prompt-old", type: "ANALYZE_IMAGE", label: "参考图分析", targetLabel: "", status: "timed_out", startedAt: Date.now(), endedAt: Date.now() },
      { id: "image-ended", jobId: "image-old", type: "GENERATE_IMAGE", label: "图片生成", targetLabel: "L001", receiptKey: "owned-image", status: "uncertain", startedAt: Date.now(), endedAt: Date.now() }
    );
    for (let index = 0; index < 8; index++) h.context.promptTaskJournal("account:alice").push(
      { id: `success-${index}`, jobId: `success-job-${index}`, type: "GENERATE_IMAGE", label: `完成项 ${index}`, status: "success", startedAt: Date.now(), endedAt: Date.now() }
    );
    h.context.legacyImageCanRestart = vi.fn((key: string) => key === "owned-image");
    h.context.legacyImageRestart = vi.fn(async () => ({ ok: true }));
    h.context.promptTaskRender();
    expect(nodes.promptTaskDialog.open).toBe(false);
    expect(nodes.promptTaskPanel.getAttribute("data-state")).toBe("attention");
    expect(nodes.promptTaskSummary.textContent).toContain("失败 1");
    expect(nodes.promptTaskSummary.textContent).toContain("待确认 1");
    expect(nodes.promptTaskSummary.textContent).toContain("最近完成 8");
    expect(h.context.promptTaskState().busy).toBe(false);
    expect(nodes.promptTaskList.innerHTML).toContain("等待超时，可重新跑");
    expect(nodes.promptTaskList.innerHTML).toContain("点击原分析按钮");
    expect(nodes.promptTaskList.innerHTML).toContain('data-task-restart="image-ended"');
    expect(nodes.promptTaskList.innerHTML).toContain("完成项 7");
    expect(nodes.promptTaskList.innerHTML).toContain("完成项 0");
    expect(nodes.promptTaskList.innerHTML).not.toContain('data-task-restart="prompt-ended"');
    expect(h.dispatched).toHaveLength(0);
    const retryButton = { getAttribute: () => "image-ended", closest: (selector: string): unknown => selector === "[data-task-restart]" ? retryButton : null };
    nodes.promptTaskPanel.dispatch("click", { target: retryButton });
    await flush();
    expect(h.context.legacyImageRestart).toHaveBeenCalledWith("owned-image");
    h.context.state.archiveAccountKey = "account:bob";
    expect(await h.context.promptTaskRestartImage("image-ended")).toMatchObject({ code: "TASK_RESTART_UNAVAILABLE" });
    expect(h.context.legacyImageRestart).toHaveBeenCalledTimes(1);
  });

  it("keeps completed task details closed until requested and preserves them after closing", () => {
    const h = fixture(), { nodes, document } = taskUi(h);
    const task = { id: "completed", jobId: "completed-request", type: "GENERATE_IMAGE", label: "图片生成", targetLabel: "第1张", status: "success", startedAt: Date.now() - 4000, endedAt: Date.now() };
    h.context.promptTaskJournal("account:alice").push(task);

    h.context.promptTaskRender();

    expect(nodes.promptTaskPanel.hidden).toBe(false);
    expect(nodes.promptTaskPanel.getAttribute("data-state")).toBe("complete");
    expect(nodes.promptTaskDialog.open).toBe(false);
    expect(nodes.promptTaskDialog.showModal).not.toHaveBeenCalled();
    expect(nodes.promptTaskOpen.getAttribute("aria-expanded")).toBe("false");
    expect(nodes.promptTaskSummary.textContent).toContain("最近完成 1");
    expect(nodes.promptTaskSummary.textContent).not.toContain(task.jobId);

    document.activeElement = nodes.promptTaskOpen;
    nodes.promptTaskOpen.dispatch("click");

    expect(nodes.promptTaskDialog.open).toBe(true);
    expect(nodes.promptTaskOpen.getAttribute("aria-expanded")).toBe("true");
    expect(nodes.promptTaskList.innerHTML).toContain("图片生成 · 第1张");
    expect(h.dispatched).toHaveLength(0);

    nodes.promptTaskClose.dispatch("click");

    expect(nodes.promptTaskDialog.open).toBe(false);
    expect(nodes.promptTaskOpen.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(nodes.promptTaskOpen);
    expect(h.context.promptTaskState().tasks).toHaveLength(1);
    expect(h.dispatched).toHaveLength(0);
  });

  it("closes task details on account change and removes the previous account recovery view", () => {
    const h = fixture(), { nodes } = taskUi(h);
    h.context.promptTaskJournal("account:alice").push({ id: "old-task", jobId: "old-request", type: "GENERATE_IMAGE", label: "原账号图片", status: "uncertain", startedAt: Date.now(), endedAt: Date.now() });
    h.context.promptTaskRender();
    nodes.promptTaskOpen.dispatch("click");
    nodes.promptTaskRecovery.hidden = false;
    nodes.promptTaskRecovery.textContent = "原账号已返回图片";

    h.context.state.archiveAccountKey = "account:bob";
    h.context.promptTaskRender();

    expect(nodes.promptTaskDialog.open).toBe(false);
    expect(nodes.promptTaskOpen.getAttribute("aria-expanded")).toBe("false");
    expect(nodes.promptTaskRecovery.hidden).toBe(true);
    expect(nodes.promptTaskRecovery.textContent).toBe("");
    expect(nodes.promptTaskList.innerHTML).not.toContain("原账号图片");
    expect(h.context.promptTaskState().tasks).toHaveLength(0);
    expect(h.context.promptTaskJournal("account:alice")).toHaveLength(1);
    expect(h.dispatched).toHaveLength(0);
  });

  it("shows a deliberately ended task separately from failures without reopening details", () => {
    const h = fixture(), { nodes } = taskUi(h);
    h.context.promptTaskJournal("account:alice").push({ id: "ended-task", jobId: "ended-request", type: "ANALYZE_IMAGE", label: "参考图分析", status: "ended", startedAt: Date.now(), endedAt: Date.now() });

    h.context.promptTaskRender();

    expect(nodes.promptTaskSummary.textContent).toBe("已结束 1");
    expect(nodes.promptTaskList.innerHTML).toContain("已结束等待");
    expect(nodes.promptTaskDialog.open).toBe(false);
    expect(h.context.promptTaskState().busy).toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });

  it("groups active and actionable tasks while folding every retained completion and technical detail", () => {
    const h = fixture(), { nodes } = taskUi(h), now = Date.now();
    const records = h.context.promptTaskJournal("account:alice");
    records.push(
      { id: "live", jobId: "live-job", type: "GENERATE_IMAGE", label: "图片生成", targetLabel: "第2张", status: "running", startedAt: now },
      { id: "unknown", jobId: "unknown-job", type: "GENERATE_IMAGE", label: "图片生成", targetLabel: "第1张", status: "uncertain", receiptState: "pending", startedAt: now, endedAt: now },
      { id: "failed", jobId: "failed-job", type: "ANALYZE_IMAGE", label: "参考图分析", status: "failed", code: "HTTP_400", startedAt: now, endedAt: now }
    );
    for (let index = 0; index < 8; index++) records.push({ id: `done-${index}`, jobId: `done-job-${index}`, type: "GENERATE_IMAGE", label: `已生成图片 ${index}`, status: "success", startedAt: now, endedAt: now });

    h.context.promptTaskRender();

    const running = nodes.promptTaskList.querySelector('[data-task-group="running"]')!;
    const attention = nodes.promptTaskList.querySelector('[data-task-group="attention"]')!;
    const completed = nodes.promptTaskList.querySelector('[data-task-group="completed"]')!;
    expect(running.querySelectorAll("[data-task-id]").map(row => row.getAttribute("data-task-id"))).toEqual(["live"]);
    expect(attention.querySelectorAll("[data-task-id]").map(row => row.getAttribute("data-task-id"))).toEqual(["failed", "unknown"]);
    expect(attention.textContent).toContain("结果待确认");
    expect(attention.querySelector('[data-task-id="unknown"]')!.textContent).not.toContain("失败");
    expect(completed.tagName).toBe("DETAILS");
    expect(completed.open).toBe(false);
    expect(completed.querySelectorAll("[data-task-id]")).toHaveLength(8);
    const technical = nodes.promptTaskList.querySelectorAll("[data-task-detail]");
    expect(technical).toHaveLength(11);
    expect(technical.every(detail => detail.tagName === "DETAILS" && !detail.open)).toBe(true);
    expect(technical.find(detail => detail.getAttribute("data-task-detail") === "failed")!.textContent).toContain("HTTP_400");
    expect(nodes.promptTaskDialog.open).toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });

  it.each([
    ["pending", "结果待确认"],
    ["storage_failed", "原回执待保存"]
  ])("keeps an ended image with a %s receipt actionable without reporting a definitive failure", (receiptState, expectedLabel) => {
    const h = fixture(), { nodes } = taskUi(h), now = Date.now();
    h.context.promptTaskJournal("account:alice").push({ id: "ended-image", jobId: "original-job", type: "GENERATE_IMAGE", label: "图片生成", targetLabel: "第3张", status: "timed_out", receiptState, startedAt: now - 10000, endedAt: now });

    h.context.promptTaskRender();

    const row = nodes.promptTaskList.querySelector('[data-task-id="ended-image"]')!;
    expect(row.closest('[data-task-group="attention"]')).not.toBeNull();
    expect(row.textContent).toContain(expectedLabel);
    expect(row.textContent).not.toContain("超时失败");
    expect(row.textContent).not.toContain("已取消");
    expect(nodes.promptTaskSummary.textContent).toBe("待确认 1");
    expect(h.context.promptTaskState()).toMatchObject({ busy: false, activeCount: 0 });
    expect(h.dispatched).toHaveLength(0);
  });

  it("shows the first active picture, concurrent task count, and live elapsed time without rebuilding controls", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    const h = fixture(), { nodes, document } = taskUi(h), now = Date.now();
    h.context.promptTaskJournal("account:alice").push(
      { id: "live-a", jobId: "live-a-job", type: "GENERATE_IMAGE", label: "图片生成", targetLabel: "第1张", status: "running", startedAt: now - 65000 },
      { id: "live-b", jobId: "live-b-job", type: "ANALYZE_STYLE_REFRESH_QA", label: "图片检查", targetLabel: "第2张", status: "running", startedAt: now - 20000 }
    );
    h.context.promptTaskRender();
    const button = nodes.promptTaskList.querySelector('[data-task-end="live-a"]')!;
    const detail = nodes.promptTaskList.querySelector('[data-task-detail="live-a"]')!;
    detail.open = true; button.focus(); nodes.promptTaskList.scrollTop = 120;
    const writes = nodes.promptTaskList.markupWrites;
    expect(nodes.promptTaskCurrent.textContent).toContain("图片生成 · 第1张");
    expect(nodes.promptTaskCurrent.textContent).toMatch(/等\s*2\s*项/);
    expect(nodes.promptTaskCurrentElapsed.textContent).toBe("已等待 1分5秒");
    expect(nodes.promptTaskSummary.textContent).toContain("进行中 2");

    await vi.advanceTimersByTimeAsync(2000);

    expect(nodes.promptTaskCurrentElapsed.textContent).toBe("已等待 1分7秒");
    expect(nodes.promptTaskList.markupWrites).toBe(writes);
    expect(nodes.promptTaskList.querySelector('[data-task-end="live-a"]')).toBe(button);
    expect(detail.open).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(nodes.promptTaskList.scrollTop).toBe(120);
    expect(h.dispatched).toHaveLength(0);
  });

  it("retains expanded groups, technical details, and the focused task control after another task finishes", () => {
    const h = fixture(), { nodes, document } = taskUi(h), now = Date.now();
    const records = h.context.promptTaskJournal("account:alice");
    records.push(
      { id: "live-a", jobId: "a-job", type: "GENERATE_IMAGE", label: "图片生成", targetLabel: "第1张", status: "running", startedAt: now },
      { id: "live-b", jobId: "b-job", type: "GENERATE_IMAGE", label: "图片生成", targetLabel: "第2张", status: "running", startedAt: now },
      { id: "done", jobId: "done-job", type: "GENERATE_IMAGE", label: "已完成图片", status: "success", startedAt: now, endedAt: now }
    );
    h.context.promptTaskRender();
    nodes.promptTaskList.querySelector('[data-task-group="completed"]')!.open = true;
    nodes.promptTaskList.querySelector('[data-task-detail="live-a"]')!.open = true;
    nodes.promptTaskList.querySelector('[data-task-end="live-a"]')!.focus();
    const writes = nodes.promptTaskList.markupWrites;
    records[1].status = "success"; records[1].endedAt = now + 1000;

    h.context.promptTaskRender();

    expect(nodes.promptTaskList.markupWrites).toBe(writes + 1);
    expect(nodes.promptTaskList.querySelector('[data-task-group="completed"]')!.open).toBe(true);
    expect(nodes.promptTaskList.querySelector('[data-task-detail="live-a"]')!.open).toBe(true);
    expect(document.activeElement?.getAttribute("data-task-end")).toBe("live-a");
    expect(nodes.promptTaskList.contains(document.activeElement!)).toBe(true);
    expect(nodes.promptTaskCurrent.textContent).toBe("图片生成 · 第1张");
    expect(h.dispatched).toHaveLength(0);
  });

  it.each(["technical", "completed"])("keeps focus on the expanded %s summary when another task finishes", kind => {
    const h = fixture(), { nodes, document } = taskUi(h), now = Date.now();
    const records = h.context.promptTaskJournal("account:alice");
    records.push(
      { id: "live-a", jobId: "a-job", type: "GENERATE_IMAGE", label: "图片生成", targetLabel: "第1张", status: "running", startedAt: now },
      { id: "live-b", jobId: "b-job", type: "GENERATE_IMAGE", label: "图片生成", targetLabel: "第2张", status: "running", startedAt: now },
      { id: "done", jobId: "done-job", type: "GENERATE_IMAGE", label: "已完成图片", status: "success", startedAt: now, endedAt: now }
    );
    h.context.promptTaskRender();
    const selector = kind === "technical" ? '[data-task-detail="live-a"]' : '[data-task-group="completed"]';
    const disclosure = nodes.promptTaskList.querySelector(selector)!;
    disclosure.open = true;
    const originalSummary = disclosure.querySelector("summary")!;
    expect(originalSummary.tagName).toBe("SUMMARY");
    originalSummary.focus();
    records[1].status = "success"; records[1].endedAt = now + 1000;

    h.context.promptTaskRender();

    const updatedDisclosure = nodes.promptTaskList.querySelector(selector)!;
    expect(updatedDisclosure.open).toBe(true);
    expect(document.activeElement).toBe(updatedDisclosure.querySelector("summary"));
    expect(document.activeElement).not.toBe(originalSummary);
    expect(originalSummary.isConnected).toBe(false);
    expect(nodes.promptTaskList.contains(document.activeElement!)).toBe(true);
    expect(h.dispatched).toHaveLength(0);
  });

  it("moves focus to the visible completed summary when the focused running task finishes", () => {
    const h = fixture(), { nodes, document } = taskUi(h), now = Date.now();
    const records = h.context.promptTaskJournal("account:alice");
    records.push(
      { id: "finishing", jobId: "finishing-job", type: "GENERATE_IMAGE", label: "图片生成", targetLabel: "第1张", status: "running", startedAt: now },
      { id: "remaining", jobId: "remaining-job", type: "GENERATE_IMAGE", label: "图片生成", targetLabel: "第2张", status: "running", startedAt: now }
    );
    h.context.promptTaskRender();
    nodes.promptTaskList.querySelector('[data-task-end="finishing"]')!.focus();
    expect(nodes.promptTaskList.querySelector('[data-task-group="completed"]')).toBeNull();
    records[0].status = "success"; records[0].endedAt = now + 1000;

    h.context.promptTaskRender();

    const completed = nodes.promptTaskList.querySelector('[data-task-group="completed"]')!;
    expect(completed.open).toBe(false);
    expect(completed.querySelector('[data-task-id="finishing"]')).not.toBeNull();
    expect(document.activeElement).toBe(completed.querySelector("summary"));
    expect(document.activeElement?.closest("[data-task-id]")).toBeNull();
    expect(nodes.promptTaskCurrent.textContent).toBe("图片生成 · 第2张");
    expect(h.dispatched).toHaveLength(0);
  });

  it("shows local preparation without falsely calling the workspace idle or adding a fake running task", () => {
    const h = fixture(), { nodes } = taskUi(h);
    h.context.state.referenceDetail.buildPhase = "building";

    h.context.promptTaskRender();

    expect(nodes.promptTaskCurrent.textContent).toBe(h.context.promptTaskState().summary);
    expect(nodes.promptTaskCurrent.textContent).toContain("正在分析详情结构");
    expect(nodes.promptTaskCurrentElapsed.hidden).toBe(true);
    expect(nodes.promptTaskPanel.hidden).toBe(false);
    expect(nodes.promptTaskPanel.getAttribute("data-state")).toBe("running");
    expect(h.context.promptTaskState()).toMatchObject({ busy: true, activeCount: 0 });
    expect(nodes.promptTaskList.querySelectorAll("[data-task-id]")).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
  });


  it("retains all 100 failed-image controls across reload while bounding completed history", () => {
    const h = fixture();
    const records = h.context.promptTaskJournal("account:alice");
    for (let index = 0; index < 100; index++) records.push({ id: `failed-${index}`, jobId: `failed-job-${index}`, type: "GENERATE_IMAGE", label: "图片生成", status: "uncertain", receiptState: "pending", startedAt: Date.now(), endedAt: Date.now() });
    for (let index = 0; index < 80; index++) records.push({ id: `completed-${index}`, jobId: `completed-job-${index}`, type: "GENERATE_IMAGE", label: "图片生成", status: "success", startedAt: Date.now(), endedAt: Date.now() });
    h.context.promptTaskPersist("account:alice");
    const restored = fixture(h.storage).context.promptTaskState().tasks;
    expect(restored.filter((task: { status: string }) => task.status === "uncertain")).toHaveLength(100);
    expect(restored.filter((task: { status: string }) => task.status === "success")).toHaveLength(40);
    expect(restored[0].id).toBe("failed-0");
    for (let index = 100; index < 600; index++) h.context.promptTaskJournal("account:alice").push({ id: `failed-${index}`, jobId: `failed-job-${index}`, type: "GENERATE_IMAGE", label: "图片生成", status: "uncertain", receiptState: "pending", startedAt: Date.now(), endedAt: Date.now() });
    h.context.promptTaskPersist("account:alice");
    expect(h.context.promptTaskState().tasks).toHaveLength(540);
  });

});
