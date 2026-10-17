import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";

const root = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const script = (file: string) => readFileSync(resolve(root, file), "utf8");
const config = {
  provider: "openai-compatible", imageAdapter: "generic-json", apiKey: "",
  imageEndpoint: "https://sub.shaozhuangai.com/v1/images/generations", imageModel: "image2",
  visionBaseUrl: "https://sub.shaozhuangai.com/v1", visionModel: "chatGPT5.5", textModel: "chatGPT5.5"
};
const bytes = Buffer.alloc(32);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
bytes.writeUInt32BE(64, 16); bytes.writeUInt32BE(64, 20);
const image = `data:image/png;base64,${bytes.toString("base64")}`;

function storage() {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] || null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key) };
}

function website(status = 200, rejection?: Record<string, unknown>, marker = false) {
  let loggedIn = true, allowed = true, username = "alice";
  let unavailableModel = "", firstModelFailureHook: (() => Promise<void>) | undefined;
  const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown>; credentials?: string }> = [];
  const context = createContext({
    URL, URLSearchParams, Request, Headers, Response, Blob, FormData, TextEncoder, TextDecoder,
    ArrayBuffer, Uint8Array, btoa, atob, console, setTimeout, clearTimeout, AbortController, crypto: webcrypto,
    localStorage: storage(), sessionStorage: storage(), __SZ_PROMPTLAB_BACKGROUND_TEST_MODE__: true,
    location: { href: "https://site.test/creative/labs/image-prompt-lab/promptlab.html?studio=1", origin: "https://site.test", search: "?studio=1" },
    document: { getElementById: () => null, addEventListener() {},
      createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, appendChild() {} }),
      body: { appendChild() {}, classList: { contains: () => false, toggle() {} } } },
    addEventListener() {},
    fetch: async (input: string, init?: RequestInit) => {
      if (/^data:image\//.test(input)) return new Response(Buffer.from(input.split(",")[1], "base64"), { headers: { "Content-Type": "image/png" } });
      if (input === "/api/auth/me") return loggedIn ? Response.json({ data: { tenantId: "shop", username, creativeEntitlement: { allowed } } }) : Response.json({}, { status: 401 });
      if (input !== "/api/creative/proxy") throw new Error(`Unexpected network request: ${input}`);
      if (init?.body instanceof FormData) {
        requests.push({ url: String(init.body.get("__sz_url")), headers: JSON.parse(String(init.body.get("__sz_headers"))),
          body: Object.fromEntries([...init.body.entries()].filter(([key]) => !key.startsWith("__sz_"))), credentials: init.credentials });
      } else {
        const envelope = JSON.parse(String(init?.body));
        requests.push({ url: envelope.url, headers: envelope.headers, body: JSON.parse(envelope.bodyText), credentials: init?.credentials });
      }
      if (unavailableModel && requests[requests.length - 1].body.model === unavailableModel) {
        if (firstModelFailureHook) { const hook = firstModelFailureHook; firstModelFailureHook = undefined; await hook(); }
        return Response.json({ error: { code: "model_not_found", message: "model not supported" } }, { status: 400 });
      }
      if (status !== 200) return Response.json(rejection || { error: "fixture rejected" }, { status, headers: marker ? { "X-Sanjie-Provider-Submission": "not-submitted" } : {} });
      return Response.json({ data: [{ url: image }], choices: [{ message: { content: '{"checked":true}' } }] });
    }
  });
  context.window = context;
  for (const file of ["web-chrome.js", "src/business-knowledge.js", "src/subject-orchestration.js", "src/subject-assets.js", "src/reference-detail-contract.js",
    "labs/image-prompt-lab/reference-detail-blueprint.js", "labs/image-prompt-lab/reference-detail-batch.js", "labs/image-prompt-lab/viral-series-contract.js",
    "labs/image-prompt-lab/style-refresh-contract.js", "labs/image-prompt-lab/scene-extension-contract.js", "labs/image-prompt-lab/creative-tools-contract.js",
    "labs/image-prompt-lab/studio-genesis-contract.js", "labs/image-prompt-lab/image-archive-store.js", "labs/image-prompt-lab/background.js"])
    runInContext(script(file), context, { filename: file });
  const send = (type: string, payload: object = {}) => new Promise<Record<string, unknown>>(done => context.chrome.runtime.sendMessage({ type, ...payload }, done));
  return { context, requests, send, api: context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__,
    setLoggedIn: (value: boolean) => { loggedIn = value; }, setAllowed: (value: boolean) => { allowed = value; }, setUser: (value: string) => { username = value; },
    setUnavailableModel: (value: string) => { unavailableModel = value; },
    setFirstModelFailureHook: (hook: () => Promise<void>) => { firstModelFailureHook = hook; } };
}

