import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const script = (path: string) => readFileSync(resolve("public/creative", path), "utf8");
function memoryStorage() {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] || null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }, values };
}
function webHarness(environment?: string) {
  let username = "alice";
  let allowed = true;
  let authMode: "ok" | "network" | "invalid" | number = "ok";
  const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
  const localStorage = memoryStorage();
  const context = createContext({ URL, URLSearchParams, Request, Headers, Response, Blob, FormData, TextEncoder, ArrayBuffer,
    Uint8Array, btoa, atob, console, setTimeout, clearTimeout, localStorage, __SANJIE_ENVIRONMENT: environment, sessionStorage: memoryStorage(),
    location: { href: "https://shaozhuangai.com/creative/labs/image-prompt-lab/promptlab.html", origin: "https://shaozhuangai.com" },
    fetch: async (input: unknown, init: RequestInit | undefined) => {
      calls.push({ input, init });
      if (input === "/api/auth/me") {
        if (authMode === "network") throw new Error("fixture connection interrupted");
        if (authMode === "invalid") return new Response("invalid JSON", { headers: { "content-type": "application/json" } });
        if (typeof authMode === "number") return Response.json({ error: "fixture unavailable" }, { status: authMode });
        return Response.json({ data: { tenantId: "shop", username, creativeEntitlement: { allowed } } });
      }
      return Response.json({ ok: true });
    } });
  runInContext(script("web-chrome.js"), context);
  return { context, localStorage, calls, setUser: (value: string) => { username = value; }, setAllowed: (value: boolean) => { allowed = value; },
    setAuthMode: (value: typeof authMode) => { authMode = value; } };
}

async function videoSettingsHarness() {
  const h = webHarness("creative-20261001");
  const account = (await h.context.authCheck()).user.id as string;
  await h.context.chrome.storage.local.set({ sz_web_video_api_key_v1: { [account]: "existing-account-key" } });
  let shown: (() => void) | undefined;
  let closed: (() => void) | undefined;
  const input = { value: "", focus: vi.fn() };
  const dialog = { id: "", style: { cssText: "" }, innerHTML: "", returnValue: "",
    querySelector: () => input, showModal: () => shown?.(), remove: vi.fn(),
    addEventListener: (name: string, listener: () => void) => { if (name === "close") closed = listener; } };
  h.context.document = { getElementById: (id: string) => id === "sz-web-account-expired" ? {} : null,
    createElement: () => dialog, body: { appendChild: vi.fn() } };
  runInContext(script("web-video-host.js"), h.context);
  const originalFetch = h.context.fetch;
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (input === "/api/creative/native-video") return Response.json({ configured: true,
      models: [{ id: "seedance-2.0", durations: [5], resolutions: [720], ratios: ["16:9"] }] });
    return originalFetch(input, init);
  });
  h.context.fetch = fetch;
  async function closeSettings(choice: string, beforeClose?: () => void) {
    const ready = new Promise<void>((resolveShown) => { shown = resolveShown; });
    const response = new Promise<Record<string, unknown>>((done) => h.context.chrome.runtime.sendMessage({ type: "OPEN_UNIFIED_API_SETTINGS" }, done));
    await ready;
    dialog.returnValue = choice;
    beforeClose?.();
    closed?.();
    return response;
  }
  return { ...h, account, input, fetch, closeSettings };
}

