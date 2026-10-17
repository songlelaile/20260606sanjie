import "server-only";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RelayGroupObservation, RelaySupplyObservation } from "./credit-pool-observation-contract";

export const RELAY_ADMIN_ORIGIN = "https://sub.shaozhuangai.com";
const PATHS = {
  groups: "/api/v1/admin/groups",
  usage: "/api/v1/admin/groups/usage-summary?timezone=Asia%2FShanghai",
  capacity: "/api/v1/admin/groups/capacity-summary"
} as const;
type Part = keyof typeof PATHS;
type Configuration = { schema: "SANJIE_RELAY_ADMIN_OBSERVATION_V1"; origin: typeof RELAY_ADMIN_ORIGIN;
  authType: "x-api-key" | "bearer"; credentialFile: string; credentialFingerprint: string; timeoutMs: number; groupIds: string[] };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
class RelayObservationError extends Error { constructor(readonly code: string) { super("中转供应观察暂时不可用"); } }
function fail(code: string): never { throw new RelayObservationError(code); }
const id = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
function privatePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && path.isAbsolute(value) && path.normalize(value) === value && !/[\u0000-\u001f\u007f]/.test(value);
}
export function parseRelayAdminObservationConfig(value: unknown): Configuration {
  if (!object(value) || Object.keys(value).sort().join() !== ["schema", "origin", "authType", "credentialFile", "credentialFingerprint", "timeoutMs", "groupIds"].sort().join() ||
    value.schema !== "SANJIE_RELAY_ADMIN_OBSERVATION_V1" || value.origin !== RELAY_ADMIN_ORIGIN ||
    !["x-api-key", "bearer"].includes(value.authType as string) || !privatePath(value.credentialFile) ||
    typeof value.credentialFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.credentialFingerprint) ||
    !Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) < 1 || Number(value.timeoutMs) > 10_000 ||
    !Array.isArray(value.groupIds) || value.groupIds.length < 1 || value.groupIds.length > 100 || !value.groupIds.every(id) || new Set(value.groupIds).size !== value.groupIds.length) fail("RELAY_ADMIN_CONFIG_INVALID");
  return value as Configuration;
}
async function privateFile(file: string, maximum: number): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum || stat.mode & 0o077 || typeof process.geteuid === "function" && stat.uid !== process.geteuid()) fail("RELAY_ADMIN_PRIVATE_FILE_INVALID");
    const bytes = Buffer.alloc(maximum + 1); let length = 0;
    while (length < bytes.length) {
      const chunk = await handle.read(bytes, length, bytes.length - length, length); if (!chunk.bytesRead) break; length += chunk.bytesRead;
    }
    if (length > maximum) fail("RELAY_ADMIN_PRIVATE_FILE_INVALID");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await handle.close(); }
}
async function configuration(): Promise<{ config: Configuration; credential: string } | null> {
  const file = process.env.GATEWAY_RELAY_ADMIN_CONFIG_FILE;
  if (!file) return null;
  if (!privatePath(file)) fail("RELAY_ADMIN_CONFIG_INVALID");
  try {
    const config = parseRelayAdminObservationConfig(JSON.parse(await privateFile(file, 32_768)));
    const credential = (await privateFile(config.credentialFile, 16_384)).trim();
    if (credential.length < 8 || credential.length > 16_384 || /[\s\u0000-\u001f\u007f]/.test(credential) ||
      createHash("sha256").update(credential).digest("hex") !== config.credentialFingerprint) fail("RELAY_ADMIN_CREDENTIAL_INVALID");
    return { config, credential };
  } catch (error) { if (error instanceof RelayObservationError) throw error; return fail("RELAY_ADMIN_CONFIG_UNAVAILABLE"); }
}
/** The finite path list is private; callers cannot supply URLs, methods, bodies or browser credentials. */
async function readPart(part: Part, config: Configuration, credential: string, deadline: number, page = 1): Promise<unknown> {
  const url = RELAY_ADMIN_ORIGIN + PATHS[part] + (part === "groups" ? `?page=${page}&page_size=100` : "");
  const remaining = Math.floor(deadline - performance.now()); if (remaining < 1) fail("RELAY_ADMIN_TIMEOUT");
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (config.authType === "x-api-key") headers["x-api-key"] = credential; else headers.Authorization = `Bearer ${credential}`;
    const response = await fetch(url, { method: "GET", headers, redirect: "error", cache: "no-store", signal: controller.signal });
    if (response.redirected || response.url !== url) fail("RELAY_ADMIN_REDIRECT_REJECTED");
    if (response.status !== 200) fail(response.status === 401 ? "RELAY_ADMIN_AUTH_REQUIRED" : response.status === 403 ? "RELAY_ADMIN_ACCESS_DENIED" : response.status === 429 ? "RELAY_ADMIN_RATE_LIMITED" : "RELAY_ADMIN_SOURCE_UNAVAILABLE");
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) fail("RELAY_ADMIN_RESPONSE_INVALID");
    const declared = response.headers.get("content-length"), maximum = 262_144;
    if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(maximum))) fail("RELAY_ADMIN_RESPONSE_TOO_LARGE");
    if (!response.body) fail("RELAY_ADMIN_RESPONSE_INVALID");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength;
        if (length > maximum) { await reader.cancel(); fail("RELAY_ADMIN_RESPONSE_TOO_LARGE"); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const envelope = parseRelayJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!object(envelope) || numeric(envelope.code) !== "0" || !Object.hasOwn(envelope, "data")) fail("RELAY_ADMIN_RESPONSE_INVALID");
    return envelope.data;
  } catch (error) {
    if (error instanceof RelayObservationError) throw error;
    return fail(controller.signal.aborted ? "RELAY_ADMIN_TIMEOUT" : "RELAY_ADMIN_SOURCE_UNAVAILABLE");
  } finally { clearTimeout(timer); controller.abort(); }
}

