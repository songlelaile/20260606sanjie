import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

type RuntimePayload = { assets: Array<{ id: string; libraryId?: string; dataUrl?: string; registrationKind?: string; portraitSessionId?: string }>; rightsConfirmed?: boolean; portraitSessionId?: string; idempotencyKey?: string };
type ProductionFixture = { buildPlan(request: unknown, options: unknown): { shots: Array<{ id: string; request: { images: Array<{ remoteUrl: string; registration?: unknown }> } }> } };
class Element {
  hidden = false; disabled = false; textContent = ""; className = ""; value = ""; src = ""; href = "";
  dataset: Record<string, string> = {}; children: Element[] = []; style = { display: "", setProperty: vi.fn() };
  parentElement?: Element;
  classList = { add: vi.fn(), toggle: vi.fn() };
  appendChild(node: Element) { this.children.push(node); return node; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
  querySelector() { return null; } querySelectorAll() { return []; }
  closest(selector: string) { return selector === ".upload-tile" ? new Element() : null; }
  setAttribute() {} addEventListener() {}
  scrollIntoView() {}
}
function harness(options: { timers?: boolean } = {}) {
  const root = "../../public/creative/labs/ecommerce-video-studio/";
  const html = readFileSync(new URL(root + "video-studio.html", import.meta.url), "utf8");
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  nodes.get("job-progress")!.parentElement = new Element();
  const record = { id: "original-image", kind: "image", name: "人物试穿.png", mimeType: "image/png", size: 4,
    width: 720, height: 1280, role: "person", blob: new Blob(["test"], { type: "image/png" }) };
  let draft: unknown = null;
  const store = { DB_NAME: "sz_ecommerce_video_studio", ASSET_STORE: "assets", getAsset: vi.fn(async () => record),
    saveDraft: vi.fn(async (_mode: string, data: unknown) => { draft = data; return { data }; }),
    getDraft: vi.fn(async () => ({ data: draft })), deleteAsset: vi.fn(), saveAsset: vi.fn(),
    upsertRun: vi.fn(async (run: unknown) => run), listRuns: vi.fn(async () => []) };
  const url = class extends URL { static createObjectURL() { return "blob:test-original"; } static revokeObjectURL() {} };
  const runtime = { sendMessage: vi.fn() };
  let clockMs = Date.now();
  const clock = options.timers ? Date : class extends Date { static now() { return clockMs; } };
  const context = vm.createContext({ console, URL: url, Blob, AbortController, Uint8Array, btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    Date: clock,
    setTimeout: options.timers ? setTimeout : (callback: () => void, delay: number) => { if (delay === 2000) Promise.resolve().then(() => { clockMs += delay; callback(); }); return 1; }, clearTimeout: options.timers ? clearTimeout : () => {},
    document: { readyState: "loading", addEventListener: vi.fn(), getElementById: (id: string) => nodes.get(id) ?? null,
      createElement: () => new Element(), querySelector: () => null, querySelectorAll: () => [] },
    CSS: { escape: (value: string) => value }, chrome: { runtime }, __SZ_VIDEO_STUDIO_EXPOSE_TESTING__: true, SZEcommerceVideoStore: store });
  for (const file of ["video-studio-contract.js", "video-production.js", "video-studio.js"]) vm.runInContext(readFileSync(new URL(root + file, import.meta.url), "utf8"), context);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The VM exposes a legacy untyped JS test API; runtime assertions below exercise its real implementation.
  const api = context.SZEcommerceVideoStudioTesting as any;
  api.cacheDom();
  Object.assign(api.state, { accountKey: "tenant:alice", backendConnected: true, credentialAvailable: true,
    capabilities: { provider: "doubao", adapter: "ark", assetReporting: { available: true, portraitAvailable: true } }, prompt: "展示白色西装细节", legacySingle: true });
  api.state.modelCatalog.find((model: { productKey: string }) => model.productKey === "seedance-2.0").configured = true;
  const imageData = { ...record, blob: undefined, storageRef: { dbName: store.DB_NAME, storeName: "assets", id: record.id }, previewUrl: "blob:test-original" };
  api.state.assets.image = vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify([imageData]))})`, context);
  const image = () => api.state.assets.image[0];
  function rights() { api.state.rightsConfirmed = true; api.state.rightsConfirmedAt = new Date().toISOString(); api.state.rightsFingerprint = api.assetRightsFingerprint(); }
  function respond(fn: (type: string, payload: RuntimePayload) => unknown) {
    runtime.sendMessage.mockImplementation((message: { type: string; payload: RuntimePayload }, done: (reply: unknown) => void) => done({ ok: true, payload: fn(message.type, message.payload) }));
  }
  const flatten = (node: Element): Element[] => [node, ...node.children.flatMap(flatten)];
  return { api, production: context.SZEcommerceVideoProduction as ProductionFixture, nodes, store, record, image, rights, respond, runtime, flatten };
}
const accountKey = "tenant:alice";
function reported(status: string, libraryId = "va_local_1") { return { accountKey, assets: [{ id: "original-image", libraryId, status, message: "供应商返回状态" }] }; }
afterEach(() => { vi.useRealTimers(); });

describe("explicit image classification and automatic supplier reporting", () => {
  it("keeps images unknown even when their usage role is person and blocks generation until explicit classification", async () => {
    const h = harness(); h.rights();
    expect(h.api.materialKind(h.image())).toBe("unknown");
    expect(h.api.validationErrors({ requireReview: true }).join(" ")).toContain("选择素材类型");
    await h.api.startGeneration(); expect(h.runtime.sendMessage).not.toHaveBeenCalled();
    expect(await h.api.setMaterialKind(h.image().id, "real")).toBe(true);
    expect(h.api.state.rightsConfirmed).toBe(false); expect(h.api.state.review.confirmed).toBe(false);
    expect(h.api.serializeAsset(h.image()).materialKind).toBe("real");
  });
  it("does not report ordinary images, including when the reporting service is unconfigured", async () => {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "ordinary"); h.rights();
    h.api.state.capabilities.assetReporting = { available: false };
    expect(await h.api.prepareVideoAssets()).toBe(true);
    expect(h.runtime.sendMessage).not.toHaveBeenCalled(); expect(h.store.getAsset).not.toHaveBeenCalled();
    expect(h.api.buildRequest("submit").images[0].storageRef.id).toBe(h.record.id);
  });
  it("requires fresh rights before submitting bytes and saves intent before the first runtime request", async () => {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "virtual");
    expect(await h.api.prepareVideoAssets()).toBe(false); expect(h.runtime.sendMessage).not.toHaveBeenCalled(); h.rights();
    h.respond((type, payload) => {
      expect(type).toBe("VIDEO_STUDIO_ASSET_PREPARE"); expect(payload.rightsConfirmed).toBe(true);
      expect(payload.assets[0]).toMatchObject({ id: h.record.id, registrationKind: "virtual", dataUrl: "data:image/png;base64,dGVzdA==" });
      const snapshot = h.store.saveDraft.mock.calls.at(-1)![1] as { assets: { image: Array<{ registration: unknown }> } };
      expect(snapshot.assets.image[0].registration).toMatchObject({ accountKey, status: "preparing", libraryId: "" });
      return reported("preparing");
    });
    expect(await h.api.prepareVideoAssets()).toBe(false);
    expect(h.image().registration.status).toBe("preparing"); expect(h.api.state.rightsConfirmed).toBe(true);
    expect(() => h.api.buildRequest("submit")).toThrow(/尚未.*确认可用/);
  });
  it("polls existing registration without resending the original image or creating another record", async () => {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "virtual"); h.rights(); h.respond(() => reported("preparing"));
    await h.api.prepareVideoAssets();
    h.respond((type, payload) => { expect(type).toBe("VIDEO_STUDIO_ASSET_PREPARE"); expect(payload.assets[0]).toMatchObject({ id: h.record.id, libraryId: "va_local_1", registrationKind: "virtual" });
      expect(payload.assets[0]).not.toHaveProperty("dataUrl"); return reported("active"); });
    expect(await h.api.prepareVideoAssets()).toBe(true); expect(h.store.getAsset).toHaveBeenCalledTimes(1);
    expect(h.api.assetForRequest(h.image())).toMatchObject({ remoteUrl: "library://va_local_1", storageRef: null, registration: { accountKey, status: "active", registrationKind: "virtual" } });
    expect(h.image().storageRef.id).toBe(h.record.id); expect(h.image().previewUrl).toBe("blob:test-original");
    expect(await h.api.prepareVideoAssets()).toBe(true); expect(h.runtime.sendMessage).toHaveBeenCalledTimes(3); expect(h.store.getAsset).toHaveBeenCalledTimes(1);
  });
  it("keeps uncertain responses non-active and subsequent lookup has no data URL even before an ID was returned", async () => {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "virtual"); h.rights();
    h.runtime.sendMessage.mockImplementation((_message, done) => done({ ok: false, error: { code: "STATE_UNCERTAIN", message: "供应商响应待核对" } }));
    expect(await h.api.prepareVideoAssets()).toBe(false); expect(h.image().registration.status).toBe("uncertain");
    h.respond((_type, payload) => { expect(payload.assets[0]).not.toHaveProperty("dataUrl"); expect(payload.assets[0].id).toBe(h.record.id); return reported("preparing"); });
    await h.api.prepareVideoAssets(); expect(h.store.getAsset).toHaveBeenCalledTimes(1);
  });
  it("resumes a first upload only when the service explicitly proves the pending portrait was never submitted", async () => {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "real"); h.rights();
    h.api.state.portraitAuthorization = { accountKey, sessionId: "vv_actor", status: "pending", url: "https://console.volcengine.com/auth" };
    h.respond(() => ({ accountKey, assets: [{ id: h.record.id, status: "needs_authorization", uploadRequired: true, providerSubmitted: false }] }));
    expect(await h.api.prepareVideoAssets()).toBe(false); expect(h.image().registration).toBeUndefined();
    h.respond((_type, payload) => { expect(payload.assets[0].dataUrl).toBe("data:image/png;base64,dGVzdA=="); return reported("active"); });
    expect(await h.api.prepareVideoAssets()).toBe(true);
  });
  it.each([
    { code: "ASSET_RATE_LIMIT", details: { uploadRequired: true, providerSubmitted: false }, clear: true },
    { code: "HUMAN_GROUP_UNVERIFIED", details: { uploadRequired: true, providerSubmitted: false }, clear: true },
    { code: "VALIDATION_NOT_FOUND", details: { uploadRequired: true, providerSubmitted: false }, clear: true },
    { code: "MATERIAL_TYPE_REQUIRED", details: { uploadRequired: true, providerSubmitted: false }, clear: true },
    { code: "ASSET_RATE_LIMIT", details: { uploadRequired: true }, clear: false },
    { code: "ASSET_RATE_LIMIT", details: { providerSubmitted: false }, clear: false },
    { code: "STATE_UNCERTAIN", details: { uploadRequired: true, providerSubmitted: false }, clear: false },
  ])("requires a safe code and both not-submitted proofs for error recovery: $code $details", async ({ code, details, clear }) => {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "virtual"); h.rights();
    h.runtime.sendMessage.mockImplementation((_message, done) => done({ ok: false, error: { code, message: "素材请求未完成", details } }));
    expect(await h.api.prepareVideoAssets()).toBe(false); expect(h.image().registration === undefined).toBe(clear);
    h.respond((_type, payload) => { expect(typeof payload.assets[0].dataUrl === "string").toBe(clear); return reported("preparing"); });
    await h.api.prepareVideoAssets();
  });
  it("does not clear other pictures when one item in a batch is definitively rejected before upload", async () => {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "virtual");
    h.api.state.assets.image.push({ ...h.image(), id: "second-image", storageRef: { ...h.image().storageRef, id: "second-image" } }); h.rights();
    h.runtime.sendMessage.mockImplementation((_message, done) => done({ ok: false, error: { code: "ASSET_RATE_LIMIT", message: "频率限制", details: { uploadRequired: true, providerSubmitted: false, assetId: "second-image" } } }));
    expect(await h.api.prepareVideoAssets()).toBe(false);
    expect(h.api.state.assets.image[0].registration.status).toBe("uncertain"); expect(h.api.state.assets.image[1].registration).toBeUndefined();
  });
  it("rechecks previously Active records and blocks a now-expired or revoked binding without uploading again", async () => {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "virtual"); h.rights(); h.respond(() => reported("active"));
    expect(await h.api.prepareVideoAssets()).toBe(true);
    h.respond((_type, payload) => { expect(payload.assets[0]).not.toHaveProperty("dataUrl"); return reported("failed"); });
    expect(await h.api.prepareVideoAssets()).toBe(false); expect(h.image().registration.status).toBe("failed");
    expect(() => h.api.buildRequest("submit")).toThrow(/尚未.*确认可用/); expect(h.store.getAsset).toHaveBeenCalledTimes(1);
  });
  it("does not send the original if the current account changes while reading local bytes", async () => {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "virtual"); h.rights();
    h.store.getAsset.mockImplementation(async () => { h.api.state.accountKey = "tenant:bob"; return h.record; });
    expect(await h.api.prepareVideoAssets()).toBe(false); expect(h.runtime.sendMessage).not.toHaveBeenCalled();
    expect(h.image().registration).toBeUndefined();
  });
  it.each(["preparing", "needs_authorization", "failed", "uncertain"])("does not create a video request while reported status is %s", async status => {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "virtual"); h.rights(); h.respond(() => reported(status));
    await h.api.startGeneration(); expect(h.runtime.sendMessage.mock.calls.every(([m]) => m.type === "VIDEO_STUDIO_ASSET_PREPARE")).toBe(true);
    expect(h.runtime.sendMessage).toHaveBeenCalledTimes(status === "preparing" ? 30 : 1);
    expect(() => h.api.buildRequest("submit")).toThrow(/尚未.*确认可用/); expect(h.api.state.activeRun).toBeNull();
  });
  it("requires an explicit actor-authentication action before reporting a real portrait, and reuses its durable idempotency key", async () => {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "real"); h.rights();
    expect(await h.api.prepareVideoAssets()).toBe(false); expect(h.runtime.sendMessage).not.toHaveBeenCalled();
    h.respond(type => { expect(type).toBe("VIDEO_STUDIO_PORTRAIT_START"); return { accountKey, authorization: { sessionId: "session-1", url: "https://console.volcengine.com/portrait/authorization", status: "pending" } }; });
    expect(await h.api.startPortraitAuthorization()).toBe(true); const firstKey = h.runtime.sendMessage.mock.calls[0][0].payload.idempotencyKey;
    expect(firstKey).toMatch(/^portrait-/); expect(await h.api.startPortraitAuthorization()).toBe(true);
    expect(h.runtime.sendMessage.mock.calls[1][0].payload.idempotencyKey).toBe(firstKey);
    expect(h.api.draftSnapshot().portraitStartRequest.idempotencyKey).toBe(firstKey);
    const link = h.flatten(h.nodes.get("asset-list")!).find(node => node.href);
    expect(link?.href).toBe("https://console.volcengine.com/portrait/authorization");
    expect(h.image().registration).toBeUndefined();
    h.respond((_type, payload) => { expect(payload.portraitSessionId).toBe("session-1"); expect(payload.assets[0].portraitSessionId).toBe("session-1"); return reported("needs_authorization"); });
    expect(await h.api.prepareVideoAssets()).toBe(false); expect(h.image().registration.status).toBe("needs_authorization");
  });
  it.each(["expired", "failed"])("only explicit user restart replaces a server-confirmed %s session, and unknown restart keeps the replacement key", async status => {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "real");
    h.respond(() => ({ accountKey, authorization: { sessionId: "vv_old", status } }));
    expect(await h.api.startPortraitAuthorization()).toBe(false); const firstKey = h.api.state.portraitStartRequest.idempotencyKey;
    h.api.renderAssets(); expect(h.flatten(h.nodes.get("asset-list")!).some(node => node.dataset.portraitRestart && node.textContent === "重新创建本人认证链接")).toBe(true);
    h.runtime.sendMessage.mockImplementation((_message, done) => done({ ok: false, error: { code: "STATE_UNCERTAIN", message: "认证创建响应未知" } }));
    expect(await h.api.restartPortraitAuthorization()).toBe(false); const replacementKey = h.api.state.portraitStartRequest.idempotencyKey;
    expect(replacementKey).not.toBe(firstKey); expect(h.api.state.portraitAuthorization.status).toBe("uncertain");
    expect(await h.api.restartPortraitAuthorization()).toBe(false); expect(h.api.state.portraitStartRequest.idempotencyKey).toBe(replacementKey);
    await h.api.startPortraitAuthorization(); expect(h.runtime.sendMessage.mock.calls.at(-1)![0].payload.idempotencyKey).toBe(replacementKey);
  });
  it("does not accept another tenant's reporting response or submit an active binding after an account switch", async () => {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "virtual"); h.rights();
    h.respond(() => ({ ...reported("active"), accountKey: "tenant:bob" }));
    expect(await h.api.prepareVideoAssets()).toBe(false); expect(h.image().registration.status).toBe("uncertain");
    h.image().registration.status = "active"; h.image().registration.libraryId = "va_local_1"; h.api.state.accountKey = "tenant:bob";
    expect(() => h.api.assetForRequest(h.image())).toThrow(/原账号/);
    expect(await h.api.prepareVideoAssets()).toBe(false); expect(h.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, { available: false }, { available: false, message: "当前账号未配置自动报备" }])("fails closed without configured reporting capability %j", async reporting => {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "real"); h.rights(); h.api.state.capabilities.assetReporting = reporting;
    expect(await h.api.prepareVideoAssets()).toBe(false); expect(await h.api.startPortraitAuthorization()).toBe(false);
    h.api.renderAssets(); expect(h.flatten(h.nodes.get("asset-list")!).filter(node => node.dataset.prepareAsset || node.dataset.portraitStart).every(node => node.disabled)).toBe(true);
    expect(h.flatten(h.nodes.get("asset-list")!).some(node => node.href === "/management/video-materials")).toBe(true);
    expect(h.runtime.sendMessage).not.toHaveBeenCalled();
  });
  it("uses explicit server reporting capability for native accounts while manual Ark references remain unavailable", async () => {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "virtual"); h.rights();
    h.api.state.capabilities.provider = "shaozhuang-native"; h.api.state.capabilities.adapter = "sanjie-native"; h.api.state.credentialAvailable = false;
    h.api.state.modelCatalog.find((model: { productKey: string }) => model.productKey === "seedance-2.0").nativePlatform = true;
    expect(h.api.personalArkPortraitAvailable()).toBe(false); expect(h.api.assetReportingAvailable()).toBe(true);
    h.respond(() => reported("active")); expect(await h.api.prepareVideoAssets()).toBe(true);
    expect(h.api.assetForRequest(h.image()).remoteUrl).toBe("library://va_local_1");
  });
  it("persists account-bound registration beside the original and keeps library references out of analysis and img src", async () => {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "virtual"); h.rights(); h.respond(() => reported("active")); await h.api.prepareVideoAssets();
    const summary = h.api.serializeAsset(h.image()), restored = await h.api.hydrateAsset(summary);
    expect(restored.registration).toEqual(summary.registration); expect(restored.storageRef.id).toBe(h.record.id); expect(restored.previewUrl).toBe("blob:test-original");
    h.api.renderAssets(); expect(h.flatten(h.nodes.get("asset-list")!).some(node => node.src.startsWith("library:"))).toBe(false);
    const analysis = h.api.buildRequest("draft"); expect(analysis.images[0].storageRef.id).toBe(h.record.id);
    expect(JSON.stringify(analysis)).not.toContain("library://"); expect(analysis.images[0].registration).toBeNull();
    expect(h.api.buildRequest("submit").images[0]).toMatchObject({ remoteUrl: "library://va_local_1", registration: { accountKey, libraryId: "va_local_1", status: "active" } });
    expect(h.store.deleteAsset).not.toHaveBeenCalled();
  });
  it("carries active library metadata into all three default production shots while local composition still reads the original", async () => {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "virtual"); h.rights(); h.respond(() => reported("active")); await h.api.prepareVideoAssets();
    h.api.state.legacySingle = false; h.api.state.productionOptions = { mode: "quality", totalDurationSeconds: 15, hybridAiSeconds: 0, budgetYuan: 17, maxAttempts: 1 };
    const plan = h.production.buildPlan(h.api.productionTemplate({ confirmed: true }), h.api.state.productionOptions);
    expect(plan.shots).toHaveLength(3);
    for (const shot of plan.shots) expect(shot.request.images[0]).toMatchObject({ remoteUrl: "library://va_local_1", storageRef: null, registration: { accountKey, status: "active" } });
    const source = await h.api.productionSourceAsset({ accountKey, plan }, h.record.id);
    expect(source.blob).toBe(h.record.blob); expect(h.image().previewUrl).toBe("blob:test-original");
    expect(h.api.productionValidationErrors({ requireReview: true })).toEqual([]);
  });
  it("stops the default production flow before persisting or submitting shots until preparation is active", async () => {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "virtual"); h.rights(); h.respond(() => reported("preparing"));
    h.api.state.legacySingle = false; h.api.state.productionOptions = { mode: "quality", totalDurationSeconds: 15, hybridAiSeconds: 0, budgetYuan: 17, maxAttempts: 1 };
    await h.api.startProductionGeneration(); expect(h.runtime.sendMessage.mock.calls.every(([m]) => m.type === "VIDEO_STUDIO_ASSET_PREPARE")).toBe(true);
    expect(h.runtime.sendMessage).toHaveBeenCalledTimes(30);
    expect(h.store.upsertRun).not.toHaveBeenCalled(); expect(h.api.state.productionRun).toBeNull();
  });
  it("automatically polls only the original library ID and continues the same generation once Active", async () => {
    vi.useFakeTimers(); const h = harness({ timers: true }); await h.api.setMaterialKind(h.image().id, "virtual"); h.rights();
    let preparations = 0;
    h.runtime.sendMessage.mockImplementation((message, done) => {
      if (message.type === "VIDEO_STUDIO_ASSET_PREPARE") {
        preparations += 1;
        if (preparations > 1) { expect(message.payload.assets[0].libraryId).toBe("va_local_1"); expect(message.payload.assets[0]).not.toHaveProperty("dataUrl"); }
        done({ ok: true, payload: reported(preparations === 1 ? "preparing" : "active") });
      } else { expect(message.type).toBe("VIDEO_STUDIO_START"); expect(message.payload.request.images[0].remoteUrl).toBe("library://va_local_1"); done({ ok: false, error: { code: "TEST_STOP", message: "fixture stops after the only video submission" } }); }
    });
    const generating = h.api.startGeneration(); await vi.advanceTimersByTimeAsync(0);
    expect(h.runtime.sendMessage).toHaveBeenCalledTimes(1); expect(h.api.state.assetPreparing).toBe(true);
    await vi.advanceTimersByTimeAsync(2000); await generating;
    expect(h.runtime.sendMessage.mock.calls.map(([message]) => message.type)).toEqual(["VIDEO_STUDIO_ASSET_PREPARE", "VIDEO_STUDIO_ASSET_PREPARE", "VIDEO_STUDIO_START"]);
    expect(h.store.getAsset).toHaveBeenCalledTimes(1); expect(h.api.state.assetPreparing).toBe(false);
  });
  it("stops automatic polling within 60 seconds and retains the original pending registration", async () => {
    vi.useFakeTimers(); const h = harness({ timers: true }); await h.api.setMaterialKind(h.image().id, "virtual"); h.rights(); h.respond(() => reported("preparing"));
    const preparing = h.api.prepareVideoAssets({ pollUntilReady: true }); await vi.advanceTimersByTimeAsync(60000);
    expect(await preparing).toBe(false); expect(h.image().registration).toMatchObject({ libraryId: "va_local_1", status: "preparing" });
    const messages = h.runtime.sendMessage.mock.calls.map(([message]) => message);
    expect(messages).toHaveLength(30); expect(messages.slice(1).every(message => message.payload.assets[0].libraryId === "va_local_1" && !message.payload.assets[0].dataUrl)).toBe(true);
    await vi.advanceTimersByTimeAsync(60000); expect(h.runtime.sendMessage).toHaveBeenCalledTimes(30); expect(h.store.getAsset).toHaveBeenCalledTimes(1);
  });
  it.each(["account", "material"])("stops automatic polling when %s changes while waiting", async changed => {
    vi.useFakeTimers(); const h = harness({ timers: true }); await h.api.setMaterialKind(h.image().id, "virtual"); h.rights(); h.respond(() => reported("preparing"));
    const preparing = h.api.prepareVideoAssets({ pollUntilReady: true }); await vi.advanceTimersByTimeAsync(0);
    if (changed === "account") h.api.state.accountKey = "tenant:bob"; else h.image().materialKind = "real";
    await vi.advanceTimersByTimeAsync(2000); expect(await preparing).toBe(false); expect(h.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.image().registration.libraryId).toBe("va_local_1");
  });
  it("retains manual trusted-portrait compatibility without sending the raw portrait to the automatic service", async () => {
    const h = harness(); await h.api.associateTrustedPortrait(h.image().id, "asset-existing-person"); h.rights();
    expect(h.api.materialKind(h.image())).toBe("real"); expect(await h.api.prepareVideoAssets()).toBe(true);
    expect(h.api.buildRequest("submit").images[0].remoteUrl).toBe("asset://asset-existing-person"); expect(h.runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe("failed production plan source-change notice", () => {
  async function failedPlan() {
    const h = harness(); await h.api.setMaterialKind(h.image().id, "ordinary");
    h.api.state.assets.image.push({ ...h.image(), id: "second-image" }); h.rights();
    h.api.state.legacySingle = false;
    h.api.state.productionOptions = { mode: "quality", totalDurationSeconds: 15, hybridAiSeconds: 0, budgetYuan: 17, maxAttempts: 1 };
    const plan = h.production.buildPlan(h.api.productionTemplate({ confirmed: true }), h.api.state.productionOptions);
    const run = { id: "old-plan", purpose: "production", accountKey, status: "failed", durationSeconds: 15, plan,
      shotRuns: plan.shots.map((shot, index) => ({ id: shot.id, status: index === 0 ? "failed" : "pending", attempts: [] })) };
    h.api.state.productionRun = run;
    return { ...h, run };
  }
  it("warns prominently when current images differ without changing the old snapshot or either action", async () => {
    const h = await failedPlan(), before = JSON.stringify(h.run);
    h.api.state.assets.image = []; h.api.renderProductionRun();
    expect(h.nodes.get("production-new-plan-help")!.textContent).toBe("当前素材已变更，旧计划仍使用提交时的素材。请先点『新建成片计划』，再生成。");
    expect(h.nodes.get("production-new-plan-help")!.className).toBe("inline-notice is-error");
    expect(h.nodes.get("production-new-plan-help")!.hidden).toBe(false);
    expect(h.nodes.get("production-resume")!.disabled).toBe(false); expect(h.nodes.get("production-new-plan")!.hidden).toBe(false);
    expect(h.api.state.productionRun).toBe(h.run); expect(JSON.stringify(h.run)).toBe(before); expect(h.run).not.toHaveProperty("newPlanRequestedAt");
    expect(h.runtime.sendMessage).not.toHaveBeenCalled();
  });
  it("compares sets rather than order, ignores deselected images, and clears an earlier warning when the original selection is restored", async () => {
    const h = await failedPlan(), original = [...h.api.state.assets.image];
    h.api.state.assets.image = []; h.api.renderProductionRun();
    h.api.state.assets.image = [original[1], original[0], { ...original[0], id: "deselected-extra", selected: false }];
    h.api.renderProductionRun();
    expect(h.nodes.get("production-new-plan-help")!.className).toBe("section-note");
    expect(h.nodes.get("production-new-plan-help")!.textContent).not.toContain("当前素材已变更");
  });
  it("does not suggest replacing a plan containing successful, processing, or unknown shots", async () => {
    const h = await failedPlan(); h.api.state.assets.image = [];
    for (const status of ["succeeded", "processing", "unknown"]) {
      h.run.shotRuns[0].status = status; h.api.renderProductionRun();
      expect(h.nodes.get("production-new-plan-help")!.hidden).toBe(true);
      expect(h.nodes.get("production-new-plan-help")!.textContent).not.toContain("当前素材已变更");
      expect(h.nodes.get("production-new-plan")!.hidden).toBe(true); expect(h.api.state.productionRun).toBe(h.run);
    }
  });
});
