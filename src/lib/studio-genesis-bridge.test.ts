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
}
interface Envelope { provider: string; payload: AnalysisPayload }
interface Bridge {
  analyze(input: Record<string, unknown>): Promise<unknown>;
  openResultAction(action: string, item: Record<string, unknown>): Promise<unknown>;
  modelInfo(): { qualityOptions: string[]; generationSpeeds: string[]; imageAdapter: string };
}

// Execute the actual production bridge object with isolated collaborators. No
// provider request or synthetic replacement of its analyze/edit handlers runs.
function bridgeHarness(key = "fixture-key", imageAdapter = "openai-images") {
  const script = source("promptlab.js"), start = script.indexOf("window.SZ_CREATIVE_TOOLS_BRIDGE = {");
  const end = script.indexOf("\n  };", start);
  if (start < 0 || end < 0) throw new Error("Production creative bridge was not found");
  const credentialStart = script.indexOf("function creativeUsesPlatformWallet(cfg, kind) {"), credentialEnd = script.indexOf("\nfunction creativeSupplyChannel", credentialStart);
  if (credentialStart < 0 || credentialEnd < 0) throw new Error("Production creative credential helpers were not found");
  // The bridge exposes the production API-busy helper; run it with its real state.
  const epochStart = script.indexOf("var configReadEpoch = 0;"), epochEnd = script.indexOf("\n", script.indexOf("var pendingProviderProfile = 0;", epochStart));
  const busyStart = script.indexOf("var creativeWebBusy = Object.create(null);"), busyEnd = script.indexOf("\nfunction creativeWebProfile(", busyStart);
  if ([epochStart, epochEnd, busyStart, busyEnd].some(index => index < 0)) throw new Error("Production API busy helpers were not found");
  expect(script.slice(epochStart, epochEnd).split("\n")).toEqual(["var configReadEpoch = 0;", "var pendingProviderSelection = 0;", "var pendingProviderProfile = 0;"]);
  expect(script.slice(busyStart, busyEnd).match(/\nfunction /g)).toHaveLength(2);
  const calls: Array<{ type: string; envelope: Envelope }> = [];
  const openEditor = vi.fn((_item: Record<string, unknown>) => ({ ok: true }));
  const context = createContext({
    cfgFromForm: () => ({ provider: "fixture-provider", apiKey: key, imageAdapter }),
    send: async (type: string, envelope: Envelope) => { calls.push({ type, envelope: clone(envelope) }); return { ok: true }; },
    queueArchiveResult: vi.fn(), state: { archiveAccountKey: "fixture-account" },
    creativeWebAccountKey: vi.fn(), creativeToolsReady: true, creativeWebRefresh: vi.fn(),
    creativeWebListBoundApis: vi.fn(), creativeWebSelectBoundApi: vi.fn(),
    newJobId: vi.fn(), registerGenerationJob: vi.fn(), unregisterGenerationJob: vi.fn(),
    openConfigModal: vi.fn(), openArchiveHistory: vi.fn(),
    cloneGuideValue: clone, $: () => null, openGuideRegenerateModal: openEditor
  });
  context.window = context;
  runInContext(script.slice(epochStart, epochEnd), context, { filename: "promptlab-production-config-epoch.js" });
  runInContext(script.slice(busyStart, busyEnd), context, { filename: "promptlab-production-api-busy.js" });
  runInContext(script.slice(credentialStart, credentialEnd), context, { filename: "promptlab-production-credentials.js" });
  runInContext(script.slice(start, end + "\n  };".length), context, { filename: "promptlab-production-bridge.js" });
  return { bridge: context.SZ_CREATIVE_TOOLS_BRIDGE as Bridge, calls, openEditor, context };
}

