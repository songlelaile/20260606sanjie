import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateGatewayKey: vi.fn(),
  assertGatewayBalance: vi.fn(),
  recordGatewayUsage: vi.fn(),
  getGatewayBillingSnapshot: vi.fn(),
  getRelayRuntime: vi.fn(),
  getUserSupplyRuntime: vi.fn(), getUserSupplyCredential: vi.fn(), bindHold: vi.fn(),
  relayFetch: vi.fn(),
  findGatewayVideoJob: vi.fn(), reconcileVideo: vi.fn(), refundHold: vi.fn(),
  reserveHold: vi.fn(), dispatchHold: vi.fn(), unknownHold: vi.fn(), releaseHold: vi.fn(), settleHold: vi.fn(),
  snapshots: new Map<string, unknown>()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/model-gateway/store", () => ({
  authenticateGatewayKey: mocks.authenticateGatewayKey,
  assertGatewayBalance: mocks.assertGatewayBalance,
  recordGatewayUsage: (input: unknown) => mocks.recordGatewayUsage(input)
}));
vi.mock("@/lib/model-gateway/billing-hold", () => ({ reserveGatewayBillingHold: mocks.reserveHold,
  markGatewayBillingHoldDispatched: mocks.dispatchHold, markGatewayBillingHoldUnknown: mocks.unknownHold,
  refundGatewayBillingHold: mocks.refundHold, releaseGatewayBillingHold: mocks.releaseHold, settleGatewayBillingHold: mocks.settleHold,
  bindGatewayBillingHoldCredential: mocks.bindHold }));
vi.mock("@/lib/model-gateway/user-supply", () => ({ getUserSupplyRuntime: mocks.getUserSupplyRuntime,
  getUserSupplyCredential: mocks.getUserSupplyCredential,
  UserSupplyError: class extends Error { constructor(message: string, readonly status = 503, readonly code = "USER_SUPPLY_UNAVAILABLE") { super(message); } } }));
vi.mock("@/lib/model-gateway/billing", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/model-gateway/billing")>(),
  getGatewayBillingSnapshot: mocks.getGatewayBillingSnapshot
}));
vi.mock("@/lib/model-gateway/relay-config", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/model-gateway/relay-config")>(),
  getRelayRuntime: mocks.getRelayRuntime
}));
vi.mock("@/lib/model-gateway/video-jobs", () => ({ findGatewayVideoJob: mocks.findGatewayVideoJob, reconcileGatewayVideoTerminal: mocks.reconcileVideo }));
vi.mock("@/lib/model-gateway/relay-network", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/model-gateway/relay-network")>(),
  relayFetch: mocks.relayFetch
}));

import {
  handleGatewayChatCompletions,
  handleGatewayImageEdits,
  handleGatewayImageGenerations,
  handleGatewayModels,
  handleGatewayVideoCreate,
  handleGatewayVideoRead
} from "@/lib/model-gateway/proxy";
import { RelayNetworkError } from "@/lib/model-gateway/relay-network";

const relayKey = "mock-upstream-secret-only-for-tests";
const relayBase = "https://relay.example.com/custom/v1";
const auth = { userId: "user-a", username: "alice", apiKeyId: "key-a", keyPrefix: "sk-sz-mock" };
const billingSnapshot = { userId: auth.userId, tenantId: "tenant-a", username: auth.username,
  userName: "Alice", planCode: "growth", planName: "增长版", multiplierBps: 10000, ruleVersion: 0, quotedAt: "2026-10-02T00:00:00.000Z" };
const chatModel = { id: "relay-chat", label: "Chat alias", upstreamModel: "provider-chat", kind: "chat", enabled: true,
  promptCentsPer1K: 2, completionCentsPer1K: 6 };
const imageModel = { id: "relay-image", label: "Image alias", upstreamModel: "provider-image", kind: "image", enabled: true, imageCents: 50 };
const videoModel = { id: "relay-video", label: "Video alias", upstreamModel: "provider-video", kind: "video", enabled: true, videoCents: 120 };

function runtime(overrides: Record<string, unknown> = {}) {
  return { baseUrl: relayBase, apiKey: relayKey, models: [chatModel, imageModel, videoModel], ...overrides };
}

