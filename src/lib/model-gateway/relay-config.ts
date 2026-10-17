import "server-only";
import { mkdir, readFile, rename, chmod, unlink, open } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { GATEWAY_MODELS } from "@/lib/model-gateway/catalog";
import { type RelayShopKey, type RelayShopPurpose } from "@/lib/model-gateway/relay-routing";
import { SHAOZHUANG_RELAY_UPSTREAM } from "@/lib/shaozhuang-relay-models";
import { assertPublicRelayUrl, normalizeRelayBaseUrl, relayFetch, RelayNetworkError } from "@/lib/model-gateway/relay-network";

export type RelayModel = {
  id: string;
  label: string;
  upstreamModel: string;
  kind: "chat" | "image" | "video" | "unknown";
  enabled: boolean;
  promptCentsPer1K?: number;
  completionCentsPer1K?: number;
  imageCents?: number;
  videoCents?: number;
};

export type RelayShopKeyView = { shopName: string; purpose: RelayShopPurpose };

export type RelaySettingsView = {
  baseUrl: string;
  keyConfigured: boolean;
  keySource: "file" | "env" | "none";
  models: RelayModel[];
  shopKeys: RelayShopKeyView[];
  usdCnyRate: number | null;
  updatedAt: string | null;
};

type RelayFile = {
  version: 1;
  baseUrl: string;
  apiKey?: string;
  keyCleared?: boolean;
  models: RelayModel[];
  shopKeys: RelayShopKey[];
  usdCnyRate: number | null;
  updatedAt: string;
};

export class RelayConfigError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "RelayConfigError"; }
}

const DEFAULT_BASE_URL = "https://sub.shaozhuangai.com/v1";
const RATE_FIELDS = ["promptCentsPer1K", "completionCentsPer1K", "imageCents", "videoCents"] as const;
let writeQueue: Promise<unknown> = Promise.resolve();

export function getRelayConfigPath() {
  const project = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 12);
  return path.resolve(process.env.MODEL_GATEWAY_CONFIG_FILE || path.join(homedir(), ".config", "shaozhuangai", "model-gateway", project, "relay.json"));
}

function defaultModels(): RelayModel[] {
  return GATEWAY_MODELS.filter((model) => model.provider === "shaozhuang").map((model) => ({
    id: model.id, label: model.label, upstreamModel: model.upstreamModel, kind: model.kind, enabled: true,
    ...Object.fromEntries(RATE_FIELDS.filter((field) => field in model).map((field) => [field, (model as unknown as Record<string, unknown>)[field]]))
  }));
}

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function modelString(value: unknown, label: string, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RelayConfigError(`${label}必须是有效文本`);
  }
  return value.trim();
}

function validateModels(raw: unknown): RelayModel[] {
  if (!Array.isArray(raw) || raw.length > 2_000) throw new RelayConfigError("模型目录必须是数组，最多 2000 个模型");
  const used = new Set<string>();
  const directIds = new Set(GATEWAY_MODELS.filter((model) => model.provider !== "shaozhuang").map((model) => model.id));
  return raw.map((item) => {
    const row = object(item);
    if (!row) throw new RelayConfigError("模型设置无效");
    const id = modelString(row.id, "模型 ID");
    if (/\s/.test(id) || used.has(id)) throw new RelayConfigError("模型 ID 不能重复或包含空白");
    if (directIds.has(id)) throw new RelayConfigError("中转站模型 ID 与现有直连模型冲突，请设置不同别名");
    used.add(id);
    const kind = row.kind;
    if (!["chat", "image", "video", "unknown"].includes(String(kind)) || typeof row.enabled !== "boolean") {
      throw new RelayConfigError("模型类型或启用状态无效");
    }
    const model: RelayModel = {
      id, label: modelString(row.label, "模型名称"), upstreamModel: modelString(row.upstreamModel, "上游模型 ID"),
      kind: kind as RelayModel["kind"], enabled: row.enabled
    };
    for (const field of RATE_FIELDS) {
      if (row[field] !== undefined) {
        if (typeof row[field] !== "number" || !Number.isFinite(row[field]) || row[field] < 0 || row[field] > 10_000_000) {
          throw new RelayConfigError("模型费率必须是有限的非负数字（单位：分）");
        }
        model[field] = row[field];
        if ((field === "imageCents" || field === "videoCents") && !Number.isSafeInteger(row[field])) {
          throw new RelayConfigError("图片和视频费率必须是整数（单位：分）");
        }
      }
    }
    if (model.enabled && model.kind === "unknown") throw new RelayConfigError("未分类模型请先选择聊天、图片或视频类型后再启用");
    if (model.enabled && model.kind === "chat" && !(model.promptCentsPer1K != null && model.promptCentsPer1K > 0 && model.completionCentsPer1K != null && model.completionCentsPer1K > 0)) {
      throw new RelayConfigError("启用聊天模型前请设置大于 0 的输入、输出费率");
    }
    if (model.enabled && model.kind === "image" && !(model.imageCents != null && model.imageCents > 0)) {
      throw new RelayConfigError("启用图片模型前请设置大于 0 的图片费率");
    }
    if (model.enabled && model.kind === "video" && !(model.videoCents != null && model.videoCents > 0)) {
      throw new RelayConfigError("启用视频模型前请设置大于 0 的视频费率");
    }
    return model;
  });
}

