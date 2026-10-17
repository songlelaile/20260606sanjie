import "server-only";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { GatewayBillingError } from "./billing-contract";
import { prisma } from "@/lib/db";
import { getRelayRuntime } from "./relay-config";
import { contractHash } from "./source-quote.mjs";
import { parseSharedWalletUsage, SharedWalletSourceError } from "./shared-wallet-usage.mjs";

export const SHARED_WALLET_ORIGIN = "https://sub.shaozhuangai.com" as const;
export const SHARED_WALLET_USAGE_URL = `${SHARED_WALLET_ORIGIN}/v1/usage` as const;
export type SharedWalletBinding = { origin: typeof SHARED_WALLET_ORIGIN; credentialFingerprint: string;
  ownerSubject: string; routeGroupBinding: { groupId: string | null; groupName: string; bindingEvidenceHash: string };
  approvalEvidenceHash: string; authorityHash: string; approvedExposure: "posted_balance_with_unobservable_external_requests";
  approvedCredentialFingerprints: string[] };
export type SharedWalletEpoch = { id: string; startedAt: string; assetExpiresAt: null };
export type SharedWalletExternalCommitments = { state: "unobservable"; amountUsd: null; evidenceHash: string }
  | { state: "proven"; amountUsd: string; evidenceHash: string };
export type SharedWalletSourceObservation = { schema: "SANJIE_SHARED_WALLET_PROOF_V1"; scope: "shared_user_lifetime_wallet";
  binding: SharedWalletBinding; epoch: SharedWalletEpoch | null;
  policy: { configVersion: string; maxSourceAgeMs: number; maxFxAgeMs: number; reserveBps: number; frozenValuationProduct: string | null };
  source: { capturedAt: string; evidenceHash: string; responseHash: string; httpStatus: 200; isValid: true;
    mode: "unrestricted"; nativeUnit: "USD"; balanceUsd: string; remainingUsd: string; balanceRaw: string; remainingRaw: string };
  externalCommitments: SharedWalletExternalCommitments };
