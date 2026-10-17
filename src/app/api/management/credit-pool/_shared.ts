import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server-session";
import { GatewayBillingError } from "@/lib/model-gateway/billing-contract";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";
import { rejectsCrossSiteMutation } from "@/lib/request-security";
export const CREDIT_POOL_HEADERS = { "Cache-Control": "private, no-store" };
export async function creditPoolAdminGuard(): Promise<{ adminId: string } | { response: NextResponse }> {
  const user = await getCurrentUser();
  if (!user) return { response: NextResponse.json({ error: "未登录", code: "AUTH_REQUIRED" }, { status: 401, headers: CREDIT_POOL_HEADERS }) };
  if (user.authRole !== "admin" || user.status !== "active") return { response: NextResponse.json({ error: "仅启用中的平台管理员可核对总积分池", code: "ADMIN_REQUIRED" }, { status: 403, headers: CREDIT_POOL_HEADERS }) };
  return { adminId: user.id };
}
const SAFE_MESSAGES: Record<string, string> = {
  HOLD_PRICE_UNPROVEN: "存在价格依据尚未核实的任务；仍可查看余额，分配需先完成账务核验",
  ALLOCATION_WINDOW_REQUIRED: "请先完成一次分配额度核验，建立本次 50% 分配上限",
  ALLOCATION_WINDOW_EXHAUSTED: "自上次成功核验后的累计新增分配已达到 50% 上限，请重新核验分配额度",
  GIFT_PLAN_CONFLICT: "预设赠送标识或内容不一致，请核对原记录",
  GIFT_PLAN_EXPIRY_INVALID: "预设赠送截止时间需在未来 30 天内",
  GIFT_PLAN_INACTIVE: "预设赠送已取消或超过截止时间",
  GIFT_PLAN_COMPLETED: "预设赠送已完成，请核对原赠送记录",
  GIFT_PLAN_NOT_FOUND: "预设赠送不存在或不属于当前管理员",
  INVALID_GIFT_INPUT: "请提交有效的赠送账号、积分、理由和请求标识",
  INVALID_GIFT_POINTS: "赠送积分必须为正数，最多一位小数",
  INVALID_GIFT_REASON: "赠送理由需为 2 至 500 字",
  INVALID_GIFT_REQUEST_KEY: "赠送请求标识无效",
  ACCOUNT_UNAVAILABLE: "赠送账号不存在或已停用",
  POOL_INPUT_INVALID: "请提交有效的来源或方案引用，不能填写预算或验真字段",
  POOL_SOURCE_UNVERIFIED: "上游少壮专属分组额度尚未接通，尚无可核验来源快照",
  POOL_PROPOSAL_NOT_FOUND: "核对方案不存在或不属于当前管理员",
  POOL_PROPOSAL_STALE: "来源、账本或方案已变化，请重新核对",
  POOL_REQUEST_CONFLICT: "此请求标识或方案已用于其他核对操作",
  CREDIT_POOL_NOT_READY: "总积分池来源尚未就绪，当前不能分配积分",
  CREDIT_POOL_INVALID: "总积分池账本或来源状态异常，请核对",
  POOL_ALREADY_INITIALIZED: "总积分池已初始化，请使用同周期刷新流程",
  ADMIN_REQUIRED: "仅启用中的平台管理员可核对总积分池",
  SHARED_SOURCE_NOT_CONFIGURED: "共用钱包额度读取尚未配置，请联系管理员接通来源",
  SHARED_SOURCE_CONFIG_UNAVAILABLE: "共用钱包来源配置暂时不可用",
  SOURCE_TIMEOUT: "上游余额读取超时，本次没有采用新额度",
  BACKING_SHORTFALL: "上游当前余额不足以覆盖已分配积分，已停止新的分配；现有余额保持不变"
};
export function creditPoolErrorResponse(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "核对请求不能超过 4 KiB", code: "REQUEST_TOO_LARGE" }, { status: 413, headers: CREDIT_POOL_HEADERS });
  if (error instanceof GatewayBillingError) return NextResponse.json({ error: SAFE_MESSAGES[error.code] ?? "总积分池来源或会计状态需核对", code: error.code }, { status: error.status, headers: CREDIT_POOL_HEADERS });
  return NextResponse.json({ error: "总积分池核对服务暂时不可用，请稍后重试", code: "CREDIT_POOL_SERVICE_UNAVAILABLE" }, { status: 503, headers: CREDIT_POOL_HEADERS });
}
export async function creditPoolRead(action: (adminId: string) => Promise<unknown>) {
  try { const auth = await creditPoolAdminGuard(); if ("response" in auth) return auth.response;
    return NextResponse.json({ data: await action(auth.adminId) }, { headers: CREDIT_POOL_HEADERS });
  } catch (error) { return creditPoolErrorResponse(error); }
}
export async function creditPoolWrite<T>(request: Request, parse: (input: unknown) => T, action: (adminId: string, input: T) => Promise<unknown>) {
  try { const auth = await creditPoolAdminGuard(); if ("response" in auth) return auth.response;
    if (rejectsCrossSiteMutation(request)) return NextResponse.json({ error: "跨站操作被拒绝", code: "CROSS_SITE_REQUEST" }, { status: 403, headers: CREDIT_POOL_HEADERS });
    const body = await readJsonWithLimit(request, 4096);
    if (body === null) return NextResponse.json({ error: "请提交有效的 JSON 核对信息", code: "INVALID_JSON" }, { status: 400, headers: CREDIT_POOL_HEADERS });
    return NextResponse.json({ data: await action(auth.adminId, parse(body)) }, { headers: CREDIT_POOL_HEADERS });
  } catch (error) { return creditPoolErrorResponse(error); }
}
