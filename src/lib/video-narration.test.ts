import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), snapshot: vi.fn(), balance: vi.fn(), usage: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("@/lib/model-gateway/billing", () => ({ getGatewayBillingSnapshot: mocks.snapshot }));
vi.mock("@/lib/model-gateway/store", () => ({ assertGatewayBalance: mocks.balance, recordGatewayUsage: mocks.usage }));
import { generateNarration, readNarration, narrationConfig, narrationCapabilities, narrationPrice, narrationWavDuration, parseNarrationInput, type NarrationConfig } from "./video-narration";
import { GatewayBillingError } from "@/lib/model-gateway/billing-contract";

const account = { id: "owned-user", username: "owner" };
const input = { requestId: "request_stable", shotId: "shot_1", text: "这是新脚本，不是上传原音。", durationSeconds: 5, expectedAccountKey: account.id };
function wav(seconds = 2) { const b = new Uint8Array(44 + seconds * 16000); const v = new DataView(b.buffer); const tag = (at: number, value: string) => [...value].forEach((char, i) => { b[at + i] = char.charCodeAt(0); }); tag(0, "RIFF"); v.setUint32(4, b.length - 8, true); tag(8, "WAVE"); tag(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, "data"); v.setUint32(40, b.length - 44, true); return b; }
let directories: string[] = [];
let config: NarrationConfig;
beforeEach(async () => {
  vi.resetAllMocks(); const storageDir = await mkdtemp(path.join(os.tmpdir(), "narration-behavior-")); directories.push(storageDir);
  config = { enabled: true, apiKey: "private-synthetic-key", endpoint: "https://api.openai.com/v1/audio/speech", model: "test-tts", voice: "test-voice", centsPer1KChar: 100, storageDir };
  mocks.lookup.mockResolvedValue([{ address: "104.18.1.1", family: 4 }]); mocks.balance.mockResolvedValue(true); mocks.usage.mockResolvedValue({ id: "usage" });
  mocks.snapshot.mockResolvedValue({ userId: account.id, tenantId: "owned-tenant", username: account.username, userName: "owner", planCode: "free", planName: "体验", multiplierBps: 12500, ruleVersion: 3, quotedAt: "2026-10-16T00:00:00Z" });
});
afterEach(async () => { await Promise.all(directories.map(dir => rm(dir, { recursive: true, force: true }))); directories = []; });
function transport(seconds = 2) { return vi.fn<typeof fetch>().mockResolvedValue(new Response(wav(seconds), { headers: { "content-type": "audio/wav", "x-request-id": "provider-request" } })); }
function fishConfig(extra: Partial<NarrationConfig> = {}): NarrationConfig { return { ...config, provider: "fish", endpoint: "https://api.fish.audio/v1/tts", model: "s2.1-pro", voice: "", referenceId: "confirmed_voice_id", centsPerMillionUtf8Bytes: 1_000_000, ...extra }; }

