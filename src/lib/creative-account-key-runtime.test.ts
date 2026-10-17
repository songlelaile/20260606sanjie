import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createContext, runInContext, type Context } from "node:vm";

const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const filesystemPublish = vi.hoisted(() => ({
  beforeRename: undefined as ((from: string, to: string) => Promise<void>) | undefined,
  failure: undefined as NodeJS.ErrnoException | undefined
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: auth.currentUser }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    await filesystemPublish.beforeRename?.(String(args[0]), String(args[1]));
    try { return await actual.rename(...args); }
    catch (error) { filesystemPublish.failure = error as NodeJS.ErrnoException; throw error; }
  } };
});
import { GET, POST, PUT, DELETE } from "@/app/api/creative/config-profiles/route";
import { creativeConfigAccountKey, getCreativeConfigProfiles, resolveCreativeConfigProfile, type CreativeConfigOwner } from "./creative-config-profile-store";

const ALICE = { id: "synthetic-immutable-A", tenantId: "synthetic-tenant-A", username: "same-username" };
const BOB = { id: "synthetic-immutable-B", tenantId: "synthetic-tenant-B", username: "same-username" };
const RECREATED_ALICE = { ...ALICE, id: "synthetic-recreated-immutable-A" };
const KEY_A = "synthetic-image-key-owned-by-A";
const KEY_NEW = "synthetic-image-key-A-explicit-replacement";
const PROVIDER = "openai-compatible";
const PROFILES_KEY = "sz_image_prompt_lab_config_profiles_v2";
const CONFIG_A = { provider: PROVIDER, apiKey: KEY_A, imageAdapter: "generic-json", visionBaseUrl: "https://sub.shaozhuangai.com/v1",
  imageEndpoint: "https://sub.shaozhuangai.com/v1/images/generations", visionModel: "private-vision-model", textModel: "private-text-model", imageModel: "gpt-image-2.5-sunburst" };
const ROUTE = "/api/creative/config-profiles";
const ORIGIN = "https://studio.example.test";
const requestOwner = new AsyncLocalStorage<CreativeConfigOwner>();
const assetRoot = path.resolve(process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative");
const asset = (name: string) => readFileSync(path.join(assetRoot, name), "utf8");
type Config = Record<string, string | number | boolean>;
type Reply = { ok: boolean; code?: string; error?: string; accountKey?: string; config?: Config; activeProvider?: string; activeSupplyChannel?: string;
  providerSubmitted?: boolean; definitiveFailure?: boolean; stateUncertain?: boolean; cacheSaved?: boolean; cacheWarning?: string; accountRevision?: number };
type RequestBudget = { attempts: number; limit: number };
type ApiRequest = { method: string; body: Record<string, unknown>; status: number };
type Runtime = Context & {
  chrome: { storage: { local: { set(value: object, callback?: () => void): Promise<void> } }; runtime: { sendMessage(message: object, callback: (reply: Reply) => void): void } };
  SZ_WEB_ACCOUNT: { supportsConfigProfiles: boolean; usesPlatformWallet(config: Config, kind: string): boolean };
  __SZ_PROMPTLAB_BACKGROUND_TEST_API__: { normalizeCfg(value: object): Config; createImageTask(config: Config, payload: object): Promise<Reply>;
    resolveUnifiedConfigReference(reference: object): Promise<Reply>;
    referenceDetailModelJson(config: Config, messages: object[], signal: AbortSignal | undefined, budget: RequestBudget, reserve: number, preconsumed?: boolean): Promise<Reply>;
    createImageTranslationEdit(config: Config, payload: object, dataUrl: string, ocr: object): Promise<Reply> };
};
function memoryStorage() {
  const values = new Map<string, string>();
  return { values, get length() { return values.size; }, key: (index: number) => [...values.keys()][index] || null,
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); }, removeItem: (name: string) => { values.delete(name); } };
}
const rawScripts = ["web-chrome.js", "src/business-knowledge.js", "src/subject-orchestration.js", "src/subject-assets.js", "src/reference-detail-contract.js",
  "labs/image-prompt-lab/reference-detail-blueprint.js", "labs/image-prompt-lab/reference-detail-batch.js", "labs/image-prompt-lab/viral-series-contract.js",
  "labs/image-prompt-lab/style-refresh-contract.js", "labs/image-prompt-lab/creative-tools-contract.js", "labs/image-prompt-lab/image-archive-store.js", "labs/image-prompt-lab/background.js"];
const loadedScripts = ["web-chrome.js", "labs/image-prompt-lab/studio-prerequisites-20261009-v1.js", "labs/image-prompt-lab/viral-series-contract.js", "labs/image-prompt-lab/studio-runtime-20261010-credit-v3.js"];

