"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const candidate = process.cwd();
const read = name => fs.readFileSync(path.join(candidate, name), "utf8");
const profileKey = "sz_image_prompt_lab_config_profiles_v2";
const localPrefix = "sz.chrome.local.v1:";
const accountId = "tenant-a:alice";
const personalKey = "fixture-personal-analysis-key";
const personalConfig = { provider: "openai-compatible", apiKey: personalKey,
  visionBaseUrl: "https://sub.shaozhuangai.com/v1", visionModel: "fixture-vision-model" };
const profile = (config = personalConfig, id = accountId) => ({ version: 2, activeAccount: "user:tenant-b:bob",
  accounts: { ["user:" + id.replace(/[^\w@.+:-]/g, "_").slice(0, 120)]: {
    activeProvider: config.provider, configs: { [config.provider]: config }
  }, "user:tenant-b:bob": { activeProvider: "openai", configs: { openai: {
    ...personalConfig, provider: "openai", apiKey: "fixture-other-account-key"
  } } } }, configs: { "openai-compatible": { ...personalConfig, apiKey: "fixture-shared-key" } } });

function hostRuntime(options = {}) {
  let currentId = options.id || accountId;
  let store = Object.prototype.hasOwnProperty.call(options, "store") ? options.store : profile();
  const reads = [];
  const fetches = [];
  const runtime = { onMessage: { addListener() {} } };
  const context = vm.createContext({ URL, fetch: async (...args) => { fetches.push(args); throw new Error("Unexpected transport"); },
    authCheck: async () => options.signedOut ? { ok: false } : { ok: true, user: { id: currentId } },
    chrome: { runtime, storage: { local: { get(keys, callback) {
      reads.push(Array.from(keys));
      if (options.readThrows) throw new Error("fixture storage unavailable");
      if (options.switchOnRead) currentId = "tenant-b:bob";
      runtime.lastError = options.readError ? { message: "fixture storage unavailable" } : undefined;
      callback(keys.includes(profileKey) ? { [profileKey]: store }
        : { sz_web_video_api_key_v1: { [accountId]: "fixture-video-only-key" } });
    } } } }, SZ_WEB_SUPPLY: { usesServerCredentials: () => options.platformAvailable !== false }
  });
  vm.runInContext(read("public/creative/web-video-host.js"), context, { filename: "web-video-host.js" });
  return { context, reads, fetches, setStore(value) { store = value; },
    resolve(request = { purpose: "analysis", accountKey: options.id || accountId, provider: "doubao" }) {
      return context.resolveUnifiedConfigReference(request);
    } };
}

function fakeDocument() {
  let prompts = 0;
  const elements = new Map();
  function element() {
    return { style: {}, setAttribute() {}, append() {}, addEventListener() {}, focus() {},
      showModal() { prompts += 1; }, remove() {}, close() {}, isConnected: false };
  }
  return { document: { getElementById: id => elements.get(id), createElement: element,
    body: { appendChild(node) { elements.set(node.id, node); } } }, promptCount: () => prompts };
}

