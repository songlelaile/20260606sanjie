import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const source = (file: string) => readFileSync(resolve(assetRoot, "labs/image-prompt-lab", file), "utf8");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const images = Array.from({ length: 7 }, (_, index) => `https://fixture.test/product-${index}.png`);

interface AnalysisPayload {
  productImages: string[];
  category: string;
  requiredFacts: string[];
  studioContext?: boolean;
  _jobId?: string;
}
interface Envelope { provider: string; payload: AnalysisPayload }
interface Bridge {
  analyze(input: Record<string, unknown>): Promise<unknown>;
  openResultAction(action: string, item: Record<string, unknown>): Promise<unknown>;
  modelInfo(): { qualityOptions: string[]; generationSpeeds: string[]; imageAdapter: string };
}

function installConfigGuards(script: string, context: ReturnType<typeof createContext>) {
  const start=script.indexOf("var configApplySeq = 0;"), end=script.indexOf("\nfunction applyCfg(cfg)",start);
  if(start<0||end<0)throw new Error("Production configuration ownership guards were not found");
  runInContext(script.slice(start,end),context,{filename:"promptlab-production-config-guards.js"});
}

// Execute the actual production bridge object with isolated collaborators. No
// provider request or synthetic replacement of its analyze/edit handlers runs.
function bridgeHarness(key = "fixture-key", imageAdapter = "openai-images") {
  const script = source("promptlab.js"), start = script.indexOf("window.SZ_CREATIVE_TOOLS_BRIDGE = {");
  const end = script.indexOf("\n  };", start);
  if (start < 0 || end < 0) throw new Error("Production creative bridge was not found");
  const calls: Array<{ type: string; envelope: Envelope }> = [];
  const openEditor = vi.fn((item: Record<string, unknown>) => { void item;return { ok: true }; });
  const context = createContext({
    cfgFromForm: () => ({ provider: "fixture-provider", apiKey: key, imageAdapter }),
    send: async (type: string, envelope: Envelope) => { calls.push({ type, envelope: clone(envelope) }); return { ok: true }; },
    queueArchiveResult: vi.fn(), state: { archiveAccountKey: "fixture-account" },
    creativeWebAccountKey: vi.fn(), creativeToolsReady: true, creativeWebRefresh: vi.fn(),
    creativeWebListBoundApis: vi.fn(), creativeWebSelectBoundApi: vi.fn(), creativeWebBusy: {},
    newJobId: vi.fn(), registerGenerationJob: vi.fn(), unregisterGenerationJob: vi.fn(),
    creativeWebIsBusy: () => false, openConfigModal: vi.fn(), openArchiveHistory: vi.fn(),
    creativeUsesPlatformWallet: () => false,
    cloneGuideValue: clone, $: () => null, openGuideRegenerateModal: openEditor
  });
  context.window = context;
  installConfigGuards(script,context);
  const busyStart=script.indexOf("var creativeWebBusy = Object.create(null);"),busyEnd=script.indexOf("\nfunction creativeWebProfile",busyStart);
  if(busyStart<0||busyEnd<0)throw new Error("Production configuration busy helper was not found");
  runInContext(script.slice(busyStart,busyEnd),context,{filename:"promptlab-production-config-busy.js"});
  // The restored v4 bridge depends on this real credential helper. Execute it
  // alongside the isolated bridge, retaining the configured/unconfigured cases.
  const credentialStart = script.indexOf("function creativeHasApiCredential(cfg, kind) {");
  const credentialEnd = script.indexOf("\nfunction creativeSupplyChannel", credentialStart);
  if (credentialStart < 0 || credentialEnd < 0) throw new Error("Production credential helper was not found");
  runInContext(script.slice(credentialStart, credentialEnd), context, { filename: "promptlab-production-credential.js" });
  runInContext(script.slice(start, end + "\n  };".length), context, { filename: "promptlab-production-bridge.js" });
  return { bridge: context.SZ_CREATIVE_TOOLS_BRIDGE as Bridge, calls, openEditor };
}