function browser(variant: "raw" | "loaded", owner: CreativeConfigOwner = ALICE) {
  const localStorage = memoryStorage(), sessionStorage = memoryStorage(), requests: ApiRequest[] = [], providerRequests: string[] = [];
  const syntheticDispatches: { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const state = { authFailure: "" as "" | "503" | "malformed" | "network", allowSyntheticProvider: false, expectedProviderCalls: 0,
    cloudProfilesEnabled: true, beforeProfileResolve: undefined as (() => Promise<void>) | undefined,
    beforeSelectionWrite: undefined as (() => Promise<void>) | undefined,
    forcedSelectionFailure: undefined as { status: number; code: string } | undefined,
    failProfileReadAfterMutation: false, mutationCommitted: false,
    providerResponse: { data: [{ url: "https://synthetic-results.example.test/one-fixture-image.png" }],
      choices: [{ message: { content: '{"syntheticVerified":true}' } }] } as Record<string, unknown>, providerStatus: 200 };
  async function nativeFetch(input: string | URL | Request, init: RequestInit = {}) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "/api/auth/me") {
      if (state.authFailure === "network") throw new TypeError("Synthetic auth transport failure");
      if (state.authFailure === "503") return new Response(null, { status: 503 });
      if (state.authFailure === "malformed") return new Response("not-json", { status: 200 });
      return Response.json({ data: { tenantId: owner.tenantId, username: owner.username, creativeConfigProfilesVersion: state.cloudProfilesEnabled ? 1 : 0, creativeEntitlement: { allowed: true } } });
    }
    if (url === ROUTE) {
      const method = String(init.method || "GET").toUpperCase();
      const headers = new Headers(init.headers);
      // Browser Fetch supplies this header; the real route rejects its absence.
      if (method !== "GET") headers.set("Origin", ORIGIN);
      const request = new Request(ORIGIN + ROUTE, { ...init, method, headers });
      const handlers: Record<string, (request: Request) => Promise<Response>> = { GET, POST, PUT, DELETE };
      if (!handlers[method]) throw new Error("Unexpected config method");
      const body: Record<string, unknown> = typeof init.body === "string" ? JSON.parse(init.body) : {};
      if (method === "POST" && body.operation === "resolveAll") {
        if (state.beforeProfileResolve) await state.beforeProfileResolve();
        if (state.failProfileReadAfterMutation && state.mutationCommitted) {
          requests.push({ method, body, status: 503 }); return new Response(null, { status: 503 });
        }
      }
      if (method === "PUT" && body.selection && body.provider === undefined) {
        if (state.beforeSelectionWrite) await state.beforeSelectionWrite();
        if (state.forcedSelectionFailure) {
          const { status, code } = state.forcedSelectionFailure;
          requests.push({ method, body, status }); return Response.json({ code, error: "Synthetic failure text must not be displayed" }, { status });
        }
      }
      const response = await requestOwner.run(owner, () => handlers[method](request));
      requests.push({ method, body, status: response.status });
      if ((method === "PUT" || method === "DELETE") && response.ok && body.importOnly !== true) state.mutationCommitted = true;
      return response;
    }
    providerRequests.push(url);
    if (url === "/api/creative/proxy" && state.allowSyntheticProvider) {
      const envelope = JSON.parse(String(init.body)) as { url: string; method: string; headers: Record<string, string>; bodyText: string };
      syntheticDispatches.push({ url: envelope.url, method: envelope.method, headers: envelope.headers, body: JSON.parse(envelope.bodyText) as Record<string, unknown> });
      return Response.json(state.providerResponse, { status: state.providerStatus });
    }
    throw new Error("A configuration operation attempted an unexpected provider request");
  }
  const context = createContext({ URL, URLSearchParams, Request, Headers, Response, Blob, FormData, TextEncoder, TextDecoder,
    ArrayBuffer, Uint8Array, btoa, atob, AbortController, crypto: webcrypto,
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }, localStorage, sessionStorage,
    __SZ_PROMPTLAB_BACKGROUND_TEST_MODE__: true, __SZ_PROMPTLAB_TEST_MODE__: true,
    location: { href: ORIGIN + "/creative/labs/image-prompt-lab/promptlab.html?studio=1", origin: ORIGIN, search: "?studio=1" },
    document: { readyState: "loading", getElementById: () => null, addEventListener() {}, querySelectorAll: () => [],
      createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, appendChild() {} }),
      body: { appendChild() {}, classList: { contains: () => false, toggle() {} } } }, addEventListener() {},
    navigator: { locks: { request(_name: string, _options: unknown, work: (lock: object) => unknown) { return Promise.resolve(work({})); } } },
    setTimeout(callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) {
      const timer = setTimeout(() => { timers.delete(timer); callback(...args); }, milliseconds); timers.add(timer); return timer;
    }, clearTimeout(timer: ReturnType<typeof setTimeout>) { timers.delete(timer); clearTimeout(timer); }, fetch: nativeFetch }) as Runtime;
  context.window = context;
  for (const file of variant === "raw" ? rawScripts : loadedScripts) runInContext(asset(file), context, { filename: file, timeout: 3000 });
  function send(type: string, payload: object = {}) {
    return new Promise<Reply>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Synthetic config runtime did not reply")), 2500);
      context.chrome.runtime.sendMessage({ type, ...payload }, reply => { clearTimeout(timeout); resolve(reply); });
    });
  }
  return { context, localStorage, requests, providerRequests, syntheticDispatches, state, send,
    switchOwner(next: CreativeConfigOwner) { owner = next; },
    async seed(config = CONFIG_A) {
      await context.chrome.storage.local.set({ [PROFILES_KEY]: { version: 2, activeAccount: creativeConfigAccountKey(owner), configs: {}, legacyConfigImports: {},
        accounts: { [creativeConfigAccountKey(owner)]: { activeProvider: config.provider, activeSupplyChannel: "external_key", configs: { [config.provider]: config } } } } });
    },
    read: () => send("GET_CONFIG_PROFILE", { provider: PROVIDER }),
    dispose() { for (const timer of timers) clearTimeout(timer); timers.clear(); }
  };
}