function parsePurpose(value: unknown): RelayShopPurpose {
  if (value === "default" || value === "image") return value;
  throw new RelayConfigError("店铺 Key 用途只能是默认或图片");
}

function parseUsdCnyRate(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000) {
    throw new RelayConfigError("美元汇率必须是大于 0 且不超过 1000 的人民币金额");
  }
  const scaled = Math.round(value * 1_000_000);
  if (Math.abs(value * 1_000_000 - scaled) > 0.001) throw new RelayConfigError("美元汇率最多保留 6 位小数");
  return scaled / 1_000_000;
}

function parseStoredShopKeys(raw: unknown): RelayShopKey[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 200) throw new RelayConfigError("店铺 Key 列表无效");
  const seen = new Set<string>();
  return raw.map((item) => {
    const row = object(item);
    if (!row) throw new RelayConfigError("店铺 Key 无效");
    const shopName = modelString(row.shopName, "店铺名称", 80);
    const purpose = parsePurpose(row.purpose);
    const id = `${purpose}\n${shopName}`;
    if (seen.has(id)) throw new RelayConfigError("同一店铺的同一用途不能重复");
    seen.add(id);
    if (typeof row.apiKey !== "string" || !row.apiKey.trim() || row.apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(row.apiKey)) {
      throw new RelayConfigError("店铺 Key 格式无效");
    }
    return { shopName, purpose, apiKey: row.apiKey.trim() };
  });
}

function mergeShopKeyUpdate(current: RelayShopKey[], raw: unknown): RelayShopKey[] {
  if (!Array.isArray(raw) || raw.length > 200) throw new RelayConfigError("店铺 Key 列表无效");
  const previous = new Map(current.map((item) => [`${item.purpose}\n${item.shopName}`, item.apiKey]));
  const seen = new Set<string>();
  const result: RelayShopKey[] = [];
  for (const item of raw) {
    const row = object(item);
    if (!row) throw new RelayConfigError("店铺 Key 无效");
    const shopName = modelString(row.shopName, "店铺名称", 80);
    const purpose = parsePurpose(row.purpose);
    const id = `${purpose}\n${shopName}`;
    if (seen.has(id)) throw new RelayConfigError("同一店铺的同一用途不能重复");
    seen.add(id);
    if (row.clear === true) continue;
    let apiKey = previous.get(id);
    if (row.apiKey !== undefined) {
      if (typeof row.apiKey !== "string" || row.apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(row.apiKey)) {
        throw new RelayConfigError("店铺 Key 格式无效");
      }
      if (row.apiKey.trim()) apiKey = row.apiKey.trim();
    }
    if (!apiKey) throw new RelayConfigError(`请先填写店铺「${shopName}」的中转站 Key`);
    result.push({ shopName, purpose, apiKey });
  }
  return result;
}