function browserRuntime(options = {}) {
  const values = new Map();
  const storage = { get length() { return values.size; }, key: index => [...values.keys()][index],
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key) };
  let currentId = accountId;
  const fixtureDoc = fakeDocument();
  const calls = [];
  const posts = [];
  function saveProfiles(value) { storage.setItem(localPrefix + profileKey, JSON.stringify(value)); }
  if (options.store !== undefined) saveProfiles(options.store);
  else saveProfiles(profile());
  storage.setItem(localPrefix + "sz_web_video_api_key_v1", JSON.stringify({ [accountId]: "fixture-video-only-key" }));
  const nativeFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    if (url === "/api/auth/me") {
      const [tenantId, username] = currentId.split(":");
      return Response.json({ data: { tenantId, username } });
    }
    if (url === "/api/creative/proxy") {
      const envelope = JSON.parse(init.body);
      posts.push(envelope);
      if (options.transport) return options.transport(envelope, init);
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        creativeSummary: "Fixture summary", script: "Fixture editable script", storyboard: []
      }) } }] });
    }
    throw new Error("Unexpected fixture transport");
  };
  const context = vm.createContext({ console, URL, URLSearchParams, Headers, Request, Response, Blob,
    FormData, ArrayBuffer, Uint8Array, AbortController, TextEncoder, TextDecoder, Buffer,
    setTimeout, clearTimeout, crypto: webcrypto, fetch: nativeFetch,
    document: fixtureDoc.document, localStorage: storage, sessionStorage: storage,
    location: { href: "https://shaozhuangai.com/creative/labs/ecommerce-video-studio/video-studio.html", origin: "https://shaozhuangai.com" }
  });
  context.window = context;
  for (const file of ["public/creative/web-chrome.js", "public/creative/labs/ecommerce-video-studio/video-studio-contract.js", "public/creative/web-video-host.js",
    "public/creative/src/ecommerce-video-background.js"]) vm.runInContext(read(file), context, { filename: file });
  context.assetStore = { async getAsset() {
    if (options.onMaterialRead) options.onMaterialRead({ saveProfiles, switchAccount(id) { currentId = id; } });
    return { blob: new Blob(["fixture image bytes"], { type: "image/png" }) };
  } };
  vm.runInContext("var controller = SZEcommerceVideoBackground.createController({store:assetStore});", context);
  function analyze(local = false) {
    const asset = local
      ? { storageRef: { dbName: "sz_ecommerce_video_studio", storeName: "assets", id: "fixture-asset" } }
      : { remoteUrl: "https://fixture.invalid/product.png" };
    const message = { request: { mode: "assist", creativeRoute: "hero_product", goal: "Fixture analysis",
      productKey: "seedance-2.0", durationSeconds: 5, resolution: "720p", ratio: "16:9",
      audioMode: "silent", images: [asset] } };
    context.fixtureMessage = JSON.stringify(message);
    return vm.runInContext("controller.analyze(JSON.parse(fixtureMessage))", context);
  }
  return { context, calls, posts, analyze, saveProfiles, storage, prompts: fixtureDoc.promptCount,
    switchAccount(id) { currentId = id; }, capabilities() { return vm.runInContext("controller.capabilities()", context); } };
}

test("analysis selects only the current account's active text/vision profile, independently of its video key", async () => {
  const runtime = hostRuntime();
  const result = await runtime.resolve();
  assert.equal(result.ok, true); assert.equal(result.accountKey, accountId);
  assert.equal(result.config.apiKey, personalKey); assert.equal(result.config.visionModel, personalConfig.visionModel);
  assert.deepEqual(runtime.reads, [[profileKey]]); assert.equal(runtime.fetches.length, 0);
  assert.ok(!JSON.stringify(result).includes("fixture-other-account-key"));
  assert.ok(!JSON.stringify(result).includes("fixture-shared-key"));
});

test("analysis matches the image profile's sanitized account key while retaining the raw video account identity", async () => {
  const id = "tenant-a:alice name@example.com";
  const result = await hostRuntime({ id, store: profile(personalConfig, id) }).resolve();
  assert.equal(result.ok, true); assert.equal(result.accountKey, id); assert.equal(result.config.apiKey, personalKey);
});

for (const [name, store] of [
  ["missing store", undefined], ["current account absent", { version: 2, accounts: { "user:other": profile().accounts["user:tenant-b:bob"] } }],
  ["blank current key", profile({ ...personalConfig, apiKey: "   " })],
  ["shared or legacy keys only", { version: 2, accounts: {}, activeAccount: "user:tenant-b:bob", configs: profile().configs }]
]) test("no selected personal API uses the original platform analysis: " + name, async () => {
  const runtime = hostRuntime({ store });
  const result = await runtime.resolve();
  assert.equal(result.ok, true); assert.equal(result.config.apiKey, "");
  assert.equal(result.config.visionBaseUrl, "https://sub.shaozhuangai.com/v1");
  assert.equal(runtime.fetches.length, 0);
});

for (const options of [{ signedOut: true }, { switchOnRead: true }, { readError: true }, { readThrows: true }]) {
  test("auth/storage uncertainty never selects platform credentials: " + Object.keys(options)[0], async () => {
    const result = await hostRuntime(options).resolve();
    assert.equal(result.ok, false); assert.equal(result.config, undefined);
    assert.ok(!JSON.stringify(result).includes(personalKey));
  });
}

test("a stale video account ref is rejected before profile access", async () => {
  const runtime = hostRuntime();
  const result = await runtime.resolve({ purpose: "analysis", accountKey: "tenant-b:bob" });
  assert.equal(result.code, "ACCOUNT_CHANGED"); assert.equal(runtime.reads.length, 0);
});