function videoStudioSettingsHarness(website = true) {
  let settingsResponse: ((response: unknown) => void) | undefined;
  const nativeModel = { productKey: "seedance-2.0", providerModel: "seedance-2.0", configured: true,
    nativePlatform: true, allowedDurations: [5], resolutions: ["720p"], ratios: ["16:9"] };
  const sendMessage = vi.fn((message: { type: string }, callback: (response: unknown) => void) => {
    if (message.type === "OPEN_UNIFIED_API_SETTINGS") settingsResponse = callback;
    if (message.type === "VIDEO_STUDIO_CAPABILITIES") callback({ ok: true, payload: {
      accountKey: "shop:alice", provider: "shaozhuang-native", credentialAvailable: true, models: [nativeModel] } });
  });
  const toasts: Array<{ className: string; textContent: string }> = [];
  const context = createContext({ console, setTimeout, clearTimeout,
    chrome: { runtime: { id: website ? "shaozhuang-web-studio" : "extension-id", sendMessage } }, SZEcommerceVideoStore: {},
    document: { readyState: "loading", addEventListener: vi.fn(), createElement: () => ({ className: "", textContent: "", parentNode: null }) } });
  runInContext(script("labs/ecommerce-video-studio/video-studio-contract.js"), context);
  const marker = "  if (globalThis.__SZ_VIDEO_STUDIO_EXPOSE_TESTING__ === true) {";
  runInContext(script("labs/ecommerce-video-studio/video-studio.js").replace(marker,
    "  renderRuntimeStatus = renderReadiness = renderModelCatalog = renderMode = renderAssets = updateEstimate = function () {};\n" +
    "  globalThis.__videoSettingsTest = { state: state, dom: dom, open: openVideoApiSettings };\n" + marker), context);
  const settings = context.__videoSettingsTest as {
    state: { accountKey: string; configOpenPending: boolean; awaitingConfigRefresh: boolean; credentialAvailable: boolean; modelCatalog: Array<{ nativePlatform: boolean }> };
    dom: { openApiSettings: { disabled: boolean }; toastRegion: { appendChild: (toast: { className: string; textContent: string }) => void } };
    open: () => Promise<void>;
  };
  settings.state.accountKey = "shop:alice";
  settings.dom.openApiSettings = { disabled: false };
  settings.dom.toastRegion = { appendChild: (toast) => { toasts.push(toast); } };
  return { settings, sendMessage, toasts, respond: (response: unknown) => settingsResponse?.(response) };
}

