import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { GATEWAY_MAX_COST_CENTS } from "./billing-contract";
import { isPublicRelayAddress } from "./relay-network";

export const NATIVE_VIDEO_ENDPOINT = "seedance.tasks";
export const NATIVE_VIDEO_PATH = "/api/creative/native-video";
export class NativeVideoError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export type NativeVideoOwner = { id: string; tenantId: string; username: string };
export type NativeVideoPriceTier = { resolution: string; hasVideoInput: boolean; completionCentsPerMillion: number };
export type NativeVideoModel = {
  id: string; label: string; upstreamModel: string; priceVersion: string;
  completionCentsPerMillion?: number; priceTiers?: NativeVideoPriceTier[]; reservationCents: number;
  durations: number[]; resolutions: string[]; ratios: string[]; generateAudio: boolean;
  mediaHosts: string[];
};
export type NativeVideoConfig = { enabled: boolean; bindingId: string; models: NativeVideoModel[] };
export type NativeVideoTariff = { priceVersion: string; completionCentsPerMillion: number; reservationCents: number; mediaHosts: string[] };
export function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function token(value: unknown, max = 160) { return typeof value === "string" && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value); }
function positive(value: unknown) { return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= GATEWAY_MAX_COST_CENTS; }
function publicHost(host: string) {
  return host.length <= 253 && !/(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host) &&
    (isIP(host) ? isPublicRelayAddress(host) : /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(host));
}
function configError(): never { throw new NativeVideoError("NATIVE_VIDEO_CONFIG_INVALID", "平台视频供应或价格配置不完整", 503); }

