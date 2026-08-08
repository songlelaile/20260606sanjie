import "server-only";
import { NextResponse } from "next/server";
import { requireShopScope } from "@/lib/store/runtime-store";
import type { AiProvider } from "@/lib/types/domain";

export type DiagnosisApiAccess = "read" | "write" | "credentials";

export async function requireDiagnosisApiAccess(
  access: DiagnosisApiAccess = "read"
): Promise<NextResponse | null> {
  try {
    // requireShopScope 会用签名会话回查 User.status、tenantId、authRole，
    // 并把 active shop 限制在当前租户店铺集合内。
    const scope = await requireShopScope();
    const role = scope.user.role;
    if (!["owner", "admin", "operator", "viewer"].includes(role)) {
      return diagnosisJson({ error: "账号角色无效，已拒绝访问诊断数据" }, { status: 403 });
    }
    if (access === "write" && !["owner", "admin", "operator"].includes(role)) {
      return diagnosisJson({ error: "当前账号为只读角色，不能修改或生成诊断数据" }, { status: 403 });
    }
    if (access === "credentials" && !scope.isAdmin && !["owner", "admin"].includes(role)) {
      return diagnosisJson({ error: "仅店铺所有者或管理员可以修改 AI 凭据" }, { status: 403 });
    }
    return null;
  } catch {
    return diagnosisJson({ error: "未登录、账号已失效或租户归属已变化" }, { status: 401 });
  }
}

/** 任意兼容网关属于租户自行选择的信任边界，只允许凭据管理员执行。 */
export async function requireAiProviderExecutionAccess(
  provider: AiProvider
): Promise<NextResponse | null> {
  if (provider !== "custom") return null;
  const unauthorized = await requireDiagnosisApiAccess("credentials");
  if (!unauthorized || unauthorized.status === 401) return unauthorized;
  return diagnosisJson(
    { error: "自定义 AI 网关仅限店铺所有者或管理员运行；操作员可使用已配置的预设服务商" },
    { status: 403 }
  );
}

export function diagnosisJson(
  body: unknown,
  init: ResponseInit = {}
): NextResponse {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Vary", "Cookie");
  return NextResponse.json(body, { ...init, headers });
}