function studioPayload(h: ReturnType<typeof website>) {
  const engine = h.context.SZ_STUDIO_GENESIS;
  const settings = { ...engine.defaults("main"), model: "image2", count: 1 };
  const task = { id: "fixture-product", name: "测试商品", requirements: "保持原图商品", products: [{ image, name: "正面", width: 64, height: 64 }], overrides: null };
  const plan = engine.createPlan(task, settings);
  expect(plan.ok).toBe(true);
  return engine.createPayload(plan, plan.shots[0].id);
}

describe("website platform wallet credentials", () => {
  it("recognizes only the canonical provider and hosted endpoints without making a request", () => {
    const h = website(), uses = h.context.SZ_WEB_ACCOUNT.usesPlatformWallet;
    expect(uses(config, "image")).toBe(true);
    expect(uses(config, "chat")).toBe(true);
    expect(uses({ ...config, imageEndpoint: "https://sub.shaozhuangai.com/v1/images/edits/" }, "image")).toBe(true);
    for (const endpoint of ["http://sub.shaozhuangai.com/v1/images/generations", "https://sub.shaozhuangai.com.evil.test/v1/images/generations",
      "https://x.sub.shaozhuangai.com/v1/images/generations", "https://sub.shaozhuangai.com/v2/images/generations",
      "https://sub.shaozhuangai.com/v1/anything", "https://sub.shaozhuangai.com:8443/v1/images/generations",
      "https://user:pass@sub.shaozhuangai.com/v1/images/generations", "https://sub.shaozhuangai.com/v1/images/generations?key=x",
      "https://sub.shaozhuangai.com/v1/images/generations#fragment"])
      expect(uses({ ...config, imageEndpoint: endpoint }, "image"), endpoint).toBe(false);
    expect(uses({ ...config, provider: "openai" }, "image")).toBe(false);
    expect(uses(config, "video")).toBe(false);
    expect(h.requests).toEqual([]);
  });

  it.each(["generic-json", "openai-images"])("executes the approved studio %s route through the login-session proxy without a browser Key", async imageAdapter => {
    const h = website();
    expect(await h.send("GENERATE_IMAGE", { config: { ...config, imageAdapter }, payload: studioPayload(h) })).toMatchObject({ ok: true, images: [image] });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ url: imageAdapter === "openai-images" ? config.imageEndpoint.replace("generations", "edits") : config.imageEndpoint,
      credentials: "same-origin", body: { model: "gpt-image-2" } });
    expect(Number(h.requests[0].body.n)).toBe(1);
    expect(h.requests[0].headers).not.toHaveProperty("Authorization");
    expect(h.requests[0].headers).not.toHaveProperty("authorization");
    expect(config.apiKey).toBe("");
  });

  it("runs product analysis through the actual profile and chat message path without a saved browser Key", async () => {
    const h = website();
    expect(await h.send("ANALYZE_SUBJECT_ASSET", { provider: "openai-compatible", payload: { productImages: [image], studioContext: true } }))
      .toMatchObject({ ok: true, imageInputMeta: { count: 1 } });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ url: `${config.visionBaseUrl}/chat/completions`, credentials: "same-origin" });
    expect(h.requests[0].headers).not.toHaveProperty("Authorization");
  });

  it("keeps a same-provider external profile while analyzing the explicitly bound platform draft", async () => {
    const h = website();
    const key = "sz_image_prompt_lab_config_profiles_v2", accountKey = "user:shop:alice";
    const external = h.api.normalizeCfg({ ...config, imageEndpoint: "https://api.openai.com/v1/images/generations", visionBaseUrl: "https://api.openai.com/v1", imageModel: "original-image", visionModel: "original-vision" });
    await h.context.chrome.storage.local.set({ [key]: { version: 2, configs: {}, legacyConfigImports: {}, accounts: {
      [accountKey]: { activeProvider: "openai-compatible", configs: { "openai-compatible": external } }
    } } });
    const before = JSON.stringify(await h.context.chrome.storage.local.get([key]));
    expect(await h.send("ANALYZE_SUBJECT_ASSET", { provider: "openai-compatible", platformConfig: config, accountKey,
      payload: { productImages: [image], studioContext: true } })).toMatchObject({ ok: true, imageInputMeta: { count: 1 } });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ url: `${config.visionBaseUrl}/chat/completions`, credentials: "same-origin" });
    expect(h.requests[0].headers).not.toHaveProperty("Authorization");
    expect(JSON.stringify(await h.context.chrome.storage.local.get([key]))).toBe(before);
    expect((await h.send("GET_CONFIG_PROFILE", { provider: "openai-compatible" })).config).toEqual(external);
  });

  it.each(["other-account", "missing-account", "external-endpoint"])("rejects an invalid platform analysis binding: %s", async invalid => {
    const h = website();
    const accountKey = invalid === "other-account" ? "user:shop:bob" : invalid === "missing-account" ? undefined : "user:shop:alice";
    const platformConfig = invalid === "external-endpoint" ? { ...config, visionBaseUrl: "https://api.openai.com/v1" } : config;
    expect(await h.send("ANALYZE_SUBJECT_ASSET", { provider: "openai-compatible", platformConfig, accountKey,
      payload: { productImages: [image], studioContext: true } })).toMatchObject({ ok: false, definitiveFailure: true,
      code: invalid === "external-endpoint" ? "platform_route_invalid" : "account_changed" });
    expect(h.requests).toEqual([]);
  });

  it("rechecks the login identity before using a draft's platform analysis configuration", async () => {
    const h = website();
    expect(await h.context.authCheck()).toMatchObject({ ok: true });
    h.setUser("bob");
    expect(await h.send("ANALYZE_SUBJECT_ASSET", { provider: "openai-compatible", platformConfig: config, accountKey: "user:shop:alice",
      payload: { productImages: [image], studioContext: true } })).toMatchObject({ ok: false, code: "account_changed", definitiveFailure: true });
    expect(h.requests).toEqual([]);
  });

  it.each(["creative", "scene"])("accepts the %s contract with session credentials while retaining its reference requirements", async route => {
    const h = website();
    let payload;
    if (route === "creative") {
      const engine = h.context.SZ_CREATIVE_TOOLS_CONTRACT;
      const plan = engine.createPlan({ tool: "refinement", products: [image], config: { count: 1, ratio: "1:1", resolution: "1K" } });
      expect(plan.ok).toBe(true);
      payload = engine.createPayload(plan, plan.shots[0].id);
    } else {
      const engine = h.context.SZ_SCENE_EXTENSION_CONTRACT;
      const plan = engine.createPlan({ config: { materialName: "测试商品", sameMaterialConfirmed: true, shots: ["near"], count: 1 }, images: [{ role: "front", image }] });
      expect(plan.ok).toBe(true);
      payload = engine.createPayload(plan, plan.shots[0].id);
    }
    expect(await h.send("GENERATE_IMAGE", { config, payload })).toMatchObject({ ok: true });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].headers).not.toHaveProperty("Authorization");
  });

  it("uses the same session for OpenAI image and chat adapters, omitting any saved hosted Key", async () => {
    const h = website(), saved = { ...config, apiKey: "synthetic-retained-key", imageAdapter: "openai-images" };
    expect(await h.api.createOpenAIImage(saved, { prompt: "测试", size: "1024x1024", count: 1 })).toMatchObject({ ok: true });
    expect(await h.api.chatJson(config, [{ role: "user", content: "测试" }], "chatGPT5.5")).toMatchObject({ ok: true, data: { checked: true } });
    expect(h.requests.map(request => request.url)).toEqual([config.imageEndpoint, `${config.visionBaseUrl}/chat/completions`]);
    expect(h.requests.every(request => request.credentials === "same-origin" && !request.headers.Authorization)).toBe(true);
    expect(saved.apiKey).toBe("synthetic-retained-key");
  });

  it("preserves direct-provider credentials and continues to reject direct or extension requests without Keys", async () => {
    const h = website(), direct = { ...config, provider: "openai", imageEndpoint: "https://api.openai.com/v1/images/generations", visionBaseUrl: "https://api.openai.com/v1" };
    expect(await h.api.createOpenAIImage(direct, { prompt: "测试" })).toMatchObject({ ok: false, error: "未配置 API Key" });
    expect(await h.api.createGenericJsonImage({ ...direct, provider: "openai-compatible" }, { prompt: "测试" })).toMatchObject({ ok: false });
    expect(await h.api.chatJson(direct, [], direct.visionModel)).toMatchObject({ ok: false, code: "missing_api_key" });
    expect(h.requests).toEqual([]);
    expect(await h.api.createOpenAIImage({ ...direct, apiKey: "synthetic-direct-key" }, { prompt: "测试", size: "1024x1024" })).toMatchObject({ ok: true });
    expect(h.requests[0].headers.Authorization).toBe("Bearer synthetic-direct-key");
    runInContext("globalThis.SZ_WEB_ACCOUNT = undefined", h.context);
    expect(await h.api.createOpenAIImage(config, { prompt: "测试" })).toMatchObject({ ok: false, error: "未配置 API Key" });
    expect(await h.api.createGenericJsonImage(config, { prompt: "测试" })).toMatchObject({ ok: false, error: "未配置 API Key" });
    expect(await h.api.chatJson(config, [], config.visionModel)).toMatchObject({ ok: false, code: "missing_api_key" });
    expect(h.requests).toHaveLength(1);
  });

  it.each(["login", "entitlement"])("retains the %s guard before the same-origin proxy", async guard => {
    const h = website();
    if (guard === "login") h.setLoggedIn(false); else h.setAllowed(false);
    expect(await h.api.createGenericJsonImage(config, { prompt: "测试" })).toMatchObject({ ok: false });
    expect(h.requests).toEqual([]);
  });

  it("retains definitive server supply failures without recording them as an uncertain provider receipt", async () => {
    const h = website(503, { error: "供应订阅未配置，请联系管理员", code: "CREATIVE_SUPPLY_NOT_CONFIGURED", providerSubmitted: false, definitiveFailure: true }, true);
    expect(await h.send("GENERATE_IMAGE", { config, payload: studioPayload(h) })).toMatchObject({ ok: false, code: "CREATIVE_SUPPLY_NOT_CONFIGURED", providerSubmitted: false, definitiveFailure: true, stateUncertain: false });
    expect(h.requests).toHaveLength(1);
  });
});

