import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const asset = (name: string) => readFileSync(new URL(`../../public/creative/${name}`, import.meta.url), "utf8");
const fixtureVideoKey = "fixture-personal-video-key";
const nativeConfig = { apiKey: "", provider: "shaozhuang-native", platformVideo: true, platformModels: [
  { id: "seedance-2.0", durations: [5], resolutions: ["720p"], ratios: ["16:9"], generateAudio: true }
] };

interface HostOptions { modes?: Record<string, string>; profiles?: unknown; switchOnReadNumber?: number; failReadNumber?: number }
function hostRuntime(key: string | null = fixtureVideoKey, switchOnRead = false, options: HostOptions = {}) {
  let account = "fixture-alice", reads = 0;
  // Key-aware storage: each read returns only the keys it requested.
  const stored: Record<string, unknown> = { sz_web_video_api_key_v1: key === null ? {} : { "fixture-alice": key } };
  if (options.modes) stored.sz_web_video_billing_mode_v1 = options.modes;
  if (options.profiles !== undefined) stored.sz_image_prompt_lab_config_profiles_v2 = options.profiles;
  const runtime: { lastError?: { message: string }; onMessage: { addListener: ReturnType<typeof vi.fn> } } = { onMessage: { addListener: vi.fn() } };
  const read = vi.fn((keys: string[], callback: (stored: unknown) => void) => {
    reads++;
    if (switchOnRead || options.switchOnReadNumber === reads) account = "fixture-bob";
    if (options.failReadNumber === reads) { runtime.lastError = { message: "fixture read failed" }; callback({}); runtime.lastError = undefined; return; }
    callback(Object.fromEntries(keys.filter(name => Object.prototype.hasOwnProperty.call(stored, name)).map(name => [name, stored[name]])));
  });
  const fetch = vi.fn(async () => Response.json({ configured: true, models: nativeConfig.platformModels }));
  const context = vm.createContext({ Response, fetch, URL,
    authCheck: async () => ({ ok: true, user: { id: account } }),
    chrome: { storage: { local: { get: read } }, runtime },
    SZ_WEB_SUPPLY: { usesServerCredentials: () => true }
  });
  vm.runInContext(asset("web-video-host.js"), context);
  const resolve = (purpose?: string) => context.resolveUnifiedConfigReference({ accountKey: "fixture-alice", purpose });
  return { resolve, read, fetch };
}

function controllerRuntime(response: Response, config: unknown = nativeConfig, cancellationReceipt = {cancelled:true,refundedCents:0}) {
  const purchase = vi.fn();
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(typeof url).toBe("string");
    expect(init?.method).toBe("POST");
    if (url.endsWith("/api/creative/billing/cancel")) return Response.json(cancellationReceipt);
    if (url.endsWith("/api/creative/native-video/quote")) return Response.json({ billingMode: "prepaid_quote", quoteCents: 30, quoteToken: "fixture-signed-token" });
    return response;
  });
  const context = vm.createContext({ console, URL, Response, Headers, Blob, FormData, AbortController,
    Uint8Array, ArrayBuffer, setTimeout, clearTimeout, fetch,
    location: { origin: "https://shaozhuangai.com" },
    SZ_WEB_SUPPLY: { usesServerCredentials: () => true, showCreditPurchasePrompt: purchase },
    fixtureConfigJSON: JSON.stringify(config)
  });
  for (const name of ["labs/ecommerce-video-studio/video-studio-contract.js", "src/ecommerce-video-background.js"]) {
    vm.runInContext(asset(name), context, { filename: name });
  }
  vm.runInContext(`
    var records = {};
    var controller = SZEcommerceVideoBackground.createController({
      resolveAccountKey: async function () { return { ok: true, accountKey: "fixture-alice" }; },
      resolveCredentials: async function () { return { ok: true, accountKey: "fixture-alice", config: JSON.parse(fixtureConfigJSON) }; },
      storageGet: async function (key) { var result = {}; result[key] = records[key]; return result; },
      storageSet: async function (values) { Object.assign(records, values); }
    });
  `, context);
  const start = () => vm.runInContext(`controller.start({ idempotencyKey: "3de141bb-c97e-40be-8e03-f346707f17af",
    request: { mode: "direct", creativeRoute: "free_direct", productKey: "seedance-2.0", durationSeconds: 5,
      resolution: "720p", ratio: "16:9", audioMode: "silent", script: "Fixture text draft must remain unchanged" } })`, context);
  return { context, start, fetch, purchase };
}

function rejectedResponse(overrides: Record<string, unknown> = {}, header = true, status = 402) {
  return Response.json({ code: "NATIVE_VIDEO_REQUEST_NOT_SUBMITTED", reasonCode: "INSUFFICIENT_BALANCE",
    error: "可用积分不足", providerSubmitted: false, definitiveFailure: true, ...overrides },
  { status, headers: header ? { "X-Sanjie-Provider-Submission": "not-submitted" } : {} });
}

