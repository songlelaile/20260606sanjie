import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { applyGatewayBillingCost, centsToPoints, type GatewayBillingSnapshot } from "./billing-contract";
import { digest, stable, NativeVideoError, nativeTokenCost, nativeTariff, type NativeVideoModel, type NativeVideoTariff, type NativeVideoOwner } from "./native-video-contract";

// This is a fixed site quote for the requested output, not a supplier usage receipt.
// Dimensions and 24 fps are pinned from the official Seedance task documentation.
// Reference-video processing cost remains a supplier cost, separate from this fee.
export const NATIVE_SUBMISSION_PRICE_VERSION = "output_area_quote_v1";
const ratios = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
const dimensions: Record<string, readonly (readonly [number, number])[]> = {
  "480p": [[864,496],[752,560],[640,640],[560,752],[496,864],[992,432]],
  "720p": [[1280,720],[1112,834],[960,960],[834,1112],[720,1280],[1470,630]],
  "1080p": [[1920,1080],[1664,1248],[1440,1440],[1248,1664],[1080,1920],[2206,946]],
  "4k": [[3840,2160],[3326,2494],[2880,2880],[2494,3326],[2160,3840],[4398,1886]],
};
export function nativeSubmissionBaseQuote(model: NativeVideoModel, body: Record<string, unknown>, tariff: NativeVideoTariff) {
  const sizes = dimensions[String(body.resolution)];
  const index = ratios.indexOf(String(body.ratio));
  if (!sizes || (index < 0 && body.ratio !== "adaptive") || !model.durations.includes(Number(body.duration))) {
    throw new NativeVideoError("NATIVE_VIDEO_QUOTE_UNAVAILABLE", "当前视频规格没有明确报价，请调整规格", 503);
  }
  let pixels = index >= 0 ? sizes[index][0] * sizes[index][1] : Math.max(...sizes.map(([w,h]) => w*h));
  if (model.id === "seedance-2.5" && body.resolution === "480p" && (index === 0 || index === 4)) pixels = 854 * 480;
  const quoteTokens = Math.ceil(pixels * 24 * Number(body.duration) / 1024);
  return Math.max(1, nativeTokenCost(quoteTokens, tariff));
}
export function nativeModelSubmissionQuotes(model: NativeVideoModel, snapshot: GatewayBillingSnapshot) {
  return model.durations.flatMap(duration => model.resolutions.flatMap(resolution => model.ratios.flatMap(ratio => [false,true].map(hasVideoInput => {
    const body = { duration, resolution, ratio, content: hasVideoInput ? [{ type:"video_url" }] : [] };
    const quoteCents = applyGatewayBillingCost(nativeSubmissionBaseQuote(model,body,nativeTariff(model,body)),snapshot);
    return { duration, resolution, ratio, hasVideoInput, quoteCents, quotePoints:centsToPoints(quoteCents) };
  }))));
}
function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new NativeVideoError("NATIVE_VIDEO_QUOTE_UNAVAILABLE", "视频报价服务暂不可用", 503);
  return secret;
}
function signature(payload: string) { return createHmac("sha256", key()).update("native-submission-quote-v1:" + payload).digest("base64url"); }
function quoteBinding(owner: NativeVideoOwner, fingerprint: string, tariff: NativeVideoTariff, snapshot: GatewayBillingSnapshot, quoteCents: number) {
  return { userId: owner.id, tenantId: owner.tenantId, requestFingerprint: fingerprint, priceVersion: NATIVE_SUBMISSION_PRICE_VERSION,
    tariffHash: digest(stable(tariff)), ruleVersion: snapshot.ruleVersion, multiplierBps: snapshot.multiplierBps, quoteCents };
}
export function issueNativeSubmissionQuote(owner: NativeVideoOwner, fingerprint: string, tariff: NativeVideoTariff, snapshot: GatewayBillingSnapshot, baseQuoteCents: number) {
  const quoteCents = applyGatewayBillingCost(baseQuoteCents, snapshot);
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const payload = Buffer.from(JSON.stringify({ ...quoteBinding(owner, fingerprint, tariff, snapshot, quoteCents), expiresAt })).toString("base64url");
  return { billingMode: "prepaid_quote" as const, quoteCents, quotePoints: centsToPoints(quoteCents), quoteToken: payload + "." + signature(payload),
    expiresAt, refundOnFailure: true, refundOnCancel: false, adjustmentOnSuccess: false };
}
export function verifyNativeSubmissionQuote(raw: unknown, owner: NativeVideoOwner, fingerprint: string, tariff: NativeVideoTariff, snapshot: GatewayBillingSnapshot, quoteCents: number) {
  if (raw === undefined) return; // Server/API callers receive the same deterministic quote at submission.
  const invalid = () => { throw new NativeVideoError("NATIVE_VIDEO_QUOTE_CHANGED", "本次报价已变化或过期，请重新查看报价后生成", 409); };
  if (typeof raw !== "string" || raw.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw)) return invalid();
  const [payload, mac] = raw.split(".");
  const expectedMac = Buffer.from(signature(payload));
  const suppliedMac = Buffer.from(mac);
  if (expectedMac.length !== suppliedMac.length || !timingSafeEqual(expectedMac, suppliedMac)) return invalid();
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(Buffer.from(payload,"base64url").toString("utf8")); } catch { return invalid(); }
  const { expiresAt, ...binding } = parsed;
  if (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) < Date.now() ||
      Date.parse(expiresAt) > Date.now() + 5 * 60_000 || stable(binding) !== stable(quoteBinding(owner,fingerprint,tariff,snapshot,quoteCents))) return invalid();
}