/** No inferred supplier, model, tariff, reservation amount, or model capabilities. */
export function parseNativeVideoConfig(raw: string | undefined, tiered = false): NativeVideoConfig {
  if (!raw) return { enabled: false, bindingId: "", models: [] };
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return configError(); }
  if (!plain(data) || typeof data.enabled !== "boolean" || !token(data.bindingId)) return configError();
  if (!Array.isArray(data.models) || data.models.length > 20 || (data.enabled && !data.models.length)) return configError();
  const seen = new Set<string>();
  const models = data.models.map((value): NativeVideoModel => {
    if (!plain(value) || !["seedance-2.0", "seedance-2.5", "seedance-2.0-mini"].includes(String(value.id)) || !token(value.upstreamModel, 220) || !token(value.priceVersion) ||
      typeof value.label !== "string" || !value.label.trim() || value.label.length > 120 ||
      (!tiered && !positive(value.completionCentsPerMillion)) || !positive(value.reservationCents) || typeof value.generateAudio !== "boolean" ||
      !Array.isArray(value.durations) || !value.durations.length || value.durations.some(v => !Number.isInteger(v) || Number(v) < 1 || Number(v) > 120) ||
      !Array.isArray(value.resolutions) || !value.resolutions.length || value.resolutions.some(v => typeof v !== "string" || (!/^[0-9]{3,4}p$/.test(v) && !(tiered && v === "4k"))) ||
      !Array.isArray(value.ratios) || !value.ratios.length || value.ratios.some(v => typeof v !== "string" || (!/^[1-9][0-9]?:[1-9][0-9]?$/.test(v) && !(tiered && v === "adaptive"))) ||
      !Array.isArray(value.mediaHosts) || !value.mediaHosts.length || value.mediaHosts.some(v => typeof v !== "string" || !publicHost(v) || v !== v.toLowerCase())) return configError();
    if (seen.has(value.id as string)) return configError();
    seen.add(value.id as string);
    // Mini is verified for direct Ark only; a legacy scalar/opaque relay cannot
    // inherit its official model ID, limits or resolution/reference tariffs.
    if (value.id === "seedance-2.0-mini" && !tiered) return configError();
    let priceTiers: NativeVideoPriceTier[] | undefined;
    if (tiered) {
      const is25 = value.id === "seedance-2.5";
      const isMini = value.id === "seedance-2.0-mini";
      const resolutions = value.resolutions as string[];
      const bounds = isMini ? ["480p", "720p"] : is25 ? ["480p", "720p", "1080p"] : ["480p", "720p", "1080p", "4k"];
      const upstreamModel = ({ "seedance-2.0": "doubao-seedance-2-0-260128", "seedance-2.5": "doubao-seedance-2-5-260628",
        "seedance-2.0-mini": "doubao-seedance-2-0-mini-260615" } as Record<string, string>)[String(value.id)];
      // This release has evidence for these three official model IDs only. An
      // opaque endpoint or unknown model cannot inherit their capabilities/price tiers.
      if (value.upstreamModel !== upstreamModel || resolutions.some(v => !bounds.includes(v)) ||
          value.durations.some(v => Number(v) < 4 || Number(v) > (is25 ? 30 : 15)) ||
          value.ratios.some(v => !["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"].includes(String(v)))) return configError();
      // Ark prices vary by output resolution and the presence of reference video.
      // Every enabled request combination must have exactly one explicit tariff.
      if (value.completionCentsPerMillion !== undefined || !Array.isArray(value.priceTiers) || value.priceTiers.length !== value.resolutions.length * 2 ||
          new Set(value.resolutions).size !== value.resolutions.length) return configError();
      const tiers = new Set<string>();
      priceTiers = value.priceTiers.map((tier): NativeVideoPriceTier => {
        if (!plain(tier) || Object.keys(tier).some(k => !["resolution", "hasVideoInput", "completionCentsPerMillion"].includes(k)) ||
            typeof tier.resolution !== "string" || !resolutions.includes(tier.resolution) ||
            typeof tier.hasVideoInput !== "boolean" || !positive(tier.completionCentsPerMillion)) return configError();
        const key = `${tier.resolution}:${tier.hasVideoInput}`;
        if (tiers.has(key)) return configError();
        tiers.add(key);
        return { resolution: tier.resolution, hasVideoInput: tier.hasVideoInput, completionCentsPerMillion: Number(tier.completionCentsPerMillion) };
      });
    } else if (value.priceTiers !== undefined) return configError();
    return {
      id: value.id as string, label: value.label.trim(), upstreamModel: value.upstreamModel as string,
      priceVersion: value.priceVersion as string, ...(priceTiers ? { priceTiers } : { completionCentsPerMillion: Number(value.completionCentsPerMillion) }), reservationCents: Number(value.reservationCents),
      durations: value.durations as number[], resolutions: value.resolutions as string[], ratios: value.ratios as string[],
      generateAudio: value.generateAudio, mediaHosts: value.mediaHosts as string[]
    };
  });
  return { enabled: data.enabled, bindingId: data.bindingId as string, models };
}
export function nativeTariff(model: NativeVideoModel, body?: Record<string, unknown>): NativeVideoTariff {
  let price = model.completionCentsPerMillion;
  if (model.priceTiers) {
    const hasVideoInput = Array.isArray(body?.content) && body.content.some(item => plain(item) && item.type === "video_url");
    const matching = model.priceTiers.filter(tier => tier.resolution === body?.resolution && tier.hasVideoInput === hasVideoInput);
    if (matching.length !== 1) return configError();
    price = matching[0].completionCentsPerMillion;
  }
  if (!positive(price)) return configError();
  return { priceVersion: model.priceVersion, completionCentsPerMillion: Number(price), reservationCents: model.reservationCents, mediaHosts: [...model.mediaHosts] };
}
export function nativeTokenCost(tokens: number, tariff: NativeVideoTariff) {
  if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > GATEWAY_MAX_COST_CENTS || !positive(tariff.completionCentsPerMillion)) {
    throw new NativeVideoError("NATIVE_VIDEO_USAGE_INVALID", "视频完成回执缺少可核验的输出用量", 502);
  }
  const cents = (BigInt(tokens) * BigInt(tariff.completionCentsPerMillion) + 999999n) / 1000000n;
  if (cents > BigInt(GATEWAY_MAX_COST_CENTS)) throw new NativeVideoError("NATIVE_VIDEO_COST_OVERFLOW", "视频结算金额超出允许范围，请联系管理员核对", 409);
  return Number(cents);
}
export function safeVideoUrl(value: unknown, hosts: string[]): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && (!url.port || url.port === "443") &&
      publicHost(url.hostname) && hosts.includes(url.hostname) ? url.toString() : null;
  } catch { return null; }
}
export function nativeTaskId(value: unknown): value is string { return token(value, 200); }
export function validateNativeRequest(body: Record<string, unknown>, model: NativeVideoModel, trustedAssetUris: ReadonlySet<string> = new Set()) {
  const allowed = new Set(["expectedAccount", "model", "content", "duration", "resolution", "ratio", "generate_audio", "omni_reference_task_type", "output_format"]);
  if (Object.keys(body).some(key => !allowed.has(key)) || !model.durations.includes(Number(body.duration)) || typeof body.duration !== "number" ||
    !model.resolutions.includes(String(body.resolution)) || !model.ratios.includes(String(body.ratio)) ||
    typeof body.generate_audio !== "boolean" || (body.generate_audio && !model.generateAudio) ||
    (body.omni_reference_task_type !== undefined && body.omni_reference_task_type !== "reference") ||
    (body.output_format !== undefined && body.output_format !== "mp4") ||
    !Array.isArray(body.content) || !body.content.length || body.content.length > 20) {
    throw new NativeVideoError("NATIVE_VIDEO_REQUEST_INVALID", "视频参数不在平台开通范围内");
  }
  let hasText = false;
  const ark = !!model.priceTiers;
  const counts = { image_url: 0, video_url: 0, audio_url: 0, first_frame: 0, last_frame: 0 };
  for (const item of body.content) {
    if (!plain(item)) throw new NativeVideoError("NATIVE_VIDEO_REQUEST_INVALID", "视频素材格式无效");
    if (item.type === "text") {
      if (Object.keys(item).some(k => !["type", "text"].includes(k)) || typeof item.text !== "string" || !item.text.trim() || item.text.length > 50000) throw new NativeVideoError("NATIVE_VIDEO_REQUEST_INVALID", "视频提示词无效");
      hasText = true; continue;
    }
    const type = String(item.type);
    const role = ({ image_url: "reference_image", video_url: "reference_video", audio_url: "reference_audio" } as Record<string, string>)[type];
    const asset = item[type];
    const frame = ark && type === "image_url" && (item.role === "first_frame" || item.role === "last_frame");
    if (!role || (!frame && item.role !== role) || Object.keys(item).some(k => !["type", "role", type].includes(k)) || !plain(asset) ||
      Object.keys(asset).some(k => k !== "url") || typeof asset.url !== "string") throw new NativeVideoError("NATIVE_VIDEO_REQUEST_INVALID", "视频素材格式无效");
    counts[type as "image_url" | "video_url" | "audio_url"]++;
    if (frame) counts[item.role as "first_frame" | "last_frame"]++;
    const raw = asset.url;
    // The platform credential is shared. Opaque provider asset IDs have no
    // tenant ownership mapping here, so knowledge of an ID is not authority.
    if (raw.startsWith("asset://")) {
      if (type !== "image_url" || !trustedAssetUris.has(raw)) throw new NativeVideoError("NATIVE_VIDEO_ASSET_UNSUPPORTED", "平台视频暂不接受未绑定当前账号的供应商素材编号");
      continue;
    }
    if (raw.startsWith("data:")) {
      const matched = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(raw);
      const mime = matched?.[1] || ""; const encoded = matched?.[2] || "";
      const mimeAllowed = type === "image_url" ? /^image\/(?:png|jpeg|webp)$/.test(mime)
        : type === "audio_url" && /^audio\/(?:mpeg|mp3|wav)$/.test(mime);
      const limit = type === "audio_url" ? 15 * 1024 * 1024 : 30 * 1024 * 1024;
      if (!mimeAllowed || !encoded || encoded.length % 4 !== 0 || encoded.length > Math.ceil(limit / 3) * 4) {
        throw new NativeVideoError("NATIVE_VIDEO_REQUEST_INVALID", "内嵌素材类型、编码或大小无效");
      }
      const bytes = Buffer.from(encoded, "base64");
      if (!bytes.length || bytes.length >= limit || bytes.toString("base64") !== encoded) throw new NativeVideoError("NATIVE_VIDEO_REQUEST_INVALID", "内嵌素材编码或大小无效");
      continue;
    }
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") || !publicHost(url.hostname)) throw new Error();
    } catch { throw new NativeVideoError("NATIVE_VIDEO_REQUEST_INVALID", "视频素材必须使用有效的 HTTPS 或平台素材引用"); }
  }
  if (!hasText) throw new NativeVideoError("NATIVE_VIDEO_REQUEST_INVALID", "视频创建需要非空提示词");
  if (ark) {
    const is25 = model.id === "seedance-2.5";
    if (counts.first_frame > 1 || counts.last_frame > 1 || (counts.last_frame && !counts.first_frame) ||
        (is25 && (counts.first_frame || counts.last_frame) && body.ratio !== "adaptive") ||
        (!is25 && counts.audio_url > 0 && counts.image_url === 0 && counts.video_url === 0) ||
        counts.image_url > (is25 ? 30 : 9) || counts.video_url > (is25 ? 10 : 3) || counts.audio_url > (is25 ? 10 : 3) ||
        counts.image_url + counts.video_url + counts.audio_url > (is25 ? 50 : 15)) {
      throw new NativeVideoError("NATIVE_VIDEO_REQUEST_INVALID", "素材数量、首尾帧比例或音频参考不符合当前模型范围");
    }
  }
  const { expectedAccount: _account, ...providerBody } = body;
  return { ...providerBody, model: model.upstreamModel };
}
