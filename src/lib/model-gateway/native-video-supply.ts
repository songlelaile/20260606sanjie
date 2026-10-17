import "server-only";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { getRelayRuntime } from "./relay-config";
import { digest, stable, plain, NativeVideoError, parseNativeVideoConfig, type NativeVideoModel } from "./native-video-contract";

export const NATIVE_VIDEO_CONFIG_ENV = "MODEL_GATEWAY_NATIVE_VIDEO_CONFIG_FILE";
export const NATIVE_VIDEO_DEFAULT_CONFIG_FILE = "/opt/sanjie-private/native-video.json";
export const NATIVE_VIDEO_CONFIG_MAX_BYTES = 64 * 1024;
export const ARK_VIDEO_ORIGIN = "https://ark.cn-beijing.volces.com";
export const SUB2_VIDEO_ORIGIN = "https://sub.shaozhuangai.com";
const TASK_PATH = "/api/v3/contents/generations/tasks";
type Kind = "ark" | "sub2api";
export type NativeVideoBinding = { provider: Kind; bindingId: string; apiKey: string; models: NativeVideoModel[] };
export type NativeVideoSupplyConfig = { version: 1; enabled: boolean; activeBindingId: string; bindings: NativeVideoBinding[] };
export type NativeVideoSupply = {
  kind: Kind; provider: "volc" | "shaozhuang"; key: string; endpoint: string; binding: string; models: NativeVideoModel[];
};
function invalid(): never { throw new NativeVideoError("NATIVE_VIDEO_CONFIG_INVALID", "平台视频私密配置无效或权限不符合要求", 503); }
function unavailable(): never { throw new NativeVideoError("NATIVE_VIDEO_SUPPLY_UNAVAILABLE", "平台视频供应尚未配置", 503); }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value); }
function exactKeys(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).some(key => !keys.includes(key))) invalid(); }

/** JSON.parse accepts duplicate keys. A private routing file must not silently shadow a binding or credential. */
function parseUniqueJson(raw: string): unknown {
  let result: unknown;
  try { result = JSON.parse(raw); } catch { return invalid(); }
  const stack: Array<{ object: boolean; key: boolean; seen: Set<string> }> = [];
  for (const match of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^{}\[\]:,\s]+/g)) {
    const token = match[0];
    if (token === "{" || token === "[") { stack.push({ object: token === "{", key: token === "{", seen: new Set() }); continue; }
    if (token === "}" || token === "]") { stack.pop(); continue; }
    const frame = stack[stack.length - 1];
    if (token === "," && frame?.object) { frame.key = true; continue; }
    if (token.startsWith('"') && frame?.object && frame.key) {
      const key = JSON.parse(token) as string;
      if (frame.seen.has(key)) invalid();
      frame.seen.add(key); frame.key = false;
    }
  }
  return result;
}

/** No URL, key reference chosen by a browser, default price, or inferred model is accepted. */
export function parseNativeVideoSupplyConfig(raw: string): NativeVideoSupplyConfig {
  if (!raw || Buffer.byteLength(raw, "utf8") > NATIVE_VIDEO_CONFIG_MAX_BYTES) return invalid();
  const value = parseUniqueJson(raw);
  if (!plain(value)) return invalid();
  exactKeys(value, ["version", "enabled", "activeBindingId", "bindings"]);
  if (value.version !== 1 || typeof value.enabled !== "boolean" ||
      !(value.activeBindingId === "" || identifier(value.activeBindingId)) ||
      !Array.isArray(value.bindings) || value.bindings.length > 20) return invalid();
  const ids = new Set<string>();
  const bindings = value.bindings.map((item): NativeVideoBinding => {
    if (!plain(item)) return invalid();
    exactKeys(item, ["provider", "bindingId", "apiKey", "models"]);
    if (!["ark", "sub2api"].includes(String(item.provider)) || !identifier(item.bindingId) || ids.has(item.bindingId) ||
        typeof item.apiKey !== "string" || !item.apiKey || item.apiKey.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(item.apiKey) ||
        !Array.isArray(item.models)) return invalid();
    ids.add(item.bindingId);
    for (const model of item.models) {
      if (!plain(model)) return invalid();
      exactKeys(model, ["id", "label", "upstreamModel", "priceVersion", "reservationCents", "durations", "resolutions", "ratios", "generateAudio", "mediaHosts",
        item.provider === "ark" ? "priceTiers" : "completionCentsPerMillion"]);
    }
    const parsed = parseNativeVideoConfig(JSON.stringify({ enabled: false, bindingId: item.bindingId, models: item.models }), item.provider === "ark");
    return { provider: item.provider as Kind, bindingId: item.bindingId, apiKey: item.apiKey, models: parsed.models };
  });
  const active = bindings.find(binding => binding.bindingId === value.activeBindingId);
  if ((value.activeBindingId !== "" && !active) || (value.enabled && (!active || !active.models.length))) return invalid();
  return { version: 1, enabled: value.enabled, activeBindingId: value.activeBindingId as string, bindings };
}

