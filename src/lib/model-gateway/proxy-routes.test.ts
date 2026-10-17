import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateGatewayKey: vi.fn(),
  assertGatewayBalance: vi.fn(),
  recordGatewayUsage: vi.fn(),
  getGatewayBillingSnapshot: vi.fn(),
  getRelayRuntime: vi.fn(),
  getUserSupplyRuntime: vi.fn(),
  getUserSupplyCredential: vi.fn(),
  relayFetch: vi.fn(),
  findGatewayVideoJob: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/model-gateway/store", () => ({
  authenticateGatewayKey: mocks.authenticateGatewayKey,
  assertGatewayBalance: mocks.assertGatewayBalance,
  recordGatewayUsage: mocks.recordGatewayUsage
}));
vi.mock("@/lib/model-gateway/billing", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/model-gateway/billing")>(),
  getGatewayBillingSnapshot: mocks.getGatewayBillingSnapshot
}));
vi.mock("@/lib/model-gateway/relay-config", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/model-gateway/relay-config")>(),
  getRelayRuntime: mocks.getRelayRuntime
}));
vi.mock("@/lib/model-gateway/video-jobs", () => ({ findGatewayVideoJob: mocks.findGatewayVideoJob }));
vi.mock("@/lib/model-gateway/user-supply", () => ({
  getUserSupplyRuntime: mocks.getUserSupplyRuntime,
  getUserSupplyCredential: mocks.getUserSupplyCredential,
  UserSupplyError: class extends Error { constructor(message: string, readonly status = 503, readonly code = "user_supply_unavailable") { super(message); } }
}));
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
const backupKey = "mock-backup-secret-only-for-tests";
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

function supplyRuntime(overrides: Record<string, unknown> = {}) {
  return { baseUrl: relayBase, primary: { id: "credential-a", apiKey: relayKey }, backup: { id: "credential-b", apiKey: backupKey }, usdCnyRate: null, ...overrides };
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
  mocks.authenticateGatewayKey.mockResolvedValue(auth);
  mocks.assertGatewayBalance.mockResolvedValue(true);
  mocks.recordGatewayUsage.mockResolvedValue({ id: "usage_123" });
  mocks.getGatewayBillingSnapshot.mockResolvedValue({ ...billingSnapshot });
  mocks.getRelayRuntime.mockResolvedValue(runtime());
  mocks.getUserSupplyRuntime.mockResolvedValue(supplyRuntime());
  mocks.getUserSupplyCredential.mockResolvedValue({ baseUrl: relayBase, apiKey: backupKey });
  mocks.findGatewayVideoJob.mockResolvedValue({ provider: "shaozhuang", model: videoModel.id, upstreamModel: videoModel.upstreamModel, baseUrl: relayBase });
});