function backgroundHarness() {
  const script = source("background.js"), start = script.indexOf("function analyzeSubjectAsset(cfg, payload) {");
  const end = script.indexOf("\nvar STYLE_REFRESH_QA_CHUNK_SIZE", start);
  if (start < 0 || end < 0) throw new Error("Production subject analyzer was not found");
  const evidenceStart = script.indexOf("function productEvidenceItems(payload) {"), evidenceEnd = script.indexOf("\nfunction productEvidenceNote", evidenceStart);
  const localizationStart = script.indexOf("function localizePromptProductImages(payload) {"), localizationEnd = script.indexOf("\nfunction imagePartForGemini", localizationStart);
  const signalStart = script.indexOf("function signalForPayload(payload) {"), signalEnd = script.indexOf("\nfunction beginLegacyPromptJob", signalStart);
  if ([evidenceStart, evidenceEnd, localizationStart, localizationEnd, signalStart, signalEnd].some(index => index < 0)) throw new Error("Production evidence/localization/signal helpers were not found");
  const requests: Array<Array<{ role: string; content: unknown }>> = [];
  const requestSignals: Array<AbortSignal | null | undefined> = [];
  const activeJobs: Record<string, AbortController> = Object.create(null);
  const context = createContext({
    DEFAULT_CFG: { visionModel: "fixture-vision" },
    activeJobs, imageRequestSignals: new WeakMap(), legacyPromptRequestSignals: new WeakMap(), sceneExtensionRequestSignals: new WeakMap(),
    fetchPromptImageAsDataUrl: async (image: string) => ({ ok: true, dataUrl: image, localized: false }),
    classifyPromptFailure: (failure: unknown) => failure,
    clampStyleRefreshScore: (value: number) => Math.max(0, Math.min(100, Number(value) || 0)),
    chatJson: async (_cfg: unknown, messages: Array<{ role: string; content: unknown }>, _model: unknown,
      _temperature: unknown, _timeout: unknown, _budget: unknown, signal?: AbortSignal | null) => {
      requests.push(clone(messages));
      requestSignals.push(signal);
      return { ok: true, data: { productName: "原图商品", identityPoints: ["正面纹理清晰"], confidence: 90, unsupportedClaim: "未确认的宣传事实" } };
    }
  });
  runInContext(script.slice(signalStart, signalEnd), context, { filename: "background-production-request-signal.js" });
  runInContext(script.slice(evidenceStart, evidenceEnd), context, { filename: "background-production-evidence.js" });
  runInContext(script.slice(localizationStart, localizationEnd), context, { filename: "background-production-localization.js" });
  runInContext(script.slice(start, end), context, { filename: "background-production-subject-analysis.js" });
  return { analyze: context.analyzeSubjectAsset as (cfg: object, payload: AnalysisPayload) => Promise<{ ok: boolean; data: Record<string, unknown>; imageInputMeta: { count: number } }>, requests, requestSignals, activeJobs };
}

interface CatalogSnapshot {
  ok: boolean;
  accountKey: string;
  providers: Array<{ provider: string }>;
}
interface ProfileSnapshot {
  ok: boolean;
  accountKey: string;
  config: Record<string, unknown>;
  boundApis: CatalogSnapshot;
}
interface ConfigBridge {
  creativeWebRefresh(options?: { deferArchive: boolean }): Promise<{ ok: boolean; accountKey: string; boundApis: CatalogSnapshot }>;
  creativeWebAccountKey(): Promise<string>;
  creativeWebListBoundApis(snapshot?: CatalogSnapshot): Promise<{ ok: boolean; accountKey?: string; providers?: CatalogSnapshot["providers"]; error?: string }>;
}

function configBridgeHarness(accountKey = "fixture-account", initialAccountKey = accountKey) {
  const script = source("promptlab.js"), start = script.indexOf("var creativeWebBusy = Object.create(null);");
  const end = script.indexOf("\nfunction creativeWebSelectBoundApi", start);
  if (start < 0 || end < 0) throw new Error("Production configuration bridge was not found");
  const state = { archiveAccountKey: initialAccountKey };
  const boundApis: CatalogSnapshot = { ok: true, accountKey, providers: [{ provider: "fixture-provider" }] };
  const profile: ProfileSnapshot = { ok: true, accountKey, config: { provider: "fixture-provider", imageModel: "fixture-image" }, boundApis };
  const send = vi.fn(async (type: string, payload: { provider?: string }) => { void payload; return type === "GET_BOUND_IMAGE_APIS" ? boundApis : profile; });
  const applyCfg = vi.fn();
  const setArchiveAccountKey = vi.fn(async (key: string, options: { refresh: boolean; deferArchive: boolean }) => { void options; state.archiveAccountKey = key; });
  const context = createContext({ send, state, applyCfg, setArchiveAccountKey });
  installConfigGuards(script,context);
  runInContext(script.slice(start, end), context, { filename: "promptlab-production-config-bridge.js" });
  return { bridge: context as unknown as ConfigBridge, state, boundApis, profile, send, applyCfg, setArchiveAccountKey };
}