describe.each(["raw", "loaded"] as const)("%s browser account profile bridge to real encrypted server storage", variant => {
  let temporary: string, root: string;
  const browsers: ReturnType<typeof browser>[] = [];
  function page(owner = ALICE) { const runtime = browser(variant, owner); browsers.push(runtime); return runtime; }
  async function importedPage() { const runtime = page(); await runtime.seed(); const reply = await runtime.read(); expect(reply.ok).toBe(true); return { runtime, reply }; }
  async function seedRows(runtime: ReturnType<typeof page>, entries: [string, object][], activeProvider: string) {
    const owner = creativeConfigAccountKey(ALICE);
    await runtime.context.chrome.storage.local.set({ [PROFILES_KEY]: { version: 2, activeAccount: owner, configs: {}, legacyConfigImports: {},
      accounts: { [owner]: { activeProvider, activeSupplyChannel: "external_key", configs: Object.fromEntries(entries) } } } });
  }
  async function serverImport(config: object, provider = PROVIDER) {
    const snapshot = await serverSnapshot();
    const response = await requestOwner.run(ALICE, () => PUT(new Request(ORIGIN + ROUTE, { method: "PUT",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ accountKey: creativeConfigAccountKey(ALICE), ownerFingerprint: snapshot.ownerFingerprint, provider, config, revision: 0, importOnly: true }) })));
    expect(response.status).toBe(200);
  }
  async function serverSnapshot() {
    const response = await requestOwner.run(ALICE, () => POST(new Request(ORIGIN + ROUTE, { method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ accountKey: creativeConfigAccountKey(ALICE), operation: "resolveAll" }) })));
    expect(response.status).toBe(200);
    return (await response.json() as { data: { ownerFingerprint: string } }).data;
  }
  async function ciphertext() { return readFile(path.join(root, (await readdir(root)).find(name => name.endsWith(".json"))!)); }
  beforeEach(async () => {
    filesystemPublish.beforeRename = undefined; filesystemPublish.failure = undefined;
    temporary = await realpath(await mkdtemp(path.join(tmpdir(), "creative-account-key-runtime-"))); root = path.join(temporary, "profiles");
    vi.stubEnv("SANJIE_CREATIVE_CONFIG_ROOT", root); vi.stubEnv("AI_API_ENCRYPTION_KEY", "synthetic-runtime-independent-key-0123456789abcdef");
    auth.currentUser.mockImplementation(async () => requestOwner.getStore() || null);
  });
  afterEach(async () => {
    filesystemPublish.beforeRename = undefined;
    for (const runtime of browsers.splice(0)) { expect(runtime.providerRequests).toHaveLength(runtime.state.expectedProviderCalls); runtime.dispose(); }
    vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(temporary, { recursive: true, force: true });
  });

  it("imports the existing A binding and restores its exact provider/model/Key in a second empty browser", async () => {
    const { runtime, reply } = await importedPage();
    expect(runtime.requests.some(request => request.method === "PUT" && request.body.importOnly === true)).toBe(true);
    expect(reply.config?._ownerFingerprint).toMatch(/^[a-f0-9]{64}$/);
    for (const request of runtime.requests.filter(request => request.method === "PUT")) expect(request.body.ownerFingerprint).toBe(reply.config?._ownerFingerprint);
    const cached = JSON.parse(runtime.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY)!) as { accounts: Record<string, { _serverOwnerFingerprint: string }> };
    expect(cached.accounts[creativeConfigAccountKey(ALICE)]._serverOwnerFingerprint).toBe(reply.config?._ownerFingerprint);
    const raw = await ciphertext(); expect(raw.toString()).not.toContain(KEY_A);
    const fresh = page(); expect(fresh.localStorage.values.size).toBe(0);
    expect(await fresh.read()).toMatchObject({ ok: true, accountKey: creativeConfigAccountKey(ALICE), config: CONFIG_A });
    expect((await resolveCreativeConfigProfile(ALICE, PROVIDER)).config).toMatchObject(CONFIG_A);
    expect(fresh.requests.some(request => request.method === "PUT")).toBe(false);
  });

  it("imports an owned Jimeng alias once without upgrading its models or transmitting an unknown legacy profile", async () => {
    const runtime = page(), owner = creativeConfigAccountKey(ALICE);
    const legacy = { provider: "jimeng", imageAdapter: "jimeng-image", apiKey: "synthetic-owned-legacy-jimeng-key",
      visionBaseUrl: "https://ark.cn-beijing.volces.com/api/v3", imageEndpoint: "https://ark.cn-beijing.volces.com/api/v3/images/generations",
      visionModel: "doubao-1.5-vision-pro", textModel: "doubao-1.5-pro", imageModel: "doubao-seedream-3-0-t2i-250415" };
    const unknown = { provider: "retired-experimental-provider", apiKey: "synthetic-unknown-local-only-key", imageModel: "legacy-local-model", legacyOption: "PRESERVE_EXACT_LOCAL_ROW" };
    const unknownBefore = JSON.stringify(unknown);
    await runtime.context.chrome.storage.local.set({ [PROFILES_KEY]: { version: 2, activeAccount: owner, configs: {}, legacyConfigImports: {},
      accounts: { [owner]: { activeProvider: "jimeng", activeSupplyChannel: "external_key", configs: { jimeng: legacy, "retired-experimental-provider": unknown } } } } });
    const reply = await runtime.send("GET_CONFIG_PROFILE", { provider: "doubao" });
    const expected = { ...legacy, provider: "doubao", imageAdapter: "doubao-image", _supplyChannel: "external_key" };
    expect(reply).toMatchObject({ ok: true, accountKey: owner, activeProvider: "doubao", activeSupplyChannel: "external_key", config: expected });
    expect(runtime.requests.filter(request => request.method === "PUT" && request.body.importOnly === true).map(request => request.body.provider)).toEqual(["doubao"]);
    expect(JSON.stringify(runtime.requests)).not.toContain(unknown.apiKey);
    expect(JSON.stringify(runtime.requests)).not.toContain(unknown.provider);
    const cached = JSON.parse(runtime.localStorage.values.get("sz.chrome.local.v1:" + PROFILES_KEY)!) as { accounts: Record<string, { configs: Record<string, unknown> }> };
    expect(JSON.stringify(cached.accounts[owner].configs[unknown.provider])).toBe(unknownBefore);
    expect((await getCreativeConfigProfiles(ALICE)).profiles.map(profile => profile.provider)).toEqual(["doubao"]);
    const fresh = page(); expect(fresh.localStorage.values.size).toBe(0);
    expect(await fresh.send("GET_CONFIG_PROFILE")).toMatchObject({ ok: true, activeProvider: "doubao", activeSupplyChannel: "external_key", config: expected });
    expect(fresh.requests.some(request => request.method === "PUT")).toBe(false);
    expect(fresh.context.SZ_WEB_ACCOUNT.usesPlatformWallet(expected, "image")).toBe(false);
  });

  const sparseJimeng = { provider: "jimeng", apiKey: "synthetic-sparse-jimeng-key", visionModel: "Exact_Old_Vision_Model",
    textModel: "Exact_Old_Text_Model", imageModel: "doubao-seedream-3-0-t2i-250415" };
  const canonicalDoubao = { ...sparseJimeng, provider: "doubao", apiKey: "synthetic-canonical-doubao-K2" };
  it("canonicalizes a sparse Jimeng alias before defaults without sending its Key to hosted endpoints or upgrading supplied models", async () => {
    const runtime = page();
    expect(runtime.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.normalizeCfg(sparseJimeng)).toMatchObject({ ...sparseJimeng,
      provider: "doubao", imageAdapter: "doubao-image", visionBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      imageEndpoint: "https://ark.cn-beijing.volces.com/api/v3/images/generations" });
    await seedRows(runtime, [["jimeng", sparseJimeng]], "jimeng");
    expect(await runtime.send("GET_CONFIG_PROFILE", { provider: "doubao" })).toMatchObject({ ok: true, config: { ...sparseJimeng,
      provider: "doubao", imageAdapter: "doubao-image", visionBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      imageEndpoint: "https://ark.cn-beijing.volces.com/api/v3/images/generations" } });
    expect(runtime.requests.filter(request => request.method === "PUT" && request.body.importOnly === true)).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ provider: "doubao", config: expect.objectContaining({ apiKey: sparseJimeng.apiKey, imageModel: sparseJimeng.imageModel }) }) })
    ]);
  });

  it.each(["alias-first", "canonical-first"] as const)("imports the explicitly selected canonical Key independently of %s object order and retains the inactive alias", async order => {
    const runtime = page(), rows: [string, object][] = [["jimeng", sparseJimeng], ["doubao", canonicalDoubao]];
    await seedRows(runtime, order === "alias-first" ? rows : [...rows].reverse(), "doubao");
    expect(await runtime.send("GET_CONFIG_PROFILE", { provider: "doubao" })).toMatchObject({ ok: true, config: { ...canonicalDoubao, imageModel: sparseJimeng.imageModel } });
    const imported = runtime.requests.filter(request => request.method === "PUT" && request.body.importOnly === true);
    expect(imported).toHaveLength(1); expect(imported[0].body.config).toMatchObject(canonicalDoubao);
    expect(JSON.stringify(imported)).not.toContain(sparseJimeng.apiKey);
    const cached = JSON.parse(runtime.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY)!) as { accounts: Record<string, { configs: Record<string, Config> }> };
    expect(cached.accounts[creativeConfigAccountKey(ALICE)].configs.jimeng).toMatchObject({ apiKey: sparseJimeng.apiKey, imageModel: sparseJimeng.imageModel });
  });

  it.each(["alias-first", "canonical-first"] as const)("blocks an active alias/canonical collision before any partial import in %s order", async order => {
    const runtime = page(), rows: [string, object][] = [[PROVIDER, CONFIG_A], ["jimeng", sparseJimeng], ["doubao", canonicalDoubao]];
    await seedRows(runtime, order === "alias-first" ? rows : [...rows].reverse(), "jimeng");
    const localBefore = runtime.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY);
    expect(await runtime.send("GET_CONFIG_PROFILE")).toMatchObject({ ok: false, code: "CONFIG_LEGACY_ALIAS_CONFLICT" });
    expect(runtime.requests.some(request => request.method === "PUT")).toBe(false);
    expect(runtime.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY)).toBe(localBefore);
    expect((await getCreativeConfigProfiles(ALICE, true)).profiles).toEqual([]);
  });

  it.each(["saved-profile", "unlink-tombstone"] as const)("an authoritative %s wins over both legacy aliases without collision reimport", async state => {
    await serverImport({ ...canonicalDoubao, imageAdapter: "doubao-image", visionBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      imageEndpoint: "https://ark.cn-beijing.volces.com/api/v3/images/generations" }, "doubao");
    if (state === "unlink-tombstone") {
      const snapshot = await serverSnapshot();
      const response = await requestOwner.run(ALICE, () => DELETE(new Request(ORIGIN + ROUTE, { method: "DELETE",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ accountKey: creativeConfigAccountKey(ALICE), ownerFingerprint: snapshot.ownerFingerprint, provider: "doubao", revision: 1 }) })));
      expect(response.status).toBe(200);
    }
    const runtime = page(); await seedRows(runtime, [["jimeng", sparseJimeng], ["doubao", canonicalDoubao]], "jimeng");
    expect(await runtime.send("GET_CONFIG_PROFILE", { provider: "doubao" })).toMatchObject({ ok: true, config: {
      provider: "doubao", apiKey: state === "unlink-tombstone" ? "" : canonicalDoubao.apiKey, imageModel: canonicalDoubao.imageModel } });
    expect(runtime.requests.some(request => request.method === "PUT" && request.body.importOnly === true)).toBe(false);
  });

  it("reconciles two real first-bootstrap selection CAS attempts to the existing winner without retrying either mutation", async () => {
    const doubao = { ...canonicalDoubao, imageAdapter: "doubao-image", visionBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      imageEndpoint: "https://ark.cn-beijing.volces.com/api/v3/images/generations" };
    await serverImport(CONFIG_A); await serverImport(doubao, "doubao");
    const first = page(), second = page(); await first.seed(); await second.seed(doubao);
    let release!: () => void, arrivals = 0;
    const bothReady = new Promise<void>(resolve => { release = resolve; });
    first.state.beforeSelectionWrite = second.state.beforeSelectionWrite = () => { if (++arrivals === 2) release(); return bothReady; };
    const replies = await Promise.all([first.send("GET_CONFIG_PROFILE"), second.send("GET_CONFIG_PROFILE")]);
    const persisted = await getCreativeConfigProfiles(ALICE, true);
    expect(persisted.selection.activeProvider).toBeTruthy();
    for (const reply of replies) expect(reply).toMatchObject({ ok: true, activeProvider: persisted.selection.activeProvider,
      config: persisted.selection.activeProvider === PROVIDER ? CONFIG_A : doubao });
    const writes = [...first.requests, ...second.requests].filter(request => request.method === "PUT");
    expect(writes).toHaveLength(2); expect(writes.map(request => request.status).sort()).toEqual([200, 409]);
    expect(first.requests.filter(request => request.method === "POST")).toHaveLength(2);
    expect(second.requests.filter(request => request.method === "POST")).toHaveLength(2);
    expect(persisted.accountRevision).toBe(3);
  });

  it.each([
    { status: 409, code: "CONFIG_REVISION_CONFLICT", reads: 2 },
    { status: 409, code: "ACCOUNT_CHANGED", reads: 1 },
    { status: 503, code: "CONFIG_BUSY", reads: 1 }
  ])("does not accept or retry a bootstrap $code when no authoritative concurrent selection exists", async failure => {
    await serverImport(CONFIG_A); const runtime = page(); await runtime.seed();
    runtime.state.forcedSelectionFailure = failure; const before = await ciphertext();
    const response = await runtime.send("GET_CONFIG_PROFILE"); expect(response.ok).toBe(false);
    expect(runtime.requests.filter(request => request.method === "PUT")).toHaveLength(1);
    expect(runtime.requests.filter(request => request.method === "POST")).toHaveLength(failure.reads);
    expect((await getCreativeConfigProfiles(ALICE, true)).selection.activeProvider).toBe("");
    expect(await ciphertext()).toEqual(before);
  });

  it("keeps an unedited bound Key scoped to its saved endpoint and returns the real route's actionable error", async () => {
    const { runtime, reply } = await importedPage(), before = await ciphertext();
    const response = await runtime.send("SAVE_CONFIG", { config: { ...reply.config, _keyEdited: false,
      imageEndpoint: "https://different-explicit-endpoint.example.test/v1/images/generations" } });
    expect(response).toMatchObject({ ok: false, code: "CONFIG_CREDENTIAL_SCOPE_CHANGED" });
    expect(response.error).toContain("对应 API Key");
    expect(runtime.requests.at(-1)).toMatchObject({ method: "PUT", status: 409 });
    expect((runtime.requests.at(-1)?.body.config as Config).apiKey).toBeUndefined();
    expect(await ciphertext()).toEqual(before);
    expect((await resolveCreativeConfigProfile(ALICE, PROVIDER)).config).toMatchObject(CONFIG_A);
    expect(runtime.providerRequests).toEqual([]);
  });

  it("retains the bound Key through save-empty, provider/wallet selection, and a fresh browser restore", async () => {
    const { runtime, reply } = await importedPage();
    expect(await runtime.send("SAVE_CONFIG", { config: { ...reply.config, apiKey: "", imageModel: "exact-user-selected-model" } })).toMatchObject({ ok: true, config: { apiKey: KEY_A, imageModel: "exact-user-selected-model" } });
    expect(await runtime.send("USE_PLATFORM_WALLET", { accountKey: creativeConfigAccountKey(ALICE), ownerFingerprint: reply.config?._ownerFingerprint })).toMatchObject({ ok: true });
    expect((await resolveCreativeConfigProfile(ALICE, PROVIDER)).config.apiKey).toBe(KEY_A);
    expect(await runtime.send("SET_ACTIVE_PROVIDER", { provider: "doubao", accountKey: reply.accountKey, ownerFingerprint: reply.config?._ownerFingerprint })).toMatchObject({ ok: true });
    expect(await runtime.send("SET_ACTIVE_PROVIDER", { provider: PROVIDER, accountKey: reply.accountKey, ownerFingerprint: reply.config?._ownerFingerprint })).toMatchObject({ ok: true });
    expect(await page().read()).toMatchObject({ ok: true, config: { apiKey: KEY_A, imageModel: "exact-user-selected-model", provider: PROVIDER, _supplyChannel: "external_key" } });
  });

  it("saves a partial model edit without resetting other explicitly saved models or the Key", async () => {
    const { runtime, reply } = await importedPage();
    const partial = { provider: PROVIDER, imageModel: "only-image-model-edited", _accountKey: reply.accountKey,
      _profileRevision: reply.config?._profileRevision, _accountRevision: reply.config?._accountRevision, _ownerFingerprint: reply.config?._ownerFingerprint };
    expect(await runtime.send("SAVE_CONFIG", { config: partial })).toMatchObject({ ok: true });
    expect((await resolveCreativeConfigProfile(ALICE, PROVIDER)).config).toMatchObject({ ...CONFIG_A, imageModel: "only-image-model-edited" });
  });

  it("uses the returned wallet profile revision when explicitly saving a new personal Key for the same provider", async () => {
    const { runtime, reply } = await importedPage();
    const wallet = await runtime.send("USE_PLATFORM_WALLET", { accountKey: reply.accountKey, ownerFingerprint: reply.config?._ownerFingerprint });
    expect(wallet).toMatchObject({ ok: true, activeSupplyChannel: "platform_wallet", config: {
      apiKey: "", _profileRevision: reply.config?._profileRevision, _ownerFingerprint: reply.config?._ownerFingerprint } });
    const personal = await runtime.send("SAVE_CONFIG", { config: { ...wallet.config, apiKey: KEY_NEW, _keyEdited: true, imageModel: "Exact_New_Personal_Model" } });
    expect(personal).toMatchObject({ ok: true, config: { provider: PROVIDER, apiKey: KEY_NEW, imageModel: "Exact_New_Personal_Model",
      _profileRevision: Number(reply.config?._profileRevision) + 1, _accountRevision: Number(wallet.config?._accountRevision) + 1,
      _ownerFingerprint: reply.config?._ownerFingerprint, _supplyChannel: "external_key" } });
    expect(await page().read()).toMatchObject({ ok: true, config: personal.config });
    expect((await resolveCreativeConfigProfile(ALICE, PROVIDER)).config).toMatchObject({ apiKey: KEY_NEW, imageModel: "Exact_New_Personal_Model" });
  });

  it("keeps an explicit unlink tombstone authoritative over an old browser's cached Key", async () => {
    const { runtime, reply } = await importedPage();
    const stale = page(); await stale.seed();
    expect(await runtime.send("UNLINK_CONFIG_KEY", { accountKey: creativeConfigAccountKey(ALICE), ownerFingerprint: reply.config?._ownerFingerprint, provider: PROVIDER, revision: reply.config?._profileRevision })).toMatchObject({ ok: true, config: { apiKey: "", _supplyChannel: "external_key" } });
    const before = await ciphertext();
    expect(await stale.read()).toMatchObject({ ok: true, config: { apiKey: "", imageModel: CONFIG_A.imageModel, _supplyChannel: "external_key" } });
    expect(stale.requests.some(request => request.method === "PUT")).toBe(false);
    expect(await ciphertext()).toEqual(before);
    expect(await resolveCreativeConfigProfile(ALICE, PROVIDER)).toMatchObject({ tombstone: true, linked: false, config: { apiKey: "" } });
    const fresh = await page().read(); expect(fresh.config?.apiKey).toBe("");
    expect(runtime.context.SZ_WEB_ACCOUNT.usesPlatformWallet(fresh.config!, "image")).toBe(false);
  });

  it("rejects stale or missing form/unlink revisions after another page explicitly replaces the Key", async () => {
    const { runtime, reply } = await importedPage();
    const other = page(), current = await other.read();
    expect(await other.send("SAVE_CONFIG", { config: { ...current.config, apiKey: KEY_NEW, _keyEdited: true } })).toMatchObject({ ok: true, config: { apiKey: KEY_NEW } });
    const before = await ciphertext();
    expect(await runtime.send("SAVE_CONFIG", { config: { ...reply.config, imageModel: "stale-must-not-save" } })).toMatchObject({ ok: false, code: "CONFIG_CONFLICT" });
    const missing = { ...reply.config }; delete missing._profileRevision; delete missing._accountRevision;
    expect(await runtime.send("SAVE_CONFIG", { config: missing })).toMatchObject({ ok: false, code: "CONFIG_CONFLICT" });
    for (const revision of [reply.config?._profileRevision, undefined]) {
      expect(await runtime.send("UNLINK_CONFIG_KEY", { accountKey: creativeConfigAccountKey(ALICE), ownerFingerprint: reply.config?._ownerFingerprint, provider: PROVIDER, ...(revision === undefined ? {} : { revision }) })).toMatchObject({ ok: false, code: "CONFIG_CONFLICT" });
    }
    expect(await ciphertext()).toEqual(before);
    expect((await page().read()).config?.apiKey).toBe(KEY_NEW);
  });

  it("never gives A's binding to B with the same username in a different tenant", async () => {
    const { reply: original } = await importedPage();
    const aliceFile = path.join(root, (await readdir(root)).find(name => name.endsWith(".json"))!), before = await readFile(aliceFile);
    const other = page(BOB), response = await other.read();
    expect(response).toMatchObject({ ok: true, accountKey: creativeConfigAccountKey(BOB) });
    expect(response.config?.apiKey).toBe("");
    expect(JSON.stringify(response)).not.toContain(KEY_A);
    expect(other.requests.some(request => request.method === "PUT")).toBe(false);
    expect((await getCreativeConfigProfiles(BOB, true)).profiles).toEqual([]);
    // Equal numeric revisions must never substitute for the draft's owner.
    await other.seed({ ...CONFIG_A, apiKey: "synthetic-image-key-owned-by-B" });
    const bobProfile = await other.read();
    expect(bobProfile.config?._profileRevision).toBe(original.config?._profileRevision);
    expect(bobProfile.config?._accountRevision).toBe(original.config?._accountRevision);
    expect(await other.send("SAVE_CONFIG", { config: { ...original.config, _accountKey: original.accountKey } })).toMatchObject({ ok: false, code: "ACCOUNT_CHANGED" });
    expect((await resolveCreativeConfigProfile(BOB, PROVIDER)).config.apiKey).toBe("synthetic-image-key-owned-by-B");
    expect(await readFile(aliceFile)).toEqual(before);
  });

  it.each(["503", "malformed", "network"] as const)("auth %s fails the current read/save closed without local writes or deleting the durable binding", async failure => {
    const { runtime, reply } = await importedPage();
    const before = await ciphertext(), localBefore = [...runtime.localStorage.values], apiCount = runtime.requests.length;
    runtime.state.authFailure = failure;
    expect(await runtime.read()).toMatchObject({ ok: false });
    expect(await runtime.send("SAVE_CONFIG", { config: { ...reply.config, apiKey: "" } })).toMatchObject({ ok: false });
    expect(runtime.requests).toHaveLength(apiCount);
    expect([...runtime.localStorage.values]).toEqual(localBefore);
    expect(await ciphertext()).toEqual(before);
    expect([...runtime.localStorage.values].some(([, value]) => value.includes('"local":'))).toBe(false);
    runtime.state.authFailure = "";
    expect((await runtime.read()).config?.apiKey).toBe(KEY_A);
  });

  it("keeps an explicitly external configuration keyless after unlink instead of choosing a paid wallet", async () => {
    const { runtime, reply } = await importedPage();
    await runtime.send("UNLINK_CONFIG_KEY", { accountKey: creativeConfigAccountKey(ALICE), ownerFingerprint: reply.config?._ownerFingerprint, provider: PROVIDER, revision: reply.config?._profileRevision });
    const response = await runtime.read();
    expect(response).toMatchObject({ ok: true, activeSupplyChannel: "external_key", config: { apiKey: "", _supplyChannel: "external_key" } });
    expect(runtime.context.SZ_WEB_ACCOUNT.usesPlatformWallet(response.config!, "chat")).toBe(false);
    expect(runtime.context.SZ_WEB_ACCOUNT.usesPlatformWallet(response.config!, "image")).toBe(false);
  });

  it("reports a real storage write failure without clearing the Key, changing the model, or invoking a provider", async () => {
    const { runtime, reply } = await importedPage(); const before = await ciphertext(), metadataBefore = await getCreativeConfigProfiles(ALICE, true);
    const filesystem = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const file = path.join(root, (await filesystem.readdir(root)).find(name => name.endsWith(".json"))!);
    const backup = path.join(temporary, "original-ciphertext.backup"), blocker = path.join(file, "publish-blocker");
    let publishAttempts = 0, displaced = false, directoryCreated = false, blockerCreated = false, publishTemporary = "";
    filesystemPublish.beforeRename = async (from, to) => {
      if (to !== file || path.dirname(from) !== root || !/^\.config-[\da-f-]+\.tmp$/.test(path.basename(from))) return;
      publishAttempts++; publishTemporary = from;
      if (publishAttempts !== 1) return;
      // Keep the real route/store path: only arrange an on-disk obstruction,
      // then let the actual OS rename reject even when the test UID is root.
      await filesystem.rename(file, backup); displaced = true;
      await filesystem.mkdir(file, { mode: 0o700 }); directoryCreated = true;
      await filesystem.writeFile(blocker, "synthetic publication obstruction", { mode: 0o600 }); blockerCreated = true;
    };
    try {
      expect(await runtime.send("SAVE_CONFIG", { config: { ...reply.config, imageModel: "must-not-persist", apiKey: "" } })).toMatchObject({ ok: false });
      expect(publishAttempts).toBe(1);
      expect(filesystemPublish.failure).toMatchObject({ code: expect.stringMatching(/^(EISDIR|ENOTDIR|ENOTEMPTY)$/) });
      expect(await filesystem.readFile(backup)).toEqual(before);
      await expect(filesystem.lstat(publishTemporary)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      filesystemPublish.beforeRename = undefined;
      if (blockerCreated) await filesystem.unlink(blocker);
      if (directoryCreated) await filesystem.rmdir(file);
      if (displaced) await filesystem.rename(backup, file);
    }
    expect(await ciphertext()).toEqual(before);
    expect(await getCreativeConfigProfiles(ALICE, true)).toEqual(metadataBefore);
    await expect(filesystem.lstat(backup)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await filesystem.readdir(root)).filter(name => name.startsWith(".config-") || name.endsWith(".lock"))).toEqual([]);
    expect((await page().read()).config).toMatchObject(CONFIG_A);
    expect(runtime.requests.some(request => request.method === "PUT" && request.status === 503)).toBe(true);
    expect(runtime.providerRequests).toEqual([]); expect(runtime.syntheticDispatches).toEqual([]);
  });

  const genericConfig = { ...CONFIG_A, imageEndpoint: "https://synthetic-model.example.test/v1/generate", visionBaseUrl: "https://synthetic-model.example.test/v1", imageModel: "Exact_User_Selected_Image_Model" };
  const generationPayload = { labMode: "main", prompt: "SYNTHETIC FIXTURE ONLY: preserve the original product", size: "1024*1024", count: 1,
    productImages: ["https://synthetic-input.example.test/original-product.png"] };
  const entryPoints = ["reference-detail", "translation"] as const;
  type EntryPoint = typeof entryPoints[number];
  function invokeEntry(runtime: ReturnType<typeof page>, entry: EntryPoint, config: Config,
    budget: RequestBudget = { attempts: 0, limit: 4 }, signal?: AbortSignal, preconsumed?: boolean) {
    const api = runtime.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__;
    return entry === "reference-detail"
      ? api.referenceDetailModelJson(config, [{ role: "user", content: "SYNTHETIC FIXTURE ONLY" }], signal, budget, 1, preconsumed)
      : api.createImageTranslationEdit(config, { mode: "translate", targetLanguage: "en", width: 1024, height: 1024 },
        "data:image/png;base64,c3ludGhldGljLWZpeHR1cmU=", { texts: [{ source: "示例", translated: "Example" }] });
  }

  it.each(entryPoints)("%s rechecks the real account binding and dispatches the unchanged exact selected model/endpoint/Key once", async entry => {
    const runtime = page(); await runtime.seed(genericConfig);
    const selected = await runtime.read(), before = JSON.stringify(selected.config), requestCount = runtime.requests.length;
    runtime.state.allowSyntheticProvider = true; runtime.state.expectedProviderCalls = 1;
    const budget = { attempts: 0, limit: 4 };
    expect(await invokeEntry(runtime, entry, selected.config!, budget)).toMatchObject({ ok: true });
    expect(runtime.requests.slice(requestCount)).toEqual([expect.objectContaining({ method: "POST", body: { operation: "resolveAll", accountKey: creativeConfigAccountKey(ALICE) }, status: 200 })]);
    expect(runtime.syntheticDispatches).toHaveLength(1);
    expect(runtime.syntheticDispatches[0]).toMatchObject({
      url: entry === "reference-detail" ? genericConfig.visionBaseUrl + "/chat/completions" : genericConfig.imageEndpoint,
      method: "POST", body: { model: entry === "reference-detail" ? genericConfig.visionModel : genericConfig.imageModel }
    });
    expect(Object.entries(runtime.syntheticDispatches[0].headers).find(([name]) => name.toLowerCase() === "authorization")?.[1]).toBe("Bearer " + KEY_A);
    expect(JSON.stringify(selected.config)).toBe(before);
    expect(budget.attempts).toBe(entry === "reference-detail" ? 1 : 0);
  });

  const entryDrifts = entryPoints.flatMap(entry => (["rotated", "unlinked", "model", "endpoint", "account"] as const).map(change => [entry, change] as const));
  it.each(entryDrifts)("%s blocks %s drift with definite zero submission and leaves the captured config untouched", async (entry, change) => {
    const runtime = page(); await runtime.seed(genericConfig);
    const selected = await runtime.read(), captured = JSON.stringify(selected.config);
    if (change === "account") runtime.switchOwner(BOB);
    else {
      const other = page(), latest = await other.read();
      if (change === "unlinked") {
        expect(await other.send("UNLINK_CONFIG_KEY", { accountKey: creativeConfigAccountKey(ALICE), ownerFingerprint: latest.config?._ownerFingerprint, provider: PROVIDER, revision: latest.config?._profileRevision })).toMatchObject({ ok: true });
      } else {
        const patch = change === "rotated" ? { apiKey: KEY_NEW, _keyEdited: true }
          : change === "model" ? { [entry === "reference-detail" ? "visionModel" : "imageModel"]: "New_Explicit_Model" }
            : { [entry === "reference-detail" ? "visionBaseUrl" : "imageEndpoint"]: "https://new-explicit-endpoint.example.test/v1", apiKey: KEY_A, _keyEdited: true };
        expect(await other.send("SAVE_CONFIG", { config: { ...latest.config, ...patch } })).toMatchObject({ ok: true });
      }
    }
    const durableBefore = await ciphertext(), budget = { attempts: 0, limit: 4 };
    runtime.state.allowSyntheticProvider = true;
    expect(await invokeEntry(runtime, entry, selected.config!, budget)).toMatchObject({ ok: false,
      code: change === "account" ? "ACCOUNT_UNAVAILABLE" : "CONFIG_BINDING_CHANGED",
      providerSubmitted: false, definitiveFailure: true, stateUncertain: false });
    expect(runtime.providerRequests).toEqual([]); expect(runtime.syntheticDispatches).toEqual([]);
    expect(budget.attempts).toBe(0); expect(JSON.stringify(selected.config)).toBe(captured);
    expect(await ciphertext()).toEqual(durableBefore);
  });

  it("reference-detail keeps legacy synchronous budget reservation, preconsumption and cancellation", async () => {
    const runtime = page(); await runtime.seed(genericConfig); const selected = await runtime.read();
    runtime.state.cloudProfilesEnabled = false; runtime.context.SZ_WEB_ACCOUNT.supportsConfigProfiles = false;
    runtime.state.allowSyntheticProvider = true; runtime.state.expectedProviderCalls = 2;
    const budget = { attempts: 0, limit: 4 }, pending = invokeEntry(runtime, "reference-detail", selected.config!, budget);
    expect(budget.attempts).toBe(1); expect(await pending).toMatchObject({ ok: true });
    const reserved = { attempts: 1, limit: 4 };
    expect(await invokeEntry(runtime, "reference-detail", selected.config!, reserved, undefined, true)).toMatchObject({ ok: true });
    expect(reserved.attempts).toBe(1);
    const exhausted = { attempts: 3, limit: 4 };
    expect(await invokeEntry(runtime, "reference-detail", selected.config!, exhausted)).toMatchObject({ ok: false, code: "request_budget_exhausted" });
    expect(exhausted.attempts).toBe(3);
    const controller = new AbortController(); controller.abort(); const cancelledBudget = { attempts: 0, limit: 4 };
    expect(await invokeEntry(runtime, "reference-detail", selected.config!, cancelledBudget, controller.signal)).toMatchObject({ ok: false, code: "cancelled" });
    expect(cancelledBudget.attempts).toBe(0);
  });

  it("reference-detail cancelled during the fresh binding check never consumes a request or dispatches", async () => {
    const runtime = page(); await runtime.seed(genericConfig); const selected = await runtime.read();
    let release!: () => void, entered!: () => void;
    const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    runtime.state.beforeProfileResolve = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
    const controller = new AbortController(), budget = { attempts: 0, limit: 4 };
    const pending = invokeEntry(runtime, "reference-detail", selected.config!, budget, controller.signal);
    await enteredGate; controller.abort(); release();
    expect(await pending).toMatchObject({ ok: false, code: "cancelled" });
    expect(budget.attempts).toBe(0); expect(runtime.syntheticDispatches).toEqual([]);
  });

  it("reference-detail preserves uncertain provider failure receipts without retry or a different model", async () => {
    const runtime = page(); await runtime.seed(genericConfig); const selected = await runtime.read();
    runtime.state.allowSyntheticProvider = true; runtime.state.expectedProviderCalls = 1;
    runtime.state.providerStatus = 503; runtime.state.providerResponse = { error: { message: "Synthetic ambiguous provider response" } };
    const budget = { attempts: 0, limit: 4 };
    expect(await invokeEntry(runtime, "reference-detail", selected.config!, budget)).toMatchObject({ ok: false, stateUncertain: true });
    expect(budget.attempts).toBe(1); expect(runtime.syntheticDispatches).toHaveLength(1);
    expect(runtime.syntheticDispatches[0].body.model).toBe(genericConfig.visionModel);
  });

  const mutations = ["save", "unlink", "provider", "wallet"] as const;
  function mutate(runtime: ReturnType<typeof page>, action: typeof mutations[number], selected: Reply) {
    if (action === "save") return runtime.send("SAVE_CONFIG", { config: { ...selected.config, apiKey: "", imageModel: "New_Durable_Model" } });
    if (action === "unlink") return runtime.send("UNLINK_CONFIG_KEY", { accountKey: selected.accountKey, ownerFingerprint: selected.config?._ownerFingerprint, provider: PROVIDER, revision: selected.config?._profileRevision });
    if (action === "provider") return runtime.send("SET_ACTIVE_PROVIDER", { accountKey: selected.accountKey, ownerFingerprint: selected.config?._ownerFingerprint, provider: "doubao" });
    return runtime.send("USE_PLATFORM_WALLET", { accountKey: selected.accountKey, ownerFingerprint: selected.config?._ownerFingerprint });
  }
  function failProfileCacheWrites(runtime: ReturnType<typeof page>) {
    const original = runtime.localStorage.setItem;
    return vi.spyOn(runtime.localStorage, "setItem").mockImplementation((name, value) => {
      if (name === "sz.chrome.local.v1:" + PROFILES_KEY) throw new Error("Synthetic local cache quota failure");
      original(name, value);
    });
  }

  it.each(["profile", "reference"] as const)("returns the authenticated first %s snapshot with a truthful warning when the real shim cannot cache its owner stamp", async entry => {
    const runtime = page(); await runtime.seed();
    const localBefore = runtime.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY);
    const cacheWrites = failProfileCacheWrites(runtime);
    const response = entry === "profile" ? await runtime.read()
      : await runtime.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.resolveUnifiedConfigReference({ accountKey: creativeConfigAccountKey(ALICE), provider: PROVIDER });
    expect(response).toMatchObject({ ok: true, cacheSaved: false, cacheWarning: "账号配置已核对，本机缓存未更新，请刷新后恢复。", config: CONFIG_A });
    expect(response.config?._ownerFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(cacheWrites).toHaveBeenCalled(); expect(runtime.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY)).toBe(localBefore);
    const fresh = page(); const restored = await fresh.read();
    expect(restored).toMatchObject({ ok: true, config: { ...CONFIG_A, _ownerFingerprint: response.config?._ownerFingerprint } });
    expect(fresh.requests.some(request => request.method === "PUT")).toBe(false);
    const stamped = JSON.parse(fresh.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY)!) as { accounts: Record<string, { _serverOwnerFingerprint: string }> };
    expect(stamped.accounts[creativeConfigAccountKey(ALICE)]._serverOwnerFingerprint).toBe(response.config?._ownerFingerprint);
  });

  it("still returns a stable failure for a legacy first-read cache migration failure", async () => {
    const runtime = page(); await seedRows(runtime, [["jimeng", sparseJimeng]], "jimeng");
    runtime.state.cloudProfilesEnabled = false; runtime.context.SZ_WEB_ACCOUNT.supportsConfigProfiles = false;
    const before = runtime.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY); failProfileCacheWrites(runtime);
    expect(await runtime.send("GET_CONFIG_PROFILE", { provider: "jimeng" })).toMatchObject({ ok: false, code: "CONFIG_WRITE_FAILED" });
    expect(runtime.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY)).toBe(before);
    expect(runtime.requests).toEqual([]);
  });

  const invalidFingerprints = mutations.flatMap(action => (["missing", "wrong"] as const).map(token => [action, token] as const));
  it.each(invalidFingerprints)("%s rejects a %s immutable-owner form token before any write or provider dispatch", async (action, invalid) => {
    const { runtime, reply } = await importedPage();
    const config = { ...reply.config! };
    if (invalid === "missing") delete config._ownerFingerprint; else config._ownerFingerprint = "0".repeat(64);
    const before = await ciphertext(), localBefore = runtime.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY), requestCount = runtime.requests.length;
    expect(await mutate(runtime, action, { ...reply, config })).toMatchObject({ ok: false, code: "ACCOUNT_CHANGED" });
    expect(runtime.requests.slice(requestCount).some(request => request.method === "PUT" || request.method === "DELETE")).toBe(false);
    expect(await ciphertext()).toEqual(before); expect(runtime.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY)).toBe(localBefore);
    expect(runtime.providerRequests).toEqual([]);
  });

  it("rejects a stamped cache after same-tenant same-username account recreation before importing its old Key", async () => {
    const { runtime, reply } = await importedPage();
    expect(creativeConfigAccountKey(RECREATED_ALICE)).toBe(creativeConfigAccountKey(ALICE));
    const rawCache = runtime.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY)!, before = await ciphertext();
    const cached = JSON.parse(rawCache) as { accounts: Record<string, { _serverOwnerFingerprint: string }> };
    expect(cached.accounts[creativeConfigAccountKey(ALICE)]._serverOwnerFingerprint).toBe(reply.config?._ownerFingerprint);
    runtime.switchOwner(RECREATED_ALICE); const requestCount = runtime.requests.length;
    expect(await runtime.read()).toMatchObject({ ok: false, code: "ACCOUNT_CHANGED" });
    const restarted = page(RECREATED_ALICE); restarted.localStorage.setItem("sz.chrome.local.v1:" + PROFILES_KEY, rawCache);
    expect(await restarted.read()).toMatchObject({ ok: false, code: "ACCOUNT_CHANGED" });
    expect([...runtime.requests.slice(requestCount), ...restarted.requests].some(request => request.method === "PUT" || request.method === "DELETE")).toBe(false);
    expect(runtime.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY)).toBe(rawCache);
    expect(restarted.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY)).toBe(rawCache);
    expect((await getCreativeConfigProfiles(RECREATED_ALICE, true)).profiles).toEqual([]);
    expect(await ciphertext()).toEqual(before);
  });

  it.each(mutations)("%s rejects an old form token in a clean browser after same-name account recreation", async action => {
    const { reply } = await importedPage(); const runtime = page(RECREATED_ALICE), before = await ciphertext();
    expect(creativeConfigAccountKey(RECREATED_ALICE)).toBe(reply.accountKey);
    expect(await mutate(runtime, action, reply)).toMatchObject({ ok: false, code: "ACCOUNT_CHANGED" });
    expect(runtime.requests.some(request => request.method === "PUT" || request.method === "DELETE")).toBe(false);
    expect((await getCreativeConfigProfiles(RECREATED_ALICE, true)).profiles).toEqual([]);
    expect(runtime.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY)).toBeNull();
    expect(await ciphertext()).toEqual(before);
  });

  it.each(entryPoints)("%s blocks a captured Key on account recreation even though the public account key is unchanged", async entry => {
    const runtime = page(); await runtime.seed(genericConfig); const selected = await runtime.read();
    const before = await ciphertext(); runtime.switchOwner(RECREATED_ALICE);
    expect(creativeConfigAccountKey(RECREATED_ALICE)).toBe(selected.accountKey);
    expect(await invokeEntry(runtime, entry, selected.config!)).toMatchObject({ ok: false, code: "CONFIG_BINDING_CHANGED",
      providerSubmitted: false, definitiveFailure: true, stateUncertain: false });
    expect(runtime.providerRequests).toEqual([]); expect(runtime.syntheticDispatches).toEqual([]);
    expect((await getCreativeConfigProfiles(RECREATED_ALICE, true)).profiles).toEqual([]); expect(await ciphertext()).toEqual(before);
  });

  it.each(mutations)("%s reports the confirmed server revision when only the local profile cache write fails", async action => {
    const { runtime, reply } = await importedPage();
    const localBefore = runtime.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY);
    const cacheWrites = failProfileCacheWrites(runtime);
    const response = await mutate(runtime, action, reply);
    expect(response).toMatchObject({ ok: true, accountKey: creativeConfigAccountKey(ALICE), cacheSaved: false,
      cacheWarning: "账号配置已保存，本机缓存未更新，请刷新后恢复。" });
    expect(cacheWrites).toHaveBeenCalled();
    expect(runtime.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY)).toBe(localBefore);
    const persisted = await getCreativeConfigProfiles(ALICE, true);
    expect(response.accountRevision).toBe(persisted.accountRevision);
    expect(response.config).toMatchObject({ _accountKey: creativeConfigAccountKey(ALICE), _accountRevision: persisted.accountRevision });
    const fresh = page(); const restored = await fresh.send("GET_CONFIG_PROFILE"); expect(restored.ok).toBe(true);
    if (action === "save") {
      expect(response.config).toMatchObject({ apiKey: KEY_A, imageModel: "New_Durable_Model", _profileRevision: Number(reply.config?._profileRevision) + 1 });
      expect(restored.config).toMatchObject(response.config!);
      // The returned authoritative revisions support the next edit even while
      // the older browser still cannot update its cache.
      expect(await runtime.send("SAVE_CONFIG", { config: { ...response.config, textModel: "Next_Durable_Text_Model" } })).toMatchObject({ ok: true, cacheSaved: false });
    } else if (action === "unlink") {
      expect(response.config).toMatchObject({ apiKey: "", _supplyChannel: "external_key" });
      expect(restored.config?.apiKey).toBe("");
      // A failed cache update left the old Key locally, but the server
      // tombstone must remain authoritative when this same browser reloads.
      cacheWrites.mockRestore(); expect((await runtime.read()).config?.apiKey).toBe("");
      expect(await resolveCreativeConfigProfile(ALICE, PROVIDER)).toMatchObject({ linked: false, tombstone: true, config: { apiKey: "" } });
    } else {
      expect(restored).toMatchObject({ activeProvider: action === "provider" ? "doubao" : PROVIDER,
        activeSupplyChannel: action === "provider" ? "external_key" : "platform_wallet" });
      expect((await resolveCreativeConfigProfile(ALICE, PROVIDER)).config.apiKey).toBe(KEY_A);
    }
    expect(fresh.requests.some(request => request.method === "PUT")).toBe(false);
  });

  it.each(mutations)("%s still fails closed when a legacy local-only profile write fails", async action => {
    const { runtime, reply } = await importedPage();
    runtime.state.cloudProfilesEnabled = false; runtime.context.SZ_WEB_ACCOUNT.supportsConfigProfiles = false;
    const before = await ciphertext(), localBefore = runtime.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY), count = runtime.requests.length;
    failProfileCacheWrites(runtime);
    expect(await mutate(runtime, action, reply)).toMatchObject({ ok: false });
    expect(runtime.requests).toHaveLength(count); expect(await ciphertext()).toEqual(before);
    expect(runtime.localStorage.getItem("sz.chrome.local.v1:" + PROFILES_KEY)).toBe(localBefore);
  });

  it("does not claim a confirmed server save when its post-commit authenticated rehydration fails", async () => {
    const { runtime, reply } = await importedPage();
    runtime.state.mutationCommitted = false; runtime.state.failProfileReadAfterMutation = true;
    expect(await mutate(runtime, "save", reply)).toMatchObject({ ok: false });
    expect((await page().read()).config).toMatchObject({ apiKey: KEY_A, imageModel: "New_Durable_Model" });
  });

  it("submits exactly one synthetic provider POST with the fresh owner's exact selected model and Key", async () => {
    const runtime = page(); await runtime.seed(genericConfig);
    const selected = await runtime.read(); expect(selected).toMatchObject({ ok: true });
    runtime.state.allowSyntheticProvider = true; runtime.state.expectedProviderCalls = 1;
    expect(await runtime.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createImageTask(selected.config!, generationPayload)).toMatchObject({ ok: true });
    expect(runtime.syntheticDispatches).toHaveLength(1);
    expect(runtime.syntheticDispatches[0]).toMatchObject({ url: genericConfig.imageEndpoint, method: "POST", body: { model: genericConfig.imageModel, n: 1 } });
    const authorization = Object.entries(runtime.syntheticDispatches[0].headers).find(([name]) => name.toLowerCase() === "authorization")?.[1];
    expect(authorization).toBe("Bearer " + KEY_A);
    expect(runtime.requests.every(request => request.status === 200)).toBe(true);
  });

  it.each(["replaced", "unlinked", "store-unavailable"] as const)("rejects a frozen config before any provider POST when its binding is %s", async change => {
    const runtime = page(); await runtime.seed(genericConfig);
    const selected = await runtime.read(); expect(selected).toMatchObject({ ok: true });
    let unavailableFile: string | undefined;
    if (change === "store-unavailable") {
      unavailableFile = path.join(root, (await readdir(root)).find(name => name.endsWith(".json"))!);
      await chmod(unavailableFile, 0o644);
    } else {
      const other = page(), latest = await other.read();
      if (change === "replaced") {
        expect(await other.send("SAVE_CONFIG", { config: { ...latest.config, imageModel: "New_Explicit_Model", apiKey: KEY_NEW, _keyEdited: true } })).toMatchObject({ ok: true });
      } else {
        expect(await other.send("UNLINK_CONFIG_KEY", { accountKey: creativeConfigAccountKey(ALICE), ownerFingerprint: latest.config?._ownerFingerprint, provider: PROVIDER, revision: latest.config?._profileRevision })).toMatchObject({ ok: true });
      }
    }
    try {
      expect(await runtime.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createImageTask(selected.config!, generationPayload)).toMatchObject({
        ok: false, providerSubmitted: false, definitiveFailure: true, stateUncertain: false
      });
      expect(runtime.syntheticDispatches).toEqual([]); expect(runtime.providerRequests).toEqual([]);
    } finally { if (unavailableFile) await chmod(unavailableFile, 0o600); }
  });
});
