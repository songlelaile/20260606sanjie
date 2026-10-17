import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const asset = (name: string) => readFileSync(
  name === "promptlab.js" && process.env.CREATIVE_PROMPTLAB_TEST_PATH
    ? resolve(process.env.CREATIVE_PROMPTLAB_TEST_PATH)
    : resolve(assetRoot, "labs/image-prompt-lab", name), "utf8");

function analysisRuntime() {
  const nodes = new Map<string, ReturnType<typeof node>>();
  function node() {
    return {
      value: "", textContent: "", innerHTML: "", disabled: false, dataset: {},
      classList: { contains: () => false, add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
      addEventListener: vi.fn(), setAttribute: vi.fn(), appendChild: vi.fn(),
      querySelectorAll: () => [], querySelector: () => null
    };
  }
  function element(id: string) {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id)!;
  }
  const document = {
    body: node(), getElementById: element, createElement: node,
    addEventListener: vi.fn(), querySelectorAll: () => []
  };
  const context = createContext({
    document, console, URL, URLSearchParams, Promise,
    location: { search: "?mode=main&source=web&layout=1" },
    setTimeout: vi.fn(), clearTimeout: vi.fn(), __SZ_PROMPTLAB_TEST_MODE__: true
  });
  context.window = context;
  for (const name of ["viral-series-contract.js", "style-refresh-contract.js", "promptlab.js"]) {
    runInContext(asset(name), context, { filename: name });
  }
  // Exercise the real request, input fingerprints and prompt records while
  // skipping the unrelated analysis-card rendering.
  context.showAnalysis = vi.fn();
  context.showProductSubjectRequired = vi.fn();
  const dispatch = vi.fn(async (): Promise<unknown> => ({ ok: true, data: { 中文提示词: "按参考图布局呈现用户主体商品" } }));
  context.__SZ_PROMPTLAB_TEST_API__.setTestSend(dispatch);
  context.state.refImages = ["https://fixtures.invalid/reference-1.png", "https://fixtures.invalid/reference-2.png"];
  context.state.productImages.front = "https://fixtures.invalid/product-front.png";
  context.state.productImages.side = "https://fixtures.invalid/product-side.png";
  context.applyCfg({ provider: "openai", apiKey: "synthetic-owned-key" });
  return { context, element, dispatch };
}

