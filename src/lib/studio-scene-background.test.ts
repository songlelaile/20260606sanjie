import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";

const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const baselineRoot = process.env.CREATIVE_BASELINE_TEST_ROOT;
const script = (path: string) => {
  const primary = resolve(assetRoot, path);
  return readFileSync(existsSync(primary) ? primary : resolve(baselineRoot || assetRoot, path), "utf8");
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const image = (marker: number) => {
  const bytes = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(64, 16); bytes.writeUInt32BE(64, 20); bytes[26] = marker;
  return `data:image/png;base64,${bytes.toString("base64")}`;
};
const PRODUCT = image(1), DETAIL = image(2), OUTPUT = image(3);
type Payload = Record<string, unknown>;
interface Configuration {
  provider: string; imageAdapter: string; apiKey: string; imageEndpoint: string; imageModel: string;
}
const configuration: Configuration = {
  provider: "openai-compatible", imageAdapter: "generic-json", apiKey: "synthetic-key",
  imageEndpoint: "https://provider.test/v1/images/generations", imageModel: "fixture-image"
};
interface Reply { ok: boolean; code?: string; images?: string[]; definitiveFailure?: boolean; stateUncertain?: boolean; }
interface Gate { ok: boolean; payload?: Payload; response?: Reply; }
interface ScenePlan { ok: boolean; shots: Array<{ id: string }>; }
interface SceneContract {
  version: string;
  createPlan(input: Payload): ScenePlan;
  createPayload(plan: ScenePlan, shot: string): Payload;
}
type Provider = (config: Configuration, payload: Payload) => Promise<Reply>;
interface BackendApi {
  activeJobs: Record<string, AbortController>;
  sceneExtensionGenerationPreflight(payload: Payload, surface: string, config: Configuration | null): Gate;
  sceneExtensionProviderPreflight(config: Configuration, payload: Payload, signal?: AbortSignal): Gate;
  createImageTask(config: Configuration, payload: Payload, batch?: unknown, signal?: AbortSignal): Promise<Reply>;
  createOpenAIImage: Provider; createVolcengineImage: Provider; createGeminiImage: Provider;
  createGenericJsonImage: Provider; createDashScopeImageTask: Provider;
  generationPayload(config: Configuration, payload: Payload): Payload;
  verifyKnowledgeBeforeImage(payload: Payload): Promise<Reply & { knowledgeMeta?: { code: string } }>;
}
interface RequestRecord { url: string; body: Payload; signal?: AbortSignal | null; files: number; }
interface ChromeRuntime { runtime: { sendMessage(message: Payload, callback: (reply: Reply) => void): void } }

function backend(options: { omitScene?: boolean; providerStatus?: number; hold?: boolean } = {}) {
  const requests: RequestRecord[] = [], local = new Map<string, string>();
  let releaseProvider: (() => void) | undefined;
  const held = new Promise<void>(resolveHeld => { releaseProvider = resolveHeld; });
  const storage = {
    get length() { return local.size; }, key: (index: number) => [...local.keys()][index] || null,
    getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => local.set(key, value),
    removeItem: (key: string) => local.delete(key)
  };
  const context = createContext({
    URL, URLSearchParams, Request, Headers, Response, Blob, FormData, TextEncoder, TextDecoder,
    ArrayBuffer, Uint8Array, btoa, atob, console, setTimeout, clearTimeout, AbortController, crypto: webcrypto,
    localStorage: storage, sessionStorage: storage, __SZ_PROMPTLAB_BACKGROUND_TEST_MODE__: true,
    location: { href: "https://site.test/creative/labs/image-prompt-lab/promptlab.html?mode=viral", origin: "https://site.test", search: "?mode=viral" },
    document: { getElementById: () => null, addEventListener() {}, body: { classList: { contains: () => false, toggle() {} } } },
    addEventListener() {},
    authCheck: async () => ({ ok: true, user: { id: "alice" }, creativeEntitlement: { allowed: true } }),
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (/^data:image\//.test(url)) return new Response(Buffer.from(url.split(",")[1], "base64"), { headers: { "Content-Type": "image/png" } });
      if (url === "/api/auth/me") return Response.json({ data: { id: "alice", tenantId: "shop", username: "alice", creativeEntitlement: { allowed: true } } });
      if (url !== "/api/creative/proxy") throw new Error(`Unexpected network: ${url}`);
      let target = "", body: Payload = {}, files = 0;
      if (init?.body instanceof FormData) {
        target = String(init.body.get("__sz_url"));
        for (const [key, value] of init.body.entries()) {
          if (/^__sz_/.test(key)) continue;
          if (typeof value === "string") body[key] = value;
          else { files++; body[key] = `image-bytes:${Buffer.from(await value.arrayBuffer()).toString("base64")}`; }
        }
      } else {
        const envelope = JSON.parse(String(init?.body)) as { url: string; bodyText?: string; bodyBase64?: string };
        target = envelope.url;
        body = JSON.parse(envelope.bodyText || Buffer.from(envelope.bodyBase64 || "", "base64").toString()) as Payload;
      }
      requests.push({ url: target, body, signal: init?.signal, files });
      if (options.hold) await held;
      if (init?.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const status = options.providerStatus || 200;
      if (status !== 200) return Response.json({ error: { message: "provider fixture rejection" } }, { status });
      return Response.json({ data: [{ url: OUTPUT }], output: { results: [{ url: "https://provider.test/result.png" }] }, candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: OUTPUT.split(",")[1] } }] } }] });
    }
  });
  context.window = context;
  const files = [
    "web-chrome.js", "src/business-knowledge.js", "src/subject-orchestration.js", "src/subject-assets.js", "src/reference-detail-contract.js",
    "labs/image-prompt-lab/reference-detail-blueprint.js", "labs/image-prompt-lab/reference-detail-batch.js",
    "labs/image-prompt-lab/viral-series-contract.js", "labs/image-prompt-lab/style-refresh-contract.js",
    "labs/image-prompt-lab/creative-tools-contract.js", "labs/image-prompt-lab/studio-genesis-contract.js",
    ...(options.omitScene ? [] : ["labs/image-prompt-lab/scene-extension-contract.js"]),
    "labs/image-prompt-lab/image-archive-store.js", "labs/image-prompt-lab/background.js"
  ];
  for (const file of files) runInContext(script(file), context, { filename: file });
  const api = context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__ as BackendApi;
  const contract = context.SZ_SCENE_EXTENSION_CONTRACT as SceneContract;
  const chrome = context.chrome as ChromeRuntime;
  const send = (message: Payload) => new Promise<Reply>(resolveReply => chrome.runtime.sendMessage(message, resolveReply));
  return { context, api, contract, requests, send, release: () => releaseProvider?.() };
}
function payload(contract: SceneContract): Payload {
  const plan = contract.createPlan({
    config: { materialName: "同款原木样板", category: "material", sameMaterialConfirmed: true, scene: "明亮客厅", shots: ["macro", "wide"], count: 2, ratio: "3:4", resolution: "2K" },
    images: [{ role: "front", image: PRODUCT }, { role: "detail", image: DETAIL }]
  });
  expect(plan.ok).toBe(true);
  return contract.createPayload(plan, plan.shots[0].id);
}
const providers: Array<{ name: keyof Pick<BackendApi, "createOpenAIImage" | "createVolcengineImage" | "createGeminiImage" | "createGenericJsonImage" | "createDashScopeImageTask">; adapter: string; model: string }> = [
  { name: "createOpenAIImage", adapter: "openai-images", model: "gpt-image-1" },
  { name: "createVolcengineImage", adapter: "volcengine-image", model: "doubao-seedream-4-0" },
  { name: "createGeminiImage", adapter: "gemini-image", model: "gemini-3-pro-image-preview" },
  { name: "createGenericJsonImage", adapter: "generic-json", model: "fixture-image" },
  { name: "createDashScopeImageTask", adapter: "dashscope-wan", model: "wan2.6-image" }
];

