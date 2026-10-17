import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve("public/creative/labs/image-prompt-lab/promptlab.js"), "utf8");
const quoteSource = source.slice(source.indexOf("function refreshLegacyCreditHints()"));
function quotes(options: { mode?: string; count?: number; style?: boolean; formal?: boolean; product?: boolean } = {}) {
  const values = new Map<string, { id: string; value: string; dataset: Record<string, string> }>();
  const button = (id: string) => {
    if (!values.has(id)) values.set(id, { id, value: "", dataset: {} });
    return values.get(id)!;
  };
  const output = new Map<string, { kind: string; model?: string; channel?: string; requests?: number[] | null; detail?: string; extraAnalysis?: boolean }>();
  const hints = {
    register() {},
    image: (node: ReturnType<typeof button>, model: string, requests: number[] | null, detail: string, extraAnalysis: boolean, channel?: string) => output.set(node.id, { kind: "image", model, requests, detail, extraAnalysis, channel }),
    chat: (node: ReturnType<typeof button>, model: string, detail: string) => output.set(node.id, { kind: "chat", model, detail }),
    local: (node: ReturnType<typeof button>, detail: string) => output.set(node.id, { kind: "local", detail })
  };
  const state = { linkList: [] as Array<{ id: string; 链接编号: string }>, linkPrompts: { main: {}, detail: {} }, referencePrompts: {} as Record<string, unknown>, styleRefresh: { promptRecord: {}, run: null as unknown }, referenceDetailBatch: { rows: [] as Array<{ selected: boolean }>, context: null as unknown, bundle: null as unknown, memoryResultUrls: {} }, skuMax: 3, detailMode: "link" };
  Object.defineProperty(button("linkJson"), "value", { configurable: true, get: () => JSON.stringify(state.linkList) });
  const context = createContext({
    window: { SZCreativeCreditHints: hints }, state, $: button,
    document: { querySelectorAll: () => [] },
    cfgFromForm: () => ({ imageModel: "image-test", visionModel: "vision-test", textModel: "text-test" }),
    currentLabMode: () => options.mode || "main", currentSurfaceMode: () => options.mode || "main",
    isStyleRefreshRoute: () => !!options.style, referenceDetailRouteActive: () => !!options.formal,
    generationImageCount: () => options.count || 20,
    subjectRowsForActiveBatch: () => null, selectRowsByLinkRange: (rows: unknown[]) => ({ rows }),
    activeSubjectTask: () => null,
    normalizeLinkRows: (value: unknown) => Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [],
    normalizeLinkRowsForBatch: (rows: unknown[]) => rows.map(row => ({ ...(row as object) })),
    parseNdjsonLinks: () => [], parseDelimitedLinks: () => [],
    modelImageList: () => [], productImageList: () => options.product === false ? [] : ["fixture-product"],
    creativeSupplyChannel: (_kind: string, config: { channel?: string }) => config.channel || "platform_wallet",
    canonicalLinkId: (id: string) => id, promptRecordIsCurrent: (record: unknown) => !!record,
    captureGenerationSettings: () => ({ count: options.count || 20 }),
    requestCountChunks: (count: number) => { const chunks = []; for (let left = count; left > 0; left -= 4) chunks.push(Math.min(4, left)); return chunks; },
    currentProductFingerprint: () => "product", sourceFingerprint: () => "same",
    SUBJECT_ORCHESTRATION: { taskStatus: () => "ready" },
    selectedSkuTasks: () => [], skuTaskBlueprints: () => [], skuTaskStatusFor: () => ({ state: "failed" }),
    skuConfigForGeneration: () => ({ imageModel: "sku-test" }),
    styleRefreshRunIsCompatible: () => true,
    styleRefreshResultForScreen: (_run: unknown, index: number) => index === 1,
    referenceDetailBatchRuntime: () => state.referenceDetailBatch.context,
    referenceDetailApprovedScreenCount: () => 5,
    referenceDetailBatchHasUnavailableResults: (target: { screens: Array<{ status: string; resultRef?: { resultId?: string } }> }) => target.screens.some(screen => screen.status === "completed" && !screen.resultRef?.resultId)
  });
  runInContext(quoteSource, context);
  return { state, context, button, run: () => { context.refreshLegacyCreditHints(); return output; } };
}

