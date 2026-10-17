import "server-only";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { assertResolvedAddresses, evaluateCreativeProxy } from "@/lib/creative-proxy";
import { getGatewayBillingSnapshot } from "@/lib/model-gateway/billing";
import { applyGatewayBillingCost, GatewayBillingError, type GatewayBillingSnapshot } from "@/lib/model-gateway/billing-contract";
import { assertGatewayBalance, recordGatewayUsage } from "@/lib/model-gateway/store";
import { FISH_SPEECH_ENDPOINT, fishSpeechConfigurationIssue, fishSpeechRequest } from "@/lib/fish-speech";

const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
export class NarrationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly providerSubmitted = false, readonly stateUncertain = false, readonly details?: Record<string, string>) { super(message); }
}
export type NarrationInput = { requestId: string; shotId: string; text: string; durationSeconds: number; expectedAccountKey: string };
export type NarrationConfig = { enabled: boolean; apiKey: string; endpoint: string; model: string; voice: string; centsPer1KChar: number | null; storageDir: string;
  provider?: string; referenceId?: string; centsPerMillionUtf8Bytes?: number | null };
export type NarrationReceipt = {
  version: 1; requestId: string; shotId: string; fingerprint: string; status: "submitting" | "generated" | "succeeded" | "failed" | "unknown";
  providerSubmitted: boolean; model: string; voice: string; provider: string; createdAt: string; durationSeconds?: number;
  contentHash?: string; upstreamRequestId?: string; code?: string; error?: string; upstreamStatus?: number; maxDurationSeconds: number; providerError?: Record<string, string>;
  billingEventId: string; billingSnapshot: GatewayBillingSnapshot; baseCostCents: number; chargedCostCents: number; characters: number;
  referenceId?: string; utf8Bytes?: number; billingUnits?: number; billingUnit?: "utf8_bytes" | "characters"; ratePerUnits?: number; rateCents?: number;
};
type NarrationAccount = { id: string; username: string };
export function narrationConfig(env: Record<string, string | undefined> = process.env): NarrationConfig {
  const rate = env.NARRATION_SPEECH_CENTS_PER_1K_CHAR?.trim() || "";
  const byteRate = env.NARRATION_SPEECH_CENTS_PER_MILLION_UTF8_BYTES?.trim() || "", provider = env.NARRATION_SPEECH_PROVIDER?.trim() || "openai";
  return { provider, enabled: env.NARRATION_SPEECH_ENABLED === "true", apiKey: env.NARRATION_SPEECH_API_KEY?.trim() || "",
    endpoint: provider === "fish" ? FISH_SPEECH_ENDPOINT : `${(env.NARRATION_SPEECH_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "")}/audio/speech`,
    model: env.NARRATION_SPEECH_MODEL?.trim() || "", voice: env.NARRATION_SPEECH_VOICE?.trim() || "",
    centsPer1KChar: /^\d+(?:\.\d{1,6})?$/.test(rate) && Number(rate) > 0 && Number(rate) <= 1_000_000 ? Number(rate) : null,
    referenceId: env.NARRATION_SPEECH_REFERENCE_ID?.trim() || "",
    centsPerMillionUtf8Bytes: /^\d+(?:\.\d{1,6})?$/.test(byteRate) && Number(byteRate) >= 0 && Number(byteRate) <= 1_000_000 ? Number(byteRate) : null,
    storageDir: env.NARRATION_SPEECH_STORAGE_DIR?.trim() || "" };
}
function configurationError(config: NarrationConfig): NarrationError | null {
  if (config.provider && !["openai", "fish"].includes(config.provider)) return new NarrationError("NARRATION_PROVIDER_INVALID", "配音服务商配置无效，当前不会提交供应商。", 503);
  const fish = config.provider === "fish";
  if (!config.enabled || !config.apiKey || !config.model || (fish ? !config.referenceId : !config.voice)) return new NarrationError("NARRATION_NOT_CONFIGURED", fish ? "Fish Audio 配音未就绪，请配置 API Key、明确的基座模型和已确认音色 ID；上传原音频不会代替配音。" : "脚本配音服务尚未配置；不会使用上传原音频代替配音。", 503);
  const byteRate = config.centsPerMillionUtf8Bytes;
  if (fish ? byteRate == null || !Number.isFinite(byteRate) || byteRate < 0 || byteRate > 1_000_000 || (byteRate === 0 && config.model !== "s2.1-pro-free") : config.centsPer1KChar === null) return new NarrationError("NARRATION_BILLING_NOT_CONFIGURED", fish ? "Fish Audio 计费需明确配置人民币分/百万 UTF-8 字节费率；只有明确选择免费模型才能使用显式零费率。" : "脚本配音计费尚未配置，当前不会提交供应商。", 503);
  if (!config.storageDir || !path.isAbsolute(config.storageDir)) return new NarrationError("NARRATION_STORAGE_NOT_CONFIGURED", "配音持久化目录尚未配置为固定共享绝对路径，当前不会提交供应商。", 503);
  if (fish) {
    const issue = fishSpeechConfigurationIssue({ endpoint: config.endpoint, model: config.model, referenceId: config.referenceId || "" });
    if (issue) return new NarrationError(issue === "model" ? "NARRATION_MODEL_INVALID" : issue === "referenceId" ? "NARRATION_REFERENCE_INVALID" : "NARRATION_ENDPOINT_INVALID", issue === "model" ? "Fish Audio 模型未在已核对名单内，已阻止上游回退到付费默认模型。" : issue === "referenceId" ? "Fish Audio 音色 ID 格式无效，请填写已确认的单人声音色模型 ID。" : "Fish Audio 必须使用已核对的官方端点。", 503);
    return null;
  }
  let url: URL;
  try { url = new URL(config.endpoint); } catch { return new NarrationError("NARRATION_ENDPOINT_INVALID", "配音服务地址配置无效。", 503); }
  const decision = evaluateCreativeProxy(config.endpoint, "POST");
  if (!decision.ok || url.search || url.hash || url.hostname === "sub.shaozhuangai.com" || !/\/audio\/speech$/.test(url.pathname) ||
    !/^[A-Za-z0-9._:-]{1,200}$/.test(config.model) || !/^[A-Za-z0-9._:-]{1,100}$/.test(config.voice)) return new NarrationError("NARRATION_ENDPOINT_INVALID", "配音服务地址、模型或音色配置无效。", 503);
  return null;
}
export function narrationCapabilities(config = narrationConfig()) {
  const unavailable = configurationError(config);
  const fish = config.provider === "fish", rate = fish ? config.centsPerMillionUtf8Bytes ?? null : config.centsPer1KChar;
  const missing = [!config.enabled ? "enabled" : "", !config.apiKey ? "apiKey" : "", !config.model ? "model" : "", fish ? !config.referenceId ? "referenceId" : "" : !config.voice ? "voice" : "", rate == null ? "billingRate" : "", !config.storageDir || !path.isAbsolute(config.storageDir) ? "storageDir" : ""].filter(Boolean);
  const publicId = (value: string | undefined) => value && /^[A-Za-z0-9._:-]{1,200}$/.test(value) && !/sk-|bearer/i.test(value) && (!config.apiKey || !value.includes(config.apiKey)) ? value : "";
  return { available: !unavailable, code: unavailable?.code || "NARRATION_READY", message: unavailable?.message || "按已确认脚本逐镜生成 AI 配音；上传音频仅为参考，不会混入成片。",
    provider: fish ? "fish" : "openai", providerLabel: fish ? "Fish Audio" : "OpenAI 兼容配音", model: publicId(config.model), ...(fish ? { referenceId: publicId(config.referenceId), centsPerMillionUtf8Bytes: rate } : { voice: publicId(config.voice), centsPer1KChar: rate }),
    currency: "CNY", billingUnit: fish ? "million_utf8_bytes" : "thousand_characters", pricingUnit: fish ? "million_utf8_bytes" : "thousand_characters",
    rate: { currency: "CNY", unit: fish ? "utf8_bytes" : "characters", perUnits: fish ? 1_000_000 : 1000, centsPerUnit: rate }, missing, disclosure: "AI 生成配音" };
}
export function narrationPrice(text: string, config: NarrationConfig) {
  const characters = [...text].length, utf8Bytes = Buffer.byteLength(text, "utf8"), fish = config.provider === "fish";
  const billingUnits = fish ? utf8Bytes : characters, ratePerUnits = fish ? 1_000_000 : 1000, rateCents = fish ? config.centsPerMillionUtf8Bytes : config.centsPer1KChar;
  if (rateCents == null || !Number.isFinite(rateCents) || rateCents < 0 || rateCents > 1_000_000 || rateCents === 0 && (!fish || config.model !== "s2.1-pro-free")) throw new NarrationError("NARRATION_BILLING_NOT_CONFIGURED", "配音费率尚未明确配置。", 503);
  // Preserve a truly free model's explicit zero rate. Paid calls retain upward cent rounding.
  const baseCostCents = rateCents === 0 ? 0 : Math.max(1, Math.ceil(billingUnits * rateCents / ratePerUnits));
  return { characters, utf8Bytes, billingUnits, billingUnit: fish ? "utf8_bytes" as const : "characters" as const, ratePerUnits, rateCents, baseCostCents };
}
export function parseNarrationInput(raw: unknown): NarrationInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new NarrationError("NARRATION_INPUT_INVALID", "配音请求格式无效。");
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(key => !["requestId", "shotId", "text", "durationSeconds", "expectedAccountKey"].includes(key)) ||
    typeof input.requestId !== "string" || !SAFE_ID.test(input.requestId) || typeof input.shotId !== "string" || !SAFE_ID.test(input.shotId) ||
    typeof input.text !== "string" || !input.text.trim() || [...input.text].length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(input.text) ||
    typeof input.durationSeconds !== "number" || !Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0 || input.durationSeconds > 60 ||
    typeof input.expectedAccountKey !== "string" || !input.expectedAccountKey || input.expectedAccountKey.length > 200) throw new NarrationError("NARRATION_INPUT_INVALID", "配音需要有效镜头、1–1000 字口播、时长和当前账号。");
  return { requestId: input.requestId, shotId: input.shotId, text: input.text.trim(), durationSeconds: input.durationSeconds, expectedAccountKey: input.expectedAccountKey };
}
function hash(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
function location(account: NarrationAccount, requestId: string, config: NarrationConfig) {
  if (!SAFE_ID.test(requestId)) throw new NarrationError("NARRATION_INPUT_INVALID", "配音回执标识无效。");
  if (!config.storageDir || !path.isAbsolute(config.storageDir)) throw new NarrationError("NARRATION_STORAGE_NOT_CONFIGURED", "配音持久化目录尚未配置，请联系管理员核对原回执位置。", 503);
  const directory = path.join(config.storageDir, hash(account.id));
  return { directory, receiptFile: path.join(directory, `${requestId}.json`), audioFile: path.join(directory, `${requestId}.wav`) };
}
async function atomicWrite(file: string, value: string | Uint8Array) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, value, { mode: 0o600 }); await rename(temp, file);
}
async function readReceipt(file: string): Promise<NarrationReceipt | null> {
  try { return JSON.parse(await readFile(file, "utf8")) as NarrationReceipt; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
/** Derive duration from the new PCM WAV itself; metadata and uploaded reference audio are never used. */
export function narrationWavDuration(bytes: Uint8Array) {
  if (bytes.length < 44 || bytes.length > MAX_AUDIO_BYTES) throw new NarrationError("NARRATION_AUDIO_INVALID", "配音供应商未返回有效 WAV 音频。", 502, true);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new NarrationError("NARRATION_AUDIO_INVALID", "配音供应商未返回有效 WAV 音频。", 502, true);
  let rate = 0, size = 0;
  for (let at = 12; at + 8 <= bytes.length;) {
    const length = view.getUint32(at + 4, true), start = at + 8;
    if (tag(at) === "fmt " && length >= 16 && start + 16 <= bytes.length) {
      const format = view.getUint16(start, true);
      if (![1, 3, 0xfffe].includes(format)) throw new NarrationError("NARRATION_AUDIO_INVALID", "配音需要可解码的 PCM WAV 音频。", 502, true);
      rate = view.getUint32(start + 8, true);
    }
    // Some speech encoders use the streaming RIFF sentinel; actual payload length remains authoritative.
    if (tag(at) === "data") { if (length !== 0xffffffff && start + length > bytes.length) throw new NarrationError("NARRATION_AUDIO_INVALID", "配音音频数据不完整。", 502, true); size = length === 0xffffffff ? bytes.length - start : length; break; }
    if (start + length > bytes.length) break;
    at = start + length + length % 2;
  }
  const duration = size / rate;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 120) throw new NarrationError("NARRATION_AUDIO_INVALID", "配音音频时长无效。", 502, true);
  return duration;
}
async function readBounded(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new NarrationError("NARRATION_AUDIO_INVALID", "配音供应商没有返回音频。", 502, true);
  const chunks: Uint8Array[] = []; let total = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; total += value.length; if (total > MAX_AUDIO_BYTES) { await reader.cancel(); throw new NarrationError("NARRATION_AUDIO_TOO_LARGE", "配音音频超过 16 MiB。", 502, true); } chunks.push(value); }
  const bytes = new Uint8Array(total); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; } return bytes;
}
async function providerError(response: Response, config: NarrationConfig): Promise<Record<string, string>> {
  const scrub = (raw: unknown, max = 400) => {
    if (typeof raw !== "string" && typeof raw !== "number") return "";
    let value = String(raw); if (config.apiKey) value = value.split(config.apiKey).join("[redacted]");
    return value.replace(/data:[^\s,"'<>]+,[^\s"'<>]+/gi, "[redacted-data]")
      .replace(/https?:\/\/[^\s<>"'\uFF09)]+/gi, "[redacted-url]")
      .replace(/\bCookie\s*:[^\r\n]*/gi, "Cookie: [redacted]")
      .replace(/Bearer\s+[^\s,;"']+/gi, "Bearer [redacted]").replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
      .replace(/(["']?(?:api[_-]?key|cookie|token|authorization|secret|password)["']?\s*[=:]\s*["']?)[^\s,;"']+/gi, "$1[redacted]")
      .replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max);
  };
  let body = ""; const reader = response.body?.getReader(); let total = 0;
  if (reader) { const decoder = new TextDecoder(); while (true) { const { value, done } = await reader.read(); if (done) break; total += value.length; body += decoder.decode(value, { stream: true }); if (total > 16 * 1024) { await reader.cancel().catch(() => undefined); break; } } }
  let parsed: unknown; try { parsed = JSON.parse(body); } catch { parsed = null; }
  const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const nested = object.error && typeof object.error === "object" && !Array.isArray(object.error) ? object.error as Record<string, unknown> : object;
  const safe: Record<string, string> = {};
  for (const key of ["code", "message", "param", "type", "reason"]) { const value = scrub(nested[key] ?? (key === "message" && typeof object.error === "string" ? object.error : "")); if (value) safe[key] = value; }
  const requestId = scrub(response.headers.get("x-request-id") || object.request_id || object.requestId, 200); if (requestId) safe.requestId = requestId;
  return safe;
}
async function settle(account: NarrationAccount, receipt: NarrationReceipt, file: string) {
  // The audio and billing snapshot are durable before settling. Replays reuse this exact event and never synthesize again.
  if (receipt.code === "NARRATION_SETTLEMENT_REJECTED") throw new NarrationError(receipt.code, receipt.error || "已生成配音，积分结算被拒绝，需核对原账本；不会重新生成或重复扣款。", 402, true, true);
  try { await recordGatewayUsage({ auth: { userId: account.id, username: account.username, apiKeyId: null, keyPrefix: "web-session" },
    endpoint: "audio.speech", provider: receipt.provider, model: receipt.model, requestId: receipt.requestId,
    costCents: receipt.chargedCostCents, baseCostCents: receipt.baseCostCents, billingSnapshot: receipt.billingSnapshot,
    billingEventId: receipt.billingEventId, status: "ok", audit: { upstreamStatus: receipt.upstreamStatus || 200, outcome: "success" },
    metadata: { source: "video_narration", upstreamModel: receipt.model, responseFormat: "wav", seconds: receipt.durationSeconds || 0, costSource: "catalog",
      ...(receipt.billingUnits == null ? {} : { billing: `${receipt.billingUnit}:${receipt.billingUnits};cents_per_${receipt.ratePerUnits}:${receipt.rateCents}` }) } }); }
  catch (error) {
    if (error instanceof GatewayBillingError && error.code === "INSUFFICIENT_BALANCE") {
      receipt.code = "NARRATION_SETTLEMENT_REJECTED"; receipt.error = "已生成配音，积分结算被拒绝，需核对原账本；不会重新生成或重复扣款。";
      await atomicWrite(file, JSON.stringify(receipt)); throw new NarrationError(receipt.code, receipt.error, 402, true, true);
    }
    throw error;
  }
  receipt.status = "succeeded"; receipt.code = undefined; receipt.error = undefined; await atomicWrite(file, JSON.stringify(receipt));
}
export async function readNarration(account: NarrationAccount, requestId: string, config = narrationConfig(), settleGenerated = false) {
  const files = location(account, requestId, config), receipt = await readReceipt(files.receiptFile);
  if (!receipt) throw new NarrationError("NARRATION_NOT_FOUND", "配音回执尚不存在。", 404);
  if (receipt.status === "succeeded" || receipt.status === "generated") {
    const bytes = new Uint8Array(await readFile(files.audioFile));
    if (hash(bytes) !== receipt.contentHash) throw new NarrationError("NARRATION_AUDIO_LOST", "已生成配音校验失败，保留回执，请核对后恢复原音轨。", 409, true, true);
    if (receipt.status === "generated") {
      if (receipt.code === "NARRATION_SETTLEMENT_REJECTED") throw new NarrationError(receipt.code, receipt.error || "已生成配音，积分结算被拒绝，需核对原账本；不会重新生成或重复扣款。", 402, true, true);
      if (!settleGenerated) throw new NarrationError("NARRATION_SETTLEMENT_PENDING", "新配音已保存，等待原回执结算；不会重新调用供应商。", 409, true, true);
      await settle(account, receipt, files.receiptFile);
    }
    if (receipt.durationSeconds! > receipt.maxDurationSeconds + 0.01) throw new NarrationError("NARRATION_TOO_LONG", "生成口播长于镜头，请缩短本镜口播后重新确认；原配音和计费回执保留。", 422, true);
    return { receipt, bytes };
  }
  if (receipt.status === "failed") throw new NarrationError(receipt.code || "NARRATION_FAILED", receipt.error || "配音失败，可单独重试这条音轨。", receipt.upstreamStatus === 429 ? 429 : 422, receipt.providerSubmitted, false, receipt.providerError);
  throw new NarrationError(receipt.code || "NARRATION_UNKNOWN", receipt.error || "配音接收状态尚未确认，已保留原回执；请核对，禁止重复提交。", 409, true, true, receipt.providerError);
}
export async function generateNarration(account: NarrationAccount, input: NarrationInput, config = narrationConfig(), transport: typeof fetch = fetch) {
  if (input.expectedAccountKey !== account.id) throw new NarrationError("NARRATION_ACCOUNT_CHANGED", "登录账号已变化，原配音任务保留在原账号。", 409);
  const files = location(account, input.requestId, config);
  // Binding excludes current config so the original receipt remains recoverable after configuration changes.
  const fingerprint = hash(JSON.stringify([account.id, input.shotId, input.text, input.durationSeconds]));
  const existing = await readReceipt(files.receiptFile);
  if (existing) { if (existing.fingerprint !== fingerprint) throw new NarrationError("NARRATION_REQUEST_CONFLICT", "同一配音回执不能用于不同脚本或镜头。", 409); return readNarration(account, input.requestId, config, true); }
  const unavailable = configurationError(config); if (unavailable) throw unavailable;
  let addresses: string[];
  try { addresses = (await lookup(new URL(config.endpoint).hostname, { all: true, verbatim: true })).map(item => item.address); }
  catch { throw new NarrationError("NARRATION_ENDPOINT_UNAVAILABLE", "配音供应商地址暂时无法解析，当前未提交。", 503); }
  const resolved = assertResolvedAddresses(addresses);
  if (!resolved.ok) throw new NarrationError("NARRATION_ENDPOINT_INVALID", "配音供应商解析地址无效。", 503);
  const pricing = narrationPrice(input.text, config), { baseCostCents } = pricing;
  let billingSnapshot: GatewayBillingSnapshot, chargedCostCents: number;
  try { billingSnapshot = await getGatewayBillingSnapshot(account.id); chargedCostCents = applyGatewayBillingCost(baseCostCents, billingSnapshot);
    if (!await assertGatewayBalance(account.id, chargedCostCents)) throw new NarrationError("NARRATION_INSUFFICIENT_BALANCE", "配音积分不足，请充值后单独重试音轨。", 402);
  } catch (error) { if (error instanceof NarrationError) throw error; throw new NarrationError("NARRATION_PREFLIGHT_UNAVAILABLE", "配音积分预检暂不可用，当前未提交供应商。", 503); }
  await mkdir(files.directory, { recursive: true, mode: 0o700 });
  const receipt: NarrationReceipt = { version: 1, requestId: input.requestId, shotId: input.shotId, fingerprint, status: "submitting", providerSubmitted: false,
    model: config.model, voice: config.provider === "fish" ? "" : config.voice, ...(config.provider === "fish" ? { referenceId: config.referenceId } : {}), provider: config.provider === "fish" ? "fish" : `speech:${new URL(config.endpoint).hostname}`, createdAt: new Date().toISOString(),
    billingEventId: `narration:${hash(`${account.id}\0${input.requestId}`)}`, billingSnapshot, ...pricing, chargedCostCents, maxDurationSeconds: input.durationSeconds };
  try { await writeFile(files.receiptFile, JSON.stringify(receipt), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") { const raced = await readReceipt(files.receiptFile); if (raced?.fingerprint !== fingerprint) throw new NarrationError("NARRATION_REQUEST_CONFLICT", "配音回执与脚本不一致。", 409); return readNarration(account, input.requestId, config, true); } throw error; }
  let response: Response;
  try {
    receipt.providerSubmitted = true; await atomicWrite(files.receiptFile, JSON.stringify(receipt));
    const speech = config.provider === "fish" ? fishSpeechRequest({ endpoint: config.endpoint, apiKey: config.apiKey, model: config.model, referenceId: config.referenceId || "" }, input.text) : {
      endpoint: config.endpoint, init: { method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": receipt.requestId }, body: JSON.stringify({ model: config.model, voice: config.voice, input: input.text, response_format: "wav" }) }
    };
    response = await transport(speech.endpoint, { ...speech.init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(90_000) });
  } catch { receipt.status = "unknown"; await atomicWrite(files.receiptFile, JSON.stringify(receipt)); throw new NarrationError("NARRATION_UNKNOWN", "配音供应商回执未知，已保留标识；请核对后继续，不能重新提交。", 409, true, true); }
  receipt.upstreamStatus = response.status;
  const upstreamId = response.headers.get("x-request-id") || "";
  receipt.upstreamRequestId = /^[A-Za-z0-9_.:-]{1,200}$/.test(upstreamId) && !/sk-|bearer/i.test(upstreamId) && !upstreamId.includes(config.apiKey) ? upstreamId : "";
  if (!response.ok) {
    receipt.providerError = await providerError(response, config).catch(() => ({}));
    receipt.status = response.status >= 500 || [408, 409].includes(response.status) ? "unknown" : "failed"; receipt.code = receipt.status === "unknown" ? "NARRATION_UNKNOWN" : "NARRATION_PROVIDER_REJECTED";
    const detail = [receipt.providerError.message, receipt.providerError.code ? `code=${receipt.providerError.code}` : "", receipt.providerError.reason ? `reason=${receipt.providerError.reason}` : "", receipt.providerError.param ? `param=${receipt.providerError.param}` : ""].filter(Boolean).join("；");
    receipt.error = (receipt.status === "unknown" ? `配音供应商异常（HTTP ${response.status}），接收状态待核对，禁止重复提交。` : `配音供应商拒绝请求（HTTP ${response.status}），可只重试失败音轨。`) + (detail ? ` ${detail}` : "");
    await atomicWrite(files.receiptFile, JSON.stringify(receipt)); throw new NarrationError(receipt.code, receipt.error, receipt.status === "unknown" ? 409 : 422, true, receipt.status === "unknown", receipt.providerError);
  }
  let bytes: Uint8Array;
  try { bytes = await readBounded(response); receipt.durationSeconds = narrationWavDuration(bytes); }
  catch (error) { receipt.status = "unknown"; receipt.code = "NARRATION_RESULT_UNCONFIRMED"; receipt.error = "配音供应商返回结果无法确认，保留回执；请核对原结果，禁止自动重生。"; await atomicWrite(files.receiptFile, JSON.stringify(receipt)); throw new NarrationError(receipt.code, receipt.error, 409, true, true); }
  receipt.contentHash = hash(bytes); await atomicWrite(files.audioFile, bytes); receipt.status = "generated"; await atomicWrite(files.receiptFile, JSON.stringify(receipt));
  await settle(account, receipt, files.receiptFile);
  // Bill a successfully generated clip even when it does not fit; retain its original file, never truncate or accelerate it.
  if (receipt.durationSeconds > input.durationSeconds + 0.01) { receipt.status = "failed"; receipt.code = "NARRATION_TOO_LONG"; receipt.error = `生成口播长于镜头（${receipt.durationSeconds.toFixed(2)} 秒），请缩短本镜口播后重新确认；原配音和计费回执保留。`; await atomicWrite(files.receiptFile, JSON.stringify(receipt)); throw new NarrationError(receipt.code, receipt.error, 422, true); }
  return { receipt, bytes };
}

export function narrationErrorView(error: unknown) {
  if (error instanceof NarrationError) return { status: error.status, body: { code: error.code, error: error.message, providerSubmitted: error.providerSubmitted, definitiveFailure: !error.stateUncertain, stateUncertain: error.stateUncertain, ...(error.details ? { details: error.details } : {}) } };
  if (error instanceof GatewayBillingError) return { status: error.status, body: { code: error.code, error: error.message, providerSubmitted: true, definitiveFailure: false, stateUncertain: true } };
  return { status: 503, body: { code: "NARRATION_UNAVAILABLE", error: "配音服务或结算暂不可用，保留回执后核对，不会自动重生。", providerSubmitted: true, definitiveFailure: false, stateUncertain: true } };
}