export type SharedWalletPrivateConfig = { schema: "SANJIE_SHARED_WALLET_CONFIG_V1"; origin: typeof SHARED_WALLET_ORIGIN;
  privateKeyRef: string; credentialFingerprint: string; ownerSubject: string;
  routeGroupBinding: SharedWalletBinding["routeGroupBinding"]; approvalEvidenceHash: string;
  approvedExposure: SharedWalletBinding["approvedExposure"]; epoch: SharedWalletEpoch | null;
  approvedCredentialFingerprints?: string[];
  maxSourceAgeMs: number; maxFxAgeMs: number; timeoutMs: number; reserveBps: number;
  frozenValuationProduct: string | null; externalCommitments: SharedWalletExternalCommitments };
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
function fail(code: string, status = 409): never { throw new GatewayBillingError(code, "共用钱包来源暂时无法核验，请管理员核对连接", status); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).sort().join() !== keys.sort().join()) fail("SHARED_SOURCE_CONFIG_INVALID");
}
const text = (value: unknown, max = 160): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const usd = (value: unknown): value is string => typeof value === "string" && value.length <= 96 && /^(0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value);
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
/** Private operator binding, never a browser request or upstream ID inferred from usage. */
export function parseSharedWalletPrivateConfig(value: unknown): SharedWalletPrivateConfig {
  exact(value, ["schema", "origin", "privateKeyRef", "credentialFingerprint", "ownerSubject", "routeGroupBinding", "approvalEvidenceHash", "approvedExposure", "epoch", "maxSourceAgeMs", "maxFxAgeMs", "timeoutMs", "reserveBps", "frozenValuationProduct", "externalCommitments", ...(object(value) && "approvedCredentialFingerprints" in value ? ["approvedCredentialFingerprints"] : [])]);
  if (value.schema !== "SANJIE_SHARED_WALLET_CONFIG_V1" || value.origin !== SHARED_WALLET_ORIGIN ||
      !text(value.privateKeyRef, 512) || !path.isAbsolute(value.privateKeyRef) || !text(value.ownerSubject) ||
      typeof value.credentialFingerprint !== "string" || !HASH.test(value.credentialFingerprint) ||
      typeof value.approvalEvidenceHash !== "string" || !HASH.test(value.approvalEvidenceHash) ||
      value.approvedExposure !== "posted_balance_with_unobservable_external_requests") fail("SHARED_SOURCE_CONFIG_INVALID");
  exact(value.routeGroupBinding, ["groupId", "groupName", "bindingEvidenceHash"]);
  if (value.routeGroupBinding.groupId !== null && (typeof value.routeGroupBinding.groupId !== "string" || !ID.test(value.routeGroupBinding.groupId)) ||
      !text(value.routeGroupBinding.groupName, 80) || typeof value.routeGroupBinding.bindingEvidenceHash !== "string" || !HASH.test(value.routeGroupBinding.bindingEvidenceHash)) fail("SHARED_SOURCE_CONFIG_INVALID");
  if (value.epoch !== null) {
    exact(value.epoch, ["id", "startedAt", "assetExpiresAt"]);
    if (typeof value.epoch.id !== "string" || !ID.test(value.epoch.id) || !instant(value.epoch.startedAt) || value.epoch.assetExpiresAt !== null) fail("SHARED_SOURCE_CONFIG_INVALID");
  }
  if (value.approvedCredentialFingerprints !== undefined && (!Array.isArray(value.approvedCredentialFingerprints) || value.approvedCredentialFingerprints.length > 10_000 ||
      value.approvedCredentialFingerprints.some(item => typeof item !== "string" || !HASH.test(item)) || new Set(value.approvedCredentialFingerprints).size !== value.approvedCredentialFingerprints.length)) fail("SHARED_SOURCE_CONFIG_INVALID");
  for (const [key, max] of [["maxSourceAgeMs", 60_000], ["maxFxAgeMs", 259_200_000], ["timeoutMs", 10_000]] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 1 || Number(value[key]) > max) fail("SHARED_SOURCE_CONFIG_INVALID");
  }
  if (!Number.isSafeInteger(value.reserveBps) || Number(value.reserveBps) < 0 || Number(value.reserveBps) >= 10_000 ||
      value.frozenValuationProduct !== null && (typeof value.frozenValuationProduct !== "string" || !/^[1-9]\d{0,32}$/.test(value.frozenValuationProduct))) fail("SHARED_SOURCE_CONFIG_INVALID");
  exact(value.externalCommitments, ["state", "amountUsd", "evidenceHash"]);
  if (typeof value.externalCommitments.evidenceHash !== "string" || !HASH.test(value.externalCommitments.evidenceHash) ||
      (value.externalCommitments.state === "unobservable" ? value.externalCommitments.amountUsd !== null
        : value.externalCommitments.state !== "proven" || !usd(value.externalCommitments.amountUsd))) fail("SHARED_SOURCE_CONFIG_INVALID");
  return value as unknown as SharedWalletPrivateConfig;
}
async function privateBytes(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes || stat.mode & 0o077) fail("SHARED_SOURCE_PRIVATE_FILE_INVALID");
    const bytes = Buffer.alloc(maxBytes + 1); let length = 0;
    while (length < bytes.length) { const chunk = await handle.read(bytes, length, bytes.length - length, length); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
    if (length > maxBytes) fail("SHARED_SOURCE_PRIVATE_FILE_INVALID");
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
export async function readSharedWalletPrivateConfig(): Promise<SharedWalletPrivateConfig> {
  const file = process.env.GATEWAY_SHARED_WALLET_CONFIG_FILE;
  if (!file || !path.isAbsolute(file)) fail("SHARED_SOURCE_NOT_CONFIGURED");
  try { return parseSharedWalletPrivateConfig(JSON.parse((await privateBytes(file, 32_768)).toString("utf8"))); }
  catch (error) { if (error instanceof GatewayBillingError) throw error; return fail("SHARED_SOURCE_CONFIG_UNAVAILABLE", 503); }
}
export async function getGatewaySharedSourceConfigVersion(): Promise<string> {
  const config = await readSharedWalletPrivateConfig();
  return contractHash({ ...config, privateKeyRef: undefined });
}
export const readGatewaySharedWalletSourceConfiguration = readSharedWalletPrivateConfig;
function operatorBinding(config: SharedWalletPrivateConfig): SharedWalletBinding {
  const facts = { origin: config.origin, credentialFingerprint: config.credentialFingerprint,
    ownerSubject: config.ownerSubject, routeGroupBinding: config.routeGroupBinding, approvalEvidenceHash: config.approvalEvidenceHash,
    approvedExposure: config.approvedExposure, approvedCredentialFingerprints: config.approvedCredentialFingerprints ?? [] };
  return { ...facts, authorityHash: contractHash(facts) };
}
async function existingKey(config: SharedWalletPrivateConfig): Promise<string> {
  let key: string;
  try { key = (await privateBytes(config.privateKeyRef, 4_096)).toString("utf8").trim(); }
  catch (error) { if (error instanceof GatewayBillingError) throw error; return fail("SHARED_SOURCE_KEY_UNAVAILABLE", 503); }
  if (key.length < 8 || key.length > 4_096 || /[\s\u0000-\u001f\u007f]/.test(key) || /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) fail("SHARED_SOURCE_KEY_INVALID");
  if (createHash("sha256").update(key).digest("hex") !== config.credentialFingerprint) fail("SHARED_SOURCE_KEY_CHANGED");
  return key;
}
/** Private dispatch runtime only. This is platform supply, never a user's BYOK or an invented provisioned key. */
export async function getGatewaySharedPlatformRuntime() {
  const config = await readSharedWalletPrivateConfig();
  const apiKey = await existingKey(config); const binding = operatorBinding(config); const runtime = await getRelayRuntime();
  if (runtime.baseUrl !== `${SHARED_WALLET_ORIGIN}/v1`) fail("SHARED_SOURCE_ROUTE_CHANGED");
  return { baseUrl: `${SHARED_WALLET_ORIGIN}/v1` as const, apiKey, credentialFingerprint: config.credentialFingerprint,
    configVersion: contractHash({ ...config, privateKeyRef: undefined }), bindingEvidenceHash: config.routeGroupBinding.bindingEvidenceHash,
    operatorBinding: binding, epoch: config.epoch, usdCnyRate: runtime.usdCnyRate, exchangeRate: runtime.exchangeRate };
}
export async function getSharedWalletPlatformSupply(userId: string) {
  if (!ID.test(userId)) fail("POOL_INPUT_INVALID", 400);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (!user || user.status !== "active") fail("ACCOUNT_UNAVAILABLE", 403);
  return getGatewaySharedPlatformRuntime();
}
/** Fixed HTTPS GET, no redirect, bounded decoded body, one deadline including body consumption. */
async function fetchSharedWalletUsageOnce(key: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(SHARED_WALLET_USAGE_URL, { method: "GET", redirect: "error", cache: "no-store", signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
    if (response.redirected || response.url !== SHARED_WALLET_USAGE_URL) fail("SOURCE_REDIRECT_REJECTED", 503);
    if (response.status !== 200) fail(response.status === 401 ? "SOURCE_AUTH_REQUIRED" : response.status === 403 ? "SOURCE_ACCESS_DENIED" : response.status === 429 ? "SOURCE_RATE_LIMITED" : response.status >= 500 ? "SOURCE_UNAVAILABLE" : "SOURCE_RESPONSE_STATUS_INVALID", 503);
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) fail("SOURCE_CONTENT_TYPE_INVALID", 503);
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) > 65_536n)) fail("SOURCE_RESPONSE_TOO_LARGE", 503);
    if (!response.body) fail("SOURCE_RESPONSE_INVALID", 503);
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength;
      if (length > 65_536) { await reader.cancel(); fail("SOURCE_RESPONSE_TOO_LARGE", 503); } chunks.push(chunk.value); } }
    finally { reader.releaseLock(); }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) { if (error instanceof GatewayBillingError) throw error; return fail(controller.signal.aborted ? "SOURCE_TIMEOUT" : "SOURCE_TRANSPORT_FAILED", 503); }
  finally { clearTimeout(timer); controller.abort(); }
}
/** At most two read-only attempts share the configured total deadline. A rejected
 * identity, scope, response, rate limit or credential is never retried. */
