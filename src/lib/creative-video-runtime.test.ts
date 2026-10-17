import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

function videoRuntime(platform: Record<string, unknown> = { configured: false, models: [] }, sharedItems?: Map<string, string>, initialUsername = "alice") {
  const items = sharedItems || new Map<string, string>();
  const storage = {
    get length() { return items.size; },
    key: (index: number) => [...items.keys()][index],
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key)
  };
  let username: string | null = initialUsername;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/creative/native-video") {
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("X-Sanjie-Expected-Account")).toBe(`tenant-${username}:${username}`);
      return Response.json(platform);
    }
    if (url !== "/api/auth/me") throw new Error("Unexpected supplier request");
    return username
      ? Response.json({ data: { tenantId: `tenant-${username}`, username, creativeEntitlement: { allowed: true } } })
      : new Response(null, { status: 401 });
  });
  const context = vm.createContext({
    console, URL, URLSearchParams, Headers, Request, Response, FormData, Blob, ArrayBuffer, Uint8Array,
    AbortController, TextEncoder, TextDecoder, Promise, fetch, setTimeout, clearTimeout,
    localStorage: storage, sessionStorage: storage,
    location: { href: "https://shaozhuangai.com/creative/labs/ecommerce-video-studio/video-studio.html", origin: "https://shaozhuangai.com" }
  });
  context.window = context;
  // Match the real video HTML: shim, contract, website credentials, then backend.
  for (const file of ["web-chrome.js", "labs/ecommerce-video-studio/video-studio-contract.js", "web-video-host.js", "src/ecommerce-video-background.js"]) {
    const source = readFileSync(new URL(`../../public/creative/${file}`, import.meta.url), "utf8");
    vm.runInContext(source, context, { filename: file, timeout: 2000 });
  }
  async function capabilities() {
    // Construct the message in the browser realm, as the production UI does.
    return vm.runInContext(`new Promise(function (resolve) {
      chrome.runtime.sendMessage({ type: "VIDEO_STUDIO_CAPABILITIES", payload: {} }, resolve);
    })`, context);
  }
  function saveFixtureKey() {
    storage.setItem("sz.chrome.local.v1:sz_web_video_api_key_v1", JSON.stringify({ "tenant-alice:alice": "test-only-not-a-real-api-key" }));
  }
  return { context, fetch, capabilities, saveFixtureKey, items, switchUser: (value: string | null) => { username = value; } };
}

