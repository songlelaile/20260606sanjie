import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadCreativeEntryBundle } from "./creative-entry-bundle";

const publicRoot = process.env.CREATIVE_PUBLIC_TEST_ROOT
  ? path.resolve(process.env.CREATIVE_PUBLIC_TEST_ROOT)
  : fileURLToPath(new URL("../../public", import.meta.url));
const htmlPath = path.join(publicRoot, "creative/labs/image-prompt-lab/promptlab.html");
const scripts = [...readFileSync(htmlPath, "utf8").matchAll(/<script[^>]+src="([^"]+)"/g)]
  .map((match) => match[1].split("?")[0])
  .map((src) => src.startsWith("/") ? path.join(publicRoot, src) : path.resolve(path.dirname(htmlPath), src));

function storage() {
  const items = new Map<string, string>();
  return {
    get length() { return items.size; },
    key: (index: number) => [...items.keys()][index],
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key)
  };
}

function element() {
  return {
    value: "", textContent: "", innerHTML: "", className: "", hidden: true,
    style: {}, dataset: {}, checked: false,
    focus: vi.fn(), appendChild: vi.fn(), setAttribute: vi.fn(), getAttribute: vi.fn(),
    addEventListener: vi.fn(), querySelectorAll: () => [], querySelector: () => null,
    classList: { toggle: vi.fn(), add: vi.fn(), remove: vi.fn(), contains: () => false }
  };
}

function imageRuntime(bundledSource?: string) {
  const elements = new Map<string, ReturnType<typeof element>>();
  const document = {
    readyState: "loading",
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id)!;
    },
    createElement: element,
    querySelectorAll: () => [],
    addEventListener: vi.fn()
  };
  const fetch = vi.fn(async (url: string, _options?: RequestInit) => {
    if (url !== "/api/auth/me") throw new Error("Unexpected upstream call in runtime test");
    return Response.json({ data: { tenantId: "tenant-a", username: "alice" } });
  });
  const context = vm.createContext({
    console, URL, URLSearchParams, Headers, Request, Response, FormData, Blob, ArrayBuffer, Uint8Array,
    AbortController, TextEncoder, TextDecoder, Promise, fetch,
    // Register background startup hooks without running unrelated scheduled cleanup.
    setTimeout: vi.fn(), clearTimeout: vi.fn(), document,
    localStorage: storage(), sessionStorage: storage(),
    location: { href: "https://shaozhuangai.com/creative/labs/image-prompt-lab/promptlab.html?source=web", origin: "https://shaozhuangai.com", search: "?source=web" },
    __SZ_PROMPTLAB_BACKGROUND_TEST_MODE__: true,
    __SZ_PROMPTLAB_TEST_MODE__: true,
    crypto: webcrypto,
    navigator: { locks: { request(_key: string, _options: unknown, callback: (lock: object) => unknown) {
      return Promise.resolve(callback({}));
    } } }
  });
  context.window = context;
  const exportedContracts = new Map<string, unknown>();
  const runtimeFiles = bundledSource === undefined ? scripts.map(file => ({ file, source: readFileSync(file, "utf8") }))
    : [{ file: scripts[0], source: readFileSync(scripts[0], "utf8") }, { file: "studio-entry.js", source: bundledSource }];
  for (const { file, source } of runtimeFiles) {
    vm.runInContext(source, context, { filename: file, timeout: 2000 });
    if (file.endsWith("/background.js")) {
      expect(context.openUnifiedApiSettings).toBeUndefined();
      expect(context.buildLinkPrompt).toBeUndefined();
      expect(context.configMutationTail).toBeUndefined();
      for (const key of ["SZ_REFERENCE_DETAIL_CONTRACT", "SZ_REFERENCE_DETAIL_BLUEPRINT", "SZ_REFERENCE_DETAIL_BATCH", "SZ_IMAGE_ARCHIVE", "SZ_CREATIVE_TOOLS_CONTRACT"]) {
        exportedContracts.set(key, context[key]);
      }
    }
  }
  return { context, document, fetch, exportedContracts };
}