function backgroundHarness() {
  const script = source("background.js"), start = script.indexOf("function analyzeSubjectAsset(cfg, payload) {");
  const end = script.indexOf("\nvar STYLE_REFRESH_QA_CHUNK_SIZE", start);
  if (start < 0 || end < 0) throw new Error("Production subject analyzer was not found");
  const evidenceStart = script.indexOf("function productEvidenceItems(payload) {"), evidenceEnd = script.indexOf("\nfunction productEvidenceNote", evidenceStart);
  const localizationStart = script.indexOf("function localizePromptProductImages(payload) {"), localizationEnd = script.indexOf("\nfunction imagePartForGemini", localizationStart);
  if ([evidenceStart, evidenceEnd, localizationStart, localizationEnd].some(index => index < 0)) throw new Error("Production evidence/localization helpers were not found");
  // The analyzer resolves cancellation through the production signal registries.
  const registryStart = script.indexOf("var activeJobs = {};"), registryEnd = script.indexOf("\nvar legacyPromptJobSequence", registryStart);
  const signalStart = script.indexOf("function signalForPayload(payload) {"), signalEnd = script.indexOf("\nfunction beginLegacyPromptJob", signalStart);
  if ([registryStart, registryEnd, signalStart, signalEnd].some(index => index < 0)) throw new Error("Production signal lookup was not found");
  expect(script.slice(registryStart, registryEnd).split("\n").every(line => /^var \w+ = (?:\{\}|new WeakMap\(\));$/.test(line))).toBe(true);
  const requests: Array<Array<{ role: string; content: unknown }>> = [];
  const context = createContext({
    DEFAULT_CFG: { visionModel: "fixture-vision" },
    fetchPromptImageAsDataUrl: async (image: string) => ({ ok: true, dataUrl: image, localized: false }),
    classifyPromptFailure: (failure: unknown) => failure,
    clampStyleRefreshScore: (value: number) => Math.max(0, Math.min(100, Number(value) || 0)),
    chatJson: async (_cfg: unknown, messages: Array<{ role: string; content: unknown }>) => {
      requests.push(clone(messages));
      return { ok: true, data: { productName: "原图商品", identityPoints: ["正面纹理清晰"], confidence: 90, unsupportedClaim: "未确认的宣传事实" } };
    }
  });
  runInContext(script.slice(registryStart, registryEnd), context, { filename: "background-production-signal-registries.js" });
  runInContext(script.slice(signalStart, signalEnd), context, { filename: "background-production-signal.js" });
  runInContext(script.slice(evidenceStart, evidenceEnd), context, { filename: "background-production-evidence.js" });
  runInContext(script.slice(localizationStart, localizationEnd), context, { filename: "background-production-localization.js" });
  runInContext(script.slice(start, end), context, { filename: "background-production-subject-analysis.js" });
  return { analyze: context.analyzeSubjectAsset as (cfg: object, payload: AnalysisPayload) => Promise<{ ok: boolean; data: Record<string, unknown>; imageInputMeta: { count: number } }>, requests };
}

describe("studio analysis and editing bridge", () => {
  it("routes studio busy state through the production API busy helper and config epoch", () => {
    const { bridge, context } = bridgeHarness(), setApiBusy = (bridge as unknown as { setApiBusy(scope: string, on: boolean): void }).setApiBusy;
    expect(setApiBusy).toBe(context.creativeWebSetApiBusy); expect(context.creativeWebIsBusy()).toBe(false); expect(context.configReadEpoch).toBe(0);
    setApiBusy("studio-genesis", true); expect(context.creativeWebIsBusy()).toBe(true); expect(context.configReadEpoch).toBe(1);
    setApiBusy("studio-genesis", true); expect(context.configReadEpoch).toBe(1);
    setApiBusy("studio-genesis", false); expect(context.creativeWebIsBusy()).toBe(false); expect(context.configReadEpoch).toBe(2);
    context.pendingProviderSelection = 1; setApiBusy("studio-genesis", true);
    expect(context.creativeWebIsBusy()).toBe(true); expect(context.configReadEpoch).toBe(2);
  });
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
});