/** Kept byte-compatible with every pre-existing Sub2API job. Never change this fingerprint format. */
export function sub2VideoBindingFingerprint(key: string, bindingId: string) {
  return digest(stable({ base: SUB2_VIDEO_ORIGIN, keyHash: digest(key), bindingId }));
}
function supply(binding: NativeVideoBinding): NativeVideoSupply {
  const ark = binding.provider === "ark";
  return { kind: binding.provider, provider: ark ? "volc" : "shaozhuang", key: binding.apiKey,
    endpoint: (ark ? ARK_VIDEO_ORIGIN : SUB2_VIDEO_ORIGIN) + TASK_PATH,
    binding: ark ? digest(stable({ version: 1, provider: "ark", base: ARK_VIDEO_ORIGIN, path: TASK_PATH, keyHash: digest(binding.apiKey), bindingId: binding.bindingId }))
      : sub2VideoBindingFingerprint(binding.apiKey, binding.bindingId), models: binding.models };
}

/** Read only a small, stable, root-owned private file through non-symlink ancestors. No secret is included in errors. */
export async function readNativeVideoSupplyConfig(): Promise<NativeVideoSupplyConfig | null> {
  const explicitPath = process.env[NATIVE_VIDEO_CONFIG_ENV];
  const filename = explicitPath === undefined ? NATIVE_VIDEO_DEFAULT_CONFIG_FILE : explicitPath;
  if (!filename || filename.length > 4096 || !path.isAbsolute(filename) || path.normalize(filename) !== filename || filename.includes("\0")) return invalid();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const ancestors: string[] = [];
    for (let dir = path.dirname(filename); ; dir = path.dirname(dir)) { ancestors.unshift(dir); if (dir === path.dirname(dir)) break; }
    for (const dir of ancestors) {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return invalid();
    }
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== 0 || (before.mode & 0o7777) !== 0o600 || before.nlink !== 1 ||
        before.size < 1 || before.size > NATIVE_VIDEO_CONFIG_MAX_BYTES) return invalid();
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(filename);
    const identity = (stat: typeof before) => [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
    if (length !== before.size || identity(before) !== identity(after) || current.isSymbolicLink() || identity(current) !== identity(after)) return invalid();
    let raw: string;
    try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)); } catch { return invalid(); }
    return parseNativeVideoSupplyConfig(raw);
  } catch (cause) {
    // Absence of the default file preserves an explicitly configured legacy
    // Sub2API installation. A bad present file or a missing explicit override does not.
    if (explicitPath === undefined && !handle && (cause as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    return invalid();
  }
  finally { await handle?.close().catch(() => undefined); }
}

async function legacySupply(): Promise<{ enabled: boolean; supply: NativeVideoSupply }> {
  const config = parseNativeVideoConfig(process.env.MODEL_GATEWAY_SEEDANCE_CONFIG);
  if (!config.bindingId) return unavailable();
  let relay: Awaited<ReturnType<typeof getRelayRuntime>>;
  try { relay = await getRelayRuntime(); } catch { return unavailable(); }
  if (!relay.apiKey || relay.baseUrl.replace(/\/+$/, "") !== SUB2_VIDEO_ORIGIN + "/v1") return unavailable();
  return { enabled: config.enabled, supply: supply({ provider: "sub2api", bindingId: config.bindingId, apiKey: relay.apiKey, models: config.models }) };
}

export async function getNativeVideoCreateSupply(): Promise<NativeVideoSupply> {
  const config = await readNativeVideoSupplyConfig();
  if (config) {
    if (!config.enabled) throw new NativeVideoError("NATIVE_VIDEO_DISABLED", "平台视频供应尚未开通", 503);
    // A present but disabled/broken private configuration never falls back to image relay credentials.
    return supply(config.bindings.find(binding => binding.bindingId === config.activeBindingId)!);
  }
  // This legacy configuration is itself an explicit Sub2API choice, not an automatic fallback.
  const legacy = await legacySupply();
  if (!legacy.enabled) throw new NativeVideoError("NATIVE_VIDEO_DISABLED", "平台视频供应尚未开通", 503);
  return legacy.supply;
}

export async function getNativeVideoSupplyForJob(fingerprint: string): Promise<NativeVideoSupply> {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new NativeVideoError("NATIVE_VIDEO_BINDING_CHANGED", "原视频供应绑定不可用，任务保留待核对", 409);
  // Matching a persisted job may use retained history even when new creation is disabled.
  try {
    const config = await readNativeVideoSupplyConfig();
    const matched = config?.bindings.map(supply).find(binding => binding.binding === fingerprint);
    if (matched) return matched;
  } catch { /* A separately retained legacy binding can still prove the exact original supplier. */ }
  try {
    const legacy = await legacySupply();
    if (legacy.supply.binding === fingerprint) return legacy.supply;
  } catch { /* Never reveal a credential, path or configuration parser failure. */ }
  throw new NativeVideoError("NATIVE_VIDEO_BINDING_CHANGED", "原视频供应绑定不可用，任务保留待核对", 409);
}