async function readConfig(): Promise<RelayFile | null> {
  let text: string;
  try { text = await readFile(getRelayConfigPath(), "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RelayConfigError("中转站配置读取失败，请检查服务端文件权限", 500);
  }
  try {
    if (Buffer.byteLength(text) > 2_000_000) throw new Error("invalid");
    const raw = object(JSON.parse(text));
    if (!raw || raw.version !== 1 || typeof raw.baseUrl !== "string" || typeof raw.updatedAt !== "string" ||
      (raw.apiKey !== undefined && typeof raw.apiKey !== "string") ||
      (raw.keyCleared !== undefined && typeof raw.keyCleared !== "boolean")) throw new Error("invalid");
    return {
      version: 1, baseUrl: normalizeRelayBaseUrl(raw.baseUrl), apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
      keyCleared: raw.keyCleared === true, models: validateModels(raw.models),
      shopKeys: parseStoredShopKeys(raw.shopKeys),
      usdCnyRate: raw.usdCnyRate === undefined ? null : parseUsdCnyRate(raw.usdCnyRate),
      updatedAt: raw.updatedAt
    };
  } catch { throw new RelayConfigError("中转站配置文件无效，请由管理员修复服务端配置", 500); }
}

/** Saved files that still store the public id as the upstream name follow the live relay ids. Custom upstream names stay. */
function applyLegacyRelayUpstream(models: RelayModel[]): RelayModel[] {
  return models.map((model) => {
    const upstream = SHAOZHUANG_RELAY_UPSTREAM[model.id as keyof typeof SHAOZHUANG_RELAY_UPSTREAM];
    return upstream && model.upstreamModel === model.id ? { ...model, upstreamModel: upstream } : model;
  });
}

function effective(config: RelayFile | null) {
  const fileKey = config?.apiKey?.trim() || "";
  const envKey = config?.keyCleared ? "" : (process.env.MODEL_GATEWAY_SHAOZHUANG_API_KEY || "").trim();
  return {
    baseUrl: config?.baseUrl || normalizeRelayBaseUrl(process.env.MODEL_GATEWAY_SHAOZHUANG_BASE_URL || DEFAULT_BASE_URL),
    apiKey: fileKey || envKey,
    keySource: (fileKey ? "file" : envKey ? "env" : "none") as RelaySettingsView["keySource"],
    models: applyLegacyRelayUpstream(config?.models || defaultModels()),
    shopKeys: config?.shopKeys || [], usdCnyRate: config?.usdCnyRate ?? null, updatedAt: config?.updatedAt || null
  };
}

function settingsView(config: RelayFile | null): RelaySettingsView {
  const runtime = effective(config);
  return {
    baseUrl: runtime.baseUrl, keyConfigured: !!runtime.apiKey, keySource: runtime.keySource, models: runtime.models,
    shopKeys: runtime.shopKeys.map(({ shopName, purpose }) => ({ shopName, purpose })),
    usdCnyRate: runtime.usdCnyRate, updatedAt: runtime.updatedAt
  };
}

export async function getRelaySettings(): Promise<RelaySettingsView> { return settingsView(await readConfig()); }

export async function getRelayRuntime(): Promise<{ baseUrl: string; apiKey: string; models: RelayModel[]; shopKeys: RelayShopKey[]; usdCnyRate: number | null }> {
  const current = effective(await readConfig());
  return { baseUrl: current.baseUrl, apiKey: current.apiKey, models: current.models, shopKeys: current.shopKeys, usdCnyRate: current.usdCnyRate };
}

async function writeConfig(config: RelayFile) {
  const file = getRelayConfigPath();
  const dir = path.dirname(file);
  const temporary = path.join(dir, `.relay-${randomUUID()}.tmp`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch {
    await unlink(temporary).catch(() => undefined);
    throw new RelayConfigError("中转站配置保存失败，请检查服务端目录权限", 500);
  }
}

function serializeWrite<T>(work: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(work, work);
  writeQueue = next.catch(() => undefined);
  return next;
}

export async function saveRelaySettings(input: unknown): Promise<RelaySettingsView> {
  return serializeWrite(async () => {
    const raw = object(input);
    if (!raw) throw new RelayConfigError("中转站配置必须是 JSON 对象");
    if ((raw.clearKey !== undefined && typeof raw.clearKey !== "boolean") ||
      (raw.clearApiKey !== undefined && typeof raw.clearApiKey !== "boolean")) throw new RelayConfigError("清空密钥选项无效");
    const current = await readConfig();
    const runtime = effective(current);
    let apiKey = current?.apiKey;
    let keyCleared = current?.keyCleared || false;
    if (raw.apiKey !== undefined) {
      if (typeof raw.apiKey !== "string" || raw.apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw.apiKey)) {
        throw new RelayConfigError("API Key 格式无效");
      }
      if (raw.apiKey.trim()) { apiKey = raw.apiKey.trim(); keyCleared = false; }
    }
    if (raw.clearKey === true || raw.clearApiKey === true) { apiKey = undefined; keyCleared = true; }
    if (raw.baseUrl !== undefined && typeof raw.baseUrl !== "string") throw new RelayConfigError("Base URL 必须是文本");
    const baseUrl = normalizeRelayBaseUrl(raw.baseUrl === undefined ? runtime.baseUrl : raw.baseUrl as string);
    await assertPublicRelayUrl(baseUrl);
    const models = raw.models === undefined ? runtime.models : validateModels(raw.models);
    const shopKeys = raw.shopKeys === undefined ? (current?.shopKeys || []) : mergeShopKeyUpdate(current?.shopKeys || [], raw.shopKeys);
    const usdCnyRate = raw.usdCnyRate === undefined ? (current?.usdCnyRate ?? null) : parseUsdCnyRate(raw.usdCnyRate);
    const config: RelayFile = { version: 1, baseUrl, apiKey, keyCleared, models, shopKeys, usdCnyRate, updatedAt: new Date().toISOString() };
    await writeConfig(config);
    return settingsView(config);
  });
}

async function fetchDirectory() {
  const runtime = await getRelayRuntime();
  if (!runtime.apiKey) throw new RelayConfigError("中转站尚未配置 API Key，请先保存凭据", 503);
  const started = Date.now();
  const response = await relayFetch(`${runtime.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${runtime.apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const message = response.status === 401 || response.status === 403 ? "中转站拒绝认证，请检查 API Key 和模型权限" :
      response.status === 404 ? "中转站未提供 /models 接口，请检查 Base URL 是否包含正确 API 路径" :
      response.status === 429 ? "中转站请求受限，请稍后重试" : "中转站模型目录读取失败，请稍后重试";
    throw new RelayConfigError(message, 502);
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2_000_000) { await reader.cancel().catch(() => undefined); throw new RelayConfigError("中转站模型目录响应过大", 502); }
      chunks.push(value);
    }
  }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RelayConfigError("中转站模型目录不是有效 JSON", 502); }
  const list = object(data)?.data;
  if (!Array.isArray(list) || list.length > 2_000) throw new RelayConfigError("中转站模型目录格式不兼容（需要 data 数组）", 502);
  const ids = [...new Set(list.map((item) => object(item)?.id).filter((id): id is string =>
    typeof id === "string" && !!id.trim() && id.length <= 256 && !id.includes(runtime.apiKey) && !/[\s\u0000-\u001f\u007f]/.test(id)))];
  return { ids, latencyMs: Date.now() - started, sourceFingerprint: runtimeFingerprint({ baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, models: runtime.models }) };
}

function runtimeFingerprint(runtime: { baseUrl: string; apiKey: string; models: RelayModel[] }) {
  return createHash("sha256").update(JSON.stringify(runtime)).digest("hex");
}

export async function testRelayConnection() {
  const { ids, latencyMs } = await fetchDirectory();
  return { ok: true, modelCount: ids.length, latencyMs, message: "中转站连接成功，已只读验证模型目录" };
}

export async function syncRelayModels(): Promise<RelaySettingsView & { syncedCount: number }> {
  const { ids, sourceFingerprint } = await fetchDirectory();
  return serializeWrite(async () => {
    const current = await readConfig();
    const runtime = effective(current);
    if (runtimeFingerprint({ baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, models: runtime.models }) !== sourceFingerprint) {
      throw new RelayConfigError("读取模型目录期间配置已变更，请重新同步", 409);
    }
    const models = [...runtime.models];
    const defaults = defaultModels();
    const directIds = new Set(GATEWAY_MODELS.filter((model) => model.provider !== "shaozhuang").map((model) => model.id));
    for (const upstreamModel of ids) {
      if (models.some((model) => model.upstreamModel === upstreamModel)) continue;
      const known = defaults.find((model) => model.upstreamModel === upstreamModel);
      let id = directIds.has(upstreamModel) || models.some((model) => model.id === upstreamModel) ? `relay:${upstreamModel}` : upstreamModel;
      let suffix = 2;
      while (models.some((model) => model.id === id) || directIds.has(id)) id = `relay:${upstreamModel}:${suffix++}`;
      models.push(known ? { ...known, id } : { id, label: upstreamModel, upstreamModel, kind: "unknown", enabled: false });
    }
    if (models.length > 2_000) throw new RelayConfigError("合并后的模型目录超过 2000 个，请先清理停用模型");
    const config: RelayFile = {
      version: 1, baseUrl: runtime.baseUrl, apiKey: current?.apiKey, keyCleared: current?.keyCleared || false,
      models: validateModels(models), shopKeys: current?.shopKeys || [], usdCnyRate: current?.usdCnyRate ?? null,
      updatedAt: new Date().toISOString()
    };
    await writeConfig(config);
    return { ...settingsView(config), syncedCount: ids.length };
  });
}

export function relayManagementError(error: unknown): { message: string; status: number } {
  // Never return raw upstream, filesystem, JSON parser, or generic exception messages.
  if (error instanceof RelayConfigError || error instanceof RelayNetworkError) return { message: error.message, status: error.status };
  return { message: "中转站操作失败，请检查配置后重试", status: 500 };
}