describe("new script narration supplier, durable receipts and billing", () => {
  it("fails closed until independent supply and explicit pricing are configured", async () => {
    expect(narrationCapabilities(narrationConfig({}))).toMatchObject({ available: false, code: "NARRATION_NOT_CONFIGURED" });
    expect(narrationCapabilities({ ...config, centsPer1KChar: null })).toMatchObject({ available: false, code: "NARRATION_BILLING_NOT_CONFIGURED" });
    const send = transport(); await expect(generateNarration(account, input, { ...config, enabled: false }, send)).rejects.toMatchObject({ providerSubmitted: false }); expect(send).not.toHaveBeenCalled();
  });
  it("generates exact confirmed words, saves a new WAV before idempotent settlement and replays without another supplier call", async () => {
    const send = transport(), first = await generateNarration(account, input, config, send);
    expect(JSON.parse(String(send.mock.calls[0][1]!.body))).toEqual({ model: "test-tts", voice: "test-voice", input: input.text, response_format: "wav" });
    expect(first.receipt).toMatchObject({ status: "succeeded", providerSubmitted: true, durationSeconds: 2, baseCostCents: 2, chargedCostCents: 3 });
    expect(first.bytes).toEqual(wav()); expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "audio.speech", model: "test-tts", costCents: 3, billingEventId: first.receipt.billingEventId }));
    const replay = await generateNarration(account, input, { ...config, enabled: false, apiKey: "changed" }, send); expect(replay.bytes).toEqual(first.bytes); expect(send).toHaveBeenCalledTimes(1); expect(mocks.usage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first.receipt)).not.toContain(config.apiKey);
  });
  it("keeps generated audio when billing is unavailable and retries settlement only under the same event", async () => {
    const send = transport(); mocks.usage.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(generateNarration(account, input, config, send)).rejects.toThrow("database unavailable");
    await expect(readNarration(account, input.requestId, config)).rejects.toMatchObject({ code: "NARRATION_SETTLEMENT_PENDING" });
    const second = await generateNarration(account, input, config, send); expect(second.receipt.status).toBe("succeeded"); expect(send).toHaveBeenCalledTimes(1); expect(mocks.usage).toHaveBeenCalledTimes(2);
    expect(mocks.usage.mock.calls[0][0].billingEventId).toBe(mocks.usage.mock.calls[1][0].billingEventId);
  });
  it("holds a permanent settlement_rejected ledger event for manual reconciliation instead of promising recharge recovery", async () => {
    const send = transport(); mocks.usage.mockRejectedValue(new GatewayBillingError("INSUFFICIENT_BALANCE", "结算余额不足", 402));
    await expect(generateNarration(account, input, config, send)).rejects.toMatchObject({ code: "NARRATION_SETTLEMENT_REJECTED", stateUncertain: true });
    await expect(readNarration(account, input.requestId, config)).rejects.toMatchObject({ code: "NARRATION_SETTLEMENT_REJECTED" });
    mocks.balance.mockResolvedValue(true); // Recharging does not change the existing immutable rejected billing event.
    await expect(generateNarration(account, input, config, send)).rejects.toMatchObject({ code: "NARRATION_SETTLEMENT_REJECTED" });
    expect(send).toHaveBeenCalledTimes(1); expect(mocks.usage).toHaveBeenCalledTimes(1);
    const directory = path.join(config.storageDir, createHash("sha256").update(account.id).digest("hex"));
    expect((await readFile(path.join(directory, `${input.requestId}.wav`))).length).toBe(wav().length);
    expect(JSON.parse(await readFile(path.join(directory, `${input.requestId}.json`), "utf8"))).toMatchObject({ status: "generated", code: "NARRATION_SETTLEMENT_REJECTED" });
  });
  it("shares a durable exclusive request claim across concurrent executions", async () => {
    let finish!: (response: Response) => void; const send = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = generateNarration(account, input, config, send); await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await expect(generateNarration(account, input, config, send)).rejects.toMatchObject({ code: "NARRATION_UNKNOWN" }); finish(new Response(wav(), { headers: { "content-type": "audio/wav" } })); await first;
    expect(send).toHaveBeenCalledTimes(1); expect(mocks.usage).toHaveBeenCalledTimes(1);
  });
  it("never resubmits an unknown request or accepts its key for different text", async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error("timeout after acceptance"));
    await expect(generateNarration(account, input, config, send)).rejects.toMatchObject({ code: "NARRATION_UNKNOWN", stateUncertain: true });
    await expect(generateNarration(account, input, config, send)).rejects.toMatchObject({ code: "NARRATION_UNKNOWN" });
    await expect(generateNarration(account, { ...input, text: "另一条脚本" }, config, send)).rejects.toMatchObject({ code: "NARRATION_REQUEST_CONFLICT" }); expect(send).toHaveBeenCalledTimes(1); expect(mocks.usage).not.toHaveBeenCalled();
  });
  it.each([408, 409, 500, 503])("holds HTTP %s in uncertain state and never resubmits it", async status => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: "upstream_uncertain", message: "check receipt" } }, { status }));
    await expect(generateNarration(account, input, config, send)).rejects.toMatchObject({ code: "NARRATION_UNKNOWN", stateUncertain: true });
    await expect(generateNarration(account, input, config, send)).rejects.toMatchObject({ code: "NARRATION_UNKNOWN" }); expect(send).toHaveBeenCalledTimes(1);
  });
  it("keeps definitive HTTP rejection; the original key never generates again", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":"private provider detail"}', { status: 400 }));
    await expect(generateNarration(account, input, config, send)).rejects.toMatchObject({ code: "NARRATION_PROVIDER_REJECTED", stateUncertain: false });
    await expect(generateNarration(account, input, config, send)).rejects.toMatchObject({ code: "NARRATION_PROVIDER_REJECTED" }); expect(send).toHaveBeenCalledTimes(1);
  });
  it("retains useful provider code/message/param/request ID while redacting configured credentials", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: "voice_invalid", message: `Unsupported voice; Bearer ${config.apiKey}`, param: "voice" } }, { status: 400, headers: { "x-request-id": "req-diagnostic" } }));
    await expect(generateNarration(account, input, config, send)).rejects.toMatchObject({ details: { code: "voice_invalid", param: "voice", requestId: "req-diagnostic" } });
    await expect(readNarration(account, input.requestId, config)).rejects.toMatchObject({ details: { message: "Unsupported voice; Bearer [redacted]" } });
    try { await readNarration(account, input.requestId, config); } catch (error) { expect(JSON.stringify(error)).not.toContain(config.apiKey); }
  });
  it("never persists or returns signed media URLs, data audio, quoted credentials or cookies from provider diagnostics", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: "voice_invalid", message: 'Invalid voice https://cdn.example/audio.wav?signature=signed-secret data:audio/wav;base64,audio-secret "apiKey":"other-secret" Cookie: sid=cookie-secret; session=x', param: "voice" } }, { status: 400 }));
    let received = "";
    try { await generateNarration(account, input, config, send); } catch (error) { received = JSON.stringify(error); }
    const stored = await readFile(path.join(config.storageDir, createHash("sha256").update(account.id).digest("hex"), `${input.requestId}.json`), "utf8");
    for (const secret of ["signed-secret", "audio-secret", "other-secret", "cookie-secret", "https://", "data:audio"]) { expect(received).not.toContain(secret); expect(stored).not.toContain(secret); }
    expect(received).toContain("voice_invalid"); expect(stored).toContain('"param":"voice"');
  });
  it("does not deliver a charged clip that overruns its shot, including after a settlement retry", async () => {
    const send = transport(6); mocks.usage.mockRejectedValueOnce(new Error("settlement offline"));
    await expect(generateNarration(account, input, config, send)).rejects.toThrow("settlement offline");
    await expect(generateNarration(account, input, config, send)).rejects.toMatchObject({ code: "NARRATION_TOO_LONG" });
    await expect(readNarration(account, input.requestId, config)).rejects.toMatchObject({ code: "NARRATION_TOO_LONG" }); expect(send).toHaveBeenCalledTimes(1);
  });
  it("isolates account receipts, blocks reference-audio bodies, private DNS and insufficient balance", async () => {
    expect(() => parseNarrationInput({ ...input, audio: "original.wav" })).toThrow();
    const send = transport(); await expect(generateNarration({ ...account, id: "other" }, input, config, send)).rejects.toMatchObject({ code: "NARRATION_ACCOUNT_CHANGED" });
    mocks.lookup.mockResolvedValueOnce([{ address: "127.0.0.1" }]); await expect(generateNarration(account, input, config, send)).rejects.toMatchObject({ code: "NARRATION_ENDPOINT_INVALID" });
    mocks.balance.mockResolvedValueOnce(false); await expect(generateNarration(account, input, config, send)).rejects.toMatchObject({ code: "NARRATION_INSUFFICIENT_BALANCE" });
    expect(send).not.toHaveBeenCalled(); await expect(readNarration({ ...account, id: "other" }, input.requestId, config)).rejects.toMatchObject({ code: "NARRATION_NOT_FOUND" });
  });
  it("does not accept empty, truncated, or non-WAV supplier output", () => {
    expect(narrationWavDuration(wav())).toBe(2); expect(() => narrationWavDuration(new Uint8Array(44))).toThrow(); expect(() => narrationWavDuration(wav().slice(0, 100))).toThrow();
  });
});