describe("fresh production video credential priority", () => {
  it("selects the current account's personal video key before a ready platform", async () => {
    const runtime = hostRuntime();
    expect(await runtime.resolve()).toMatchObject({ ok: true, accountKey: "fixture-alice",
      config: { apiKey: fixtureVideoKey, provider: "doubao" } });
    expect(runtime.read).toHaveBeenCalledOnce();
    expect(runtime.fetch).not.toHaveBeenCalled();
  });
  it.each([null, "   "])("uses platform supply only when the personal key is absent (%s)", async key => {
    const runtime = hostRuntime(key);
    expect(await runtime.resolve()).toMatchObject({ ok: true, config: { apiKey: "", platformVideo: true } });
    expect(runtime.fetch).toHaveBeenCalledOnce();
  });
  it("rejects an account switch during storage reads without returning a key or checking platform supply", async () => {
    const runtime = hostRuntime(fixtureVideoKey, true);
    const result = await runtime.resolve();
    expect(result).toMatchObject({ ok: false, code: "ACCOUNT_CHANGED" });
    expect(JSON.stringify(result)).not.toContain(fixtureVideoKey);
    expect(runtime.fetch).not.toHaveBeenCalled();
  });
  it("keeps script analysis separate from the saved Doubao video key", async () => {
    const runtime = hostRuntime();
    const result = await runtime.resolve("analysis");
    expect(result).toMatchObject({ ok: true, accountKey: "fixture-alice",
      config: { apiKey: "", provider: "shaozhuang", visionBaseUrl: "https://sub.shaozhuangai.com/v1", visionModel: "chatGPT5.5" } });
    expect(JSON.stringify(result)).not.toContain(fixtureVideoKey);
    // The analysis route reads the billing mode first, then (outside the platform
    // wallet) only the image analysis profile; the video key map is never consulted for a key.
    expect(runtime.read).toHaveBeenCalledTimes(2);
    expect(runtime.read.mock.calls.map(call => call[0])).toEqual([
      ["sz_web_video_api_key_v1", "sz_web_video_billing_mode_v1"], ["sz_image_prompt_lab_config_profiles_v2"]
    ]);
    expect(runtime.fetch).not.toHaveBeenCalled();
  });
  it("uses the platform wallet analysis profile with one billing-mode read and no personal profile read", async () => {
    const runtime = hostRuntime(fixtureVideoKey, false, { modes: { "fixture-alice": "platform_wallet" },
      profiles: { accounts: { "user:fixture-alice": { activeProvider: "openai", configs: { openai: { apiKey: "fixture-personal-analysis-key" } } } } } });
    const result = await runtime.resolve("analysis");
    expect(result).toMatchObject({ ok: true, accountKey: "fixture-alice",
      config: { apiKey: "", provider: "openai-compatible", visionBaseUrl: "https://sub.shaozhuangai.com/v1", visionModel: "chatGPT5.5" } });
    expect(JSON.stringify(result)).not.toContain(fixtureVideoKey);
    expect(JSON.stringify(result)).not.toContain("fixture-personal-analysis-key");
    expect(runtime.read).toHaveBeenCalledOnce();
    expect(runtime.read).toHaveBeenCalledWith(["sz_web_video_api_key_v1", "sz_web_video_billing_mode_v1"], expect.any(Function));
    expect(runtime.fetch).not.toHaveBeenCalled();
  });
  it.each([1, 2])("rejects an account change observed after analysis storage read %i", async readNumber => {
    const runtime = hostRuntime(fixtureVideoKey, false, { switchOnReadNumber: readNumber,
      profiles: { accounts: { "user:fixture-alice": { activeProvider: "openai", configs: { openai: { apiKey: "fixture-personal-analysis-key",
        visionBaseUrl: "https://vision.fixture.test/v1", visionModel: "fixture-vision" } } } } } });
    const result = await runtime.resolve("analysis");
    expect(result).toMatchObject({ ok: false, code: "ACCOUNT_CHANGED" });
    expect(JSON.stringify(result)).not.toContain("fixture-personal-analysis-key");
    expect(runtime.read).toHaveBeenCalledTimes(readNumber);
    expect(runtime.fetch).not.toHaveBeenCalled();
  });
  it.each([1, 2])("stops analysis when storage read %i fails instead of falling back to platform credits", async readNumber => {
    const runtime = hostRuntime(fixtureVideoKey, false, { failReadNumber: readNumber });
    expect(await runtime.resolve("analysis")).toMatchObject({ ok: false, accountKey: "fixture-alice", code: "ANALYZER_PROFILE_READ_FAILED" });
    expect(runtime.read).toHaveBeenCalledTimes(readNumber);
    expect(runtime.fetch).not.toHaveBeenCalled();
  });
  it("does not switch an unsuccessful personal video request to a platform request", async () => {
    const runtime = controllerRuntime(Response.json({ error: "fixture unauthorized" }, { status: 401 }),
      { apiKey: fixtureVideoKey, provider: "doubao" });
    await expect(runtime.start()).rejects.toMatchObject({ code: "PROVIDER_HTTP_ERROR" });
    expect(runtime.fetch).toHaveBeenCalledOnce();
    expect(runtime.fetch.mock.calls[0]?.[0]).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks");
    expect(new Headers(runtime.fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(`Bearer ${fixtureVideoKey}`);
    expect(runtime.purchase).not.toHaveBeenCalled();
  });
  it("preserves an existing personal analysis API even on the hosted-compatible URL", async () => {
    const runtime = controllerRuntime(Response.json({ error: "fixture unavailable" }, { status: 401 }),
      { apiKey: "fixture-personal-analysis-key", visionBaseUrl: "https://sub.shaozhuangai.com/v1", visionModel: "fixture-chat" });
    await expect(vm.runInContext(`controller.analyze({ request: { mode: "assist", creativeRoute: "free_direct",
      goal: "Fixture analysis", productKey: "seedance-2.0", durationSeconds: 5, resolution: "720p", ratio: "16:9", audioMode: "silent" } })`, runtime.context)).rejects.toMatchObject({ code: "PROVIDER_HTTP_ERROR" });
    expect(runtime.fetch).toHaveBeenCalledOnce();
    expect(runtime.fetch.mock.calls[0]?.[0]).toBe("https://sub.shaozhuangai.com/v1/chat/completions");
    expect(new Headers(runtime.fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer fixture-personal-analysis-key");
  });
});

describe("native prepaid browser transport", () => {
  it("binds the signed quote to the exact creation body and persists cancellation by the original stable key",async()=>{
    const runtime=controllerRuntime(Response.json({id:"native-job",status:"processing"}));
    const created=await runtime.start();
    expect(runtime.fetch).toHaveBeenCalledTimes(2);
    const quoteBody=JSON.parse(String(runtime.fetch.mock.calls[0][1]?.body));
    const createBody=JSON.parse(String(runtime.fetch.mock.calls[1][1]?.body));
    expect(createBody).toEqual({...quoteBody,quoteToken:"fixture-signed-token"});
    expect(new Headers(runtime.fetch.mock.calls[1][1]?.headers).get("Idempotency-Key")).toBe("3de141bb-c97e-40be-8e03-f346707f17af");
    const result=await runtime.context.controller.cancel({taskId:created.task.taskId});
    expect(result).toMatchObject({task:{status:"cancelled"},providerCancelled:false,refundOnCancel:false});
    expect(JSON.parse(String(runtime.fetch.mock.calls[2][1]?.body))).toEqual({idempotencyKey:"native-video:3de141bb-c97e-40be-8e03-f346707f17af",expectedAccount:"fixture-alice"});
  });
  it("keeps a prior confirmed failure refund distinct from a paid cancellation",async()=>{
    const runtime=controllerRuntime(Response.json({id:"native-job",status:"processing"}),nativeConfig,{cancelled:false,refundedCents:30});
    const created=await runtime.start(); const result=await runtime.context.controller.cancel({taskId:created.task.taskId});
    expect(result.task.status).toBe("failed"); expect(result.message).toContain("已失败并退回积分");
  });
});

describe("native insufficient-credit purchase guidance", () => {
  it("opens purchase guidance only for a proven local rejection and preserves its reason", async () => {
    const runtime = controllerRuntime(rejectedResponse());
    await expect(runtime.start()).rejects.toMatchObject({ code: "NATIVE_VIDEO_REQUEST_NOT_SUBMITTED",
      details: { reasonCode: "INSUFFICIENT_BALANCE", providerSubmitted: false, stateUncertain: false } });
    expect(runtime.purchase).toHaveBeenCalledOnce();
    expect(runtime.fetch).toHaveBeenCalledTimes(2);
    expect(runtime.fetch.mock.calls[0][0]).toMatch(/native-video\/quote$/);
  });
  it.each([
    { name: "missing local provenance", body: {}, header: false, status: 402 },
    { name: "different reason", body: { reasonCode: "CREDIT_POOL_NOT_READY" }, header: true, status: 402 },
    { name: "provider submitted", body: { providerSubmitted: true }, header: true, status: 402 },
    { name: "uncertain failure", body: { definitiveFailure: false }, header: true, status: 402 },
    { name: "different status", body: {}, header: true, status: 403 },
    { name: "upstream-shaped error", body: { code: "INSUFFICIENT_BALANCE" }, header: true, status: 402 }
  ])("does not show a purchase prompt for $name", async fixture => {
    const runtime = controllerRuntime(rejectedResponse(fixture.body, fixture.header, fixture.status));
    await expect(runtime.start()).rejects.toBeDefined();
    expect(runtime.purchase).not.toHaveBeenCalled();
    expect(runtime.fetch).toHaveBeenCalledTimes(2);
    expect(runtime.fetch.mock.calls[0][0]).toMatch(/native-video\/quote$/);
  });
});
