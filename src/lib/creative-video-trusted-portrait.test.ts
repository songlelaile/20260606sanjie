import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Node {
  hidden = false; disabled = false; textContent = ""; className = ""; value = ""; src = "";
  dataset: Record<string, string> = {}; children: Node[] = []; style = { display: "", setProperty: vi.fn() };
  classList = { add: vi.fn(), toggle: vi.fn() };
  appendChild(node: Node) { this.children.push(node); return node; }
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
  querySelector() { return null; } querySelectorAll() { return []; }
  closest(selector: string) { return selector === ".upload-tile" ? new Node() : null; }
  setAttribute() {} addEventListener() {}
}
function harness() {
  const root = "../../public/creative/labs/ecommerce-video-studio/";
  const html = readFileSync(new URL(root + "video-studio.html", import.meta.url), "utf8");
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Node()]));
  const record = { id: "original-image", kind: "image", name: "人物试穿.png", mimeType: "image/png", size: 4,
    width: 720, height: 1280, role: "person", blob: new Blob(["test"], { type: "image/png" }) };
  const store = { DB_NAME: "sz_ecommerce_video_studio", ASSET_STORE: "assets", getAsset: vi.fn(async () => record),
    saveDraft: vi.fn(async (_mode: string, data: unknown) => ({ data })), deleteAsset: vi.fn(), saveAsset: vi.fn() };
  const url = class extends URL { static createObjectURL() { return "blob:test-original"; } static revokeObjectURL() {} };
  const runtime = { sendMessage: vi.fn() };
  const context = vm.createContext({ console, URL: url, Blob, AbortController, setTimeout: () => 1, clearTimeout: () => {},
    document: { readyState: "loading", addEventListener: vi.fn(), getElementById: (id: string) => nodes.get(id) ?? null,
      createElement: () => new Node(), querySelector: () => null, querySelectorAll: () => [] },
    CSS: { escape: (value: string) => value }, chrome: { runtime },
    __SZ_VIDEO_STUDIO_EXPOSE_TESTING__: true, SZEcommerceVideoStore: store });
  for (const file of ["video-studio-contract.js", "video-production.js", "video-studio.js"]) {
    vm.runInContext(readFileSync(new URL(root + file, import.meta.url), "utf8"), context);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- This test boundary loads the untyped browser API from a separate VM realm.
  const api = context.SZEcommerceVideoStudioTesting as any;
  api.cacheDom();
  Object.assign(api.state, { accountKey: "tenant:alice", backendConnected: true, credentialAvailable: true,
    capabilities: { provider: "doubao", adapter: "ark" }, prompt: "展示白色西装细节", legacySingle: true });
  api.state.modelCatalog.find((model: { productKey: string }) => model.productKey === "seedance-2.0").configured = true;
  api.state.assets.image = vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify([{ ...record, blob: undefined,
    storageRef: { dbName: store.DB_NAME, storeName: "assets", id: record.id }, previewUrl: "blob:test-original" }]))})`, context);
  const image = () => api.state.assets.image[0];
  const allNodes = (node: Node): Node[] => [node, ...node.children.flatMap(allNodes)];
  async function refresh(payload: Record<string, unknown>) {
    runtime.sendMessage.mockImplementation((message: { type: string }, done: (reply: unknown) => void) => {
      expect(message.type).toBe("VIDEO_STUDIO_CAPABILITIES"); done({ ok: true, payload });
    });
    await api.refreshCapabilities();
  }
  const production = context.SZEcommerceVideoProduction as {
    buildPlan(input: unknown, options: unknown): { shots: Array<{ request: { images: Array<{ remoteUrl: string; storageRef: { id: string } | null }> }; sourceAssetId: string }> };
  };
  return { api, production, nodes, store, record, image, allNodes, runtime, refresh };
}

describe("explicit trusted Ark portrait references", () => {
  function capabilityPayload(overrides: Record<string, unknown> = {}) {
    return { accountKey: "tenant:alice", provider: "doubao", adapter: "ark", credentialAvailable: true,
      capabilities: { remoteAssets: true, localAssets: ["image", "audio"] }, models: [{ productKey: "seedance-2.0",
        providerModel: "doubao-seedance-2-0-260128", configured: true, providerModelConfigured: true }], ...overrides };
  }
  it("enables association after the real capability refresh consumes the nested website response envelope", async () => {
    const h = harness(); h.api.state.capabilities = null; h.api.state.credentialAvailable = null;
    await h.refresh(capabilityPayload());
    expect(h.api.state.backendConnected).toBe(true);
    expect(h.api.state.capabilities).toMatchObject({ provider: "doubao", adapter: "ark", remoteAssets: true, localAssets: ["image", "audio"] });
    const button = h.allNodes(h.nodes.get("asset-list")!).find(node => node.dataset.trustedPortraitAsset);
    expect(button?.disabled).toBe(false); expect(h.api.personalArkPortraitAvailable()).toBe(true);
  });
  it.each([false, undefined])("keeps missing credential state %s disabled after a real nested-envelope refresh", async credentialAvailable => {
    const h = harness(); await h.refresh(capabilityPayload({ credentialAvailable }));
    const button = h.allNodes(h.nodes.get("asset-list")!).find(node => node.dataset.trustedPortraitAsset);
    expect(button?.disabled).toBe(true); expect(h.api.personalArkPortraitAvailable()).toBe(false);
  });
  it("retains native provider identity even if nested capabilities contain another provider", async () => {
    const h = harness(); await h.refresh(capabilityPayload({ provider: "shaozhuang-native",
      capabilities: { provider: "doubao", adapter: "ark", remoteAssets: true }, models: [{ id: "seedance-2.0",
        providerModel: "seedance-2.0", configured: true, nativePlatform: true, limits: { durations: [5], resolutions: ["720p"], ratios: ["9:16"] } }] }));
    expect(h.api.state.capabilities.provider).toBe("shaozhuang-native");
    const button = h.allNodes(h.nodes.get("asset-list")!).find(node => node.dataset.trustedPortraitAsset);
    expect(button?.disabled).toBe(true); expect(h.api.personalArkPortraitAvailable()).toBe(false);
  });
  it("clears a previously enabled portrait capability when the real refresh fails", async () => {
    const h = harness(); await h.refresh(capabilityPayload());
    h.runtime.sendMessage.mockImplementation((_message, done) => done({ ok: false, error: { code: "TEST_ONLY_UNAVAILABLE", message: "test offline" } }));
    await h.api.refreshCapabilities();
    expect(h.api.state.backendConnected).toBe(false); expect(h.api.state.capabilities).toBeNull();
    expect(h.api.state.credentialAvailable).toBeNull();
    const button = h.allNodes(h.nodes.get("asset-list")!).find(node => node.dataset.trustedPortraitAsset);
    expect(button?.disabled).toBe(true); expect(h.api.personalArkPortraitAvailable()).toBe(false);
  });
  it.each(["asset-20261018000000-test", "asset://asset-20261018000000-test"])("accepts only the canonical asset ID form: %s", value => {
    expect(harness().api.normalizeTrustedPortraitUri(value)).toBe("asset://asset-20261018000000-test");
  });
  it.each(["asset://asset-ok?token=x", "asset://asset-ok#fragment", "asset://user:password@asset-ok", "https://example.com/asset-ok", "portrait_asset://asset-ok", " asset-ok", "asset-ok ", "asset://asset-ok/path", "asset://asset-%20", "asset-"])("rejects unsafe or unsupported references: %s", value => {
    expect(harness().api.normalizeTrustedPortraitUri(value)).toBe("");
  });

  it("associates only a generation reference and resets approval without uploading or deleting the original", async () => {
    const h = harness(); const before = { ...h.image() }; h.api.state.rightsConfirmed = true;
    expect(await h.api.associateTrustedPortrait(before.id, "asset-person-approved")).toBe(true);
    expect(h.image()).toMatchObject({ storageRef: before.storageRef, previewUrl: before.previewUrl,
      trustedPortrait: { uri: "asset://asset-person-approved", accountKey: "tenant:alice" } });
    expect(h.api.state.rightsConfirmed).toBe(false);
    expect(h.api.assetForRequest(h.image())).toMatchObject({ remoteUrl: "asset://asset-person-approved", storageRef: null });
    expect(h.store.saveDraft).toHaveBeenCalledTimes(1);
    expect(h.store.deleteAsset).not.toHaveBeenCalled(); expect(h.store.saveAsset).not.toHaveBeenCalled();
    const rendered = h.allNodes(h.nodes.get("asset-list")!);
    expect(rendered.map(node => node.textContent).join(" ")).toContain("已填写素材引用，实际可用性由火山方舟校验");
    expect(rendered.some(node => node.src.startsWith("asset:"))).toBe(false);
  });

  it("persists the reference beside the original storage key and restores an original-blob preview", async () => {
    const h = harness(); await h.api.associateTrustedPortrait(h.image().id, "asset-person-approved");
    const saved = h.api.serializeAsset(h.image());
    expect(saved.remoteUrl).toBe(""); expect(saved.storageRef.id).toBe(h.record.id);
    const restored = await h.api.hydrateAsset(saved);
    expect(restored.previewUrl).toBe("blob:test-original"); expect(restored.trustedPortrait).toEqual(saved.trustedPortrait);
    expect(h.api.assetForRequest(restored).remoteUrl).toBe("asset://asset-person-approved");
    expect(h.store.getAsset).toHaveBeenCalledWith(h.record.id);
  });

  it("keeps asset URIs out of script analysis while generation uses the trusted URI", async () => {
    const h = harness(); await h.api.associateTrustedPortrait(h.image().id, "asset-person-approved");
    const analysis = h.api.buildRequest("draft");
    expect(analysis.images[0]).toMatchObject({ remoteUrl: "", storageRef: { id: h.record.id } });
    expect(JSON.stringify(analysis)).not.toContain("asset://");
    expect(h.api.assetForRequest(h.image()).remoteUrl).toBe("asset://asset-person-approved");
    h.api.state.rightsConfirmed = true; h.api.state.rightsConfirmedAt = new Date().toISOString();
    h.api.state.rightsFingerprint = h.api.assetRightsFingerprint();
    expect(h.api.buildRequest("submit").images[0].remoteUrl).toBe("asset://asset-person-approved");
  });

  it("restores the original reference without deleting media and requires rights confirmation again", async () => {
    const h = harness(); await h.api.associateTrustedPortrait(h.image().id, "asset-person-approved");
    const associatedFingerprint = h.api.assetRightsFingerprint(); h.api.state.rightsConfirmed = true;
    expect(await h.api.associateTrustedPortrait(h.image().id, null)).toBe(true);
    expect(h.image().trustedPortrait).toBeUndefined(); expect(h.image().previewUrl).toBe("blob:test-original");
    expect(h.api.assetForRequest(h.image())).toMatchObject({ remoteUrl: "", storageRef: { id: h.record.id } });
    expect(h.api.state.rightsConfirmed).toBe(false); expect(h.api.assetRightsFingerprint()).not.toBe(associatedFingerprint);
    expect(h.store.deleteAsset).not.toHaveBeenCalled();
  });

  it("carries only the trusted URI into every AI shot of the default production plan", async () => {
    const h = harness(); await h.api.associateTrustedPortrait(h.image().id, "asset-person-approved");
    h.api.state.legacySingle = false;
    h.api.state.productionOptions = { mode: "quality", totalDurationSeconds: 15, hybridAiSeconds: 0, budgetYuan: 17, maxAttempts: 1 };
    h.api.state.rightsConfirmed = true; h.api.state.rightsConfirmedAt = new Date().toISOString();
    h.api.state.rightsFingerprint = h.api.assetRightsFingerprint();
    const plan = h.production.buildPlan(h.api.productionTemplate({ confirmed: true }), h.api.state.productionOptions);
    expect(plan.shots).toHaveLength(3);
    for (const shot of plan.shots) {
      expect(shot.request.images[0]).toMatchObject({ remoteUrl: "asset://asset-person-approved", storageRef: null });
      expect(JSON.stringify(shot.request)).not.toContain("blob:test-original");
    }
    expect(h.image().storageRef.id).toBe(h.record.id); expect(h.image().previewUrl).toBe("blob:test-original");
    expect(h.api.buildRequest("draft").images[0].storageRef.id).toBe(h.record.id);
  });

  it("keeps the original local blob available to composition and rejects stale rights after association", async () => {
    const h = harness(); h.api.state.legacySingle = false;
    h.api.state.productionOptions = { mode: "quality", totalDurationSeconds: 15, hybridAiSeconds: 0, budgetYuan: 17, maxAttempts: 1 };
    h.api.state.rightsConfirmed = true; h.api.state.rightsConfirmedAt = new Date().toISOString();
    const before = h.api.assetRightsFingerprint(); h.api.state.rightsFingerprint = before;
    await h.api.associateTrustedPortrait(h.image().id, "asset-person-approved");
    expect(h.api.productionValidationErrors({ requireReview: true }).join(" ")).toContain("素材权利");
    h.api.state.rightsConfirmed = true; h.api.state.rightsConfirmedAt = new Date().toISOString(); h.api.state.rightsFingerprint = before;
    expect(h.api.productionValidationErrors({ requireReview: true }).join(" ")).toContain("素材权利");
    h.api.state.rightsFingerprint = h.api.assetRightsFingerprint();
    expect(h.api.productionValidationErrors({ requireReview: true })).toEqual([]);
    h.api.state.productionOptions.mode = "economic";
    const plan = h.production.buildPlan(h.api.productionTemplate({ confirmed: true }), h.api.state.productionOptions);
    const local = await h.api.productionSourceAsset({ accountKey: "tenant:alice", plan }, plan.shots[0].sourceAssetId);
    expect(local.blob).toBe(h.record.blob); expect(h.store.getAsset).toHaveBeenCalledWith(h.record.id);
    expect(h.image().trustedPortrait.uri).toBe("asset://asset-person-approved");
    expect(h.store.deleteAsset).not.toHaveBeenCalled(); expect(h.store.saveAsset).not.toHaveBeenCalled();
  });

  it("invalidates a confirmed assisted script on association and restoration", async () => {
    const h = harness(); h.api.state.mode = "assist"; h.api.state.review.state = "confirmed";
    h.api.state.review.confirmed = true; h.api.state.review.script = "已确认脚本";
    await h.api.associateTrustedPortrait(h.image().id, "asset-person-approved");
    expect(h.api.state.review).toMatchObject({ state: "stale", confirmed: false, confirmedAt: "" });
    h.api.state.review.state = "confirmed"; h.api.state.review.confirmed = true;
    await h.api.associateTrustedPortrait(h.image().id, null);
    expect(h.api.state.review).toMatchObject({ state: "stale", confirmed: false });
  });

  it("disables platform associations and blocks existing references after a platform/account switch", async () => {
    const h = harness(); await h.api.associateTrustedPortrait(h.image().id, "asset-person-approved");
    const model = h.api.state.modelCatalog.find((item: { productKey: string }) => item.productKey === "seedance-2.0");
    model.nativePlatform = true; h.api.state.capabilities.provider = "shaozhuang-native";
    expect(await h.api.associateTrustedPortrait(h.image().id, "asset-other")).toBe(false);
    expect(() => h.api.assetForRequest(h.image())).toThrow("个人火山方舟 API");
    h.api.renderAssets();
    const associate = h.allNodes(h.nodes.get("asset-list")!).find(node => node.dataset.trustedPortraitAsset);
    expect(associate?.disabled).toBe(true);
    model.nativePlatform = false; h.api.state.capabilities.provider = "doubao"; h.api.state.accountKey = "tenant:bob";
    expect(() => h.api.assetForRequest(h.image())).toThrow("原账号");
    expect(h.api.assetForRequest(h.image(), { analysis: true }).remoteUrl).toBe("");
    expect(await h.api.associateTrustedPortrait(h.image().id, null)).toBe(true);
  });

  it("does not silently fall back to uploading the original when saved portrait metadata is invalid", async () => {
    const h = harness(); const saved = h.api.serializeAsset(h.image());
    saved.trustedPortrait = { uri: "asset://asset-ok?bad=1", accountKey: "tenant:alice" };
    const restored = await h.api.hydrateAsset(saved);
    expect(() => h.api.assetForRequest(restored)).toThrow("引用无效");
    expect(h.api.assetForRequest(restored, { analysis: true })).toMatchObject({ remoteUrl: "", storageRef: { id: h.record.id } });
  });
});