describe("restored V4 configuration snapshot protocol", () => {
  it("requests a fresh startup DTO once and reuses its bound API catalog within the same refresh", async () => {
    const h = configBridgeHarness();
    const ready = await h.bridge.creativeWebRefresh({ deferArchive: true });
    expect(h.send.mock.calls).toEqual([["GET_STUDIO_CONFIG_SNAPSHOT", { provider: "" }]]);
    expect(h.applyCfg).toHaveBeenCalledWith(h.profile.config);
    expect(h.setArchiveAccountKey).toHaveBeenCalledWith("fixture-account", { refresh: false, deferArchive: true });
    expect(ready.boundApis).toBe(h.boundApis);
    expect(await h.bridge.creativeWebListBoundApis(ready.boundApis)).toEqual({ ok: true, accountKey: "fixture-account", providers: h.boundApis.providers });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(await h.bridge.creativeWebAccountKey()).toBe("fixture-account");
    expect(h.send.mock.calls[1]).toEqual(["GET_CONFIG_PROFILE", { provider: "" }]);
    expect(await h.bridge.creativeWebListBoundApis()).toMatchObject({ ok: true, accountKey: "fixture-account" });
    expect(h.send.mock.calls[2]).toEqual(["GET_BOUND_IMAGE_APIS", {}]);
  });

  it("rejects a local identity before changing configuration or restoring an account archive", async () => {
    const h = configBridgeHarness("local","fixture-previous");
    await expect(h.bridge.creativeWebRefresh({ deferArchive: true })).rejects.toThrow("请先登录账号");
    expect(h.applyCfg).not.toHaveBeenCalled();
    expect(h.setArchiveAccountKey).not.toHaveBeenCalled();
    expect(h.state.archiveAccountKey).toBe("fixture-previous");
  });

  it("rejects a different account's startup snapshot before applying its configuration",async()=>{
    const h=configBridgeHarness("fixture-other-account","fixture-account");
    await expect(h.bridge.creativeWebRefresh({deferArchive:true})).rejects.toThrow("账号已变化");
    expect(h.applyCfg).not.toHaveBeenCalled();expect(h.setArchiveAccountKey).not.toHaveBeenCalled();
    expect(h.state.archiveAccountKey).toBe("fixture-account");
  });

  it("rejects an old startup DTO after an account switch without another implicit catalog request", async () => {
    const h = configBridgeHarness();
    const ready = await h.bridge.creativeWebRefresh({ deferArchive: true });
    h.state.archiveAccountKey = "fixture-other-account";
    expect(await h.bridge.creativeWebListBoundApis(ready.boundApis)).toMatchObject({ ok: false, error: expect.stringContaining("账号已变化") });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("rejects a fresh catalog response when the account changes while the read is pending", async () => {
    const h = configBridgeHarness();
    await h.bridge.creativeWebRefresh({ deferArchive: true });
    const pending = h.bridge.creativeWebListBoundApis();
    h.state.archiveAccountKey = "fixture-other-account";
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining("账号已变化") });
    expect(h.send.mock.calls[1]).toEqual(["GET_BOUND_IMAGE_APIS", {}]);
  });
});