describe("website extension compatibility", () => {
  it.each(["network", "invalid", 429, 500, 503] as const)("recovers from transient auth failure %s without accepting any failed identity", async mode => {
    const h = webHarness();
    await h.context.chrome.storage.local.set({ draft: "saved original" });
    h.setAuthMode(mode);
    expect(await h.context.authCheck()).toMatchObject({ ok: false, reason: "auth_transient" });
    await expect(h.context.chrome.storage.local.set({ draft: "must not write" }))
      .rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE", retryable: true });
    expect(h.localStorage.getItem("sz.chrome.local.v1:account:shop%3Aalice:draft")).toBe('"saved original"');
    h.setAuthMode("ok");
    expect(await h.context.SZ_WEB_ACCOUNT.requireAccess()).toBe("shop:alice");
    expect(await h.context.chrome.storage.local.get("draft")).toEqual({ draft: "saved original" });
    h.setUser("bob");
    await expect(h.context.SZ_WEB_ACCOUNT.requireAccess()).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE", retryable: false });
    expect(h.localStorage.getItem("sz.chrome.local.v1:account:shop%3Abob:draft")).toBeNull();
  });

  it.each([401, 403])("keeps definitive auth rejection %s blocked after a pinned login", async status => {
    const h = webHarness();
    expect(await h.context.SZ_WEB_ACCOUNT.requireAccess()).toBe("shop:alice");
    h.setAuthMode(status);
    await expect(h.context.SZ_WEB_ACCOUNT.requireAccess()).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE", retryable: false });
    h.setAuthMode("ok");
    await expect(h.context.SZ_WEB_ACCOUNT.requireAccess()).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE", retryable: false });
  });

  it("shares the exact existing account storage-key format", () => {
    const h = webHarness();
    for (const id of ["shop:alice", "tenant+1:name@example.com", "店铺:账号", "a".repeat(200)]) {
      expect(h.context.SZ_WEB_ACCOUNT.storageKey(id)).toBe("user:" + id.replace(/[^\w@.+:-]/g, "_").slice(0, 120));
    }
  });

  it("checks identity and creative access in one fresh response per operation", async () => {
    const h = webHarness();
    expect(await h.context.SZ_WEB_ACCOUNT.requireAccess()).toBe("shop:alice");
    expect(h.calls.filter(call => call.input === "/api/auth/me")).toHaveLength(1);

    h.setAllowed(false);
    await expect(h.context.SZ_WEB_ACCOUNT.requireAccess()).rejects.toMatchObject({ code: "CREATIVE_ACCESS_REQUIRED" });
    expect(h.calls.filter(call => call.input === "/api/auth/me")).toHaveLength(2);

    h.setAllowed(true);
    h.setUser("bob");
    await expect(h.context.SZ_WEB_ACCOUNT.requireAccess()).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE" });
    expect(h.calls.filter(call => call.input === "/api/auth/me")).toHaveLength(3);
    await expect(h.context.SZ_WEB_ACCOUNT.requireAccess()).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE" });
    expect(h.calls.filter(call => call.input === "/api/auth/me")).toHaveLength(3);
  });

  it("shares concurrent access checks without retaining a stale entitlement", async () => {
    const h = webHarness();
    expect(await Promise.all([h.context.SZ_WEB_ACCOUNT.requireAccess(), h.context.SZ_WEB_ACCOUNT.requireAccess()]))
      .toEqual(["shop:alice", "shop:alice"]);
    expect(h.calls.filter(call => call.input === "/api/auth/me")).toHaveLength(1);
    h.setAllowed(false);
    await expect(h.context.SZ_WEB_ACCOUNT.requireAccess()).rejects.toMatchObject({ code: "CREATIVE_ACCESS_REQUIRED" });
    expect(h.calls.filter(call => call.input === "/api/auth/me")).toHaveLength(2);
  });

  it("copies only owned old profiles, retains the old records, and separates subsequent pages", async () => {
    const h = webHarness();
    const legacy = { accounts: { "user:shop:alice": { configs: { openai: { apiKey: "alice-key" } } }, "user:shop:bob": { configs: { openai: { apiKey: "bob-key" } } } } };
    h.localStorage.setItem("sz.chrome.local.v1:profiles", JSON.stringify(legacy));
    const result = await h.context.chrome.storage.local.get(["profiles"]);
    expect(Object.keys(result.profiles.accounts)).toEqual(["user:shop:alice"]);
    expect(h.localStorage.getItem("sz.chrome.local.v1:profiles")).toBe(JSON.stringify(legacy));
    await h.context.chrome.storage.local.set({ draft: { prompt: "alice draft" } });
    expect([...h.localStorage.values.keys()]).toContain("sz.chrome.local.v1:account:shop%3Aalice:draft");
    h.setUser("bob");
    const auth = await h.context.authCheck();
    expect(auth.ok).toBe(false);
    await expect(h.context.chrome.storage.local.set({ draft: "wrong user" })).rejects.toThrow("身份已失效");
    expect(h.localStorage.getItem("sz.chrome.local.v1:account:shop%3Abob:draft")).toBeNull();
  });

  it("does not claim unowned legacy credentials for a new account", async () => {
    const h = webHarness();
    h.localStorage.setItem("sz.chrome.local.v1:sz_image_prompt_lab_config", JSON.stringify({ apiKey: "unowned" }));
    expect(await h.context.chrome.storage.local.get(["sz_image_prompt_lab_config"])).toEqual({});
    expect(h.localStorage.getItem("sz.chrome.local.v1:sz_image_prompt_lab_config")).toContain("unowned");
  });

  it("forwards Request bytes and cancellation while enforcing paid access", async () => {
    const h = webHarness();
    const controller = new AbortController();
    await h.context.fetch(new Request("https://api.openai.com/v1/images/generations", {
      method: "POST", headers: { authorization: "Bearer account-key" }, body: "你好", signal: controller.signal
    }));
    const forwarded = h.calls.find((call) => call.input === "/api/creative/proxy");
    expect(forwarded?.init?.signal).toBeDefined();
    const payload = JSON.parse(String(forwarded?.init?.body));
    expect(payload.method).toBe("POST");
    expect(Buffer.from(payload.bodyBase64, "base64").toString()).toBe("你好");
    expect(payload.headers.authorization).toBe("Bearer account-key");
    h.setAllowed(false);
    await expect(h.context.fetch("https://api.openai.com/v1/images/generations", { method: "POST", body: "test" })).rejects.toThrow("尚未开通");
    expect(h.calls.filter((call) => call.input === "/api/creative/proxy")).toHaveLength(1);
  });

  it("rejects reserved upload fields rather than letting them replace proxy metadata", async () => {
    const h = webHarness();
    const body = new FormData();
    body.set("__sz_url", "https://example.test");
    await expect(h.context.fetch("https://api.openai.com/v1/images/edits", { method: "POST", body })).rejects.toThrow("保留名称");
    expect(h.calls.some((call) => call.input === "/api/creative/proxy")).toBe(false);
  });

  it("keeps worker handlers isolated from same-name page handlers and opens the website config modal", async () => {
    const h = webHarness();
    h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_MODE__ = true;
    h.context.document = { getElementById: () => null };
    h.context.openConfigModal = vi.fn();
    for (const file of ["src/business-knowledge.js", "src/subject-orchestration.js", "src/subject-assets.js", "src/reference-detail-contract.js",
      "labs/image-prompt-lab/reference-detail-blueprint.js", "labs/image-prompt-lab/reference-detail-batch.js", "labs/image-prompt-lab/viral-series-contract.js",
      "labs/image-prompt-lab/style-refresh-contract.js", "labs/image-prompt-lab/image-archive-store.js", "labs/image-prompt-lab/background.js"]) {
      runInContext(script(file), h.context);
    }
    h.context.openUnifiedApiSettings = vi.fn(() => { throw new Error("wrong page handler"); });
    const response = await new Promise((done) => h.context.chrome.runtime.sendMessage({ type: "OPEN_UNIFIED_API_SETTINGS" }, done));
    expect(response).toMatchObject({ ok: true, opened: true });
    expect(h.context.openConfigModal).toHaveBeenCalledOnce();
    expect(h.context.openUnifiedApiSettings).not.toHaveBeenCalled();
  });

  it.each(["cancel", ""])("treats video settings close %j as neutral cancellation without writing or refreshing", async (returnValue) => {
    const h = webHarness("creative-20261001");
    const account = (await h.context.authCheck()).user.id as string;
    const original = { [account]: "existing-account-key" };
    await h.context.chrome.storage.local.set({ sz_web_video_api_key_v1: original });
    const storageBefore = [...h.localStorage.values.entries()];
    const storageWrite = vi.spyOn(h.localStorage, "setItem");
    const runtimeSend = vi.spyOn(h.context.chrome.runtime, "sendMessage");
    let closeDialog: (() => void) | undefined;
    let markShown: () => void = () => {};
    const shown = new Promise<void>((resolveShown) => { markShown = resolveShown; });
    const input = { value: "", focus: vi.fn() };
    const dialog = {
      id: "", style: { cssText: "" }, innerHTML: "", returnValue,
      querySelector: () => input, showModal: vi.fn(() => { markShown(); }), remove: vi.fn(),
      addEventListener: (name: string, listener: () => void) => { if (name === "close") closeDialog = listener; }
    };
    type Toast = { className: string; textContent: string; parentNode: null };
    const toasts: Toast[] = [];
    h.context.document = {
      readyState: "loading", getElementById: () => null, addEventListener: vi.fn(), body: { appendChild: vi.fn() },
      createElement: (tag: string) => tag === "dialog" ? dialog : { className: "", textContent: "", parentNode: null }
    };
    h.context.setTimeout = vi.fn(() => 0);
    h.context.SZEcommerceVideoStore = {};
    runInContext(script("labs/ecommerce-video-studio/video-studio-contract.js"), h.context);
    runInContext(script("web-video-host.js"), h.context);
    const marker = "  if (globalThis.__SZ_VIDEO_STUDIO_EXPOSE_TESTING__ === true) {";
    const studio = script("labs/ecommerce-video-studio/video-studio.js");
    expect(studio).toContain(marker);
    runInContext(studio.replace(marker,
      "  globalThis.__videoSettingsTest = { state: state, dom: dom, open: openVideoApiSettings, focus: refreshAfterConfigReturn };\n" + marker), h.context);
    const settings = h.context.__videoSettingsTest as {
      state: { accountKey: string; awaitingConfigRefresh: boolean; configOpenPending: boolean };
      dom: { openApiSettings: { disabled: boolean }; toastRegion: { appendChild: (toast: Toast) => void } };
      open: () => Promise<void>; focus: () => void;
    };
    settings.state.accountKey = account;
    settings.dom.openApiSettings = { disabled: false };
    settings.dom.toastRegion = { appendChild: (toast) => { toasts.push(toast); } };
    const completion = settings.open();
    await shown;
    expect(input.value).toBe(original[account]);
    input.value = "unsaved-draft-key";
    expect(closeDialog).toBeTypeOf("function");
    closeDialog?.();
    await completion;
    settings.focus();
    expect(toasts).toEqual([{ className: "toast", textContent: "已取消视频 API 配置，未保存修改。", parentNode: null }]);
    expect(settings.state).toMatchObject({ accountKey: account, awaitingConfigRefresh: false, configOpenPending: false });
    expect(settings.dom.openApiSettings.disabled).toBe(false);
    expect(storageWrite).not.toHaveBeenCalled();
    expect([...h.localStorage.values.entries()]).toEqual(storageBefore);
    expect(runtimeSend).toHaveBeenCalledOnce();
    expect(runtimeSend.mock.calls[0][0]).toMatchObject({ type: "OPEN_UNIFIED_API_SETTINGS" });
    expect((await h.context.authCheck()).user.id).toBe(account);
    expect(h.calls.every((call) => call.input === "/api/auth/me")).toBe(true);
  });

  it("persists video credit selection without erasing the API key and switches back when an API key is saved", async () => {
    const h = await videoSettingsHarness();
    expect((await h.context.resolveUnifiedConfigReference({ accountKey: h.account })).config).toMatchObject({ apiKey: "existing-account-key", provider: "doubao" });
    expect(await h.closeSettings("platform_wallet", () => { h.input.value = "unsaved-key"; })).toMatchObject({ ok: true, saved: true, billingMode: "platform_wallet" });
    const stored = await h.context.chrome.storage.local.get(["sz_web_video_api_key_v1", "sz_web_video_billing_mode_v1"]);
    expect(stored).toEqual({ sz_web_video_api_key_v1: { [h.account]: "existing-account-key" }, sz_web_video_billing_mode_v1: { [h.account]: "platform_wallet" } });
    expect((await h.context.resolveUnifiedConfigReference({ accountKey: h.account })).config).toMatchObject({ apiKey: "", platformVideo: true, provider: "shaozhuang-native" });
    const storageBeforeCancel = [...h.localStorage.values.entries()];
    expect(await h.closeSettings("cancel", () => { expect(h.input.value).toBe("existing-account-key"); h.input.value = "cancelled-key"; })).toMatchObject({ cancelled: true });
    expect([...h.localStorage.values.entries()]).toEqual(storageBeforeCancel);
    expect(await h.closeSettings("save", () => { h.input.value = "new-account-key"; })).toMatchObject({ ok: true, saved: true, billingMode: "api" });
    expect((await h.context.resolveUnifiedConfigReference({ accountKey: h.account })).config).toMatchObject({ apiKey: "new-account-key", provider: "doubao" });
    expect(h.fetch.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("keeps video credit preference when native supply is unavailable rather than using the saved external API key", async () => {
    const h = await videoSettingsHarness();
    h.context.fetch = vi.fn(async () => Response.json({ configured: false, reason: { message: "视频供应未就绪" } }));
    expect(await h.closeSettings("platform_wallet")).toMatchObject({ ok: true, billingMode: "platform_wallet" });
    expect(await h.context.resolveUnifiedConfigReference({ accountKey: h.account })).toMatchObject({ ok: false, code: "CREDENTIALS_UNAVAILABLE", error: "视频供应未就绪" });
    expect(await h.context.chrome.storage.local.get(["sz_web_video_api_key_v1"])).toEqual({ sz_web_video_api_key_v1: { [h.account]: "existing-account-key" } });
  });

  it("refuses video billing mode changes when the account changes while the dialog is open", async () => {
    const h = await videoSettingsHarness();
    const original = [...h.localStorage.values.entries()];
    expect(await h.closeSettings("platform_wallet", () => { h.setUser("bob"); })).toMatchObject({ ok: false, code: "ACCOUNT_CHANGED" });
    expect([...h.localStorage.values.entries()]).toEqual(original);
  });

  it("reports failed video billing mode writes without claiming that credit selection was saved", async () => {
    const h = await videoSettingsHarness();
    vi.spyOn(h.localStorage, "setItem").mockImplementation(() => { throw new Error("浏览器存储已满"); });
    expect(await h.closeSettings("platform_wallet")).toMatchObject({ ok: false, error: "浏览器存储已满", message: "浏览器存储已满" });
    expect((await h.context.resolveUnifiedConfigReference({ accountKey: h.account })).config).toMatchObject({ apiKey: "existing-account-key", provider: "doubao" });
  });

  it("waits for a website video dialog choice beyond the message deadline and refreshes capabilities after saving", async () => {
    vi.useFakeTimers();
    try {
      const h = videoStudioSettingsHarness();
      const completion = h.settings.open();
      await vi.advanceTimersByTimeAsync(30000);
      expect(h.settings.state.configOpenPending).toBe(true);
      expect(h.settings.dom.openApiSettings.disabled).toBe(true);
      expect(h.toasts).toEqual([]);
      expect(h.sendMessage.mock.calls.map(([message]) => message.type)).toEqual(["OPEN_UNIFIED_API_SETTINGS"]);
      h.respond({ ok: true, saved: true, billingMode: "platform_wallet" });
      await completion;
      expect(h.sendMessage.mock.calls.map(([message]) => message.type)).toEqual(["OPEN_UNIFIED_API_SETTINGS", "VIDEO_STUDIO_CAPABILITIES"]);
      expect(h.settings.state).toMatchObject({ configOpenPending: false, awaitingConfigRefresh: false, credentialAvailable: true });
      expect(h.settings.state.modelCatalog.some((model) => model.nativePlatform)).toBe(true);
      expect(h.settings.dom.openApiSettings.disabled).toBe(false);
      expect(h.toasts.every((toast) => !toast.className.includes("is-error"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the extension video settings connection deadline", async () => {
    vi.useFakeTimers();
    try {
      const h = videoStudioSettingsHarness(false);
      const completion = h.settings.open();
      await vi.advanceTimersByTimeAsync(15000);
      await completion;
      expect(h.settings.state.configOpenPending).toBe(false);
      expect(h.settings.dom.openApiSettings.disabled).toBe(false);
      expect(h.toasts).toHaveLength(1);
      expect(h.toasts[0].textContent).toContain("后台响应超时");
      expect(h.sendMessage.mock.calls.map(([message]) => message.type)).toEqual(["OPEN_UNIFIED_API_SETTINGS"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

function videoStoreHarness(environment?: string) {
  const openedDatabases: string[] = [];
  let account = "shop:alice";
  const records: Record<string, Map<string, Record<string, unknown>>> = { assets: new Map(), drafts: new Map(), runs: new Map() };
  const db = { onversionchange: null, close() {}, transaction: (storeName: string) => {
    const tx = { oncomplete: null as (() => void) | null, onerror: null as (() => void) | null, onabort: null as (() => void) | null, abort() {}, objectStore: () => store };
    const values = records[storeName];
    const request = (work: () => unknown) => {
      const req = { onsuccess: null as (() => void) | null, onerror: null as (() => void) | null, result: undefined as unknown };
      queueMicrotask(() => { req.result = work(); req.onsuccess?.(); tx.oncomplete?.(); });
      return req;
    };
    const store = {
      put: (value: Record<string, unknown>) => request(() => { const key = String(storeName === "drafts" ? value.mode : value.id); values.set(key, value); return key; }),
      get: (key: string) => request(() => values.get(key)), delete: (key: string) => request(() => values.delete(key)),
      getAll: () => request(() => [...values.values()]), index: (field: string) => ({ getAll: (value: unknown) => request(() => [...values.values()].filter((record) => record[field] === value)) })
    };
    return tx;
  } };
  const indexedDB = { open: (name: string) => {
    openedDatabases.push(name);
    const request = { onsuccess: null as ((event: { target: { result: typeof db } }) => void) | null, onerror: null as (() => void) | null };
    queueMicrotask(() => request.onsuccess?.({ target: { result: db } }));
    return request;
  } };
  const context = createContext({ Blob, structuredClone, console, indexedDB, __SANJIE_ENVIRONMENT: environment, SZ_WEB_ACCOUNT: { require: async () => account } });
  runInContext(script("labs/ecommerce-video-studio/video-studio-store.js"), context);
  return { store: context.SZEcommerceVideoStore, records, openedDatabases, setAccount: (next: string) => { account = next; } };
}

describe("website video local records", () => {
  it("keeps assets, drafts and history for their original account across switches", async () => {
    const h = videoStoreHarness();
    const original = new Blob(["original"], { type: "image/png" });
    await h.store.saveAsset(original, { id: "asset-a", kind: "image" });
    await h.store.saveDraft("direct", { mode: "direct", prompt: "alice draft", assets: { image: [{ storageRef: { id: "asset-a" } }] } });
    await h.store.saveRun({ id: "run-a", status: "succeeded", accountKey: "shop:alice" });
    expect((await h.store.getAsset("asset-a")).blob).toBe(original);
    h.setAccount("shop:bob");
    expect(await h.store.getAsset("asset-a")).toBeUndefined();
    expect(await h.store.getDraft("direct")).toBeNull();
    expect(await h.store.listRuns()).toEqual([]);
    await expect(h.store.deleteAsset("asset-a")).rejects.toThrow("当前账号");
    await expect(h.store.saveRun({ id: "run-a", accountKey: "shop:alice" })).rejects.toThrow("其他账号");
    await h.store.saveDraft("direct", { mode: "direct", prompt: "bob draft" });
    h.setAccount("shop:alice");
    expect((await h.store.getDraft("direct")).data.prompt).toBe("alice draft");
    expect(await h.store.listRuns()).toHaveLength(1);
    expect((await h.store.getAsset("asset-a")).blob).toBe(original);
  });

  it("preserves unowned legacy data and reads a legacy asset only through an owned history reference", async () => {
    const h = videoStoreHarness();
    h.records.assets.set("legacy", { id: "legacy", blob: new Blob(["legacy"]) });
    h.records.drafts.set("direct", { mode: "direct", data: { mode: "direct", prompt: "unknown owner" } });
    expect(await h.store.getAsset("legacy")).toBeUndefined();
    expect(await h.store.getDraft("direct")).toBeNull();
    h.records.runs.set("run-old", { id: "run-old", accountKey: "shop:alice", request: { images: [{ storageRef: { id: "legacy" } }] } });
    expect((await h.store.getAsset("legacy")).id).toBe("legacy");
    h.setAccount("shop:bob");
    expect(await h.store.getAsset("legacy")).toBeUndefined();
    expect(h.records.assets.has("legacy")).toBe(true);
    expect(h.records.drafts.get("direct")).toMatchObject({ data: { prompt: "unknown owner" } });
  });
});


describe("isolated test browser persistence", () => {
  it("uses test-only storage and databases without claiming production records", async () => {
    const h = webHarness("creative-uat-20261001");
    h.localStorage.setItem("sz.chrome.local.v1:profiles", JSON.stringify({ accounts: { "user:shop:alice": { apiKey: "prod-key" } } }));
    expect(await h.context.chrome.storage.local.get(["profiles"])).toEqual({});
    await h.context.chrome.storage.local.set({ draft: "test-only" });
    expect(h.localStorage.getItem("sz.chrome.local.v1:environment:creative-uat-20261001:account:shop%3Aalice:draft")).toContain("test-only");
    expect(h.localStorage.getItem("sz.chrome.local.v1:profiles")).toContain("prod-key");
    runInContext(script("labs/image-prompt-lab/image-archive-store.js"), h.context);
    expect(h.context.SZ_IMAGE_ARCHIVE.DB_NAME).toBe("sz_image_archive_v1:environment:creative-uat-20261001");
    const video = videoStoreHarness("creative-uat-20261001");
    const asset = await video.store.saveAsset(new Blob(["fixture"]), { id: "uat-asset" });
    expect(video.openedDatabases).toEqual(["sz_ecommerce_video_studio:environment:creative-uat-20261001"]);
    expect(asset.storageRef.dbName).toBe("sz_ecommerce_video_studio");
  });
});
