import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/server-session";
import {
  GatewayBillingError,
  GATEWAY_MIN_MULTIPLIER_BPS,
  GATEWAY_MAX_MULTIPLIER_BPS,
  type GatewayBillingQuery,
  type GatewayBillingLedgerQuery,
  type UpdateGatewayBillingRuleInput
} from "@/lib/model-gateway/billing-contract";

export const BILLING_PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

export async function gatewayBillingAdminGuard(): Promise<{ adminId: string } | { response: NextResponse }> {
  const user = await getCurrentUser();
  if (!user) {
    return { response: NextResponse.json({ error: "未登录", code: "AUTH_REQUIRED" }, { status: 401, headers: BILLING_PRIVATE_HEADERS }) };
  }
  if (user.authRole !== "admin" || user.status !== "active") {
    return { response: NextResponse.json({ error: "仅启用中的管理员可管理网关扣费", code: "ADMIN_REQUIRED" }, { status: 403, headers: BILLING_PRIVATE_HEADERS }) };
  }
  return { adminId: user.id };
}

export function gatewayBillingErrorResponse(error: unknown) {
  if (error instanceof GatewayBillingError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: BILLING_PRIVATE_HEADERS });
  }
  return NextResponse.json({ error: "网关扣费服务暂时不可用，请稍后重试", code: "BILLING_SERVICE_UNAVAILABLE" }, { status: 503, headers: BILLING_PRIVATE_HEADERS });
}

const noControls = /^[^\u0000-\u001f\u007f]*$/u;
const updateSchema = z.object({
  planCode: z.string().trim().min(1).max(80).regex(noControls),
  multiplierBps: z.number().int().min(GATEWAY_MIN_MULTIPLIER_BPS).max(GATEWAY_MAX_MULTIPLIER_BPS),
  reason: z.string().trim().min(2).max(500).regex(noControls),
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
}).strict();

export function parseGatewayBillingRuleInput(input: unknown): UpdateGatewayBillingRuleInput {
  const result = updateSchema.safeParse(input);
  if (!result.success) {
    throw new GatewayBillingError("INVALID_RULE", "请填写有效套餐、扣费倍率、修改理由和当前版本；倍率为 100 至 1000000 的整数，理由为 2 至 500 字符");
  }
  return result.data;
}

function singleParam(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1) throw new GatewayBillingError("INVALID_QUERY", `${name} 参数不能重复`);
  return values[0];
}

function textParam(params: URLSearchParams, name: string, maxLength: number): string | undefined {
  const value = singleParam(params, name)?.trim();
  if (!value) return undefined;
  if (value.length > maxLength || !noControls.test(value)) {
    throw new GatewayBillingError("INVALID_QUERY", `${name} 参数超出长度限制或包含无效字符`);
  }
  return value;
}

function integerParam(params: URLSearchParams, name: string, fallback: number, max: number): number {
  const raw = singleParam(params, name);
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/u.test(raw) || raw.length > 10 || Number(raw) > max) {
    throw new GatewayBillingError("INVALID_QUERY", `${name} 必须是 1 至 ${max} 的整数`);
  }
  return Number(raw);
}

function dateParam(params: URLSearchParams, name: string): string | undefined {
  const value = textParam(params, name, 40);
  if (value === undefined) return undefined;
  if (!z.string().datetime({ offset: true }).safeParse(value).success || !Number.isFinite(Date.parse(value))) {
    throw new GatewayBillingError("INVALID_QUERY", `${name} 必须为带时区的 ISO 日期时间`);
  }
  return new Date(value).toISOString();
}

function commonQuery(params: URLSearchParams): GatewayBillingQuery {
  return {
    tenantId: textParam(params, "tenantId", 120),
    userId: textParam(params, "userId", 120),
    planCode: textParam(params, "planCode", 80),
    search: textParam(params, "search", 120),
    page: integerParam(params, "page", 1, 1_000_000),
    pageSize: integerParam(params, "pageSize", 20, 100)
  };
}

export function parseGatewayBillingAccountsQuery(request: Request): GatewayBillingQuery {
  return commonQuery(new URL(request.url).searchParams);
}

export function parseGatewayBillingLedgerQuery(request: Request): GatewayBillingLedgerQuery {
  const params = new URL(request.url).searchParams;
  const query: GatewayBillingLedgerQuery = {
    ...commonQuery(params),
    model: textParam(params, "model", 160),
    endpoint: textParam(params, "endpoint", 120),
    from: dateParam(params, "from"),
    to: dateParam(params, "to")
  };
  const kind = textParam(params, "kind", 20);
  if (kind !== undefined) {
    if (!["opening", "recharge", "gift", "debit", "error"].includes(kind)) {
      throw new GatewayBillingError("INVALID_QUERY", "kind 只支持 opening、recharge、gift、debit 或 error");
    }
    query.kind = kind as GatewayBillingLedgerQuery["kind"];
  }
  if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) {
    throw new GatewayBillingError("INVALID_QUERY", "开始时间不能晚于结束时间");
  }
  return query;
}
