import "server-only";
import { open } from "node:fs/promises";
import { GatewayBillingError, sanitizeGatewayFxSnapshot, type GatewayFxSnapshot } from "./billing-contract";
import { validateFxCache, type FxCache } from "./exchange-rate-core.mjs";

export type ExchangeRateView = {
  mode: "automatic" | "manual";
  status: "ready" | "stale" | "unavailable";
  source: "ecb" | "manual" | null;
  referenceDate: string | null;
  fetchedAt: string | null;
  id: string | null;
  errorCode?: "FX_CACHE_NOT_CONFIGURED" | "FX_CACHE_UNAVAILABLE" | "FX_CACHE_INVALID" | "FX_CACHE_STALE" | "FX_FETCH_FAILED" | "FX_REFERENCE_DATE_ROLLBACK" | "FX_FETCHED_AT_ROLLBACK" | "FX_PERSIST_FAILED" | "FX_STATUS_WRITE_FAILED_AFTER_CACHE_COMMIT";
};

export function automaticExchangeRateEnabled() { return process.env.MODEL_GATEWAY_FX_AUTOMATIC === "1"; }

async function boundedJson(file: string, maxBytes: number): Promise<unknown> {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("FX_FILE_SIZE");
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > maxBytes) throw new Error("FX_FILE_SIZE");
    return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally { await handle.close(); }
}

const STATUS_ERRORS = new Set(["FX_FETCH_FAILED", "FX_CACHE_INVALID", "FX_REFERENCE_DATE_ROLLBACK", "FX_FETCHED_AT_ROLLBACK", "FX_PERSIST_FAILED", "FX_STATUS_WRITE_FAILED_AFTER_CACHE_COMMIT"]);
async function latestFailure(file: string, cache: FxCache, now: Date): Promise<ExchangeRateView["errorCode"] | undefined> {
  try {
    const raw = await boundedJson(file + ".status.json", 4_096);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const row = raw as Record<string, unknown>;
    const keys = Object.keys(row);
    if (keys.length !== 6 || !keys.every(key => ["version", "cacheId", "fetchedAt", "attemptedAt", "success", "errorCode"].includes(key))) return;
    if (row.version !== 1 || row.success !== false || row.cacheId !== cache.id || row.fetchedAt !== cache.fetchedAt ||
        typeof row.errorCode !== "string" || !STATUS_ERRORS.has(row.errorCode) || typeof row.attemptedAt !== "string") return;
    const time = Date.parse(row.attemptedAt);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== row.attemptedAt || time < Date.parse(cache.fetchedAt) || time > now.getTime() + 300_000) return;
    return row.errorCode as ExchangeRateView["errorCode"];
  } catch { /* A missing or invalid status cannot poison a verified quote cache. */ }
}

/** Public FX data only. Every quote reads bounded fresh files; no network or memo. */
export async function readEffectiveExchangeRate(manualRate: number | null, now = new Date()): Promise<{ rate: number | null; view: ExchangeRateView }> {
  if (!automaticExchangeRateEnabled()) return { rate: manualRate, view: {
    mode: "manual", status: manualRate == null ? "unavailable" : "ready", source: manualRate == null ? null : "manual",
    referenceDate: null, fetchedAt: null, id: null
  } };
  const empty: ExchangeRateView = { mode: "automatic", status: "unavailable", source: null, referenceDate: null, fetchedAt: null, id: null };
  const file = process.env.MODEL_GATEWAY_FX_CACHE_FILE;
  if (!file) return { rate: null, view: { ...empty, errorCode: "FX_CACHE_NOT_CONFIGURED" } };
  let raw: unknown;
  try { raw = await boundedJson(file, 16_384); }
  catch { return { rate: null, view: { ...empty, errorCode: "FX_CACHE_UNAVAILABLE" } }; }
  try {
    const cache = validateFxCache(raw, now);
    const errorCode = await latestFailure(file, cache, now);
    return { rate: cache.rate, view: { mode: "automatic", status: errorCode || now.getTime() - Date.parse(cache.fetchedAt) > 36 * 60 * 60 * 1000 ? "stale" : "ready", source: "ecb",
      referenceDate: cache.referenceDate, fetchedAt: new Date(cache.fetchedAt).toISOString(), id: cache.id, ...(errorCode ? { errorCode } : {}) } };
  } catch {
    try {
      const cache = validateFxCache(raw, now, { allowExpired: true });
      return { rate: null, view: { mode: "automatic", status: "unavailable", source: "ecb",
        referenceDate: cache.referenceDate, fetchedAt: new Date(cache.fetchedAt).toISOString(), id: cache.id, errorCode: "FX_CACHE_STALE" } };
    } catch { return { rate: null, view: { ...empty, errorCode: "FX_CACHE_INVALID" } }; }
  }
}

/** Called only for a new platform quote, never for BYOK or historical settlement. */
export function requireGatewayFxSnapshot(runtime: { usdCnyRate?: number | null; exchangeRate?: ExchangeRateView }): GatewayFxSnapshot | undefined {
  const view = runtime.exchangeRate;
  if (view?.mode === "automatic" || automaticExchangeRateEnabled()) {
    if (!view || view.mode !== "automatic" || !(["ready", "stale"] as string[]).includes(view.status) || view.source !== "ecb" || runtime.usdCnyRate == null) {
      throw new GatewayBillingError(view?.status === "stale" ? "FX_RATE_STALE" : "FX_RATE_UNAVAILABLE", "自动结算汇率暂不可用，请管理员更新后重试", 503);
    }
    try { return sanitizeGatewayFxSnapshot({ rate: runtime.usdCnyRate, source: "ecb", referenceDate: view.referenceDate, fetchedAt: view.fetchedAt, id: view.id }); }
    catch { throw new GatewayBillingError("FX_RATE_UNAVAILABLE", "自动结算汇率暂不可用，请管理员更新后重试", 503); }
  }
  return runtime.usdCnyRate == null ? undefined : sanitizeGatewayFxSnapshot({ rate: runtime.usdCnyRate,
    source: "manual", referenceDate: null, fetchedAt: null, id: null });
}

export function gatewayFxMetadata(snapshot: GatewayFxSnapshot | undefined): Record<string, string> {
  return snapshot ? { fxSource: snapshot.source,
    ...(snapshot.id ? { fxQuoteId: snapshot.id } : {}),
    ...(snapshot.referenceDate ? { fxReferenceDate: snapshot.referenceDate } : {}),
    ...(snapshot.fetchedAt ? { fxFetchedAt: snapshot.fetchedAt } : {}) } : {};
}
