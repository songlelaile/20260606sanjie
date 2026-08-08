// 认证 + 角色权限配置（纯配置，不依赖 next/headers 与 Prisma，
// client、server 与中间件 edge 运行时均可安全引用）。
// 账号已落库（见 src/lib/accounts.ts）；本文件仅负责会话编解码与路由权限。

export type Role = "tenant" | "admin";

export const SESSION_COOKIE = "sanjie_session";
export const ACTIVE_SHOP_COOKIE = "sanjie_active_shop";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

export interface Session {
  username: string;
  role: Role;
  name: string;
  /** 所属租户，用于多租户数据隔离。 */
  tenantId: string;
}

interface SignedSessionClaims extends Session {
  iat: number;
  exp: number;
}

/** 每个角色登录后的默认首页。 */
export const ROLE_HOME: Record<Role, string> = {
  tenant: "/dashboards/operating-network",
  admin: "/dashboards/operating-network"
};

/** 每个角色可访问的页面路由前缀。 */
const ROLE_ALLOWED_PREFIXES: Record<Role, string[]> = {
  // 租户版：运营日常（看板 + 数据导入 + 预填写 + 采集工具）
  tenant: ["/dashboards", "/imports", "/prefill", "/tools", "/models"],
  // 管理版：在租户版全部功能之上，额外多一个「管理」（及管理后台/版本留痕）。
  admin: ["/dashboards", "/imports", "/prefill", "/tools", "/models", "/management", "/admin", "/versions"]
};

export function canAccess(role: Role, pathname: string): boolean {
  if (pathname === "/") {
    return true;
  }
  return ROLE_ALLOWED_PREFIXES[role].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

// ───── 会话 cookie 完整性保护（HMAC-SHA256 签名）─────
// cookie 形如 `<hex签名>.<URL编码的JSON>`：签名用服务端密钥对 payload 计算，
// parseSession 先验签再信任，验签失败一律当未登录（杜绝伪造 role/tenantId 越权）。
// 用 Web Crypto，client / server / 中间件 edge 运行时均可用；仅在调用时执行，不在模块加载期跑。
// ⚠️ 生产必须设置 SESSION_SECRET 环境变量；缺省的开发回退值是公开的，等于无保护。
const DEV_FALLBACK_SECRET = "sanjie-dev-insecure-secret-change-me";
const SESSION_SECRET = process.env.SESSION_SECRET ?? DEV_FALLBACK_SECRET;

const sessionEncoder = new TextEncoder();
let hmacKeyPromise: Promise<CryptoKey> | null = null;

function getHmacKey(): Promise<CryptoKey> {
  if (!hmacKeyPromise) {
    // 生产环境必须显式配置一个高强度 SESSION_SECRET。若缺省回落到上面这个公开默认值，
    // 任何人都能伪造任意 role/tenantId 的有效会话（同时击穿网站登录与采集插件门槛）——
    // 直接 fail-fast，宁可启动即报错也不带病运行。
    // 仅在服务端检查：客户端 bundle 里 process.env.SESSION_SECRET 必为 undefined，不能据此抛错。
    if (
      typeof window === "undefined" &&
      process.env.NODE_ENV === "production" &&
      (SESSION_SECRET === DEV_FALLBACK_SECRET ||
        SESSION_SECRET.length < 32 ||
        SESSION_SECRET.toLowerCase().startsWith("change-me-"))
    ) {
      throw new Error(
        "SESSION_SECRET 未配置：生产环境必须设置一个高强度随机值（openssl rand -hex 32），否则会话可被伪造。"
      );
    }
    hmacKeyPromise = crypto.subtle.importKey(
      "raw",
      sessionEncoder.encode(SESSION_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
  }
  return hmacKeyPromise;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function signPayload(payload: string): Promise<string> {
  const key = await getHmacKey();
  const sig = await crypto.subtle.sign("HMAC", key, sessionEncoder.encode(payload));
  return toHex(sig);
}

/** 定长常量时间比较，避免签名校验泄露时序信息。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 旧版签名 cookie 没有 iat/exp。仅在部署方显式配置迁移截止时间且尚未到期时兼容；
 * 支持 Unix 秒、Unix 毫秒或 ISO 8601，非法值按未配置处理。
 */
function legacySessionAcceptUntilSeconds(): number | null {
  const raw = process.env.LEGACY_SESSION_ACCEPT_UNTIL?.trim();
  if (!raw) {
    return null;
  }

  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    // 当前 Unix 毫秒为 13 位；低于 1e12 的正数按 Unix 秒解释。
    return Math.floor(numeric >= 1_000_000_000_000 ? numeric / 1000 : numeric);
  }

  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

function hasValidSessionIdentity(
  claims: Partial<SignedSessionClaims>
): claims is Partial<SignedSessionClaims> & Pick<Session, "username" | "role" | "tenantId"> {
  return (
    (claims.role === "tenant" || claims.role === "admin") &&
    typeof claims.username === "string" &&
    claims.username.trim().length > 0 &&
    typeof claims.tenantId === "string" &&
    claims.tenantId.trim().length > 0
  );
}

export async function serializeSession(session: Session): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims: SignedSessionClaims = {
    ...session,
    iat: issuedAt,
    exp: issuedAt + SESSION_MAX_AGE_SECONDS
  };
  const payload = encodeURIComponent(JSON.stringify(claims));
  const sig = await signPayload(payload);
  return `${sig}.${payload}`;
}

export async function parseSession(value: string | undefined): Promise<Session | null> {
  if (!value) {
    return null;
  }
  const dot = value.indexOf(".");
  // 无分隔符 = 旧的无签名明文 cookie → 硬切，直接当未登录。
  if (dot <= 0) {
    return null;
  }
  const sig = value.slice(0, dot);
  const payload = value.slice(dot + 1);
  let expected: string;
  try {
    expected = await signPayload(payload);
  } catch {
    return null;
  }
  // 验签失败（被篡改 / 旧 cookie / 密钥轮换）→ 一律当未登录。
  if (!timingSafeEqual(sig, expected)) {
    return null;
  }
  try {
    const parsed = JSON.parse(decodeURIComponent(payload)) as Partial<SignedSessionClaims>;
    const now = Math.floor(Date.now() / 1000);
    const validLifetime =
      Number.isInteger(parsed.iat) &&
      Number.isInteger(parsed.exp) &&
      (parsed.iat as number) <= now + 300 &&
      (parsed.exp as number) > now &&
      (parsed.exp as number) > (parsed.iat as number) &&
      (parsed.exp as number) - (parsed.iat as number) <= SESSION_MAX_AGE_SECONDS;
    const legacyAcceptUntil = legacySessionAcceptUntilSeconds();
    const validLegacyLifetime =
      parsed.iat === undefined &&
      parsed.exp === undefined &&
      legacyAcceptUntil !== null &&
      legacyAcceptUntil > now;
    if (hasValidSessionIdentity(parsed) && (validLifetime || validLegacyLifetime)) {
      return {
        username: parsed.username,
        role: parsed.role,
        name: parsed.name ?? parsed.username,
        tenantId: parsed.tenantId
      };
    }
    return null;
  } catch {
    return null;
  }
}