describe("model gateway generation handlers", () => {
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
    expect(mocks.getUserSupplyRuntime).toHaveBeenCalledExactlyOnceWith(auth.userId);
    expect(JSON.parse(init.body)).toMatchObject({ model: chatModel.upstreamModel, temperature: 0.4 });
    expect(await response.json()).toMatchObject({ model: chatModel.id, id: "chat_123" });
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ auth, costCents: 5, status: "ok", promptTokens: 1000, completionTokens: 500 }));
  });

  it("uses the immutable account supply Key and settles its dollar cost into RMB cents", async () => {
    mocks.authenticateGatewayKey.mockResolvedValue({ ...auth, shopName: "西西礼" });
    mocks.getRelayRuntime.mockResolvedValue(runtime({
      apiKey: "platform-key",
      shopKeys: [
        { shopName: "西西礼", purpose: "default", apiKey: "xixi-key" },
        { shopName: "少壮", purpose: "image", apiKey: "gemini-key" }
      ]
    }));
    mocks.getUserSupplyRuntime.mockResolvedValue(supplyRuntime({ primary: { id: "user-a-primary", apiKey: "user-a-supply-key" }, usdCnyRate: 7.2 }));
    mocks.relayFetch.mockResolvedValue(jsonResponse({
      id: "chat_usd", model: chatModel.upstreamModel,
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, actual_cost: 0.01, quota: 500000 }
    }));
    const response = await handleGatewayChatCompletions(chatRequest());
    expect(response.status).toBe(200);
    expect(new Headers(mocks.relayFetch.mock.calls[0][1].headers).get("authorization")).toBe("Bearer user-a-supply-key");
    expect(mocks.getUserSupplyRuntime).toHaveBeenCalledExactlyOnceWith(auth.userId);
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      baseCostCents: 8, costCents: 8,
      metadata: expect.objectContaining({ credentialId: "user-a-primary", costSource: "upstream_usd", usdCost: "0.01", usdCnyRate: "7.2" })
    }));
    expect(JSON.stringify(mocks.recordGatewayUsage.mock.calls[0][0])).not.toContain("xixi-key");
  });

  it.each([true, "true"])("rejects stream=%s without an upstream call", async (stream) => {
    await expectRejected(await handleGatewayChatCompletions(chatRequest({ stream })), 400);
  });

  it.each([null, [], "invalid"])("rejects non-object JSON request bodies (%j)", async (body) => {
    await expectRejected(await handleGatewayChatCompletions(request(body)), 400);
  });

  it("rejects a model at the wrong endpoint", async () => {
    await expectRejected(await handleGatewayChatCompletions(chatRequest({ model: imageModel.id })), 404);
  });

  it("fails closed when the relay upstream Key is absent", async () => {
    mocks.getUserSupplyRuntime.mockResolvedValue(supplyRuntime({ primary: { id: "credential-a", apiKey: "" }, backup: null }));
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
    expect(mocks.recordGatewayUsage).toHaveBeenCalledTimes(2);
    const initial = mocks.recordGatewayUsage.mock.calls[0][0];
    expect(mocks.recordGatewayUsage.mock.calls[1][0]).toEqual(expect.objectContaining({
      billingEventId: initial.billingEventId, requestId: "image_settlement", baseCostCents: 50,
      imageCount: 1, costCents: 0, status: "error", error: "SETTLEMENT_FAILED",
      audit: expect.objectContaining({ upstreamStatus: 200, outcome: "settlement_failed" }),
      metadata: expect.objectContaining({ requestedImageCount: 1, size: "1024x1024", quality: "medium" })
    }));
    expect(response.headers.get("x-gateway-billing-id")).toBe(initial.billingEventId);
  });

  it("records provider-reported image token usage and keeps safe upstream failure codes", async () => {
    mocks.relayFetch.mockResolvedValueOnce(jsonResponse({ id: "image_tokens", data: [{ url: "https://images.example/test.png" }],
      usage: { input_tokens: 230, output_tokens: 750, total_tokens: 980 } }));
    expect((await handleGatewayImageGenerations(mediaRequest("image"))).status).toBe(200);
    expect(mocks.recordGatewayUsage).toHaveBeenLastCalledWith(expect.objectContaining({ promptTokens: 230,
      completionTokens: 750, totalTokens: 980, costCents: 50, metadata: expect.objectContaining({ tokenSource: "reported" }) }));
    mocks.relayFetch.mockResolvedValueOnce(jsonResponse({ error: { code: "rate_limit_exceeded", message: "private upstream request content" } }, 429));
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
    expect(mocks.recordGatewayUsage).toHaveBeenLastCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ tokenSource: "unreported" }) }));
  });

  it("records a failed invocation with its frozen rule and safe diagnostics without prompt or image content", async () => {
    mocks.relayFetch.mockRejectedValue(new RelayNetworkError("中转站请求超时或取消", 504));
    const response = await handleGatewayImageEdits(formRequest("image", { quality: "high" }));
    expect(response.status).toBe(504);
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      costCents: 0, baseCostCents: 0, status: "error", billingSnapshot,
      metadata: expect.objectContaining({ inputImageCount: 1, quality: "high" }),
      audit: expect.objectContaining({ durationMs: expect.any(Number) })
    }));
    const saved = JSON.stringify(mocks.recordGatewayUsage.mock.calls);
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
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ costCents: 0, status: "error" }));
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
    mocks.relayFetch.mockResolvedValue(jsonResponse({ id: "video_123", status: "failed" }));
    const response = await handleGatewayVideoCreate(mediaRequest("video"));
    expect(response.status).toBe(502);
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ costCents: 0, status: "error" }));
  });

  it("returns a safe network failure and records zero cost without exposing exception secrets", async () => {
    mocks.relayFetch.mockRejectedValue(new Error(`upstream headers include ${relayKey}`));
    const response = await handleGatewayChatCompletions(chatRequest());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(relayKey);
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ costCents: 0, status: "error" }));
    expect(JSON.stringify(mocks.recordGatewayUsage.mock.calls)).not.toContain(relayKey);
  });

  it.each([499, 504])("returns safe 504 for cancelled or timed out transport (%i)", async (status) => {
    mocks.relayFetch.mockRejectedValue(new RelayNetworkError("中转站请求超时或取消", status));
    const response = await handleGatewayChatCompletions(chatRequest());
    expect(response.status).toBe(504);
    expect((await response.json()).error.code).toBe("upstream_timeout");
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ costCents: 0, status: "error" }));
  });

  it("redacts upstream credentials from successful nested JSON responses", async () => {
    mocks.relayFetch.mockResolvedValue(jsonResponse({ id: "chat_123", choices: [{ message: { content: `debug ${relayKey}` } }], debug: { nested: [relayKey, backupKey] } }));
    const response = await handleGatewayChatCompletions(chatRequest());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(relayKey);
    expect(text).not.toContain(backupKey);
    expect(text).toContain("[redacted]");
  });

  it("rejects upstream HTML as a protocol error with zero cost", async () => {
    mocks.relayFetch.mockResolvedValue(new Response(`<html>error ${relayKey}</html>`, { status: 502, headers: { "Content-Type": "text/html" } }));
    const response = await handleGatewayImageGenerations(mediaRequest("image"));
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("invalid_upstream_response");
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ costCents: 0, status: "error" }));
  });

  it.each([[401, 502], [429, 429]])("maps upstream %i to readable safe JSON (%i) and records zero cost", async (upstreamStatus, clientStatus) => {
    mocks.relayFetch.mockResolvedValue(jsonResponse({ error: { message: `bad credentials ${relayKey}`, debug: { key: relayKey } } }, upstreamStatus, { "Retry-After": "30" }));
    const response = await handleGatewayChatCompletions(chatRequest());
    expect(response.status).toBe(clientStatus);
    const text = await response.text();
    expect(text).not.toContain(relayKey);
    expect(JSON.parse(text).error.message).toContain("上游调用失败");
    if (upstreamStatus === 429) expect(response.headers.get("retry-after")).toBe("30");
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ costCents: 0, status: "error" }));
    expect(JSON.stringify(mocks.recordGatewayUsage.mock.calls)).not.toContain(relayKey);
  });

  it("rejects a successful response lacking media output without billing", async () => {
    mocks.relayFetch.mockResolvedValue(jsonResponse({ data: [] }));
    expect((await handleGatewayImageGenerations(mediaRequest("image"))).status).toBe(502);
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ costCents: 0, status: "error" }));
  });

  it("uses the backup once after explicit authentication rejection, replays multipart images, and settles only final output", async () => {
    mocks.relayFetch.mockResolvedValueOnce(jsonResponse({ code: "INVALID_API_KEY", message: relayKey }, 401))
      .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: "image" }], debug: [relayKey, backupKey] }));
    const response = await handleGatewayImageEdits(formRequest("image"));
    expect(response.status).toBe(200);
    expect(mocks.relayFetch).toHaveBeenCalledTimes(2);
    expect(mocks.relayFetch.mock.calls.map(([, init]) => new Headers(init.headers).get("authorization"))).toEqual([`Bearer ${relayKey}`, `Bearer ${backupKey}`]);
    for (const [, init] of mocks.relayFetch.mock.calls) {
      expect(init.body.get("model")).toBe(imageModel.upstreamModel);
      expect(await init.body.get("image").text()).toBe("mock image bytes");
    }
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      status: "ok", costCents: 50, metadata: expect.objectContaining({ credentialId: "credential-b" })
    }));
    const text = await response.text();
    expect(text).not.toContain(relayKey);
    expect(text).not.toContain(backupKey);
    expect(JSON.stringify(mocks.recordGatewayUsage.mock.calls)).not.toContain(relayKey);
    expect(JSON.stringify(mocks.recordGatewayUsage.mock.calls)).not.toContain(backupKey);
  });

  it.each([429, 500, 503])("does not create a second image on ambiguous upstream HTTP %i", async (status) => {
    mocks.relayFetch.mockResolvedValue(jsonResponse({ error: { code: "invalid_api_key" } }, status));
    expect((await handleGatewayImageGenerations(mediaRequest("image"))).status).toBe(status);
    expect(mocks.relayFetch).toHaveBeenCalledOnce();
    expect(mocks.recordGatewayUsage).toHaveBeenCalledOnce();
  });

  it("stores the accepted backup credential with video task ownership", async () => {
    mocks.relayFetch.mockResolvedValueOnce(jsonResponse({ error: { code: "invalid_api_key" } }, 401))
      .mockResolvedValueOnce(jsonResponse({ id: "backup_video", status: "queued" }, 202));
    expect((await handleGatewayVideoCreate(mediaRequest("video"))).status).toBe(202);
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      requestId: "backup_video", status: "ok", metadata: expect.objectContaining({ credentialId: "credential-b", baseUrl: relayBase })
    }));
  });

  it("records the attempted backup credential when its submission outcome is unknown", async () => {
    mocks.relayFetch.mockResolvedValueOnce(jsonResponse({ error: { code: "invalid_api_key" } }, 401))
      .mockRejectedValueOnce(new RelayNetworkError("请求超时", 504));
    expect((await handleGatewayImageGenerations(mediaRequest("image"))).status).toBe(504);
    expect(mocks.relayFetch).toHaveBeenCalledTimes(2);
    expect(mocks.recordGatewayUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      status: "error", costCents: 0, metadata: expect.objectContaining({ credentialId: "credential-b" })
    }));
  });
});