describe("website scene backend contract", () => {
  it("requires the scene contract and does not downgrade missing components to another route", async () => {
    const source = backend(), h = backend({ omitScene: true });
    expect(await h.api.createImageTask(configuration, payload(source.contract))).toMatchObject({ ok: false, code: "SCENE_CONTRACT_MISSING", definitiveFailure: true });
    expect(h.requests).toHaveLength(0);
  });
  it("canonicalizes caller prompts and removes unrelated provider modifiers", async () => {
    const h = backend(), original = payload(h.contract), edited = { ...clone(original), prompt: "caller prompt override", negativePrompt: "", watermark: true, quality: "high", batchId: "caller-batch", _jobId: "scene-direct" };
    const gate = h.api.sceneExtensionGenerationPreflight(edited, "GENERATE_IMAGE", configuration);
    expect(gate.ok).toBe(true); expect(gate.payload?.prompt).toBe(original.prompt);
    expect(gate.payload?._jobId).toBe("scene-direct");
    expect(gate.payload?.batchId).toBeUndefined(); expect(gate.payload?.watermark).toBeUndefined(); expect(gate.payload?.quality).toBeUndefined();
    expect((await h.api.createImageTask(configuration, edited)).ok).toBe(true);
    expect(h.requests[0].body.prompt).toBe(original.prompt);
    expect(h.requests[0].body.product_images).toEqual([PRODUCT, DETAIL]);
    expect(h.requests[0].body.product_image).toBe("");
    expect(h.requests[0].body.reference_images).toEqual([]);
  });
  it.each(["ANALYZE_IMAGE", "BUILD_DETAIL_PROMPT"])("rejects scene payload on %s without any provider request", async type => {
    const h = backend();
    expect(await h.send({ type, config: configuration, payload: payload(h.contract) })).toMatchObject({ ok: false, code: "SCENE_ROUTE_CONFLICT" });
    expect(h.requests).toHaveLength(0);
  });
  it.each([
    { viralContractVersion: "VIRAL_SERIES_V3" }, { styleRefreshContractVersion: "STYLE_REFRESH_V10" },
    { referenceDetailBatch: { batchId: "foreign" } }, { guideContract: { operation: "replace-visible-text" } },
    { skuVisualLock: { version: "SKU_TEMPLATE_BATCH_V3" } }, { studioGenesisVersion: "foreign" },
    { creativeContractVersion: "foreign" }, { referenceImages: [PRODUCT] }, { visualTemplateImages: [PRODUCT] },
    { modelImages: [PRODUCT] }, { editBaseImage: PRODUCT }
  ])("rejects mixed route/source contracts %# before provider", async extras => {
    const h = backend();
    expect((await h.api.createImageTask(configuration, { ...payload(h.contract), ...extras })).ok).toBe(false);
    expect(h.requests).toHaveLength(0);
  });
  it.each([
    { sceneExtensionContractVersion: "foreign" }, { sceneTransportVersion: "foreign" }, { scenePlanSignature: "stale" }, { sceneShotId: "not-in-plan" },
    { count: 2 }, { size: "1024*1024" }, { productImages: [DETAIL, PRODUCT] }, { labMode: "main" }, { promptSource: "reference" }
  ])("rejects stale identities and changed originals/specifications %#", async changed => {
    const h = backend();
    expect((await h.api.createImageTask(configuration, { ...payload(h.contract), ...changed })).ok).toBe(false);
    expect(h.requests).toHaveLength(0);
  });
  it("only bypasses link knowledge for a completely validated scene contract", async () => {
    const h = backend();
    expect(await h.api.verifyKnowledgeBeforeImage(payload(h.contract))).toMatchObject({ ok: true, knowledgeMeta: { code: "scene_extension_scope" } });
    expect((await h.api.verifyKnowledgeBeforeImage({ promptSource: "scene-extension" })).ok).toBe(false);
    // Optional business knowledge no longer gates a saved link prompt (background
    // verifyKnowledgeBeforeImage); it must take the ordinary route, never the scene bypass.
    expect(await h.api.verifyKnowledgeBeforeImage({ labMode: "detail", detailMode: "link", promptSource: "link" })).toMatchObject({ ok: true, knowledgeMeta: { code: "prompt_input_scope", provider: "none" } });
    // Subject identity fingerprints remain a hard gate on that ordinary route.
    expect(await h.api.verifyKnowledgeBeforeImage({ labMode: "detail", detailMode: "link", promptSource: "link", subjectTaskId: "S-1" })).toMatchObject({ ok: false, code: "subject_binding_incomplete" });
    expect(h.requests).toHaveLength(0);
  });
  it("blocks a scene transport marker smuggled into the old reference knowledge bypass", async () => {
    const h = backend();
    expect(await h.api.verifyKnowledgeBeforeImage({ labMode: "detail", detailMode: "reference", promptSource: "reference", sceneTransportVersion: "foreign" })).toMatchObject({ ok: false, code: "SCENE_ROUTE_CONFLICT" });
    expect(h.requests).toHaveLength(0);
  });
  it.each(["case", "style-refresh"])("keeps the existing %s provider route and original-image fields intact", async route => {
    const h = backend(), style = route === "style-refresh";
    const viral = h.context.SZ_VIRAL_SERIES_CONTRACT as { config: { version: string } };
    const refresh = h.context.SZ_STYLE_REFRESH_CONTRACT as { version: string };
    const oldPayload = {
      labMode: "detail", detailMode: "reference", referenceMode: style ? "style-refresh" : "viral",
      generationRoute: style ? "style-refresh" : "viral-case", promptSource: style ? "style-refresh" : "reference",
      ...(style ? { styleRefreshContractVersion: refresh.version } : { viralContractVersion: viral.config.version }),
      productImages: [PRODUCT], referenceImages: style ? [] : [DETAIL], prompt: "existing route prompt",
      size: "1536*2048", ratio: "3:4", resolution: "2K", count: 1
    };
    expect((await h.api.createImageTask(configuration, oldPayload)).ok).toBe(true);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].body.product_image).toBe(PRODUCT);
    expect(h.requests[0].body.product_images).toEqual([PRODUCT]);
    expect(h.requests[0].body.reference_images).toEqual(style ? [] : [DETAIL]);
    expect(h.requests[0].body.prompt).toBe(oldPayload.prompt);
  });
  it.each(["none", "minimax-image", "zhipu-cogview"])("rejects unsupported reference adapter %s before dispatch", async adapter => {
    const h = backend();
    expect(await h.api.createImageTask({ ...configuration, imageAdapter: adapter }, payload(h.contract))).toMatchObject({ ok: false, code: "CONFIG_SCENE_REFERENCE_REQUIRED" });
    expect(h.requests).toHaveLength(0);
  });
  it("does not silently change scene resolution for a fixed-size Gemini model", async () => {
    const h = backend();
    expect((await h.api.createImageTask({ ...configuration, imageAdapter: "gemini-image", imageModel: "gemini-2.5-flash-image" }, payload(h.contract))).ok).toBe(false);
    expect(h.requests).toHaveLength(0);
  });
  it.each(providers)("revalidates and canonicalizes the $name provider entry", async entry => {
    const h = backend(), original = payload(h.contract), config = { ...configuration, imageAdapter: entry.adapter, imageModel: entry.model };
    expect((await h.api[entry.name](config, { ...original, prompt: "caller prompt override", negativePrompt: "", watermark: true })).ok).toBe(true);
    expect(h.requests).toHaveLength(1);
    const encoded = JSON.stringify(h.requests[0].body);
    expect(encoded).not.toContain("caller prompt override");
    if (entry.adapter === "openai-images") expect(h.requests[0].files).toBe(2);
    else expect(encoded).toContain(PRODUCT.split(",")[1]);
    expect((await h.api[entry.name](config, { ...original, scenePlanSignature: "stale" })).ok).toBe(false);
    expect(h.requests).toHaveLength(1);
  });
  it.each(providers)("rejects a cancelled scene at the $name entry without submitting", async entry => {
    const h = backend(), controller = new AbortController(), config = { ...configuration, imageAdapter: entry.adapter, imageModel: entry.model };
    h.api.activeJobs["cancelled-direct"] = controller; controller.abort();
    expect(await h.api[entry.name](config, { ...payload(h.contract), _jobId: "cancelled-direct" })).toMatchObject({ ok: false, code: "SCENE_CANCELLED_BEFORE_PROVIDER", definitiveFailure: true });
    expect(h.requests).toHaveLength(0);
  });
  it("dispatches a valid scene message with its original products and releases the job slot", async () => {
    const h = backend();
    expect((await h.send({ type: "GENERATE_IMAGE", jobId: "valid-scene", config: configuration, payload: payload(h.contract) })).ok).toBe(true);
    expect(h.requests[0].body.product_images).toEqual([PRODUCT, DETAIL]);
    expect(h.requests[0].body.product_image).toBe("");
    expect(Object.keys(h.api.activeJobs)).toHaveLength(0);
  });
  it("keeps the DashScope scene prompt unextended and rejects stale encoder inputs", () => {
    const h = backend(), original = payload(h.contract), config = { ...configuration, imageAdapter: "dashscope-wan" };
    const body = h.api.generationPayload(config, { ...original, prompt: "caller prompt override" });
    expect(body.parameters).toMatchObject({ n: 1, prompt_extend: false, watermark: false });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("caller prompt override");
    const input = body.input as { messages: Array<{ content: Array<{ text?: string }> }> };
    expect(input.messages[0].content.at(-1)?.text).toBe(original.prompt + "\nNegative prompt: " + original.negativePrompt);
    expect(h.api.generationPayload(config, { ...original, scenePlanSignature: "stale" })).toMatchObject({ ok: false, code: "SCENE_PLAN_STALE" });
  });
  it("matches outer and inner job identities before creating an active task", async () => {
    const h = backend();
    expect(await h.send({ type: "GENERATE_IMAGE", jobId: "outer", config: configuration, payload: { ...payload(h.contract), _jobId: "inner" } })).toMatchObject({ ok: false, code: "SCENE_JOB_ID_MISMATCH" });
    expect(Object.keys(h.api.activeJobs)).toHaveLength(0); expect(h.requests).toHaveLength(0);
  });
  it("honors immediate cancellation after the message controller was removed", async () => {
    const h = backend();
    const generated = h.send({ type: "GENERATE_IMAGE", jobId: "scene-immediate", config: configuration, payload: payload(h.contract) });
    expect(await h.send({ type: "CANCEL_GENERATION", jobId: "scene-immediate" })).toMatchObject({ ok: true, cancelled: true });
    expect(await generated).toMatchObject({ ok: false, code: "SCENE_CANCELLED_BEFORE_PROVIDER", definitiveFailure: true });
    expect(h.requests).toHaveLength(0);
  });
  it("preserves a captured AbortSignal across canonicalization after activeJobs deletion", async () => {
    const h = backend(), controller = new AbortController();
    h.api.activeJobs["scene-captured"] = controller;
    const generated = h.api.createImageTask(configuration, { ...payload(h.contract), _jobId: "scene-captured" });
    delete h.api.activeJobs["scene-captured"]; controller.abort();
    expect(await generated).toMatchObject({ ok: false, code: "SCENE_CANCELLED_BEFORE_PROVIDER" });
    expect(h.requests).toHaveLength(0);
  });
  it("propagates cancellation to an already dispatched provider without resubmitting", async () => {
    const h = backend({ hold: true });
    const generated = h.send({ type: "GENERATE_IMAGE", jobId: "scene-in-flight", config: configuration, payload: payload(h.contract) });
    for (let attempt = 0; attempt < 30 && !h.requests.length; attempt++) await new Promise(resolveTick => setTimeout(resolveTick, 1));
    expect(h.requests).toHaveLength(1);
    expect(await h.send({ type: "CANCEL_GENERATION", jobId: "scene-in-flight" })).toMatchObject({ ok: true, cancelled: true });
    expect(h.requests[0].signal?.aborted).toBe(true); h.release();
    expect((await generated).ok).toBe(false); expect(h.requests).toHaveLength(1);
  });
  it.each([{ status: 400, definitive: true, uncertain: false }, { status: 500, definitive: false, uncertain: true }])("classifies provider HTTP $status without assuming an unknown receipt is safe to retry", async entry => {
    const h = backend({ providerStatus: entry.status });
    expect(await h.api.createImageTask(configuration, payload(h.contract))).toMatchObject({ ok: false, definitiveFailure: entry.definitive, stateUncertain: entry.uncertain });
    expect(h.requests).toHaveLength(1);
  });
});