describe("video website account and credential contract", () => {
  it("carries the direct usage mode and zero reservation from the native API to browser capabilities", async () => {
    const runtime = videoRuntime({ configured: true, billingMode: "direct_usage", models: [{ id: "seedance-2.0",
      durations: [5], resolutions: ["720p"], ratios: ["16:9"], generateAudio: true, reservationCents: 0, estimateCents: 1000 }] });
    const response = await runtime.capabilities();
    expect(response).toMatchObject({ ok: true, payload: { provider: "shaozhuang-native", billingMode: "direct_usage", credentialAvailable: true } });
    expect(response.payload.models.find((model: { productKey: string }) => model.productKey === "seedance-2.0"))
      .toMatchObject({ nativePlatform: true, billingMode: "direct_usage", reservationCents: 0, estimateCents: 1000 });
    expect(response.payload.credentialStatus.message).toContain("提交时扣报价积分");
    expect(JSON.stringify(response)).not.toMatch(/100.*预占|冻结|0 积分/);
    expect(runtime.fetch.mock.calls.every(([url]) => ["/api/auth/me", "/api/creative/native-video"].includes(url))).toBe(true);
  });

  it("preserves a legacy native reservation when the API has not supplied direct usage mode", async () => {
    const runtime = videoRuntime({ configured: true, models: [{ id: "seedance-2.0", durations: [5],
      resolutions: ["720p"], ratios: ["16:9"], generateAudio: true, reservationCents: 1000 }] });
    const response = await runtime.capabilities();
    expect(response.payload.models.find((model: { productKey: string }) => model.productKey === "seedance-2.0"))
      .toMatchObject({ nativePlatform: true, reservationCents: 1000 });
    expect(response.payload.billingMode).not.toBe("direct_usage");
  });

  it("recognizes a signed-in account before any video API key is configured", async () => {
    const runtime = videoRuntime();
    const response = await runtime.capabilities();
    expect(response).toMatchObject({ ok: true, payload: {
      accountKey: "tenant-alice:alice", credentialAvailable: false,
      credentialStatus: { state: "missing", code: "CREDENTIALS_MISSING" }
    } });
    expect(runtime.fetch.mock.calls.every(([url]) => ["/api/auth/me", "/api/creative/native-video"].includes(url))).toBe(true);
    const credentials = await runtime.context.resolveUnifiedConfigReference({ accountKey: "tenant-alice:alice", provider: "doubao" });
    expect(credentials).toMatchObject({ ok: false, code: "CREDENTIALS_UNAVAILABLE", accountKey: "tenant-alice:alice" });
    expect(credentials.config).toBeUndefined();
  });

  it("continues to reject signed-out users even if a previous account has a saved key", async () => {
    const runtime = videoRuntime();
    runtime.saveFixtureKey();
    runtime.switchUser(null);
    expect(await runtime.capabilities()).toMatchObject({ ok: false, payload: { error: { code: "ACCOUNT_UNAVAILABLE" } } });
    const credentials = await runtime.context.resolveUnifiedConfigReference({});
    expect(credentials).toMatchObject({ ok: false, code: "ACCOUNT_UNAVAILABLE" });
    expect(credentials.accountKey).toBeUndefined();
    expect(credentials.user).toBeUndefined();
  });

  it("reports a saved key as ready without including the secret in public capabilities", async () => {
    const runtime = videoRuntime();
    runtime.saveFixtureKey();
    const response = await runtime.capabilities();
    expect(response).toMatchObject({ ok: true, payload: { accountKey: "tenant-alice:alice", credentialAvailable: true, credentialStatus: { state: "ready" } } });
    expect(JSON.stringify(response)).not.toContain("test-only-not-a-real-api-key");
    expect(runtime.fetch.mock.calls.every(([url]) => ["/api/auth/me", "/api/creative/native-video"].includes(url))).toBe(true);
  });

  it("does not carry credentials across an account switch or into the next page", async () => {
    const runtime = videoRuntime();
    runtime.saveFixtureKey();
    expect((await runtime.capabilities()).payload.credentialAvailable).toBe(true);
    const storedBefore = [...runtime.items.entries()];
    const requestsBeforeSwitch = runtime.fetch.mock.calls.filter(([url]) => url === "/api/creative/native-video").length;
    runtime.switchUser("bob");
    const changed = await runtime.capabilities();
    expect(changed).toMatchObject({ ok: false, payload: { error: { code: "ACCOUNT_UNAVAILABLE" } } });
    expect(changed.payload.accountKey).toBeUndefined();
    expect(changed.payload.credentialAvailable).not.toBe(true);
    expect(runtime.fetch.mock.calls.filter(([url]) => url === "/api/creative/native-video")).toHaveLength(requestsBeforeSwitch);
    const stalePage = await runtime.context.resolveUnifiedConfigReference({ accountKey: "tenant-alice:alice", provider: "doubao" });
    expect(stalePage).toMatchObject({ ok: false, code: "ACCOUNT_UNAVAILABLE" });
    expect(stalePage.config).toBeUndefined();
    expect(JSON.stringify([changed, stalePage])).not.toContain("test-only-not-a-real-api-key");
    expect([...runtime.items.entries()]).toEqual(storedBefore);

    // Refresh creates a new pinned page while retaining the exact legacy store.
    const fresh = videoRuntime({ configured: false, models: [] }, runtime.items, "bob");
    expect(await fresh.capabilities()).toMatchObject({ ok: true, payload: {
      accountKey: "tenant-bob:bob", credentialAvailable: false,
      credentialStatus: { state: "missing", code: "CREDENTIALS_MISSING" }
    } });
    const stale = await fresh.context.resolveUnifiedConfigReference({ accountKey: "tenant-alice:alice", provider: "doubao" });
    expect(stale).toMatchObject({ ok: false, code: "ACCOUNT_CHANGED" });
    expect(stale.config).toBeUndefined();
    expect(JSON.stringify(stale)).not.toContain("test-only-not-a-real-api-key");
    expect([...runtime.items.entries()]).toEqual(storedBefore);
  });
});