describe("model gateway discovery and video reads", () => {
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

  it("polls with the immutable task credential even after the user's current primary changes", async () => {
    mocks.findGatewayVideoJob.mockResolvedValue({ provider: "shaozhuang", model: videoModel.id, upstreamModel: videoModel.upstreamModel, baseUrl: relayBase, credentialId: "retained-old-backup" });
    mocks.getUserSupplyCredential.mockResolvedValue({ baseUrl: relayBase, apiKey: "retained-old-key" });
    mocks.relayFetch.mockResolvedValue(jsonResponse({ id: "video_123", status: "pending" }));
    expect((await handleGatewayVideoRead(readRequest(), "video_123")).status).toBe(200);
    expect(mocks.getUserSupplyCredential).toHaveBeenCalledExactlyOnceWith(auth.userId, "retained-old-backup");
    expect(new Headers(mocks.relayFetch.mock.calls[0][1].headers).get("authorization")).toBe("Bearer retained-old-key");
    expect(mocks.getRelayRuntime).not.toHaveBeenCalled();
    expect(mocks.getUserSupplyRuntime).not.toHaveBeenCalled();
    expect(mocks.recordGatewayUsage).not.toHaveBeenCalled();
  });

  it("keeps legacy video reads on the original global credential", async () => {
    mocks.relayFetch.mockResolvedValue(jsonResponse({ id: "video_123", status: "pending" }));
    expect((await handleGatewayVideoRead(readRequest(), "video_123")).status).toBe(200);
    expect(mocks.getRelayRuntime).toHaveBeenCalledOnce();
    expect(mocks.getUserSupplyCredential).not.toHaveBeenCalled();
    expect(new Headers(mocks.relayFetch.mock.calls[0][1].headers).get("authorization")).toBe(`Bearer ${relayKey}`);
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
