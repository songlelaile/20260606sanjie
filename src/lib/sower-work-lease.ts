import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  loadSowerWorkAccountAccess, requireSowerWorkAccess, SowerWorkAccessError,
  type SowerWorkAccess
} from "@/lib/sower-work-entitlements";
import {
  SOWER_WORK_EXTENSION_ID, SOWER_WORK_LEASE_SECONDS, SOWER_WORK_PRODUCT_ID,
  SOWER_WORK_VERSION
} from "@/lib/sower-work-product";

export const sowerWorkBindingSchema = z.object({
  productId: z.literal(SOWER_WORK_PRODUCT_ID),
  extensionId: z.literal(SOWER_WORK_EXTENSION_ID),
  releaseVersion: z.literal(SOWER_WORK_VERSION),
  clientId: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
  runId: z.string().uuid(),
  challenge: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export const sowerWorkVerificationSchema = sowerWorkBindingSchema.extend({
  lease: z.string().min(64).max(4096)
}).strict();
const accountSchema = z.object({
  id: z.string().min(1).max(128),
  username: z.string().min(1).max(128),
  tenantId: z.string().min(1).max(128)
}).strict();
const claimsSchema = sowerWorkBindingSchema.extend({
  account: accountSchema,
  revision: z.string().min(1).max(256),
  jti: z.string().uuid(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive()
}).strict();
export type SowerWorkBinding = z.infer<typeof sowerWorkBindingSchema>;
type Claims = z.infer<typeof claimsSchema>;
const PREFIX = "swc1";
function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32 || secret.toLowerCase().startsWith("change-me-") ||
      secret === "sanjie-dev-insecure-secret-change-me") {
    throw new SowerWorkAccessError(503, "LEASE_SIGNING_UNAVAILABLE", "授权签名服务未就绪");
  }
  // Domain separation prevents a session-cookie MAC from serving as a lease.
  return createHmac("sha256", secret).update("sanjie:sower-work-collector:lease:v1").digest();
}
function sign(input: string) { return createHmac("sha256", key()).update(input).digest(); }
export function parseSowerWorkBinding(value: unknown): SowerWorkBinding {
  const result = sowerWorkBindingSchema.safeParse(value);
  if (!result.success) throw new SowerWorkAccessError(400, "INVALID_BINDING", "插件版本或采集绑定参数无效");
  return result.data;
}
export function issueSowerWorkLease(
  binding: SowerWorkBinding,
  loaded: { access: SowerWorkAccess; revision: string },
  now = Date.now()
) {
  requireSowerWorkAccess(loaded.access);
  if (!loaded.revision.startsWith("SOWER_COLLECTOR_GRANT_V1:")) {
    throw new SowerWorkAccessError(403, "ADMIN_GRANT_REQUIRED", "请联系管理员重新开通 Sower Work");
  }
  const iat = Math.floor(now / 1000);
  const exp = Math.min(iat + SOWER_WORK_LEASE_SECONDS,
    Math.floor(Date.parse(loaded.access.entitlement.expiresAt ?? "") / 1000));
  if (!Number.isSafeInteger(exp) || exp <= iat) {
    throw new SowerWorkAccessError(403, "ENTITLEMENT_EXPIRED", "Sower Work 授权已到期");
  }
  const claims: Claims = {
    ...parseSowerWorkBinding(binding), account: loaded.access.account,
    revision: loaded.revision, jti: randomUUID(), iat, exp
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = PREFIX + "." + payload;
  return { lease: input + "." + sign(input).toString("base64url"), expiresAt: new Date(exp * 1000).toISOString() };
}
function readClaims(lease: string, binding: SowerWorkBinding, now: number): Claims {
  if (typeof lease !== "string" || lease.length > 4096) throw invalidLease();
  const parts = lease.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX ||
      !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) throw invalidLease();
  const actual = Buffer.from(parts[2], "base64url");
  const expected = sign(parts[0] + "." + parts[1]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected) ||
      actual.toString("base64url") !== parts[2]) throw invalidLease();
  let parsed: unknown;
  try {
    const bytes = Buffer.from(parts[1], "base64url");
    if (bytes.toString("base64url") !== parts[1]) throw invalidLease();
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch { throw invalidLease(); }
  const result = claimsSchema.safeParse(parsed);
  if (!result.success) throw invalidLease();
  const claims = result.data;
  const seconds = Math.floor(now / 1000);
  if (claims.iat > seconds || claims.exp <= seconds || claims.exp <= claims.iat ||
      claims.exp - claims.iat > SOWER_WORK_LEASE_SECONDS) throw invalidLease();
  for (const field of Object.keys(binding) as (keyof SowerWorkBinding)[]) {
    if (claims[field] !== binding[field]) {
      throw new SowerWorkAccessError(403, "LEASE_BINDING_MISMATCH", "授权凭证与本次采集不匹配");
    }
  }
  return claims;
}
function invalidLease() {
  return new SowerWorkAccessError(401, "LEASE_INVALID", "授权凭证无效或已过期，请重新检查官网授权");
}
export async function verifySowerWorkLease(lease: string, binding: SowerWorkBinding, now = Date.now()) {
  const claims = readClaims(lease, parseSowerWorkBinding(binding), now);
  // No cached positive decision: every packet checks revocation and account state.
  const loaded = await loadSowerWorkAccountAccess(claims.account, new Date(now));
  requireSowerWorkAccess(loaded.access);
  if (loaded.revision !== claims.revision) {
    throw new SowerWorkAccessError(403, "LEASE_GRANT_CHANGED", "授权已变更，请重新检查官网授权");
  }
  const accountKey = "user:" + loaded.access.account.username;
  if (!/^user:[\w@.+:-]{1,120}$/.test(accountKey)) {
    throw new SowerWorkAccessError(403, "ARCHIVE_ACCOUNT_UNSUPPORTED", "当前账号名称不兼容原件档案，请联系管理员处理");
  }
  return {
    ...loaded.access, ...binding, accountKey,
    expiresAt: new Date(claims.exp * 1000).toISOString()
  };
}