for (const [name, store] of [
  ["invalid JSON represented by null", null], ["array store", []], ["invalid account", { accounts: { ["user:" + accountId]: [] } }],
  ["wrong key type", profile({ ...personalConfig, apiKey: 7 })],
  ["invalid key whitespace", profile({ ...personalConfig, apiKey: "invalid key" })],
  ["stored config without selected provider", { accounts: { ["user:" + accountId]: { activeProvider: "", configs: { "openai-compatible": personalConfig } } } }],
  ["selected provider missing but another personal key remains", { accounts: { ["user:" + accountId]: { activeProvider: "openai", configs: { "openai-compatible": personalConfig } } } }],
  ["missing model", profile({ ...personalConfig, visionModel: "", textModel: "do-not-guess-vision" })],
  ["missing endpoint", profile({ ...personalConfig, visionBaseUrl: "" })],
  ["unsafe endpoint", profile({ ...personalConfig, visionBaseUrl: "https://user:pass@fixture.invalid/v1" })],
  ["official Gemini endpoint disguised as compatible", profile({ ...personalConfig, visionBaseUrl: "https://generativelanguage.googleapis.com/v1beta" })]
]) test("invalid configured analysis rejects without falling back: " + name, async () => {
  const result = await hostRuntime({ store }).resolve();
  assert.equal(result.ok, false); assert.equal(result.code, "ANALYZER_CONFIG_INVALID"); assert.equal(result.config, undefined);
  assert.ok(!JSON.stringify(result).includes(personalKey));
});

for (const provider of ["nano-banana", "deepseek-v4", "minimax", "unknown-provider"])
  test("unsupported configured protocol or vision capability is explicit: " + provider, async () => {
    const result = await hostRuntime({ store: profile({ ...personalConfig, provider }) }).resolve();
    assert.equal(result.code, "ANALYZER_API_UNSUPPORTED"); assert.equal(result.config, undefined);
  });

test("a saved Gemini chat adapter is not sent through the OpenAI-compatible analyzer", async () => {
  const result = await hostRuntime({ store: profile({ ...personalConfig, imageAdapter: "gemini-image" }) }).resolve();
  assert.equal(result.code, "ANALYZER_API_UNSUPPORTED"); assert.equal(result.config, undefined);
});

for (const provider of ["openai-compatible", "openai", "doubao", "zhipu", "dashscope", "shaozhuang"])
  test("saved compatible profile is used without inventing a model: " + provider, async () => {
    const result = await hostRuntime({ platformAvailable: false, store: profile({ ...personalConfig, provider }) }).resolve();
    assert.equal(result.ok, true); assert.equal(result.config.visionModel, "fixture-vision-model");
    assert.equal(result.config.provider, provider);
  });

test("the legacy shaozhuang label does not guess compatibility for an unrelated endpoint", async () => {
  const result = await hostRuntime({ store: profile({ ...personalConfig, provider: "shaozhuang", visionBaseUrl: "https://fixture.invalid/v1" }) }).resolve();
  assert.equal(result.code, "ANALYZER_API_UNSUPPORTED"); assert.equal(result.config, undefined);
});

test("video generation continues to use its separate current-account video key", async () => {
  const runtime = hostRuntime({ store: profile({ ...personalConfig, provider: "nano-banana" }) });
  const result = await runtime.resolve({ accountKey: accountId });
  assert.equal(result.config.apiKey, "fixture-video-only-key"); assert.equal(result.config.provider, "doubao");
  assert.deepEqual(runtime.reads, [["sz_web_video_api_key_v1"]]);
});

test("real website shim carries the personal API and selected model to exactly one proxy request", async () => {
  const runtime = browserRuntime();
  const result = await runtime.analyze();
  assert.equal(result.status, "needs_confirmation"); assert.equal(runtime.posts.length, 1);
  assert.equal(runtime.posts[0].url, "https://sub.shaozhuangai.com/v1/chat/completions");
  assert.equal(new Headers(runtime.posts[0].headers).get("Authorization"), "Bearer " + personalKey);
  assert.equal(JSON.parse(runtime.posts[0].bodyText).model, personalConfig.visionModel);
  assert.equal(runtime.prompts(), 0);
});

test("a saved shaozhuang personal key is forwarded as BYOK, without assuming model permissions or using points", async () => {
  const runtime = browserRuntime({ store: profile({ ...personalConfig, provider: "shaozhuang" }) });
  await runtime.analyze();
  assert.equal(runtime.posts.length, 1);
  assert.equal(new Headers(runtime.posts[0].headers).get("Authorization"), "Bearer " + personalKey);
  assert.equal(JSON.parse(runtime.posts[0].bodyText).model, personalConfig.visionModel);
  assert.equal(runtime.prompts(), 0);
});