describe("image action hints quote the existing request shape without submitting requests", () => {
  it("labels AI brief writing by vision model and a single-image retry by its task model", () => {
    const ui = readFileSync(resolve("public/creative/labs/image-prompt-lab/studio-genesis-ui.js"), "utf8");
    const start = ui.indexOf("function renderCredits()"), end = ui.indexOf("window.SZCreativeCreditHints?.register('studio-genesis'", start);
    const brief = { id: "brief", dataset: {} }, retry = { id: "retry", dataset: { taskId: "task" } };
    const output = new Map<string, { kind: string; model: string; requests?: number[] }>();
    const plan = { signature: "same", settings: { model: "frozen-task-model" }, shots: [{}] };
    const record = { id: "task", plan, slots: [{ status: "done" }] };
    const context = createContext({
      window: { SZCreativeCreditHints: {
        chat: (button: typeof brief, model: string) => output.set(button.id, { kind: "chat", model }),
        image: (button: typeof retry, model: string, requests: number[]) => output.set(button.id, { kind: "image", model, requests })
      } },
      root: { querySelectorAll: (selector: string) => selector.includes('="write-brief"') ? [brief] : selector.includes('="retry-slot"') ? [retry] : [] },
      bridge: { config: () => ({ visionModel: "selected-vision-model", imageModel: "current-default-image-model" }) },
      draft: { tasks: [{ id: "task", plan }] }, current: () => ({ tasks: [record] }), modelInfo: {}
    });
    const slotsStart = ui.indexOf("function matchingSlots(entry)"), slotsEnd = ui.indexOf("function activeSlots()", slotsStart);
    runInContext(ui.slice(slotsStart, slotsEnd), context);
    runInContext(ui.slice(start, end), context);
    context.renderCredits();
    expect(output.get("brief")).toEqual({ kind: "chat", model: "selected-vision-model" });
    expect(output.get("retry")).toEqual({ kind: "image", model: "frozen-task-model", requests: [1] });
  });
  it("only registers API submissions and leaves navigation, downloads and unknown controls untouched", () => {
    const buttons = [
      { id: "downloadAllBtn", dataset: {} as Record<string, string> },
      { id: "newUnreviewedButton", dataset: {} as Record<string, string> },
      { id: "urlAdd", dataset: {} as Record<string, string>, uploadUrl: true },
      { id: "paid", dataset: {} as Record<string, string> },
      { id: "styleCard", dataset: {} as Record<string, string>, styleCard: true },
      { id: "smartModules", dataset: { action: "module-mode" } as Record<string, string> },
      { id: "customModules", dataset: { action: "module-mode" } as Record<string, string> },
      { id: "moduleQuantity", dataset: { action: "module-count" } as Record<string, string> },
      { id: "stepNavigation", dataset: { action: "navigate-step" } as Record<string, string> },
      { id: "screenOrder", dataset: { action: "module-move" } as Record<string, string> }
    ].map(node => ({ ...node, matches: (selector: string) => selector.includes("[data-cu-add-url]") && "uploadUrl" in node || selector.includes("[data-style-refresh-id]") && "styleCard" in node }));
    const captions = new Map<string, { kind: string }>();
    const frames: Array<() => void> = [];
    const context = createContext({
      document: { body: {}, readyState: "loading", addEventListener() {}, querySelectorAll: () => buttons },
      SZCreativeCredits: { annotate: (node: typeof buttons[number], spec: { kind: string }) => captions.set(node.id, spec) },
      requestAnimationFrame: (callback: () => void) => frames.push(callback)
    });
    context.window = context;
    runInContext(readFileSync(resolve("public/creative/labs/image-prompt-lab/creative-credit-hints.js"), "utf8"), context);
    context.SZCreativeCreditHints.register("fixture-paid", () => context.SZCreativeCreditHints.image(buttons[3], "model", [1], ""));
    frames.splice(0).forEach(callback => callback());
    expect(captions.get("paid")?.kind).toBe("image");
    expect([...captions.keys()]).toEqual(["paid"]);
    buttons.filter(button => button.id !== "paid").forEach(button => expect(button.dataset.szCreditKind).toBeUndefined());
  });
  it("uses four-image chunks for generic main generation and four one-image directions for batch", () => {
    const h = quotes();
    h.state.referencePrompts.main = {};
    const q = h.run();
    expect(q.get("generateBtn")?.requests).toEqual([4, 4, 4, 4, 4]);
    expect(q.get("generateBtn")?.extraAnalysis).toBe(false);
    expect(q.get("batchBtn")?.requests).toEqual([1, 1, 1, 1]);
    h.button("batchMode").value = "single";
    expect(h.run().get("batchBtn")?.requests).toEqual([1]);
  });

  it("hides request hints when cached prompts, retries, and subject actions will not call a model", () => {
    const h = quotes();
    h.state.linkList = [{ id: "a", 链接编号: "a" }, { id: "b", 链接编号: "b" }];
    h.state.linkPrompts.main = { a: { linkId: "a" }, b: { linkId: "b" } };
    const retry = h.button("dynamicPromptRetry");
    h.context.document.querySelectorAll = (selector: string) => selector === "[data-credit-prompt-retry]" ? [retry] : [];
    const q = h.run();
    for (const id of ["buildPromptBtn", "batchLinksBtn", "retryFailedPromptsBtn", "dynamicPromptRetry", "allSubjectPromptsBtn", "allSubjectImagesBtn"]) {
      expect(q.get(id)?.kind).toBe("local");
    }
  });

  it("only prices style recommendations when product images are sent for analysis", () => {
    expect(quotes({ product: false }).run().get("styleRefreshRecommendBtn")?.kind).toBe("local");
    expect(quotes().run().get("styleRefreshRecommendBtn")).toMatchObject({ kind: "chat", model: "vision-test" });
  });

  it("quotes the first link's vision model and leaves mixed model batches without a misleading unit rate", () => {
    const h = quotes();
    h.state.linkList = [{ id: "a", 链接编号: "a" }];
    expect(h.run().get("buildPromptBtn")).toMatchObject({ kind: "chat", model: "vision-test" });
    expect(h.run().get("batchLinksBtn")).toMatchObject({ kind: "chat", model: "vision-test" });
    h.state.linkList.push({ id: "b", 链接编号: "b" });
    expect(h.run().get("buildPromptBtn")).toMatchObject({ kind: "chat", model: "" });
    expect(h.run().get("batchLinksBtn")).toMatchObject({ kind: "chat", model: "" });
    Object.assign(h.state, { promptBatchContext: { mode: "main", failedIds: ["a"], sharedSubjectContext: { contractVersion: "SHARED_SUBJECT_CONTEXT_V1", primed: true } } });
    expect(h.run().get("retryFailedPromptsBtn")).toMatchObject({ kind: "chat", model: "text-test" });
  });

  it("reads freshly typed links without changing remembered state and counts the requested prompt mode", () => {
    const h = quotes();
    const freshRows = [{ id: "a", 链接编号: "a" }, { id: "b", 链接编号: "b" }];
    Object.defineProperty(h.button("linkJson"), "value", { value: JSON.stringify(freshRows) });
    h.context.parseLinkListInput = () => { throw new Error("The submission parser must not run while pricing"); };
    h.state.linkPrompts.main = { a: { linkId: "a" }, b: { linkId: "b" } };
    const q = h.run();
    expect(h.state.linkList).toEqual([]);
    expect(q.get("buildPromptBtn")?.kind).toBe("local");
    expect(q.get("batchLinksBtn")?.kind).toBe("local");
    expect(q.get("detailLinkGenerateBtn")).toMatchObject({ kind: "chat", model: "" });
    expect(q.get("detailRefGenerateBtn")).toMatchObject({ kind: "chat", model: "" });
    h.state.linkPrompts.main = {};
    expect(h.run().get("buildPromptBtn")).toMatchObject({ kind: "chat", model: "" });
    expect(h.run().get("batchLinksBtn")).toMatchObject({ kind: "chat", model: "" });
  });

  it("keeps visual evidence on the vision model and matches the detail primary action's link batch route", () => {
    const h = quotes({ mode: "detail" });
    h.state.linkList = [{ id: "a", 链接编号: "a" }, { id: "b", 链接编号: "b" }];
    h.context.modelImageList = () => ["fixture-model"];
    expect(h.run().get("detailRefGenerateBtn")).toMatchObject({ kind: "chat", model: "vision-test" });
    expect(h.run().get("detailLinkGenerateBtn")).toMatchObject({ kind: "chat", model: "vision-test" });
    h.state.linkPrompts.detail = { a: { linkId: "a" }, b: { linkId: "b" } };
    expect(h.run().get("detailRefGenerateBtn")?.kind).toBe("local");
    expect(h.run().get("detailLinkGenerateBtn")?.kind).toBe("local");
  });

  it("uses the frozen guide and resume configs for the quoted model and payment channel", () => {
    const h = quotes({ mode: "detail", formal: true });
    Object.assign(h.state, { guideDraft: { config: { imageModel: "frozen-guide-model", channel: "external_key" } } });
    Object.assign(h.state.referenceDetailBatch, { sessionConfig: { imageModel: "frozen-batch-model", channel: "external_key" } });
    const q = h.run();
    expect(q.get("guideRunBtn")).toMatchObject({ kind: "image", model: "frozen-guide-model", requests: [1], channel: "external_key" });
    expect(q.get("referenceDetailBatchResumeBtn")).toMatchObject({ kind: "image", model: "frozen-batch-model", channel: "external_key" });
    expect(q.get("referenceDetailBatchStartBtn")?.kind).toBe("local");
    expect(q.get("generateBtn")?.kind).toBe("local");
  });

  it("waits for automatic analysis before quoting an absent or stale prompt's request grouping", () => {
    const h = quotes({ count: 3 });
    h.state.referencePrompts.main = { data: { 主图规划: [1, 2, 3] } };
    h.context.promptRecordIsCurrent = () => false;
    expect(h.run().get("generateBtn")).toMatchObject({ requests: null, extraAnalysis: true });
  });

  it("splits confirmed per-image plans into separate requests and avoids extra analysis for current prompts", () => {
    const h = quotes({ count: 3 });
    h.state.referencePrompts.main = { data: { 主图规划: [1, 2, 3] } };
    expect(h.run().get("generateBtn")).toMatchObject({ requests: [1, 1, 1], extraAnalysis: false });
  });

  it("uses valid selected link prompts, then only failed keys for a compatible resume", () => {
    const h = quotes({ count: 3 });
    h.state.linkList = [{ id: "a", 链接编号: "a" }, { id: "b", 链接编号: "b" }];
    h.state.linkPrompts.main = { a: { linkId: "a" }, b: { linkId: "b" } };
    expect(h.run().get("linkNumberGenerateBtn")?.requests).toEqual([1, 1, 1, 1, 1, 1]);
    Object.assign(h.state, { linkGenerationResume: { fingerprint: "same", failedKeys: ["a:2"] } });
    expect(h.run().get("linkNumberGenerateBtn")?.requests).toEqual([1]);
  });

  it("never silently caps large batches to a lower quote", () => {
    const h = quotes({ count: 20 });
    h.state.linkList = Array.from({ length: 51 }, (_, index) => ({ id: String(index), 链接编号: String(index) }));
    h.state.linkPrompts.main = Object.fromEntries(h.state.linkList.map(row => [row.id, { linkId: row.id }]));
    expect(h.run().get("linkNumberGenerateBtn")?.requests).toBeNull();
  });

  it("SKU retry matches its automatic failed-task selection instead of current checkboxes", () => {
    const h = quotes();
    h.context.selectedSkuTasks = () => [{}, {}];
    h.context.skuTaskBlueprints = () => Array.from({ length: 7 }, () => ({ item: { url: "fixture" } }));
    const q = h.run();
    expect(q.get("skuGenerateBtn")?.requests).toEqual([1, 1]);
    expect(q.get("skuRetryFailedBtn")?.requests).toEqual([1, 1, 1]);
    expect(q.get("skuGenerateBtn")?.model).toBe("sku-test");
  });

  it("style continuation quotes only missing images, and a QA-only retry remains token-based", () => {
    const h = quotes({ mode: "detail", style: true, count: 3 });
    h.state.styleRefresh.run = { phase: "qa-retry", slots: [{ index: 1 }, { index: 2 }, { index: 3 }] };
    expect(h.run().get("generateBtn")).toMatchObject({ requests: [1, 1], extraAnalysis: true });
    h.context.styleRefreshResultForScreen = () => true;
    expect(h.run().get("generateBtn")?.kind).toBe("chat");
  });

  it("formal details start a new target-by-screen batch, while resume excludes completed and failed screens", () => {
    const h = quotes({ mode: "detail", formal: true });
    h.state.referenceDetailBatch.bundle = {};
    h.state.referenceDetailBatch.rows = [{ selected: true }, { selected: false }, { selected: true }];
    h.state.referenceDetailBatch.context = { tasks: [{ taskId: "a", phase: "interrupted", prompt: { status: "completed" }, screens: [{ status: "completed", resultRef: { resultId: "saved" } }, { status: "failed" }, { status: "pending" }] }] };
    const q = h.run();
    expect(q.get("generateBtn")?.requests).toHaveLength(10);
    expect(q.get("referenceDetailBatchStartBtn")?.extraAnalysis).toBe(true);
    expect(q.get("referenceDetailBatchResumeBtn")?.requests).toEqual([1]);
    expect(q.get("referenceDetailBatchRetryFailedBtn")?.requests).toEqual([1, 1]);
  });
});