describe("清单成图参考图反推", () => {
  it("shares one in-flight request between manual and automatic analysis callers", async () => {
    const { context, element, dispatch } = analysisRuntime();
    let complete!: (value: unknown) => void;
    dispatch.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const first = context.analyzeCurrentImage();
    const automatic = context.analyzeCurrentImage();
    expect(automatic).toBe(first);
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(element("analyzeBtn").disabled).toBe(true);
    complete({ ok: true, data: { 中文提示词: "同一请求的分析结果" } });
    expect(await automatic).toBe(await first);
    expect(element("analyzeBtn").disabled).toBe(false);
  });

  it("releases a timed-out analysis button, reruns explicitly, and ignores the old late response", async () => {
    const { context, element, dispatch } = analysisRuntime();
    let oldComplete!: (value: unknown) => void;
    dispatch.mockImplementationOnce(() => new Promise(resolve => { oldComplete = resolve; }));
    element("cnPrompt").value = "已有提示词";
    const oldTask = context.analyzeCurrentImage();
    await Promise.resolve();
    const oldJournal = context.promptTaskState().tasks[0];
    context.promptTaskFlights[oldJournal.id].end(true);
    expect(await oldTask).toMatchObject({ ok: false, code: "TASK_WAIT_TIMEOUT", stateUncertain: true });
    expect(element("analyzeBtn").disabled).toBe(false);
    expect(element("runState").textContent).toContain("超时失败");
    expect(element("cnPrompt").value).toBe("已有提示词");
    expect(context.promptTaskState().busy).toBe(false);
    dispatch.mockResolvedValue({ ok: true, data: { 中文提示词: "重新跑的提示词" } });
    expect((await context.analyzeCurrentImage()).ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(2);
    const calls = dispatch.mock.calls as unknown as Array<[string, { jobId: string }]>;
    expect(calls[1][1].jobId).not.toBe(calls[0][1].jobId);
    oldComplete({ ok: true, data: { 中文提示词: "旧任务迟到提示词" } });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(element("cnPrompt").value).toContain("重新跑的提示词");
    expect(element("cnPrompt").value).not.toContain("旧任务迟到提示词");
  });

  it.each(["reference", "configuration", "account"])("does not submit a second request while %s changes during analysis", async input => {
    const { context, element, dispatch } = analysisRuntime();
    let complete!: (value: unknown) => void;
    dispatch.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const first = context.analyzeCurrentImage();
    await Promise.resolve();
    if (input === "reference") context.state.refImages = ["https://fixtures.invalid/reference-new.png"];
    else if (input === "configuration") element("visionModel").value = "another-vision-model";
    else context.state.archiveAccountKey = "another-account";
    const blocked = await context.analyzeCurrentImage();
    expect(blocked).toMatchObject({ ok: false, code: "REFERENCE_ANALYSIS_BUSY" });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(element("analyzeBtn").disabled).toBe(true);
    complete({ ok: false, error: "上一轮结束" });
    await first;
    dispatch.mockResolvedValue({ ok: true, data: { 中文提示词: "当前输入的结果" } });
    expect((await context.analyzeCurrentImage()).ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it.each(["legacy", "url-import"])("waits for %s image import without dispatching old materials", async upload => {
    const { context, element, dispatch } = analysisRuntime();
    element("cnPrompt").value = "保留当前草稿";
    if (upload === "legacy") {
      context.imageUploadReads = 1;
      context.syncLegacyImageUploadControls();
      expect(element("analyzeBtn").disabled).toBe(true);
    } else context.SZ_IMAGE_UPLOAD = { isImporting: () => true };
    const response = await context.analyzeCurrentImage();
    expect(response).toMatchObject({ ok: false, code: "IMAGE_IMPORT_PENDING" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(element("cnPrompt").value).toBe("保留当前草稿");
    context.imageUploadReads = 0;
    context.SZ_IMAGE_UPLOAD = null;
    context.syncLegacyImageUploadControls();
    expect(element("analyzeBtn").disabled).toBe(false);
  });

  it("rechecks materials before dispatch when an image changes in the same turn", async () => {
    const { context, element, dispatch } = analysisRuntime();
    element("cnPrompt").value = "当前素材的草稿";
    const task = context.analyzeCurrentImage();
    context.state.productImages.front = "https://fixtures.invalid/product-replaced.png";
    expect(await task).toMatchObject({ ok: false, stale: true });
    expect(dispatch).not.toHaveBeenCalled();
    expect(element("cnPrompt").value).toBe("当前素材的草稿");
  });

  it("rechecks image import immediately before dispatch", async () => {
    const { context, dispatch } = analysisRuntime();
    const task = context.analyzeCurrentImage();
    context.imageUploadReads = 1;
    expect(await task).toMatchObject({ ok: false, code: "IMAGE_IMPORT_PENDING" });
    expect(dispatch).not.toHaveBeenCalled();
    context.imageUploadReads = 0;
    context.syncLegacyImageUploadControls();
  });

  it("does not dispatch after the account changes before the queued request starts", async () => {
    const { context, dispatch } = analysisRuntime();
    const task = context.analyzeCurrentImage();
    context.state.archiveAccountKey = "another-account";
    expect(await task).toMatchObject({ ok: false, stale: true, error: expect.stringContaining("账号已切换") });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not save a former account's successful response into the current account", async () => {
    const { context, element, dispatch } = analysisRuntime();
    let complete!: (value: unknown) => void;
    dispatch.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    element("cnPrompt").value = "当前账号草稿";
    const task = context.analyzeCurrentImage();
    await Promise.resolve();
    context.state.archiveAccountKey = "another-account";
    complete({ ok: true, data: { 中文提示词: "上个账号的结果" } });
    expect(await task).toMatchObject({ ok: false, stale: true });
    expect(element("cnPrompt").value).toBe("当前账号草稿");
    expect(context.state.referenceAnalysis).toBeFalsy();
    expect(context.state.activePromptRecord).toBeFalsy();
  });

  it.each([false, true])("only applies a model fallback to the request's account (account changed: %s)", async accountChanged => {
    const { context, element, dispatch } = analysisRuntime();
    let complete!: (value: unknown) => void;
    dispatch.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    element("visionModel").value = "initial-vision-model";
    const task = context.analyzeCurrentImage();
    await Promise.resolve();
    if (accountChanged) context.state.archiveAccountKey = "another-account";
    complete({ ok: true, data: { 中文提示词: "模型回退后的结果" }, modelFallback: {
      from: "initial-vision-model", to: "fallback-vision-model"
    } });
    const response = await task;
    expect(response.ok).toBe(!accountChanged);
    expect(element("visionModel").value).toBe(accountChanged ? "initial-vision-model" : "fallback-vision-model");
  });

  it("discards a late transport failure after reference images change", async () => {
    const { context, element } = analysisRuntime();
    let fail!: (reason: Error) => void;
    context.__SZ_PROMPTLAB_TEST_API__.setTestSend(() => new Promise((_, reject) => { fail = reject; }));
    const task = context.analyzeCurrentImage();
    await Promise.resolve();
    context.state.refImages = ["https://fixtures.invalid/reference-new.png"];
    fail(new Error("旧素材的接口失败"));
    expect(await task).toMatchObject({ ok: false, stale: true });
    expect(element("runState").textContent).not.toBe("旧素材的接口失败");
    expect(element("analyzeBtn").disabled).toBe(false);
  });

  it.each(["batch", "upload"])("keeps the analysis button locked until the overlapping %s work finishes", async owner => {
    const { context, element, dispatch } = analysisRuntime();
    let complete!: (value: unknown) => void;
    dispatch.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const task = context.analyzeCurrentImage();
    await Promise.resolve();
    if (owner === "batch") context.setBatchLinksBusy(true);
    else { context.imageUploadReads = 1; context.syncLegacyImageUploadControls(); }
    complete({ ok: false, error: "本轮完成" });
    await task;
    expect(element("analyzeBtn").disabled).toBe(true);
    if (owner === "batch") context.setBatchLinksBusy(false);
    else { context.imageUploadReads = 0; context.syncLegacyImageUploadControls(); }
    expect(element("analyzeBtn").disabled).toBe(false);
  });

  it("routes reference analysis explicitly and keeps ordered references separate from product evidence", async () => {
    const { context, element, dispatch } = analysisRuntime();
    context.state.lastLink = { 链接编号: "L009", 主推关键词: "旧链接词" };
    element("linkJson").value = JSON.stringify(context.state.lastLink);
    const task = context.analyzeCurrentImage();
    expect(element("analyzeBtn").disabled).toBe(true);
    const response = await task;
    expect(response.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
    const [type, request] = dispatch.mock.calls[0] as unknown as [string, { config: Record<string, unknown>; payload: Record<string, unknown> }];
    expect(type).toBe("ANALYZE_IMAGE");
    expect(request.config).toMatchObject({ provider: "openai", apiKey: "synthetic-owned-key" });
    expect(request.payload).toMatchObject({
      promptSource: "reference", requestId: expect.stringMatching(/^reference_prompt_/), linkHint: "",
      image: "https://fixtures.invalid/reference-1.png",
      referenceImages: ["https://fixtures.invalid/reference-1.png", "https://fixtures.invalid/reference-2.png"],
      productImages: ["https://fixtures.invalid/product-front.png", "https://fixtures.invalid/product-side.png"],
      productImageEvidence: [
        { angle: "front", image: "https://fixtures.invalid/product-front.png" },
        { angle: "side", image: "https://fixtures.invalid/product-side.png" }
      ]
    });
    expect(request.payload.link).toBeUndefined();
    expect(request.payload.linkId).toBeUndefined();
    expect(response.promptRecord.requestId).toBe(request.payload.requestId);
    expect(context.state.activePromptRecord).toBe(response.promptRecord);
    expect(element("cnPrompt").value).toContain("按参考图布局");
    expect(element("runState").textContent).toBe("提词完成");
    expect(element("analyzeBtn").disabled).toBe(false);
  });

  it("requires product evidence before dispatch and preserves the reference inputs", async () => {
    const { context, element, dispatch } = analysisRuntime();
    context.state.productImages = { front: "", side: "", back: "" };
    const before = JSON.stringify(context.state.refImages);
    const response = await context.analyzeCurrentImage();
    expect(response).toMatchObject({ ok: false, error: "缺少商品主体图" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(JSON.stringify(context.state.refImages)).toBe(before);
    expect(element("analyzeBtn").disabled).toBe(false);
  });

  it.each(["reject", "throw"])("shows %s dispatch failures and unlocks the analysis button without replacing an existing prompt", async kind => {
    const { context, element } = analysisRuntime();
    element("cnPrompt").value = "用户已有提示词";
    context.__SZ_PROMPTLAB_TEST_API__.setTestSend(() => {
      if (kind === "throw") throw new Error("本地消息失败");
      return Promise.reject(new Error("本地消息失败"));
    });
    const response = await context.analyzeCurrentImage();
    expect(response).toMatchObject({ ok: false, code: "TASK_TRANSPORT_FAILED" });
    expect(element("runState").textContent).toContain("任务连接失败");
    expect(element("runState").textContent).toContain("重新跑");
    expect(element("analyzeBtn").disabled).toBe(false);
    expect(element("cnPrompt").value).toBe("用户已有提示词");
    expect(context.state.referenceAnalysis).toBeFalsy();
  });

  it("shows provider validation failures without saving a successful analysis", async () => {
    const { context, element } = analysisRuntime();
    context.__SZ_PROMPTLAB_TEST_API__.setTestSend(() => ({ ok: false, code: "vision_model_required", error: "请选择视觉模型" }));
    const response = await context.analyzeCurrentImage();
    expect(response).toMatchObject({ ok: false, code: "vision_model_required" });
    expect(element("runState").textContent).toBe("请选择视觉模型");
    expect(element("analyzeBtn").disabled).toBe(false);
    expect(context.state.referenceAnalysis).toBeFalsy();
  });

  it.each(["product", "reference"])("discards a late reply when the %s images change", async input => {
    const { context, element } = analysisRuntime();
    let complete!: (value: unknown) => void;
    context.__SZ_PROMPTLAB_TEST_API__.setTestSend(() => new Promise(resolve => { complete = resolve; }));
    element("cnPrompt").value = "当前草稿";
    const task = context.analyzeCurrentImage();
    await Promise.resolve();
    if (input === "product") context.state.productImages.front = "https://fixtures.invalid/product-new.png";
    else context.state.refImages = ["https://fixtures.invalid/reference-new.png"];
    complete({ ok: true, data: { 中文提示词: "过期结果" } });
    const response = await task;
    expect(response).toMatchObject({ ok: false, stale: true });
    expect(element("cnPrompt").value).toBe("当前草稿");
    expect(context.state.referenceAnalysis).toBeFalsy();
    expect(element("analyzeBtn").disabled).toBe(false);
  });
});