describe("studio analysis and editing bridge", () => {
  it("exposes provider quality capability without advertising an unsupported fast mode", () => {
    const supported = bridgeHarness().bridge.modelInfo();
    expect(supported.qualityOptions).toEqual(["auto", "low", "medium", "high"]);
    expect(supported.generationSpeeds).toEqual(["standard"]);
    expect(supported.imageAdapter).toBe("openai-images");
    expect(bridgeHarness("fixture-key", "gemini").bridge.modelInfo().qualityOptions).toEqual(["auto"]);
    expect(bridgeHarness("fixture-key", "generic-json").bridge.modelInfo().qualityOptions).toContain("high");
  });
  it("binds six product images and the current creation intent to the existing safe analysis route", async () => {
    const h = bridgeHarness();
    await h.bridge.analyze({ tool: "product", products: images.map(image => ({ image })), requirements: "突出原图可见衣领和纽扣", purpose: "plan",
      settings: { platform: "淘宝", language: "中文简体", imageType: "main", modules: ["白底首图", { name: "细节图" }], expertMode: true } });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].type).toBe("ANALYZE_SUBJECT_ASSET");
    expect(h.calls[0].envelope.provider).toBe("fixture-provider");
    expect(h.calls[0].envelope.payload.productImages).toEqual(images.slice(0, 6));
    expect(h.calls[0].envelope.payload.studioContext).toBe(true);
    const instructions = h.calls[0].envelope.payload.requiredFacts.join("\n");
    for (const text of ["衣领和纽扣", "淘宝", "中文简体", "main", "白底首图、细节图", "专家模式", "需要补证", "构图", "未知信息留空"]) expect(instructions).toContain(text);
  });

  it("makes brief intent explicit and retains the three-image behavior of other tools", async () => {
    const h = bridgeHarness();
    await h.bridge.analyze({ tool: "product", products: images, purpose: "brief", settings: { expertMode: false } });
    expect(h.calls[0].envelope.payload.requiredFacts.join("\n")).toContain("起草简洁的图片要求");
    expect(h.calls[0].envelope.payload.requiredFacts.join("\n")).not.toContain("专家模式");
    await h.bridge.analyze({ tool: "clothing", products: images, requirements: "不应改变其他工具的分析" });
    expect(h.calls[1].envelope.payload).toEqual({ productImages: images.slice(0, 3), category: "服装", requiredFacts: [] });
  });

  it("fails before dispatch when the account has no configured API", async () => {
    const h = bridgeHarness("");
    expect(await h.bridge.analyze({ tool: "product", products: images })).toMatchObject({ ok: false });
    expect(h.calls).toEqual([]);
  });

  it("edits studio results with originals preserved and incompatible generation contracts removed", async () => {
    const h = bridgeHarness();
    const original = { url: "https://fixture.test/result.png", productName: "原图商品", productImages: images.slice(0, 2),
      generationRoute: "studio-genesis", promptSource: "studio-genesis", studioGenesisVersion: "STUDIO_GENESIS_V1",
      studioGenesisPlan: { taskId: "product-1" }, studioGenesisPlanSignature: "old-signature", ratio: "1:1", model: "fixture-image" };
    expect(await h.bridge.openResultAction("edit", original)).toMatchObject({ ok: true });
    const edited = h.openEditor.mock.calls[0][0];
    expect(edited.productImages).toEqual(original.productImages);
    expect(edited.url).toBe(original.url);
    expect(edited.productName).toBe(original.productName);
    expect(edited.labMode).toBe("main");
    for (const field of ["generationRoute", "promptSource", "studioGenesisVersion", "studioGenesisPlan", "studioGenesisPlanSignature"]) expect(edited[field]).toBeUndefined();
    expect(original.studioGenesisPlan).toEqual({ taskId: "product-1" });
  });

  it("honors the six-image studio context in the actual analyzer without widening other analysis inputs", async () => {
    const bridge = bridgeHarness(), backend = backgroundHarness();
    await bridge.bridge.analyze({ tool: "product", products: images, purpose: "plan", settings: { expertMode: true } });
    const result = await backend.analyze({ provider: "fixture-provider" }, bridge.calls[0].envelope.payload);
    expect(result.ok).toBe(true);
    expect(result.imageInputMeta.count).toBe(6);
    const content = backend.requests[0][1].content as Array<{ type: string; text?: string }>;
    expect(content.filter(part => part.type === "image_url")).toHaveLength(6);
    expect(content[0].text).toContain("主体图片是唯一可见证据");
    expect(content[0].text).toContain("专家模式");
    expect(result.data.unsupportedClaim).toBeUndefined();
    await backend.analyze({ provider: "fixture-provider" }, { productImages: images, category: "", requiredFacts: [] });
    const other = backend.requests[1][1].content as Array<{ type: string }>;
    expect(other.filter(part => part.type === "image_url")).toHaveLength(3);
  });

  it("passes the captured subject job signal through image localization into the text request", async () => {
    const backend = backgroundHarness(), controller = new AbortController();
    backend.activeJobs["subject-analysis"] = controller;
    const pending = backend.analyze({ provider: "fixture-provider" }, {
      productImages: images, category: "", requiredFacts: [], _jobId: "subject-analysis"
    });
    // The analyzer captures the original controller before localization. A
    // replacement job cannot change which request is cancelled afterward.
    backend.activeJobs["subject-analysis"] = new AbortController();
    controller.abort();
    await pending;
    expect(backend.requestSignals).toHaveLength(1);
    expect(backend.requestSignals[0]).toBe(controller.signal);
    expect(backend.requestSignals[0]?.aborted).toBe(true);
  });
});