const NUMBER = Symbol("relay-json-number");
function numeric(value: unknown): string | null {
  return value && typeof value === "object" && NUMBER in value ? (value as { [NUMBER]: string })[NUMBER] : null;
}
/** Preserve number lexemes before projecting reported costs; duplicate JSON keys are rejected. */
function parseRelayJson(text: string): unknown {
  let cursor = 0, tokens = 0;
  const invalid = () => fail("RELAY_ADMIN_RESPONSE_INVALID");
  const whitespace = () => { while (/[\x20\t\r\n]/.test(text[cursor] ?? "") && cursor < text.length) cursor++; };
  const string = (): string => {
    const start = cursor++; let escaped = false;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === '"' && !escaped) { try { return JSON.parse(text.slice(start, cursor)) as string; } catch { return invalid(); } }
      if (char === "\\" && !escaped) escaped = true; else escaped = false;
    }
    return invalid();
  };
  const value = (depth: number): unknown => {
    if (depth > 24 || ++tokens > 30_000) invalid(); whitespace(); const char = text[cursor];
    if (char === '"') return string();
    if (char === "{") {
      cursor++; whitespace(); const row: Record<string, unknown> = Object.create(null);
      if (text[cursor] === "}") { cursor++; return row; }
      while (true) {
        whitespace(); if (text[cursor] !== '"') invalid(); const key = string();
        if (Object.hasOwn(row, key)) invalid(); whitespace(); if (text[cursor++] !== ":") invalid();
        row[key] = value(depth + 1); whitespace(); const end = text[cursor++];
        if (end === "}") return row; if (end !== ",") invalid();
      }
    }
    if (char === "[") {
      cursor++; whitespace(); const rows: unknown[] = [];
      if (text[cursor] === "]") { cursor++; return rows; }
      while (true) {
        rows.push(value(depth + 1)); whitespace(); const end = text[cursor++];
        if (end === "]") return rows; if (end !== ",") invalid();
      }
    }
    for (const [literal, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(literal, cursor)) { cursor += literal.length; return result; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(cursor));
    if (!number) return invalid(); cursor += number[0].length; return { [NUMBER]: number[0] };
  };
  const result = value(0); whitespace(); if (cursor !== text.length) invalid(); return result;
}
function numericId(value: unknown): string {
  const raw = numeric(value); if (!id(raw)) return fail("RELAY_ADMIN_RESPONSE_INVALID"); return raw;
}
function optionalCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const raw = numeric(value);
  if (raw === null || !/^(0|[1-9]\d{0,15})$/.test(raw) || !Number.isSafeInteger(Number(raw))) return fail("RELAY_ADMIN_RESPONSE_INVALID");
  return Number(raw);
}
function optionalCost(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = numeric(value);
  if (raw === null || raw.length > 96 || !/^(0|[1-9]\d*)(?:\.\d{1,8})?$/.test(raw)) return fail("RELAY_ADMIN_RESPONSE_INVALID");
  const [whole, fraction] = raw.split("."); const decimals = fraction?.replace(/0+$/, "");
  return whole + (decimals ? `.${decimals}` : "");
}
function optionalLabel(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.length || value.length > 100 || /[\u0000-\u001f\u007f@]/.test(value)) return fail("RELAY_ADMIN_RESPONSE_INVALID");
  return value;
}
async function readGroups(config: Configuration, credential: string, deadline: number): Promise<RelayGroupObservation[]> {
  const groups: RelayGroupObservation[] = [], allIds = new Set<string>();
  let expectedTotal: number | null = null, expectedPages: number | null = null, expectedPageSize: number | null = null;
  for (let page = 1; page <= 20; page++) {
    const data = await readPart("groups", config, credential, deadline, page);
    if (!object(data) || !Array.isArray(data.items)) fail("RELAY_ADMIN_RESPONSE_INVALID");
    const total = optionalCount(data.total), pages = optionalCount(data.pages), pageSize = optionalCount(data.page_size);
    if (total === null || total > 2_000 || pages === null || pages < 1 || pages > 20 || pageSize === null || pageSize < 1 || pageSize > 100 ||
      optionalCount(data.page) !== page || pages !== Math.max(1, Math.ceil(total / pageSize)) ||
      data.items.length !== Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize))) fail("RELAY_ADMIN_RESPONSE_INVALID");
    if (expectedTotal !== null && (total !== expectedTotal || pages !== expectedPages || pageSize !== expectedPageSize)) fail("RELAY_ADMIN_RESPONSE_INVALID");
    expectedTotal = total; expectedPages = pages; expectedPageSize = pageSize;
    for (const item of data.items) {
      if (!object(item)) fail("RELAY_ADMIN_RESPONSE_INVALID"); const groupId = numericId(item.id);
      if (allIds.has(groupId)) fail("RELAY_ADMIN_RESPONSE_INVALID"); allIds.add(groupId);
      if (!config.groupIds.includes(groupId)) continue;
      const accountCount = optionalCount(item.account_count), activeAccountCount = optionalCount(item.active_account_count);
      if (accountCount !== null && activeAccountCount !== null && activeAccountCount > accountCount) fail("RELAY_ADMIN_RESPONSE_INVALID");
      groups.push({ groupId, name: optionalLabel(item.name), platform: optionalLabel(item.platform), status: optionalLabel(item.status),
        accountCount, activeAccountCount, usage: null, capacity: null });
    }
    if (page === pages) {
      if (groups.length !== config.groupIds.length) fail("RELAY_ADMIN_GROUP_NOT_FOUND");
      return groups.sort((a, b) => config.groupIds.indexOf(a.groupId) - config.groupIds.indexOf(b.groupId));
    }
  }
  return fail("RELAY_ADMIN_RESPONSE_INVALID");
}
function projectSummary(value: unknown, groupIds: string[], part: "usage" | "capacity") {
  if (!Array.isArray(value) || value.length > 2_000) fail("RELAY_ADMIN_RESPONSE_INVALID");
  const map = new Map<string, RelayGroupObservation["usage"] | RelayGroupObservation["capacity"]>(), seen = new Set<string>();
  for (const item of value) {
    if (!object(item)) fail("RELAY_ADMIN_RESPONSE_INVALID"); const groupId = numericId(item.group_id);
    if (seen.has(groupId)) fail("RELAY_ADMIN_RESPONSE_INVALID"); seen.add(groupId);
    if (!groupIds.includes(groupId)) continue;
    if (part === "usage") map.set(groupId, { todayCost: optionalCost(item.today_cost), yesterdayCost: optionalCost(item.yesterday_cost), totalCost: optionalCost(item.total_cost), unit: "relay_reported_cost" });
    else map.set(groupId, { concurrencyUsed: optionalCount(item.concurrency_used), concurrencyMax: optionalCount(item.concurrency_max), sessionsUsed: optionalCount(item.sessions_used),
      sessionsMax: optionalCount(item.sessions_max), rpmUsed: optionalCount(item.rpm_used), rpmMax: optionalCount(item.rpm_max) });
  }
  return map;
}
export async function readRelayAdminSupplyObservation(): Promise<RelaySupplyObservation> {
  let runtime: Awaited<ReturnType<typeof configuration>>;
  try { runtime = await configuration(); }
  catch (error) { return { status: "unavailable", observedAt: null, groups: [], referenceOnly: true, code: error instanceof RelayObservationError ? error.code : "RELAY_ADMIN_CONFIG_UNAVAILABLE" }; }
  if (!runtime) return { status: "not_configured", observedAt: null, groups: [], referenceOnly: true, code: "RELAY_ADMIN_NOT_CONFIGURED" };
  const observedAt = new Date().toISOString();
  const deadline = performance.now() + runtime.config.timeoutMs;
  const [groupResult, usageResult, capacityResult] = await Promise.allSettled([
    readGroups(runtime.config, runtime.credential, deadline),
    readPart("usage", runtime.config, runtime.credential, deadline).then(value => projectSummary(value, runtime.config.groupIds, "usage")),
    readPart("capacity", runtime.config, runtime.credential, deadline).then(value => projectSummary(value, runtime.config.groupIds, "capacity"))
  ]);
  if (groupResult.status === "rejected") return { status: "unavailable", observedAt: null, groups: [], referenceOnly: true,
    code: groupResult.reason instanceof RelayObservationError ? groupResult.reason.code : "RELAY_ADMIN_RESPONSE_INVALID" };
  try {
    const groups = groupResult.value.map(group => ({ ...group,
      usage: usageResult.status === "fulfilled" ? usageResult.value.get(group.groupId) as RelayGroupObservation["usage"] ?? null : null,
      capacity: capacityResult.status === "fulfilled" ? capacityResult.value.get(group.groupId) as RelayGroupObservation["capacity"] ?? null : null
    }));
    const partial = groups.some(group => group.usage === null || group.capacity === null ||
      [group.usage.todayCost, group.usage.yesterdayCost, group.usage.totalCost].some(value => value === null) ||
      Object.values(group.capacity).some(value => value === null));
    return { status: partial ? "partial" : "ok", observedAt, groups, referenceOnly: true, code: partial ? "RELAY_ADMIN_PARTIAL" : null };
  } catch { return { status: "unavailable", observedAt: null, groups: [], referenceOnly: true, code: "RELAY_ADMIN_RESPONSE_INVALID" }; }
}