function send(context: vm.Context, type: string, payload: object = {}) {
  return new Promise<Record<string, unknown>>((resolve) => {
    context.chrome.runtime.sendMessage({ type, payload }, resolve);
  });
}

describe("image studio background and UI coexistence", () => {
  it("initializes the real protected tail bundle with the same bridge, contracts and API behavior", async () => {
    const bundle = await loadCreativeEntryBundle(path.join(publicRoot, "creative"));
    if (!bundle.bundled) throw new Error("Expected bundled fixture");
    const individual = imageRuntime(), bundled = imageRuntime(bundle.js);
    for (const key of ["SZ_REFERENCE_DETAIL_CONTRACT", "SZ_REFERENCE_DETAIL_BLUEPRINT", "SZ_REFERENCE_DETAIL_BATCH", "SZ_IMAGE_ARCHIVE", "SZ_CREATIVE_TOOLS_CONTRACT", "SZ_STUDIO_GENESIS"]) {
      expect(Object.keys(bundled.context[key])).toEqual(Object.keys(individual.context[key]));
    }
    expect(Object.keys(bundled.context.SZ_CREATIVE_TOOLS_BRIDGE)).toEqual(Object.keys(individual.context.SZ_CREATIVE_TOOLS_BRIDGE));
    expect(bundled.context.SZ_CREATIVE_TOOLS_UI).toBeUndefined();
    expect(bundled.document.addEventListener).toHaveBeenCalledWith("DOMContentLoaded", expect.any(Function));
    expect(bundled.context.normalizeCfg).not.toBe(bundled.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.normalizeCfg);
    bundled.context.applyCfg({ provider: "openai-compatible", apiKey: "" });
    expect(bundled.context.SZ_CREATIVE_TOOLS_BRIDGE.modelInfo()).toMatchObject({ ready: true, supportsReference: true, supplyChannel: "platform_wallet" });
    expect(await bundled.context.openUnifiedApiSettings()).toMatchObject({ ok: true, centralized: true });
    expect(bundled.document.getElementById("configModal").hidden).toBe(false);
    expect(bundled.fetch.mock.calls.every(([url]) => url === "/api/auth/me")).toBe(true);
  });

  it("loads all HTML scripts in order and retains explicit shared exports", () => {
    const { context, document, exportedContracts } = imageRuntime();
    expect(scripts.map((file) => path.relative(publicRoot, file).split(path.sep).join("/"))).toEqual([
      "creative/web-chrome.js",
      "creative/src/local-import.js",
      "creative/src/business-knowledge.js",
      "creative/src/knowledge-output-contract.js",
      "creative/src/subject-orchestration.js",
      "creative/src/subject-assets.js",
      "creative/src/reference-detail-contract.js",
      "creative/labs/image-prompt-lab/reference-detail-blueprint.js",
      "creative/labs/image-prompt-lab/reference-detail-batch.js",
      "creative/labs/image-prompt-lab/image-archive-store.js",
      "creative/labs/image-prompt-lab/guide-model-profile.js",
      "creative/labs/image-prompt-lab/viral-series-contract.js",
      "creative/labs/image-prompt-lab/style-refresh-contract.js",
      "creative/src/reference-detail-interceptor.js",
      "creative/src/reference-detail-background.js",
      "creative/src/taobao-sku-background.js",
      "creative/labs/image-prompt-lab/creative-tools-contract.js",
      "creative/labs/image-prompt-lab/aesthetic-mirror-contract.js",
      "creative/labs/image-prompt-lab/studio-genesis-contract.js",
      "creative/labs/image-prompt-lab/scene-extension-contract.js",
      "creative/labs/image-prompt-lab/background.js",
      "creative/labs/image-prompt-lab/image-upload.js",
      "creative/credit-display.js",
      "creative/labs/image-prompt-lab/creative-credit-hints.js",
      "creative/labs/image-prompt-lab/sku-region-ui.js",
      "creative/labs/image-prompt-lab/sku-delivery-store.js",
      "creative/labs/image-prompt-lab/sku-durable-receipt.js",
      "creative/labs/image-prompt-lab/promptlab.js",
      "creative/labs/image-prompt-lab/aesthetic-mirror-ui.js",
      "creative/labs/image-prompt-lab/link-list-import.js",
      "creative/labs/image-prompt-lab/link-image-contract.js",
      "creative/labs/image-prompt-lab/link-image-ui.js",
      "creative/labs/image-prompt-lab/creative-tools-ui.js",
      "creative/labs/image-prompt-lab/studio-genesis-ui.js",
      "creative/labs/image-prompt-lab/scene-extension-ui.js",
      "creative/labs/image-prompt-lab/studio-legacy-layout.js",
      "creative/labs/image-prompt-lab/viral-workflow-layout.js",
      "creative/labs/image-prompt-lab/viral-workflow-bridge.js"
    ]);
    expect(document.addEventListener).toHaveBeenCalledWith("DOMContentLoaded", expect.any(Function));
    expect(typeof context.resolveUnifiedConfigReference).toBe("function");
    expect(context.resolveUnifiedConfigReference).toBe(context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.resolveUnifiedConfigReference);
    for (const [key, value] of exportedContracts) {
      expect(value).toBeTruthy();
      expect(context[key]).toBe(value);
    }
    expect(context.SZ_CREATIVE_TOOLS_CONTRACT.version).toBe("CREATIVE_TOOLS_V1");
    for (const key of ["createPlan", "createController", "validatePayload", "supportsReferenceConfig"]) {
      expect(typeof context.SZ_CREATIVE_TOOLS_CONTRACT[key]).toBe("function");
    }
    for (const key of ["send", "config", "archive", "getAccountKey", "ready", "listBoundApis", "selectBoundApi"]) {
      expect(typeof context.SZ_CREATIVE_TOOLS_BRIDGE[key]).toBe("function");
    }
    // Loading the additional script on the existing main-image route must not boot the creative workspace.
    expect(context.SZ_CREATIVE_TOOLS_UI).toBeUndefined();
    expect(context.normalizeCfg).not.toBe(context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.normalizeCfg);
    expect(context.saveReferenceDetailBlueprint).not.toBe(context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.saveReferenceDetailBlueprint);
    expect(context.loadReferenceDetailBlueprint).not.toBe(context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.loadReferenceDetailBlueprint);
  });

  it("opens website API settings through one message without recursion", async () => {
    const { context, document, fetch } = imageRuntime();
    const sendMessage = vi.spyOn(context.chrome.runtime, "sendMessage");
    const result = await context.openUnifiedApiSettings();
    expect(result).toMatchObject({ ok: true, centralized: true });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(document.getElementById("configModal").hidden).toBe(false);
    expect(fetch.mock.calls.every(([url]) => url === "/api/auth/me")).toBe(true);
  });

  it("allows the website platform image route without a browser API key and identifies credit billing", () => {
    const { context, document, fetch } = imageRuntime();
    context.applyCfg({ provider: "openai-compatible", apiKey: "" });
    expect(context.SZ_CREATIVE_TOOLS_BRIDGE.modelInfo()).toMatchObject({
      ready: true, supportsReference: true, supplyChannel: "platform_wallet", model: "image2"
    });
    expect(document.getElementById("apiKey").value).toBe("");
    expect(document.getElementById("configState").textContent).toBe("使用本站积分");
    expect(document.getElementById("configSummaryText").textContent).toContain("无需填写 API Key");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a direct provider unavailable without its own key and preserves a configured key", () => {
    const { context, document } = imageRuntime();
    context.applyCfg({ provider: "openai", apiKey: "" });
    expect(context.SZ_CREATIVE_TOOLS_BRIDGE.modelInfo()).toMatchObject({ ready: false, supplyChannel: "external_key" });
    context.applyCfg({ provider: "openai", apiKey: "synthetic-owned-key" });
    expect(context.SZ_CREATIVE_TOOLS_BRIDGE.modelInfo()).toMatchObject({ ready: true, supplyChannel: "external_key" });
    expect(document.getElementById("apiKey").value).toBe("synthetic-owned-key");
  });

  it.each(["openai", "openai-compatible"])("sends the image2 task alias as gpt-image-2 for %s on the hosted image endpoint", async (provider) => {
    const { context, fetch } = imageRuntime();
    const submissions: Array<{ url: string; headers: Record<string, string>; bodyText: string }> = [];
    fetch.mockImplementation(async (url, options) => {
      if (url === "/api/auth/me") return Response.json({ data: { tenantId: "tenant-a", username: "alice", creativeEntitlement: { allowed: true } } });
      expect(url).toBe("/api/creative/proxy");
      submissions.push(JSON.parse(String(options?.body)));
      return Response.json({ data: [{ url: "https://result.example/offline-image.png" }] });
    });
    const config = { provider, apiKey: "synthetic-owned-key", imageModel: "image2", imageEndpoint: "https://sub.shaozhuangai.com/v1/images/generations" };
    const result = await context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createOpenAIImage(config, { prompt: "离线回归", size: "1024x1024", count: 1 });
    expect(result.ok, JSON.stringify({result,calls:fetch.mock.calls.map(([url])=>url)})).toBe(true);
    expect(submissions).toHaveLength(1);
    expect(JSON.parse(submissions[0].bodyText)).toMatchObject({ model: "gpt-image-2", n: 1 });
    expect(submissions[0].headers.Authorization).toBe(provider === "openai" ? "Bearer synthetic-owned-key" : undefined);
    expect(config.imageModel).toBe("image2");
    expect(config.apiKey).toBe("synthetic-owned-key");
  });

  it("leaves custom gateway aliases unchanged and rejects lookalike hosted routes", () => {
    const { context } = imageRuntime();
    const translate = context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.hostedImageUpstreamModel;
    for (const imageEndpoint of ["https://custom.example/v1/images/generations", "https://sub.shaozhuangai.com.evil.example/v1/images/generations", "http://sub.shaozhuangai.com/v1/images/generations", "https://sub.shaozhuangai.com/v1/chat/completions", "https://sub.shaozhuangai.com/v1/images/generations?route=other"]) {
      expect(translate({ provider: "openai", imageEndpoint }, "image2")).toBe("image2");
    }
  });

  it("allows explicit platform analysis without prompting for a user key", async () => {
    const { context } = imageRuntime();
    context.applyCfg({ provider: "openai-compatible", apiKey: "" });
    const dispatch = vi.fn(async () => ({ ok: true, productName: "测试商品" }));
    context.__SZ_PROMPTLAB_TEST_API__.setTestSend(dispatch);
    expect(await context.SZ_CREATIVE_TOOLS_BRIDGE.analyze({ tool: "product", products: [] })).toMatchObject({ ok: true });
    expect(dispatch).toHaveBeenCalledWith("ANALYZE_SUBJECT_ASSET", expect.objectContaining({ provider: "openai-compatible" }));
  });

  it("selects platform credits while retaining an incomplete custom profile for the same provider", async () => {
    const { context } = imageRuntime();
    const owner = "user:tenant-a:alice";
    const external = context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.normalizeCfg({
      provider: "openai-compatible", apiKey: "", visionBaseUrl: "https://external.example/v1",
      imageEndpoint: "https://external.example/v1/images/generations"
    });
    const profileKey = "sz_image_prompt_lab_config_profiles_v2";
    await context.chrome.storage.local.set({ [profileKey]: { accounts: { [owner]: {
      activeProvider: "openai-compatible", configs: { "openai-compatible": external }
    } } } });
    context.__SZ_PROMPTLAB_TEST_API__.state.archiveAccountKey = owner;
    expect(await context.SZ_CREATIVE_TOOLS_BRIDGE.selectBoundApi("openai-compatible")).toMatchObject({ ok: true, accountKey: owner });
    expect(context.SZ_CREATIVE_TOOLS_BRIDGE.modelInfo()).toMatchObject({ ready: true, supplyChannel: "platform_wallet" });
    const stored = await context.chrome.storage.local.get(profileKey);
    expect(stored[profileKey].accounts[owner].configs["openai-compatible"]).toEqual(external);
  });

  it("switches the config form to credits, persists it through refresh and retains the saved custom gateway", async () => {
    const { context, document, fetch } = imageRuntime();
    const owner = "user:tenant-a:alice", key = "sz_image_prompt_lab_config_profiles_v2";
    const external = context.normalizeCfg({ provider: "openai-compatible", apiKey: "synthetic-original-key",
      visionBaseUrl: "https://external.example/v1", imageEndpoint: "https://external.example/v1/images/generations" });
    await context.chrome.storage.local.set({ [key]: { accounts: { [owner]: {
      activeProvider: external.provider, configs: { [external.provider]: external }
    } } } });
    context.applyCfg(external);
    context.__SZ_PROMPTLAB_TEST_API__.state.archiveAccountKey = owner;
    context.CustomEvent = class { constructor(public type: string) {} };
    context.dispatchEvent = vi.fn(() => {
      expect(context.creativeWebIsBusy()).toBe(false);
    });
    context.openConfigModal();
    expect(document.getElementById("configWalletRow").hidden).toBe(false);
    expect(await context.usePlatformWallet()).toMatchObject({ ok: true, accountKey: owner });
    expect(document.getElementById("configModal").hidden).toBe(true);
    expect(document.getElementById("apiKey").value).toBe("");
    expect(context.dispatchEvent).toHaveBeenCalledOnce();
    expect(await context.SZ_CREATIVE_TOOLS_BRIDGE.refresh()).toMatchObject({ ok: true, accountKey: owner });
    expect(context.SZ_CREATIVE_TOOLS_BRIDGE.modelInfo()).toMatchObject({ supplyChannel: "platform_wallet", model: "image2" });
    // Selecting the active credit entry must also retain the preference.
    expect(await context.SZ_CREATIVE_TOOLS_BRIDGE.selectBoundApi("openai-compatible")).toMatchObject({ ok: true });
    const stored = await context.chrome.storage.local.get(key);
    expect(stored[key].accounts[owner]).toMatchObject({ activeSupplyChannel: "platform_wallet", configs: { [external.provider]: external } });
    document.getElementById("imageModel").value = "image1";
    expect(await context.saveCfg()).toMatchObject({ ok: true });
    expect(await context.SZ_CREATIVE_TOOLS_BRIDGE.refresh()).toMatchObject({ ok: true });
    expect(context.SZ_CREATIVE_TOOLS_BRIDGE.modelInfo()).toMatchObject({ supplyChannel: "platform_wallet", model: "image1" });
    const updated = await context.chrome.storage.local.get(key);
    expect(updated[key].accounts[owner].configs[external.provider]).toEqual(external);
    expect(fetch.mock.calls.every(([url]) => url === "/api/auth/me")).toBe(true);
  });

  it("does not change the form or notify workflows when switching is busy or the account write is rejected", async () => {
    const { context, document } = imageRuntime();
    context.applyCfg({ provider: "openai", apiKey: "synthetic-key" });
    context.__SZ_PROMPTLAB_TEST_API__.state.archiveAccountKey = "user:tenant-a:alice";
    context.dispatchEvent = vi.fn();
    const dispatch = vi.fn(async () => ({ ok: false, error: "登录账号已变化" }));
    context.__SZ_PROMPTLAB_TEST_API__.setTestSend(dispatch);
    context.SZ_CREATIVE_TOOLS_BRIDGE.setApiBusy("fixture-task", true);
    await context.usePlatformWallet();
    expect(dispatch).not.toHaveBeenCalled();
    context.SZ_CREATIVE_TOOLS_BRIDGE.setApiBusy("fixture-task", false);
    expect(await context.usePlatformWallet()).toMatchObject({ ok: false });
    expect(document.getElementById("provider").value).toBe("openai");
    expect(document.getElementById("apiKey").value).toBe("synthetic-key");
    expect(document.getElementById("configState").textContent).toContain("登录账号已变化");
    expect(context.creativeWebIsBusy()).toBe(false);
    expect(context.dispatchEvent).not.toHaveBeenCalled();
  });

  it("routes link prompt messages to background validation after the UI is loaded", async () => {
    const { context, fetch } = imageRuntime();
    const uiPrompt = vi.spyOn(context, "buildLinkPrompt");
    const result = await send(context, "BUILD_LINK_PROMPT");
    expect(result).toMatchObject({ ok: false, code: "missing_link_record" });
    expect(uiPrompt).not.toHaveBeenCalled();
    expect(fetch.mock.calls.every(([url]) => url === "/api/auth/me")).toBe(true);
  });

  it("ignores legacy connector configuration and permits saved link prompts without a knowledge batch", async () => {
    const { context, fetch } = imageRuntime();
    const accountKey = "user:tenant-a:alice";
    const legacy = { accounts: { [accountKey]: { enabled: true } } };
    await context.chrome.storage.local.set({
      sz_obsidian_connection_v1: legacy,
      sz_obsidian_batch_locks_v1: { blockedBatch: { accountKey, vaultFingerprint: "old-vault" } }
    });
    const get = vi.spyOn(context.chrome.storage.local, "get");
    const api = context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__;
    expect(context.SZObsidianKnowledge).toBeUndefined();
    expect(await api.verifyKnowledgeBeforeImage({ labMode: "main", promptSource: "link", linkId: "L001" }))
      .toMatchObject({ ok: true, knowledgeMeta: { code: "prompt_input_scope" } });
    const result = await api.readResolvedBusinessKnowledgeContextForAccount(accountKey, "main", 5000, { linkId: "L001" });
    expect(result).toMatchObject({ ok: true, provider: "none", context: "", sources: [] });
    expect(get.mock.calls.flat().some((value) => String(value).includes("obsidian"))).toBe(false);
    const stored = await context.chrome.storage.local.get("sz_obsidian_connection_v1");
    expect(stored.sz_obsidian_connection_v1).toEqual(legacy);
    expect(fetch.mock.calls.every(([url]) => url === "/api/auth/me")).toBe(true);
  });

  it("submits a saved list prompt with its product image even when no knowledge batch was recorded", async () => {
    const { context, fetch } = imageRuntime();
    const submissions: Array<{ url: string; bodyText: string }> = [];
    fetch.mockImplementation(async (url, options) => {
      if (url === "/api/auth/me") return Response.json({ data: { tenantId: "tenant-a", username: "alice", creativeEntitlement: { allowed: true } } });
      expect(url).toBe("/api/creative/proxy");
      submissions.push(JSON.parse(String(options?.body)));
      return Response.json({ data: [{ url: "https://result.example/offline-list-image.png" }] });
    });
    const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ";
    const result = await context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createImageTask({
      provider: "openai-compatible", imageAdapter: "generic-json", imageModel: "image2", apiKey: ""
    }, { promptSource: "link", labMode: "main", linkId: "L001", prompt: "当前商品置于干净背景", productImages: [image], size: "1024x1024", count: 1 });
    expect(result).toMatchObject({ ok: true, images: ["https://result.example/offline-list-image.png"] });
    expect(submissions).toHaveLength(1);
    expect(JSON.parse(submissions[0].bodyText)).toMatchObject({
      model: "gpt-image-2", product_images: [image], prompt: "当前商品置于干净背景"
    });
  });

  it("reads only the current account local knowledge and keeps its output trace", async () => {
    const { context, fetch } = imageRuntime();
    const engine = context.SZBusinessKnowledge, api = context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__;
    let store = engine.setForAccount({}, "user:tenant-a:alice", {
      updatedAt: 10, fields: { product: "ALICE PRODUCT", tone: "清楚简洁" },
      sources: [{ id: "alice-source", name: "产品说明", text: "ALICE PRIVATE SOURCE" }]
    });
    store = engine.setForAccount(store, "user:tenant-b:bob", { fields: { product: "BOB PRIVATE PRODUCT" } });
    await context.chrome.storage.local.set({ [engine.KEY]: store });
    const result = await api.readResolvedBusinessKnowledgeContextForAccount("user:tenant-a:alice", "main", 5000, { linkId: "L001" });
    expect(result).toMatchObject({ ok: true, provider: "local", summary: { ready: true, sourceCount: 1 } });
    expect(result.context).toContain("ALICE PRIVATE SOURCE");
    expect(result.context).not.toContain("BOB PRIVATE PRODUCT");
    const trace = api.attachPromptKnowledgeTrace({ ok: true, data: { "中文提示词": "明亮背景" } }, {
      link: { "链接编号": "L001" }, businessKnowledgeMeta: result
    }, "main", "link");
    expect(trace.fieldTrace.find((row: { field: string }) => row.field === "中文提示词"))
      .toMatchObject({ linkId: "L001", decision: "constrained", sourcePaths: ["local:alice-source"] });
    expect(fetch.mock.calls.every(([url]) => url === "/api/auth/me")).toBe(true);
  });

  it("continues independent prompting without reading knowledge when the account is unavailable", async () => {
    const { context, fetch } = imageRuntime();
    fetch.mockImplementation(async () => Response.json({ error: { message: "unauthorized" } }, { status: 401 }));
    const get = vi.spyOn(context.chrome.storage.local, "get");
    const result = await context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.attachBusinessKnowledge({
      promptSource: "reference", productName: "当前商品"
    }, "main");
    expect(result).toMatchObject({
      businessKnowledgeContext: "", businessKnowledgeMeta: { provider: "none", code: "account_unavailable", facts: [] }
    });
    expect(get.mock.calls.flat().some((value) => String(value).includes("sz_business_knowledge_v1"))).toBe(false);
    expect(fetch.mock.calls.every(([url]) => url === "/api/auth/me")).toBe(true);
  });

  it("keeps product binding validation while removing the optional knowledge gate", async () => {
    const { context, fetch } = imageRuntime();
    const verify = context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.verifyKnowledgeBeforeImage;
    expect(await verify({ promptSource: "link", subjectTaskId: "S001" }))
      .toMatchObject({ ok: false, code: "subject_binding_incomplete" });
    expect(await verify({ promptSource: "link", subjectTaskId: "S001", orchestrationBatchId: "batch",
      subjectBatchId: "subjects", subjectBindingId: "binding", subjectFingerprint: "subject",
      subjectFactsFingerprint: "facts", visualProfileFingerprint: "visual" }))
      .toMatchObject({ ok: true });
    expect(fetch.mock.calls.every(([url]) => url === "/api/auth/me")).toBe(true);
  });

  it("retains standalone fact validation without any connector network dependency", () => {
    const { context, fetch } = imageRuntime();
    const contract = context.SZKnowledgeOutputContract;
    expect(contract.validateGeneratedClaims({ "画面布局": "主体占画面70%" })).toMatchObject({ ok: true });
    expect(contract.validateGeneratedClaims({ "主图文案": "除菌率99%" })).toMatchObject({ ok: false, code: "generated_claim_unverified" });
    expect(contract.validateGeneratedClaims({ "主图文案": "深度537mm" }, {
      facts: [{ factKey: "depth", factValue: "537", unit: "mm", evidenceStatus: "verified" }]
    })).toMatchObject({ ok: true });
    expect(fetch.mock.calls.every(([url]) => url === "/api/auth/me")).toBe(true);
  });

});