test("a stale selected provider blocks locally instead of charging points despite another saved personal key", async () => {
  const store = profile();
  store.accounts["user:" + accountId].activeProvider = "openai";
  const runtime = browserRuntime({ store });
  await assert.rejects(runtime.analyze(), cause => cause.code === "ANALYZER_CONFIG_INVALID");
  assert.equal(runtime.posts.length, 0); assert.equal(runtime.prompts(), 0);
});

for (const status of [401, 402, 503]) test("personal provider failure does not make a second platform request: " + status, async () => {
  const runtime = browserRuntime({ transport: () => Response.json({ code: "INSUFFICIENT_BALANCE", providerSubmitted: false }, { status }) });
  await assert.rejects(runtime.analyze(), cause => cause.code === "PROVIDER_HTTP_ERROR");
  assert.equal(runtime.posts.length, 1); assert.equal(runtime.prompts(), 0);
  assert.equal(new Headers(runtime.posts[0].headers).get("Authorization"), "Bearer " + personalKey);
});

test("personal transport failure never falls back or automatically reposts", async () => {
  const runtime = browserRuntime({ transport: () => { throw new Error("fixture network uncertainty"); } });
  await assert.rejects(runtime.analyze()); assert.equal(runtime.posts.length, 1); assert.equal(runtime.prompts(), 0);
});

test("no personal API omits Authorization and trusted local insufficient points opens the existing purchase guidance", async () => {
  const runtime = browserRuntime({ store: profile({ ...personalConfig, apiKey: "" }), transport: () =>
    Response.json({ code: "INSUFFICIENT_BALANCE", providerSubmitted: false, definitiveFailure: true },
      { status: 402, headers: { "X-Sanjie-Provider-Submission": "not-submitted" } }) });
  await assert.rejects(runtime.analyze()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.posts.length, 1); assert.equal(new Headers(runtime.posts[0].headers).has("Authorization"), false);
  assert.equal(runtime.prompts(), 1);
});

for (const [name, patch] of [["key", { apiKey: "fixture-new-key" }], ["API to points", { apiKey: "" }],
  ["endpoint", { visionBaseUrl: "https://api.openai.com/v1" }], ["model", { visionModel: "fixture-other-vision-model" }],
  ["provider", { provider: "openai" }]]) test("material-read config change is blocked before any POST: " + name, async () => {
  const runtime = browserRuntime({ onMaterialRead: ({ saveProfiles }) => saveProfiles(profile({ ...personalConfig, ...patch })) });
  await assert.rejects(runtime.analyze(true), cause => cause.code === "ANALYSIS_CONFIG_CHANGED" &&
    cause.details.providerSubmitted === false && cause.details.stateUncertain === false);
  assert.equal(runtime.posts.length, 0);
});

test("material-read points-to-API change is also blocked before any POST", async () => {
  const runtime = browserRuntime({ store: profile({ ...personalConfig, apiKey: "" }), onMaterialRead: ({ saveProfiles }) => saveProfiles(profile()) });
  await assert.rejects(runtime.analyze(true), cause => cause.code === "ANALYSIS_CONFIG_CHANGED");
  assert.equal(runtime.posts.length, 0);
});

test("material-read account change is blocked before any POST without leaking a key", async () => {
  const runtime = browserRuntime({ onMaterialRead: ({ switchAccount }) => switchAccount("tenant-b:bob") });
  await assert.rejects(runtime.analyze(true), cause => cause.code === "ACCOUNT_CHANGED" && !JSON.stringify(cause).includes(personalKey));
  assert.equal(runtime.posts.length, 0);
});

test("public capabilities explain personal versus points mode without exposing the saved key", async () => {
  const personal = browserRuntime();
  const ready = await personal.capabilities();
  assert.equal(ready.analysisAvailable, true); assert.match(ready.analysisStatus.message, /个人视觉 API/);
  assert.ok(!JSON.stringify(ready).includes(personalKey)); assert.equal(personal.posts.length, 0);
  const points = browserRuntime({ store: profile({ ...personalConfig, apiKey: "" }) });
  assert.match((await points.capabilities()).analysisStatus.message, /当前账号积分/); assert.equal(points.posts.length, 0);
});