function request(body: unknown, route = "chat/completions") {
  return new Request(`https://shaozhuangai.com/api/v1/${route}`, {
    method: "POST", headers: { Authorization: "Bearer sk-sz-mock-client", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function readRequest(path = "videos/video_123") {
  return new Request(`https://shaozhuangai.com/api/v1/${path}`, { headers: { Authorization: "Bearer sk-sz-mock-client" } });
}

function chatRequest(extra: Record<string, unknown> = {}) {
  return request({ model: chatModel.id, messages: [{ role: "user", content: "hello" }], ...extra });
}

function mediaRequest(kind: "image" | "video", extra: Record<string, unknown> = {}) {
  return request({ model: kind === "image" ? imageModel.id : videoModel.id, prompt: "A calm street scene", ...extra },
    kind === "image" ? "images/generations" : "videos");
}

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function chatResponse() {
  return jsonResponse({ id: "chat_123", model: chatModel.upstreamModel,
    choices: [{ message: { role: "assistant", content: "hello" } }], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } });
}

function formRequest(kind: "image" | "video", extras: Record<string, string> = {}) {
  const form = new FormData();
  form.set("model", kind === "image" ? imageModel.id : videoModel.id);
  form.set("prompt", "A calm street scene");
  if (kind === "image") form.set("image", new Blob(["mock image bytes"], { type: "image/png" }), "reference.png");
  Object.entries(extras).forEach(([key, value]) => form.set(key, value));
  return new Request(`https://shaozhuangai.com/api/v1/${kind === "image" ? "images/edits" : "videos"}`, {
    method: "POST", headers: { Authorization: "Bearer sk-sz-mock-client" }, body: form
  });
}

async function expectRejected(response: Response, status: number, recordsFailure = false) {
  expect(response.status).toBe(status);
  expect((await response.json()).error.message).toEqual(expect.any(String));
  expect(mocks.relayFetch).not.toHaveBeenCalled();
  if (!recordsFailure) expect(mocks.recordGatewayUsage).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("MODEL_GATEWAY_FX_AUTOMATIC", "0");
  mocks.authenticateGatewayKey.mockResolvedValue(auth);
  mocks.assertGatewayBalance.mockResolvedValue(true);
  mocks.recordGatewayUsage.mockResolvedValue({ id: "usage_123" });
  mocks.getGatewayBillingSnapshot.mockResolvedValue({ ...billingSnapshot });
  mocks.getRelayRuntime.mockResolvedValue(runtime());
  mocks.getUserSupplyRuntime.mockImplementation(async () => { const relay = await mocks.getRelayRuntime.mock.results.at(-1)!.value; return { baseUrl: relay.baseUrl, primary: { id: "user-a-primary", apiKey: relay.apiKey }, backup: null, usdCnyRate: relay.usdCnyRate || null }; });
  mocks.getUserSupplyCredential.mockResolvedValue({ baseUrl: relayBase, apiKey: "retained-user-key" });
  mocks.bindHold.mockResolvedValue({});
  mocks.findGatewayVideoJob.mockResolvedValue({ provider: "shaozhuang", model: videoModel.id, upstreamModel: videoModel.upstreamModel, baseUrl: relayBase });
  mocks.snapshots.clear();
  mocks.reserveHold.mockImplementation(async input => { mocks.snapshots.set(input.eventId, input.billingSnapshot); return { hold: { eventId: input.eventId, billingSnapshot: input.billingSnapshot }, shouldDispatch: true, replayed: false }; });
  mocks.dispatchHold.mockImplementation(async input => ({ hold: {eventId:input.eventId, billingSnapshot:mocks.snapshots.get(input.eventId)}, shouldDispatch: true }));
  mocks.unknownHold.mockResolvedValue({}); mocks.releaseHold.mockResolvedValue({}); mocks.refundHold.mockResolvedValue({});
  mocks.settleHold.mockImplementation(async input => { await input.writeUsage({}, { billingSnapshot: mocks.snapshots.get(input.eventId), eventId: input.eventId }); return { replayed: false }; });
});

describe("prepaid provider submission boundary",()=>{
  it("refunds local binding failure before any POST even after the dispatch claim",async()=>{
    mocks.bindHold.mockRejectedValueOnce(new Error("private local bind failure"));
    expect((await handleGatewayImageGenerations(mediaRequest("image"))).status).toBe(502);
    expect(mocks.dispatchHold).toHaveBeenCalledOnce(); expect(mocks.relayFetch).not.toHaveBeenCalled();
    expect(mocks.refundHold).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({userId:auth.userId,reason:"confirmed_failed"}));
    expect(mocks.unknownHold).not.toHaveBeenCalled();
  });
});

describe("model gateway generation handlers", () => {
  it("replays multipart references only after a verified 401 and keeps the event, quote and settlement stable", async () => {
    mocks.getRelayRuntime.mockResolvedValue(runtime({apiKey:"",usdCnyRate:7.2}));
    mocks.getUserSupplyRuntime.mockResolvedValue({baseUrl:relayBase,primary:{id:"user-a-primary",apiKey:"user-private-main"},backup:{id:"user-a-backup",apiKey:"user-private-backup"},usdCnyRate:7.2});
    mocks.relayFetch.mockResolvedValueOnce(jsonResponse({code:"INVALID_API_KEY"},401))
      .mockResolvedValueOnce(jsonResponse({data:[{b64_json:"image"}],usage:{actual_cost:0.01},debug:["user-private-main","user-private-backup"]}));
    const response=await handleGatewayImageEdits(formRequest("image"));
    expect(response.status).toBe(200);expect(mocks.getUserSupplyRuntime).toHaveBeenCalledExactlyOnceWith(auth.userId);
    const event=mocks.reserveHold.mock.calls[0][0].eventId;
    for(const [,init] of mocks.relayFetch.mock.calls){expect(init.headers["Idempotency-Key"]).toBe(event);expect(await init.body.get("image").text()).toBe("mock image bytes");expect(init.body.get("model")).toBe(imageModel.upstreamModel);}
    expect(mocks.bindHold.mock.calls.map(([input])=>input.credentialId)).toEqual(["user-a-primary","user-a-backup"]);
    expect(mocks.reserveHold).toHaveBeenCalledOnce();expect(mocks.dispatchHold).toHaveBeenCalledOnce();expect(mocks.settleHold).toHaveBeenCalledOnce();
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({costCents:8,metadata:expect.objectContaining({credentialId:"user-a-backup",usdCnyRate:"7.2"})}));
    expect(await response.text()).not.toContain("user-private");expect(JSON.stringify(mocks.recordGatewayUsage.mock.calls)).not.toContain("user-private");
  });
  it("preserves the hold after a backup timeout and persists that credential before dispatch",async()=>{
    mocks.getUserSupplyRuntime.mockResolvedValue({baseUrl:relayBase,primary:{id:"main-id",apiKey:"main-secret"},backup:{id:"backup-id",apiKey:"backup-secret"},usdCnyRate:null});
    mocks.relayFetch.mockResolvedValueOnce(jsonResponse({code:"API_KEY_DISABLED"},401)).mockImplementationOnce(async()=>{
      expect(mocks.bindHold.mock.calls.at(-1)![0].credentialId).toBe("backup-id");throw new RelayNetworkError("timeout",504);
    });
    expect((await handleGatewayImageGenerations(mediaRequest("image"))).status).toBe(504);
    expect(mocks.relayFetch).toHaveBeenCalledTimes(2);expect(mocks.unknownHold).toHaveBeenCalledOnce();expect(mocks.settleHold).not.toHaveBeenCalled();expect(mocks.recordGatewayUsage).not.toHaveBeenCalled();
  });
  it("rejects an invalid client Key before upstream or balance checks", async () => {
    mocks.authenticateGatewayKey.mockResolvedValue(null);
    await expectRejected(await handleGatewayChatCompletions(chatRequest()), 401);
    expect(mocks.assertGatewayBalance).not.toHaveBeenCalled();
  });

  it("rejects insufficient balance without making an upstream request", async () => {
    mocks.assertGatewayBalance.mockResolvedValue(false);
    const response = await handleGatewayChatCompletions(chatRequest());
    await expectRejected(response, 402, true);
    expect(mocks.assertGatewayBalance).toHaveBeenCalledWith(auth.userId, expect.any(Number));
    expect(mocks.recordGatewayUsage).toHaveBeenCalledWith(expect.objectContaining({
      status: "error", error: "INSUFFICIENT_BALANCE", costCents: 0,
      baseCostCents: expect.any(Number), audit: expect.objectContaining({ outcome: "balance_rejected" })
    }));
    expect(response.headers.get("x-gateway-billing-id")).toBe(mocks.recordGatewayUsage.mock.calls[0][0].billingEventId);
  });

  it("returns a traceable safe failure when the preflight rejection cannot be journaled", async () => {
    mocks.assertGatewayBalance.mockResolvedValue(false);
    mocks.recordGatewayUsage.mockRejectedValueOnce(new Error("private database connection"));
    const response = await handleGatewayImageGenerations(mediaRequest("image"));
    expect(response.status).toBe(502);
    expect(response.headers.get("x-gateway-billing-id")).toBe(mocks.recordGatewayUsage.mock.calls[0][0].billingEventId);
    expect(mocks.recordGatewayUsage).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ tokenSource: "unreported" })
    }));
    expect(mocks.relayFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain("private database");
  });

  it("routes a relay alias using saved URL, saved Key and upstream model while retaining client payload", async () => {
    vi.stubEnv("MODEL_GATEWAY_SHAOZHUANG_API_KEY", "outdated-env-key");
    vi.stubEnv("MODEL_GATEWAY_SHAOZHUANG_BASE_URL", "https://outdated.example.com/v1");
    mocks.relayFetch.mockResolvedValue(chatResponse());
    const response = await handleGatewayChatCompletions(chatRequest({ temperature: 0.4 }));
    expect(response.status).toBe(200);
    const [url, init] = mocks.relayFetch.mock.calls[0];
    expect(url).toBe(`${relayBase}/chat/completions`);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${relayKey}`);
    expect(JSON.parse(init.body)).toMatchObject({ model: chatModel.upstreamModel, temperature: 0.4 });
    expect(await response.json()).toMatchObject({ model: chatModel.id, id: "chat_123" });
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ auth, costCents: 5, status: "ok", promptTokens: 1000, completionTokens: 500 }));
  });

  it("uses the shared supply key for every tenant and settles the relay dollar cost into RMB cents", async () => {
    mocks.authenticateGatewayKey.mockResolvedValue({ ...auth, shopName: "西西礼" });
    mocks.getRelayRuntime.mockResolvedValue(runtime({
      apiKey: "platform-key", usdCnyRate: 7.2,
      shopKeys: [
        { shopName: "西西礼", purpose: "default", apiKey: "xixi-key" },
        { shopName: "少壮", purpose: "image", apiKey: "gemini-key" }
      ]
    }));
    mocks.relayFetch.mockResolvedValue(jsonResponse({
      id: "chat_usd", model: chatModel.upstreamModel,
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, actual_cost: 0.01, quota: 500000 }
    }));
    const response = await handleGatewayChatCompletions(chatRequest());
    expect(response.status).toBe(200);
    expect(new Headers(mocks.relayFetch.mock.calls[0][1].headers).get("authorization")).toBe("Bearer platform-key");
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      baseCostCents: 8, costCents: 8,
      metadata: expect.objectContaining({ costSource: "upstream_usd", usdCost: "0.01", usdCnyRate: "7.2" })
    }));
    expect(JSON.stringify(mocks.recordGatewayUsage.mock.calls[0][0])).not.toContain("xixi-key");
  });

  it.each([true, "true"])("rejects stream=%s without an upstream call", async (stream) => {
    await expectRejected(await handleGatewayChatCompletions(chatRequest({ stream })), 400);
  });
  it.each([2, 10, "1"])("rejects multiple or malformed text choices n=%j before dispatch", async n => {
    await expectRejected(await handleGatewayChatCompletions(chatRequest({ n })), 400);
    expect(mocks.reserveHold).not.toHaveBeenCalled();
  });
  it("does not dispatch an idempotent replay and never uses the raw caller key upstream", async () => {
    mocks.reserveHold.mockResolvedValue({ shouldDispatch: false, replayed: true });
    const replay = chatRequest(); replay.headers.set("Idempotency-Key", "same-business-request");
    await expectRejected(await handleGatewayChatCompletions(replay), 409);
    expect(mocks.dispatchHold).not.toHaveBeenCalled();
    mocks.reserveHold.mockImplementation(async input => { mocks.snapshots.set(input.eventId, input.billingSnapshot); return { hold: { eventId: input.eventId, billingSnapshot: input.billingSnapshot }, shouldDispatch: true, replayed: false }; });
    mocks.relayFetch.mockResolvedValue(chatResponse());
    const fresh = chatRequest(); fresh.headers.set("Idempotency-Key", "same-business-request");
    const response = await handleGatewayChatCompletions(fresh);
    expect(response.status).toBe(200);
    expect(new Headers(mocks.relayFetch.mock.calls[0][1].headers).get("Idempotency-Key")).toBe(response.headers.get("X-Gateway-Billing-Id"));
    expect(JSON.parse(mocks.relayFetch.mock.calls[0][1].body).max_completion_tokens).toBe(1024);
  });
  it("recognizes an idempotent replay even when its original hold consumed all available balance", async () => {
    mocks.assertGatewayBalance.mockResolvedValue(false);
    mocks.reserveHold.mockResolvedValue({ shouldDispatch: false, replayed: true });
    const replay = chatRequest(); replay.headers.set("Idempotency-Key", "original-fully-reserved-request");
    await expectRejected(await handleGatewayChatCompletions(replay), 409);
    expect(mocks.reserveHold).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "original-fully-reserved-request" }));
    expect(mocks.assertGatewayBalance).not.toHaveBeenCalled();
    expect(mocks.recordGatewayUsage).not.toHaveBeenCalled();
    expect(mocks.dispatchHold).not.toHaveBeenCalled();
  });
  it("releases a reserved request only if dispatch fails before any upstream request", async () => {
    mocks.dispatchHold.mockRejectedValue(new Error("database unavailable"));
    expect((await handleGatewayChatCompletions(chatRequest())).status).toBe(502);
    expect(mocks.relayFetch).not.toHaveBeenCalled();
    expect(mocks.releaseHold).toHaveBeenCalledWith(expect.objectContaining({ reason: "pre_dispatch" }));
    expect(mocks.unknownHold).not.toHaveBeenCalled();
  });

  it.each([null, [], "invalid"])("rejects non-object JSON request bodies (%j)", async (body) => {
    await expectRejected(await handleGatewayChatCompletions(request(body)), 400);
  });

  it("rejects a model at the wrong endpoint", async () => {
    await expectRejected(await handleGatewayChatCompletions(chatRequest({ model: imageModel.id })), 404);
  });

  it("fails closed when the relay upstream Key is absent", async () => {
    mocks.getRelayRuntime.mockResolvedValue(runtime({ apiKey: "" }));
    await expectRejected(await handleGatewayChatCompletions(chatRequest()), 503);
  });

  it.each([0, -1, 11, 1.5, "2", null])("rejects invalid image n=%j before upstream", async (n) => {
    await expectRejected(await handleGatewayImageGenerations(mediaRequest("image", { n })), 400);
  });

  it("pre-checks the entire requested image fee and records returned output count", async () => {
    mocks.relayFetch.mockResolvedValue(jsonResponse({ data: [{ b64_json: "a" }, { b64_json: "b" }, { url: "https://media.example.com/c.png" }] }));
    const response = await handleGatewayImageGenerations(mediaRequest("image", { n: 3, size: "1024x1024" }));
    expect(response.status).toBe(200);
    expect(mocks.assertGatewayBalance).toHaveBeenCalledWith(auth.userId, 150);
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ costCents: 150, imageCount: 3, endpoint: "images.generations", status: "ok" }));
  });

  it("applies one package multiplier to the full quote and only the returned images", async () => {
    const quoted = { ...billingSnapshot, multiplierBps: 8000, ruleVersion: 3 };
    mocks.getGatewayBillingSnapshot.mockResolvedValue(quoted);
    mocks.relayFetch.mockResolvedValue(jsonResponse({ data: [{ b64_json: "a" }, { b64_json: "b" }] }));
    const response = await handleGatewayImageGenerations(mediaRequest("image", { n: 3, size: "1024x1024", quality: "high" }));
    expect(response.status).toBe(200);
    expect(mocks.assertGatewayBalance).toHaveBeenCalledWith(auth.userId, 120);
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      baseCostCents: 100, costCents: 80, imageCount: 2, billingSnapshot: quoted,
      billingEventId: expect.any(String), audit: expect.objectContaining({ upstreamStatus: 200, outcome: "success" }),
      metadata: expect.objectContaining({ quality: "high", requestedImageCount: 3, tokenSource: "unreported" })
    }));
    expect(response.headers.get("x-gateway-billing-id")).toBe(mocks.recordGatewayUsage.mock.calls[0][0].billingEventId);
  });

  it("keeps the package snapshot when the administrator changes the rule during an upstream call", async () => {
    mocks.getGatewayBillingSnapshot.mockResolvedValue({ ...billingSnapshot, multiplierBps: 8000, ruleVersion: 2 });
    mocks.relayFetch.mockImplementation(async () => {
      mocks.getGatewayBillingSnapshot.mockResolvedValue({ ...billingSnapshot, multiplierBps: 15000, ruleVersion: 3 });
      return jsonResponse({ data: [{ b64_json: "a" }] });
    });
    expect((await handleGatewayImageGenerations(mediaRequest("image"))).status).toBe(200);
    expect(mocks.getGatewayBillingSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      costCents: 40, baseCostCents: 50, billingSnapshot: expect.objectContaining({ multiplierBps: 8000, ruleVersion: 2 })
    }));
  });

  it("preserves successful upstream billing facts when settlement fails and exposes the event for tracing", async () => {
    mocks.relayFetch.mockResolvedValue(jsonResponse({ id: "image_settlement", data: [{ url: "https://images.example/test.png" }] }));
    mocks.recordGatewayUsage.mockRejectedValueOnce(new Error("database unavailable with secret"));
    const response = await handleGatewayImageGenerations(mediaRequest("image", { size: "1024x1024", quality: "medium" }));
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("gateway_unavailable");
    expect(mocks.recordGatewayUsage).toHaveBeenCalledTimes(1);
    const initial = mocks.recordGatewayUsage.mock.calls[0][0];
    expect(initial).toMatchObject({ requestId: "image_settlement", costCents: 50, status: "ok" });
    expect(mocks.unknownHold).toHaveBeenCalledExactlyOnceWith({ userId: auth.userId, eventId: initial.billingEventId, reason: "settlement_failed" });
    expect(mocks.releaseHold).not.toHaveBeenCalled();
    expect(response.headers.get("x-gateway-billing-id")).toBe(initial.billingEventId);
  });

  it("records provider-reported image token usage and keeps safe upstream failure codes", async () => {
    mocks.relayFetch.mockResolvedValueOnce(jsonResponse({ id: "image_tokens", data: [{ url: "https://images.example/test.png" }],
      usage: { input_tokens: 230, output_tokens: 750, total_tokens: 980 } }));
    expect((await handleGatewayImageGenerations(mediaRequest("image"))).status).toBe(200);
    expect(mocks.recordGatewayUsage).toHaveBeenLastCalledWith(expect.objectContaining({ promptTokens: 230,
      completionTokens: 750, totalTokens: 980, costCents: 50, metadata: expect.objectContaining({ tokenSource: "reported" }) }));
    mocks.relayFetch.mockResolvedValueOnce(jsonResponse({ error: { code: "rate_limit_exceeded", message: "private upstream request content" }, usage: { actual_cost: 0 } }, 429));
    expect((await handleGatewayImageGenerations(mediaRequest("image"))).status).toBe(429);
    expect(mocks.recordGatewayUsage).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error", costCents: 0, error: "rate_limit_exceeded" }));
    expect(JSON.stringify(mocks.recordGatewayUsage.mock.calls.at(-1))).not.toContain("private upstream request content");
  });

  it("marks partially reported image tokens so omitted fields remain unknown", async () => {
    mocks.relayFetch.mockResolvedValueOnce(jsonResponse({ id: "image_partial", data: [{ url: "https://images.example/test.png" }], usage: { input_tokens: 230 } }));
    expect((await handleGatewayImageGenerations(mediaRequest("image"))).status).toBe(200);
    expect(mocks.recordGatewayUsage).toHaveBeenLastCalledWith(expect.objectContaining({ promptTokens: 230,
      metadata: expect.objectContaining({ tokenSource: "partial", reportedTokenFields: "prompt" }) }));
    mocks.relayFetch.mockRejectedValueOnce(new Error("network interrupted"));
    expect((await handleGatewayImageGenerations(mediaRequest("image"))).status).toBe(502);
    expect(mocks.recordGatewayUsage).toHaveBeenCalledTimes(1);
    expect(mocks.unknownHold).toHaveBeenCalledWith(expect.objectContaining({ userId: auth.userId, reason: "ambiguous_response" }));
  });

  it("retains the frozen quote after timeout without persisting prompt, image content or zero-cost fiction", async () => {
    mocks.relayFetch.mockRejectedValue(new RelayNetworkError("中转站请求超时或取消", 504));
    const response = await handleGatewayImageEdits(formRequest("image", { quality: "high" }));
    expect(response.status).toBe(504);
    expect(mocks.recordGatewayUsage).not.toHaveBeenCalled();
    expect(mocks.reserveHold).toHaveBeenCalledWith(expect.objectContaining({ quoteCents: 50, billingSnapshot }));
    expect(mocks.unknownHold).toHaveBeenCalledWith(expect.objectContaining({ userId: auth.userId }));
    expect(mocks.releaseHold).not.toHaveBeenCalled();
    const saved = JSON.stringify(mocks.reserveHold.mock.calls.concat(mocks.unknownHold.mock.calls));
    expect(saved).not.toContain("A calm street scene");
    expect(saved).not.toContain("mock image bytes");
    expect(saved).not.toContain(relayKey);
  });

  it("does not generate images when the full requested fee is unavailable", async () => {
    mocks.assertGatewayBalance.mockResolvedValue(false);
    await expectRejected(await handleGatewayImageGenerations(mediaRequest("image", { n: 3 })), 402, true);
    expect(mocks.assertGatewayBalance).toHaveBeenCalledWith(auth.userId, 150);
  });

  it("rounds fractional image prices consistently for balance checks and integer accounting", async () => {
    mocks.getRelayRuntime.mockResolvedValue(runtime({ models: [chatModel, { ...imageModel, imageCents: 50.1 }, videoModel] }));
    mocks.relayFetch.mockResolvedValue(jsonResponse({ data: [{ b64_json: "a" }, { b64_json: "b" }] }));
    expect((await handleGatewayImageGenerations(mediaRequest("image", { n: 2 }))).status).toBe(200);
    expect(mocks.assertGatewayBalance).toHaveBeenCalledWith(auth.userId, 101);
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ costCents: 101 }));
  });

  it("rejects upstream image counts greater than the budgeted request count", async () => {
    mocks.relayFetch.mockResolvedValue(jsonResponse({ data: [{ b64_json: "a" }, { b64_json: "b" }] }));
    expect((await handleGatewayImageGenerations(mediaRequest("image", { n: 1 }))).status).toBe(502);
    expect(mocks.recordGatewayUsage).not.toHaveBeenCalled();
    expect(mocks.unknownHold).toHaveBeenCalled();
  });

  it("forwards multipart edits with upstream model, reference file and validated n", async () => {
    mocks.relayFetch.mockResolvedValue(jsonResponse({ data: [{ b64_json: "a" }, { b64_json: "b" }] }));
    const response = await handleGatewayImageEdits(formRequest("image", { n: "2" }));
    expect(response.status).toBe(200);
    const [url, init] = mocks.relayFetch.mock.calls[0];
    expect(url).toBe(`${relayBase}/images/edits`);
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get("model")).toBe(imageModel.upstreamModel);
    expect(init.body.get("n")).toBe("2");
    expect(init.body.get("image")).toBeInstanceOf(Blob);
    expect(mocks.assertGatewayBalance).toHaveBeenCalledWith(auth.userId, 100);
    expect(new Headers(init.headers).get("content-type")).toBeNull();
  });

  it("rejects invalid multipart image n without forwarding uploaded files", async () => {
    await expectRejected(await handleGatewayImageEdits(formRequest("image", { n: "2.5" })), 400);
  });

  it.each([
    { field: "n", values: ["10", "1"] },
    { field: "n", values: ["1", "10"] },
    { field: "prompt", values: ["quoted prompt", "different supplier prompt"] },
    { field: "stream", values: ["true", "false"] }
  ])("rejects duplicate multipart $field values before freezing or dispatching", async ({ field, values }) => {
    const form = new FormData();
    form.set("model", imageModel.id);
    if (field !== "prompt") form.set("prompt", "A calm street scene");
    form.set("image", new Blob(["mock image bytes"], { type: "image/png" }), "reference.png");
    for (const value of values) form.append(field, value);
    const req = new Request("https://shaozhuangai.com/api/v1/images/edits", {
      method: "POST", headers: { Authorization: "Bearer sk-sz-mock-client" }, body: form
    });
    await expectRejected(await handleGatewayImageEdits(req), 400);
    expect(mocks.reserveHold).not.toHaveBeenCalled();
    expect(mocks.dispatchHold).not.toHaveBeenCalled();
  });

  it("requires a reference image for the edits endpoint", async () => {
    await expectRejected(await handleGatewayImageEdits(request({ model: imageModel.id, prompt: "edit me" }, "images/edits")), 400);
  });

  it("forwards multipart video with the selected upstream model and checks full task fee", async () => {
    mocks.relayFetch.mockResolvedValue(jsonResponse({ id: "video_123", object: "video", status: "queued" }, 202));
    const response = await handleGatewayVideoCreate(formRequest("video", { duration: "5", aspect_ratio: "16:9" }));
    expect(response.status).toBe(202);
    const [url, init] = mocks.relayFetch.mock.calls[0];
    expect(url).toBe(`${relayBase}/videos`);
    expect(init.body.get("model")).toBe(videoModel.upstreamModel);
    expect(init.body.get("duration")).toBe("5");
    expect(mocks.assertGatewayBalance).toHaveBeenCalledWith(auth.userId, 120);
  });

  it("records one accepted video task with its user and original upstream metadata", async () => {
    mocks.relayFetch.mockResolvedValue(jsonResponse({ request_id: "video_123", status: "pending" }, 202));
    const response = await handleGatewayVideoCreate(mediaRequest("video", { duration: 5 }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ id: "video_123", request_id: "video_123", model: videoModel.id });
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ auth, endpoint: "videos", requestId: "video_123", costCents: 120, status: "ok",
      metadata: expect.objectContaining({ upstreamModel: videoModel.upstreamModel, baseUrl: relayBase, billing: "accepted_task" }) }));
  });

  it.each([{ data: { task_id: "video_nested" } }, { video: { request_id: "video_nested" } }])("normalizes nested video task IDs (%j)", async (result) => {
    mocks.relayFetch.mockResolvedValue(jsonResponse({ ...result, status: "pending" }, 202));
    const response = await handleGatewayVideoCreate(mediaRequest("video"));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ id: "video_nested" });
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: "video_nested", costCents: 120 }));
  });

  it("does not charge for an immediately failed video task", async () => {
    mocks.relayFetch.mockResolvedValue(jsonResponse({ id: "video_123", status: "failed", usage: { actual_cost: 0 } }));
    const response = await handleGatewayVideoCreate(mediaRequest("video"));
    expect(response.status).toBe(502);
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ costCents: 0, status: "error" }));
  });

  it("returns a safe network failure and retains the hold without exposing exception secrets", async () => {
    mocks.relayFetch.mockRejectedValue(new Error(`upstream headers include ${relayKey}`));
    const response = await handleGatewayChatCompletions(chatRequest());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(relayKey);
    expect(mocks.recordGatewayUsage).not.toHaveBeenCalled();
    expect(mocks.unknownHold).toHaveBeenCalled();
    expect(mocks.releaseHold).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.recordGatewayUsage.mock.calls)).not.toContain(relayKey);
  });

  it.each([499, 504])("returns safe 504 for cancelled or timed out transport (%i)", async (status) => {
    mocks.relayFetch.mockRejectedValue(new RelayNetworkError("中转站请求超时或取消", status));
    const response = await handleGatewayChatCompletions(chatRequest());
    expect(response.status).toBe(504);
    expect((await response.json()).error.code).toBe("upstream_timeout");
    expect(mocks.recordGatewayUsage).not.toHaveBeenCalled();
    expect(mocks.unknownHold).toHaveBeenCalled();
  });

  it("redacts upstream credentials from successful nested JSON responses", async () => {
    mocks.relayFetch.mockResolvedValue(jsonResponse({ id: "chat_123", choices: [{ message: { content: `debug ${relayKey}` } }], debug: { nested: [relayKey], [relayKey]: "reflected key" } }));
    const response = await handleGatewayChatCompletions(chatRequest());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(relayKey);
    expect(text).toContain("[redacted]");
  });

  it("rejects upstream HTML as a protocol error and retains the unresolved hold", async () => {
    mocks.relayFetch.mockResolvedValue(new Response(`<html>error ${relayKey}</html>`, { status: 502, headers: { "Content-Type": "text/html" } }));
    const response = await handleGatewayImageGenerations(mediaRequest("image"));
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("invalid_upstream_response");
    expect(mocks.recordGatewayUsage).not.toHaveBeenCalled();
    expect(mocks.unknownHold).toHaveBeenCalled();
  });

  it.each([[401, 502], [429, 429]])("maps upstream %i to readable safe JSON (%i) and records zero cost", async (upstreamStatus, clientStatus) => {
    mocks.relayFetch.mockResolvedValue(jsonResponse({ error: { message: `bad credentials ${relayKey}`, debug: { key: relayKey } }, usage: { actual_cost: 0 } }, upstreamStatus, { "Retry-After": "30" }));
    const response = await handleGatewayChatCompletions(chatRequest());
    expect(response.status).toBe(clientStatus);
    const text = await response.text();
    expect(text).not.toContain(relayKey);
    expect(JSON.parse(text).error.message).toContain("上游调用失败");
    if (upstreamStatus === 429) expect(response.headers.get("retry-after")).toBe("30");
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ costCents: 0, status: "error" }));
    expect(JSON.stringify(mocks.recordGatewayUsage.mock.calls)).not.toContain(relayKey);
  });

  it("retains the unresolved hold when a successful response lacks media output", async () => {
    mocks.relayFetch.mockResolvedValue(jsonResponse({ data: [] }));
    expect((await handleGatewayImageGenerations(mediaRequest("image"))).status).toBe(502);
    expect(mocks.recordGatewayUsage).not.toHaveBeenCalled();
    expect(mocks.unknownHold).toHaveBeenCalled();
  });
});

describe("model gateway discovery and video reads", () => {
  it("reads per-user videos with the retained credential without provisioning or switching current Keys",async()=>{
    mocks.findGatewayVideoJob.mockResolvedValue({provider:"shaozhuang",model:videoModel.id,upstreamModel:videoModel.upstreamModel,baseUrl:relayBase,credentialId:"retained-credential"});
    mocks.relayFetch.mockResolvedValue(jsonResponse({id:"video_123",status:"pending"}));
    expect((await handleGatewayVideoRead(readRequest(),"video_123")).status).toBe(200);
    expect(mocks.getUserSupplyCredential).toHaveBeenCalledExactlyOnceWith(auth.userId,"retained-credential");
    expect(new Headers(mocks.relayFetch.mock.calls[0][1].headers).get("authorization")).toBe("Bearer retained-user-key");
    expect(mocks.getRelayRuntime).not.toHaveBeenCalled();expect(mocks.getUserSupplyRuntime).not.toHaveBeenCalled();expect(mocks.bindHold).not.toHaveBeenCalled();
  });
  it("returns only public model fields without exposing Key or server base URL", async () => {
    const response = await handleGatewayModels(readRequest("models"));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(relayKey);
    expect(text).not.toContain(relayBase);
    expect(text).not.toContain("apiKeyEnv");
    expect(text).not.toContain("upstreamModel");
    expect(JSON.parse(text)).toMatchObject({ object: "list", data: expect.arrayContaining([expect.objectContaining({ id: chatModel.id, endpoint: "chat/completions" })]) });
    expect(mocks.assertGatewayBalance).not.toHaveBeenCalled();
    expect(mocks.relayFetch).not.toHaveBeenCalled();
  });

  it("requires client Key authentication for discovery", async () => {
    mocks.authenticateGatewayKey.mockResolvedValue(null);
    await expectRejected(await handleGatewayModels(readRequest("models")), 401);
  });

  it("polls owned tasks without balance checks or charging and rewrites protected video URLs", async () => {
    mocks.relayFetch.mockResolvedValue(jsonResponse({ request_id: "video_123", status: "done", video: { url: `${relayBase}/videos/video_123/content` } }));
    const response = await handleGatewayVideoRead(readRequest(), "video_123");
    expect(response.status).toBe(200);
    expect(mocks.findGatewayVideoJob).toHaveBeenCalledWith(auth.userId, "video_123");
    expect(mocks.relayFetch).toHaveBeenCalledWith(`${relayBase}/videos/video_123`, expect.objectContaining({ method: "GET" }));
    const data = await response.json();
    expect(data.model).toBe(videoModel.id);
    expect(data.video.url).not.toContain(relayBase);
    expect(data.video.url).toContain("/videos/video_123/content");
    expect(mocks.assertGatewayBalance).not.toHaveBeenCalled();
    expect(mocks.recordGatewayUsage).not.toHaveBeenCalled();
  });

  it.each([false, true])("denies status/content access to a task absent from the user's ownership records (content=%s)", async (content) => {
    mocks.authenticateGatewayKey.mockResolvedValue({ ...auth, userId: "user-b" });
    mocks.findGatewayVideoJob.mockResolvedValue(null);
    await expectRejected(await handleGatewayVideoRead(readRequest(), "video_123", content), 404);
    expect(mocks.findGatewayVideoJob).toHaveBeenCalledWith("user-b", "video_123");
  });

  it("rejects changed upstream base before sending the current credential to the former host", async () => {
    mocks.getRelayRuntime.mockResolvedValue(runtime({ baseUrl: "https://new-relay.example.com/v1" }));
    await expectRejected(await handleGatewayVideoRead(readRequest(), "video_123"), 409);
  });

  it("rejects path traversal in video task IDs", async () => {
    await expectRejected(await handleGatewayVideoRead(readRequest(), "../other-task"), 400);
    expect(mocks.findGatewayVideoJob).not.toHaveBeenCalled();
  });

  it("streams owned video downloads without cookies, upstream headers or repeated billing", async () => {
    mocks.relayFetch.mockResolvedValue(new Response(new Uint8Array([0, 1, 2, 3]), { headers: {
      "Content-Type": "video/mp4", "Set-Cookie": "upstream-session=secret", "X-Upstream-Key": relayKey, "Content-Disposition": "attachment; filename=video.mp4"
    } }));
    const response = await handleGatewayVideoRead(readRequest("videos/video_123/content"), "video_123", true);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-upstream-key")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 1, 2, 3]);
    expect(mocks.recordGatewayUsage).not.toHaveBeenCalled();
    expect(mocks.assertGatewayBalance).not.toHaveBeenCalled();
  });

  it("forwards a single byte Range and preserves safe partial content metadata", async () => {
    const req = new Request("https://shaozhuangai.com/api/v1/videos/video_123/content", { headers: { Authorization: "Bearer sk-sz-mock-client", Range: "bytes=1-2" } });
    mocks.relayFetch.mockResolvedValue(new Response(new Uint8Array([1, 2]), { status: 206, headers: {
      "Content-Type": "video/mp4", "Content-Range": "bytes 1-2/4", "Accept-Ranges": "bytes", "Content-Length": "2", "Set-Cookie": "secret=session"
    } }));
    const response = await handleGatewayVideoRead(req, "video_123", true);
    expect(response.status).toBe(206);
    expect(new Headers(mocks.relayFetch.mock.calls[0][1].headers).get("range")).toBe("bytes=1-2");
    expect(response.headers.get("content-range")).toBe("bytes 1-2/4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("2");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2]);
    expect(mocks.recordGatewayUsage).not.toHaveBeenCalled();
  });

  it("rejects multiple byte Ranges without contacting the upstream", async () => {
    const req = new Request("https://shaozhuangai.com/api/v1/videos/video_123/content", { headers: { Authorization: "Bearer sk-sz-mock-client", Range: "bytes=0-1,2-3" } });
    await expectRejected(await handleGatewayVideoRead(req, "video_123", true), 400);
  });

  it("forwards a supported thumbnail variant without additional billing", async () => {
    mocks.relayFetch.mockResolvedValue(new Response(new Uint8Array([1, 2]), { headers: { "Content-Type": "image/png" } }));
    const response = await handleGatewayVideoRead(readRequest("videos/video_123/content?variant=thumbnail"), "video_123", true);
    expect(response.status).toBe(200);
    expect(mocks.relayFetch.mock.calls[0][0]).toBe(`${relayBase}/videos/video_123/content?variant=thumbnail`);
    expect(mocks.recordGatewayUsage).not.toHaveBeenCalled();
  });

  it("rejects unsupported download variants without an upstream request", async () => {
    await expectRejected(await handleGatewayVideoRead(readRequest("videos/video_123/content?variant=private"), "video_123", true), 400);
  });

  it("rejects HTML content downloads without exposing upstream body", async () => {
    mocks.relayFetch.mockResolvedValue(new Response(`<html>${relayKey}</html>`, { headers: { "Content-Type": "text/html" } }));
    const response = await handleGatewayVideoRead(readRequest("videos/video_123/content"), "video_123", true);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(relayKey);
    expect(mocks.recordGatewayUsage).not.toHaveBeenCalled();
  });
});


describe("frozen automatic exchange rate in gateway generation", () => {
  const fx = { rate: 7.2, source: "ecb" as const, referenceDate: "2026-10-02", fetchedAt: "2026-10-02T16:05:00.000Z", id: "a".repeat(64) };
  const view = { mode: "automatic", status: "ready", ...fx };
  it("persists provenance and uses the quoted rate when the daily cache changes before settlement", async () => {
    vi.stubEnv("MODEL_GATEWAY_FX_AUTOMATIC", "1");
    mocks.getRelayRuntime.mockResolvedValue(runtime({ usdCnyRate: fx.rate, exchangeRate: view }));
    mocks.relayFetch.mockImplementation(async () => {
      mocks.getRelayRuntime.mockResolvedValue(runtime({ usdCnyRate: 9, exchangeRate: { ...view, id: "b".repeat(64) } }));
      return jsonResponse({ choices: [{ message: { content: "ok" } }], usage: { actual_cost: 1 } });
    });
    expect((await handleGatewayChatCompletions(chatRequest())).status).toBe(200);
    expect(mocks.reserveHold.mock.calls[0][0].billingSnapshot.fxSnapshot).toEqual(fx);
    expect(mocks.recordGatewayUsage).toHaveBeenCalledWith(expect.objectContaining({ baseCostCents: 720, costCents: 720,
      billingSnapshot: expect.objectContaining({ fxSnapshot: fx }), metadata: expect.objectContaining({ usdCnyRate: "7.2", fxSource: "ecb", fxQuoteId: fx.id, fxReferenceDate: fx.referenceDate, fxFetchedAt: fx.fetchedAt }) }));
  });
  it("takes the persisted dispatch snapshot as authority rather than a newer in-memory quote", async () => {
    mocks.getRelayRuntime.mockResolvedValue(runtime({ usdCnyRate: 9 }));
    const persisted = { ...billingSnapshot, fxSnapshot: fx };
    mocks.dispatchHold.mockImplementation(async input => { mocks.snapshots.set(input.eventId, persisted); return { shouldDispatch:true, hold:{eventId:input.eventId,billingSnapshot:persisted} }; });
    mocks.relayFetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "ok" } }], usage: { actual_cost: 1 } }));
    expect((await handleGatewayChatCompletions(chatRequest())).status).toBe(200);
    expect(mocks.recordGatewayUsage.mock.calls[0][0]).toMatchObject({baseCostCents:720,billingSnapshot:persisted});
  });
  it("blocks an unavailable automatic cache with zero reservation and upstream dispatch", async () => {
    vi.stubEnv("MODEL_GATEWAY_FX_AUTOMATIC", "1");
    mocks.getRelayRuntime.mockResolvedValue(runtime({ usdCnyRate:null, exchangeRate:{...view,status:"unavailable",errorCode:"FX_CACHE_STALE"} }));
    await expectRejected(await handleGatewayChatCompletions(chatRequest()), 503);
    expect(mocks.reserveHold).not.toHaveBeenCalled(); expect(mocks.dispatchHold).not.toHaveBeenCalled();
  });
  it("allows a hard-valid stale cache after a failed refresh", async () => {
    vi.stubEnv("MODEL_GATEWAY_FX_AUTOMATIC", "1");
    mocks.getRelayRuntime.mockResolvedValue(runtime({ usdCnyRate:7.2, exchangeRate:{...view,status:"stale",errorCode:"FX_FETCH_FAILED"} }));
    mocks.relayFetch.mockResolvedValue(chatResponse());
    expect((await handleGatewayChatCompletions(chatRequest())).status).toBe(200);
    expect(mocks.reserveHold.mock.calls[0][0].billingSnapshot.fxSnapshot).toEqual(fx);
  });
  it("never redispatches an idempotent replay when the effective rate has changed", async () => {
    mocks.getRelayRuntime.mockResolvedValue(runtime({usdCnyRate:9}));
    mocks.reserveHold.mockResolvedValue({shouldDispatch:false,replayed:true,hold:{eventId:"original",billingSnapshot:{...billingSnapshot,fxSnapshot:fx}}});
    const req=chatRequest(); req.headers.set("idempotency-key","original-operation");
    await expectRejected(await handleGatewayChatCompletions(req),409);
    expect(mocks.dispatchHold).not.toHaveBeenCalled(); expect(mocks.settleHold).not.toHaveBeenCalled();
  });
});