describe("website guide model dispatch", () => {
  const png = (() => {
    const bytes = Buffer.alloc(32);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    bytes.writeUInt32BE(1024, 16); bytes.writeUInt32BE(1024, 20); bytes[24] = 8; bytes[25] = 6;
    return `data:image/png;base64,${bytes.toString("base64")}`;
  })();

  for (const model of ["gpt-image-2", "gpt-image-2.5-sunburst"]) {
    for (const labMode of ["main", "detail"]) {
      it(`sends ${model} ${labMode} guide through GENERATE_IMAGE with its own strategy and parent`, async () => {
        const { context, fetch } = imageRuntime();
        context.applyCfg({ provider: "openai", apiKey: "test-only", imageModel: model, imageAdapter: "openai-images" });
        const api = context.__SZ_PROMPTLAB_TEST_API__;
        const item = {
          resultId: "current-result", url: png, labMode, detailMode: labMode === "detail" ? "link" : "main",
          ratio: "1:1", resolution: "1K", productImages: [png],
          prompt: "OLD ADVERTISEMENT DIRECTION", negativePrompt: "OLD NEGATIVE PROMPT",
          promptRecord: { id: "old-record", source: "reference", prompt: "OLD ADVERTISEMENT DIRECTION", data: {
            "主图规划": [{ "主标题": "OLD MAIN COPY" }], "屏幕规划": [{ "主标题": "OLD DETAIL COPY" }]
          } }
        };
        const draft = api.guideDraftForItem(item);
        expect(Object.isFrozen(draft.config)).toBe(true);
        const contract = api.createStructuredGuideContract({
          config: draft.config, scope: "current", mode: "general", guide: "只替换选中文字",
          issues: ["copy-remove-local"], textTarget: "旧文案", replacementText: "新文案",
          annotation: { mustStrokeCount: 1, editMaskDataUrl: png }, parentResultId: draft.parentResultId
        });
        expect(contract.valid).toBe(true);
        type CapturedGuideRequest = {
          config: { imageModel: string };
          payload: {
            guideContract: { modelProfile: { strategy: string }; parentResultId: string };
            sourceResultId: string; editBaseImage: string; productImages: string[];
            negativePrompt: string; prompt: string;
          };
        };
        const dispatched: Array<{ type: string; value: unknown }> = [];
        api.setTestSend(async (type: string, value: unknown) => {
          dispatched.push({ type, value });
          return { ok: false, error: "Synthetic dispatch captured before provider" };
        });
        const generationResult = await context.generateOne("guide", "引导重生", 1, {
          labMode, detailMode: item.detailMode, config: draft.config, generationSettings: draft.generationSettings,
          promptRecord: draft.promptRecord, guideContract: contract, editBaseImage: png, editMaskImage: png,
          sourceResultId: draft.parentResultId, productImages: draft.productImages, parentItem: item,
          negativePrompt: item.negativePrompt, detailTargetScreenIndex: 2, detailTargetScreenTotal: 8,
          detailScreenDirection: "OLD FROZEN DIRECTION", detailScreenPlan: { "主标题": "OLD SCREEN COPY" }
        });
        expect(dispatched.some(entry => entry.type === "GENERATE_IMAGE"), JSON.stringify(generationResult)).toBe(true);
        const request = dispatched.find(entry => entry.type === "GENERATE_IMAGE")!.value as CapturedGuideRequest;
        expect(request.config.imageModel).toBe(model);
        expect(request.payload.guideContract.modelProfile.strategy).toBe(model === "gpt-image-2" ? "image2-structured-edit-v1" : "sunburst-precise-edit-v1");
        expect(request.payload.sourceResultId).toBe("current-result");
        expect(request.payload.guideContract.parentResultId).toBe("current-result");
        expect(request.payload.editBaseImage).toBe(png);
        expect(request.payload.productImages).toEqual([png]);
        expect(request.payload.negativePrompt).toBe("");
        expect(request.payload.prompt).not.toMatch(/OLD|Create a new e-commerce|GENERATION MODE|screen 2 of 8|premium lighting/);
        expect(request.payload.prompt).toContain("旧文案");
        expect(request.payload.prompt).toContain("新文案");
        if (model.includes("sunburst")) expect(request.payload.prompt).not.toMatch(/STRUCTURED GUIDE|repairPath|L2|P1/);
        expect(fetch.mock.calls.every(([url]) => url === "/api/auth/me")).toBe(true);
      });
    }
  }

  it("captures the current configured model on opening and leaves a prior snapshot immutable", () => {
    const { context } = imageRuntime();
    const item = { url: png, resultId: "one", labMode: "main", productImages: [png], ratio: "1:1", resolution: "1K" };
    context.applyCfg({ provider: "openai", apiKey: "test-only", imageModel: "gpt-image-2" });
    const before = context.__SZ_PROMPTLAB_TEST_API__.guideDraftForItem(item);
    context.applyCfg({ provider: "openai", apiKey: "test-only", imageModel: "gpt-image-2.5-sunburst" });
    const after = context.__SZ_PROMPTLAB_TEST_API__.guideDraftForItem(item);
    expect(before.config.imageModel).toBe("gpt-image-2");
    expect(after.config.imageModel).toBe("gpt-image-2.5-sunburst");
    expect(context.SZ_GUIDE_MODEL_PROFILE.resolve(before.config).strategy).not.toBe(context.SZ_GUIDE_MODEL_PROFILE.resolve(after.config).strategy);
  });
});