describe("Fish Audio narration uses the existing durable and accounted workflow", () => {
  it("exposes safe Fish configuration and precise UTF-8 pricing units even when not enabled", () => {
    const view = narrationCapabilities(narrationConfig({ NARRATION_SPEECH_PROVIDER: "fish", NARRATION_SPEECH_MODEL: "s2.1-pro-free", NARRATION_SPEECH_REFERENCE_ID: "confirmed_voice_id", NARRATION_SPEECH_CENTS_PER_MILLION_UTF8_BYTES: "0" }));
    expect(view).toMatchObject({ available: false, provider: "fish", providerLabel: "Fish Audio", model: "s2.1-pro-free", referenceId: "confirmed_voice_id", centsPerMillionUtf8Bytes: 0, currency: "CNY", billingUnit: "million_utf8_bytes", rate: { unit: "utf8_bytes", perUnits: 1_000_000, centsPerUnit: 0 } });
    expect(view.missing).toEqual(["enabled", "apiKey", "storageDir"]); expect(JSON.stringify(view)).not.toContain("synthetic-fish-key");
  });
  it("generates native Fish WAV from exact confirmed text and bills Chinese and emoji as UTF-8 bytes", async () => {
    const fish = fishConfig(), send = transport(), result = await generateNarration(account, { ...input, text: "中文🙂A" }, fish, send);
    expect(send.mock.calls[0][0]).toBe("https://api.fish.audio/v1/tts");
    expect(send.mock.calls[0][1]!.headers).toMatchObject({ model: "s2.1-pro", Authorization: `Bearer ${fish.apiKey}` });
    expect(JSON.parse(String(send.mock.calls[0][1]!.body))).toEqual({ text: "中文🙂A", format: "wav", reference_id: "confirmed_voice_id" });
    expect(result.receipt).toMatchObject({ status: "succeeded", provider: "fish", referenceId: "confirmed_voice_id", voice: "", characters: 4, utf8Bytes: 11, billingUnits: 11, billingUnit: "utf8_bytes", ratePerUnits: 1_000_000, baseCostCents: 11, chargedCostCents: 14 });
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({ provider: "fish", endpoint: "audio.speech", model: "s2.1-pro", baseCostCents: 11, costCents: 14, metadata: expect.objectContaining({ billing: "utf8_bytes:11;cents_per_1000000:1000000" }) }));
  });
  it("keeps an explicitly selected free model truly zero-cost while recording the stable accounting event", async () => {
    const fish = fishConfig({ model: "s2.1-pro-free", centsPerMillionUtf8Bytes: 0 }), send = transport();
    expect(narrationPrice("中文🙂A", fish)).toMatchObject({ billingUnits: 11, baseCostCents: 0, rateCents: 0 });
    const result = await generateNarration(account, input, fish, send);
    expect(result.receipt).toMatchObject({ baseCostCents: 0, chargedCostCents: 0, model: "s2.1-pro-free" });
    expect(mocks.balance).toHaveBeenCalledWith(account.id, 0); expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({ baseCostCents: 0, costCents: 0, status: "ok" }));
    await generateNarration(account, input, fish, send); expect(send).toHaveBeenCalledTimes(1); expect(mocks.usage).toHaveBeenCalledTimes(1);
  });
  it.each([null, undefined])("does not replace a missing explicit byte rate %s with the legacy character price", async rate => {
    const fish = fishConfig({ centsPerMillionUtf8Bytes: rate }), send = transport();
    expect(narrationCapabilities(fish)).toMatchObject({ available: false, code: "NARRATION_BILLING_NOT_CONFIGURED" });
    await expect(generateNarration(account, input, fish, send)).rejects.toMatchObject({ code: "NARRATION_BILLING_NOT_CONFIGURED", providerSubmitted: false }); expect(send).not.toHaveBeenCalled();
  });
  it("does not treat an unpriced free model or a zero-priced paid model as configured", () => {
    expect(narrationCapabilities(fishConfig({ model: "s2.1-pro-free", centsPerMillionUtf8Bytes: null }))).toMatchObject({ available: false, code: "NARRATION_BILLING_NOT_CONFIGURED" });
    expect(narrationCapabilities(fishConfig({ model: "s2.1-pro", centsPerMillionUtf8Bytes: 0 }))).toMatchObject({ available: false, code: "NARRATION_BILLING_NOT_CONFIGURED" });
    expect(() => narrationPrice("中文", fishConfig({ model: "s2.1-pro", centsPerMillionUtf8Bytes: 0 }))).toThrow();
  });
  it.each(["", "s2.1-pro-fre", "latest"])("blocks model %j locally instead of letting Fish silently select a paid model", async model => {
    const send = transport(); await expect(generateNarration(account, input, fishConfig({ model }), send)).rejects.toMatchObject({ providerSubmitted: false }); expect(send).not.toHaveBeenCalled(); expect(mocks.usage).not.toHaveBeenCalled();
  });
  it("requires its own reference ID and pinned Fish endpoint; the old OpenAI voice is never repurposed", async () => {
    const send = transport(); await expect(generateNarration(account, input, fishConfig({ referenceId: "", voice: "alloy" }), send)).rejects.toMatchObject({ code: "NARRATION_NOT_CONFIGURED" });
    await expect(generateNarration(account, input, fishConfig({ endpoint: "https://api.fish.audio.evil.test/v1/tts" }), send)).rejects.toMatchObject({ code: "NARRATION_ENDPOINT_INVALID" }); expect(send).not.toHaveBeenCalled();
  });
  it("retains Fish's top-level message and reason safely under the original failed receipt", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: 402, message: `Insufficient Fish balance; Bearer ${config.apiKey}`, reason: "insufficient_balance" }, { status: 402, headers: { "x-request-id": "fish-request-receipt" } }));
    await expect(generateNarration(account, input, fishConfig(), send)).rejects.toMatchObject({ details: { message: "Insufficient Fish balance; Bearer [redacted]", reason: "insufficient_balance", requestId: "fish-request-receipt" } });
    await expect(readNarration(account, input.requestId, fishConfig())).rejects.toMatchObject({ details: { reason: "insufficient_balance" } }); expect(send).toHaveBeenCalledTimes(1); expect(mocks.usage).not.toHaveBeenCalled();
  });
  it("keeps a saved Fish 503 diagnostic visible during read-only reconciliation, without retrying generation", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: 503, message: "Fish inference overloaded", reason: "capacity_unavailable" }, { status: 503, headers: { "x-request-id": "fish-overload-receipt" } }));
    await expect(generateNarration(account, input, fishConfig(), send)).rejects.toMatchObject({ code: "NARRATION_UNKNOWN", stateUncertain: true });
    await expect(readNarration(account, input.requestId, fishConfig())).rejects.toMatchObject({ message: expect.stringContaining("Fish inference overloaded"), details: { reason: "capacity_unavailable", requestId: "fish-overload-receipt" }, stateUncertain: true });
    expect(send).toHaveBeenCalledTimes(1); expect(mocks.usage).not.toHaveBeenCalled();
  });
  it("keeps Fish network ambiguity under its original receipt, without a second generation", async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error("timeout after Fish accepted request"));
    await expect(generateNarration(account, input, fishConfig(), send)).rejects.toMatchObject({ code: "NARRATION_UNKNOWN", stateUncertain: true });
    await expect(generateNarration(account, input, fishConfig(), send)).rejects.toMatchObject({ code: "NARRATION_UNKNOWN" }); expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not replace historical OpenAI results or reprice their receipt when Fish is selected later", async () => {
    const send = transport(), original = await generateNarration(account, input, config, send);
    const replay = await generateNarration(account, input, fishConfig({ model: "s2.1-pro-free", centsPerMillionUtf8Bytes: 0 }), send);
    expect(replay.receipt).toEqual(original.receipt); expect(replay.bytes).toEqual(original.bytes); expect(send).toHaveBeenCalledTimes(1); expect(mocks.usage).toHaveBeenCalledTimes(1);
  });
});