describe("wallet text model fallback persistence", () => {
  const profileKey = "sz_image_prompt_lab_config_profiles_v2";
  const legacyKey = "sz_image_prompt_lab_config";
  const accountKey = "user:shop:alice";
  async function selectedWallet(h: ReturnType<typeof website>) {
    // The preserved own API uses the same hosted text model, so writing the
    // wrong profile would visibly change both its model and legacy copy.
    const external = h.api.normalizeCfg({ ...config, apiKey: "synthetic-retained-key",
      imageEndpoint: "https://custom-provider.test/v1/images/generations", imageModel: "custom-image",
      textModel: "wallet-unavailable-model", visionModel: "wallet-unavailable-model" });
    await h.context.chrome.storage.local.set({ [profileKey]: { version: 2, configs: {}, legacyConfigImports: {}, accounts: {
      [accountKey]: { activeProvider: "openai-compatible", configs: { "openai-compatible": external } }
    } }, [legacyKey]: external });
    const walletConfig = h.api.normalizeCfg({ ...config, textModel: "wallet-unavailable-model", visionModel: "wallet-unavailable-model" });
    expect(await h.send("USE_PLATFORM_WALLET", { accountKey, config: walletConfig })).toMatchObject({ ok: true });
    h.setUnavailableModel("wallet-unavailable-model");
    return { external, walletConfig };
  }

  it.each(["form", "signed-reference"])("persists a successful %s wallet fallback without changing saved API or legacy credentials", async route => {
    const h = website(), { external, walletConfig } = await selectedWallet(h);
    const before = JSON.stringify((await h.context.chrome.storage.local.get([profileKey, legacyKey]))[legacyKey]);
    const requestConfig = route === "form" ? walletConfig : (await h.send("RESOLVE_CONFIG_PROFILE", {
      ref: { accountKey, provider: "openai-compatible", supplyChannel: "platform_wallet" }
    })).config;
    expect(await h.api.chatJson(requestConfig, [{ role: "user", content: "测试" }], "wallet-unavailable-model"))
      .toMatchObject({ ok: true, data: { checked: true }, modelFallback: { from: "wallet-unavailable-model", to: "chatGPT5.5", persisted: true } });
    expect(h.requests.map(request => request.body.model)).toEqual(["wallet-unavailable-model", "gpt-5.6-sol"]);
    expect(h.requests.every(request => !request.headers.Authorization)).toBe(true);
    const stored = await h.context.chrome.storage.local.get([profileKey, legacyKey]);
    expect(stored[profileKey].accounts[accountKey].configs["openai-compatible"]).toEqual(external);
    expect(stored[profileKey].accounts[accountKey].platformWalletConfig).toMatchObject({ textModel: "chatGPT5.5", visionModel: "chatGPT5.5", apiKey: "" });
    expect(JSON.stringify(stored[legacyKey])).toBe(before);
    expect(await h.send("GET_STUDIO_CONFIG_SNAPSHOT")).toMatchObject({ activeSupplyChannel: "platform_wallet", config: { textModel: "chatGPT5.5", visionModel: "chatGPT5.5" } });
    expect((await h.send("GET_CONFIG_PROFILE", { provider: "openai-compatible" })).config).toEqual(external);
  });

  it("keeps a newer wallet selection when an older successful fallback arrives", async () => {
    const h = website(), { external, walletConfig } = await selectedWallet(h);
    const newer = { ...walletConfig, textModel: "new-wallet-text", visionModel: "new-wallet-vision", imageModel: "image1" };
    h.setFirstModelFailureHook(async () => { expect(await h.send("USE_PLATFORM_WALLET", { accountKey, config: newer })).toMatchObject({ ok: true }); });
    expect(await h.api.chatJson(walletConfig, [{ role: "user", content: "测试" }], "wallet-unavailable-model"))
      .toMatchObject({ ok: true, modelFallback: { persisted: false } });
    const stored = await h.context.chrome.storage.local.get([profileKey, legacyKey]);
    expect(stored[profileKey].accounts[accountKey].platformWalletConfig).toEqual(newer);
    expect(stored[profileKey].accounts[accountKey].configs["openai-compatible"]).toEqual(external);
    expect(stored[legacyKey]).toEqual(external);
    expect((await h.send("GET_STUDIO_CONFIG_SNAPSHOT")).config).toEqual(newer);
  });
});