export async function fetchSharedWalletUsage(key: string, timeoutMs: number): Promise<string> {
  const started = performance.now();
  try { return await fetchSharedWalletUsageOnce(key, Math.max(1, timeoutMs - Math.min(1_000, Math.floor(timeoutMs / 2)))); }
  catch (error) {
    const remaining = Math.floor(timeoutMs - (performance.now() - started));
    if (!(error instanceof GatewayBillingError) || !["SOURCE_TIMEOUT", "SOURCE_TRANSPORT_FAILED", "SOURCE_UNAVAILABLE"].includes(error.code) || remaining < 1) throw error;
    return fetchSharedWalletUsageOnce(key, remaining);
  }
}
/** Network-only trusted observation. No DB mutation and no arguments accepted from HTTP. */
export async function readGatewaySharedWalletSource(...inputs: never[]): Promise<SharedWalletSourceObservation> {
  if (inputs.length) fail("POOL_INPUT_INVALID", 400);
  const config = await readSharedWalletPrivateConfig();
  const key = await existingKey(config);
  // Request-start time is conservative: a delayed older GET cannot become a
  // newer source observation merely because its response completed last.
  const capturedAt = new Date().toISOString();
  const raw = await fetchSharedWalletUsage(key, config.timeoutMs);
  let parsed: ReturnType<typeof parseSharedWalletUsage>;
  try { parsed = parseSharedWalletUsage(raw); }
  catch (error) { return fail(error instanceof SharedWalletSourceError ? error.code : "SOURCE_RESPONSE_INVALID", 503); }
  const binding = operatorBinding(config);
  if (config.epoch && Date.parse(config.epoch.startedAt) > Date.parse(capturedAt)) fail("SHARED_SOURCE_EPOCH_INVALID");
  const source = { capturedAt, responseHash: parsed.responseHash, httpStatus: 200 as const, isValid: true as const,
    mode: "unrestricted" as const, nativeUnit: "USD" as const, balanceUsd: parsed.balanceUsd, remainingUsd: parsed.remainingUsd,
    balanceRaw: parsed.balanceRaw, remainingRaw: parsed.remainingRaw };
  return { schema: "SANJIE_SHARED_WALLET_PROOF_V1", scope: "shared_user_lifetime_wallet", binding, epoch: config.epoch,
    policy: { configVersion: contractHash({ ...config, privateKeyRef: undefined }), maxSourceAgeMs: config.maxSourceAgeMs,
      maxFxAgeMs: config.maxFxAgeMs, reserveBps: config.reserveBps, frozenValuationProduct: config.frozenValuationProduct },
    source: { ...source, evidenceHash: contractHash({ source, binding }) }, externalCommitments: config.externalCommitments };
}
