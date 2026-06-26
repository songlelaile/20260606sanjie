import { NextResponse } from "next/server";
import { SESSION_COOKIE, parseSession } from "@/lib/auth";
import { isAccountActive } from "@/lib/accounts";

// 要查库(Prisma)校验账号状态，固定 Node 运行时（Edge 跑不了 Prisma）。
export const runtime = "nodejs";

// 采集插件用来校验「当前是否已登录 shaozhuangai.com」的轻量端点。
// 设计要点：
//  1) 只读会话、验签，不碰 Prisma、不写任何数据 —— 纯读校验。
//  2) 优先读 `x-sanjie-session` 请求头：浏览器扩展跨站请求不会自动带上
//     SameSite=lax 的会话 cookie，所以插件用 chrome.cookies 取到值后放进头里传来。
//     回退读 Cookie 头：站点自身同源调用时照常工作。
//  3) 宽松 CORS：返回的只是「持有该签名令牌者自己的」用户名/租户，需令牌才能拿到，
//     不构成越权泄露；扩展凭 host_permissions 直读响应，CORS 头只是兜底。
//  4) 中间件已放行 /api/auth/*，本端点不会被未登录拦截在前面。

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "x-sanjie-session, content-type",
  "Cache-Control": "no-store"
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

function readCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

// 先按原样验签，失败再 decodeURIComponent 解一层重试。
// 原因：Next 写 cookie 时对值做了一层 encodeURIComponent，站点自身读 cookie 会自动解码，
// 但采集插件用 chrome.cookies 取到的是「编码后的原始值」直接塞进 x-sanjie-session 头，
// 不解这层码签名就对不上 → 401（表现为插件「登录已过期」）。两条路都兼容。
async function resolveSession(rawToken: string | undefined) {
  if (!rawToken) return null;
  const s = await parseSession(rawToken);
  if (s) return s;
  try {
    return await parseSession(decodeURIComponent(rawToken));
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const headerToken = request.headers.get("x-sanjie-session") ?? undefined;
  const value = headerToken || readCookie(request.headers.get("cookie"), SESSION_COOKIE);

  const session = await resolveSession(value);
  if (!session) {
    return NextResponse.json({ error: "未登录" }, { status: 401, headers: CORS });
  }

  // 验签通过后再查账号是否仍有效：被禁用/删除的账号即时锁定（不等会话自然过期）。
  // DB 暂时不可用时 fail-open（放行验签通过的会话），不因基础设施抖动误锁正常用户。
  let active = true;
  try {
    active = await isAccountActive(session.username);
  } catch {
    active = true;
  }
  if (!active) {
    return NextResponse.json({ error: "账号已停用" }, { status: 401, headers: CORS });
  }

  return NextResponse.json(
    {
      data: {
        username: session.username,
        name: session.name,
        role: session.role,
        tenantId: session.tenantId
      }
    },
    { headers: CORS }
  );
}
