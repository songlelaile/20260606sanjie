import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server-session";
import { backfillUserSupplyKeys, listUserSupplyStatus } from "@/lib/model-gateway/user-supply";
import { getSub2ApiProvisioningView, saveSub2ApiProvisionConfig, Sub2ApiProvisionError } from "@/lib/model-gateway/sub2api-provisioner";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";
import { rejectsCrossSiteMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };
const MAX_BATCH_SIZE = 10;
const SAFE_ERROR_CODES = new Set([
  "USER_SUPPLY_STORE_UNAVAILABLE", "USER_SUPPLY_PROVISION_NOT_CONFIGURED", "USER_SUPPLY_PROVISION_FAILED",
  "USER_SUPPLY_PROVISION_PENDING", "USER_SUPPLY_PROVIDER_UNCONFIRMED", "USER_SUPPLY_USER_DISABLED",
  "USER_SUPPLY_DECRYPT_FAILED", "USER_SUPPLY_CREDENTIAL_MISMATCH", "USER_SUPPLY_LIMIT_INVALID"
]);
const CONFIG_ERRORS: Record<string, { message: string; status: number }> = {
  supply_provisioning_invalid_config: { message: "请填写有效配发账号、密码、上游分组和每 Key 额度", status: 400 },
  supply_provisioning_invalid_config_path: { message: "配发账号配置路径无效，请检查服务端配置", status: 503 },
  supply_provisioning_encryption_unconfigured: { message: "配发账号加密尚未配置，请先完成服务端配置", status: 503 },
  supply_provisioning_config_unreadable: { message: "配发账号配置暂不可读取，请检查服务端配置", status: 503 },
  supply_provisioning_config_permissions: { message: "配发账号配置权限无效，请检查服务端配置", status: 503 },
  supply_provisioning_config_corrupt: { message: "配发账号配置无法验证，请检查服务端配置", status: 503 },
  supply_provisioning_config_busy: { message: "配发账号配置正在保存，请稍后重试", status: 409 },
  supply_provisioning_config_unwritable: { message: "配发账号配置暂不可保存，请检查服务端配置", status: 503 }
};

function responseError(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status, headers: PRIVATE_HEADERS });
}

async function adminGuard() {
  const user = await getCurrentUser();
  if (!user) return responseError("未登录", "AUTH_REQUIRED", 401);
  if (user.authRole !== "admin" || user.status !== "active") {
    return responseError("仅启用中的管理员可管理用户供应 Key", "ADMIN_REQUIRED", 403);
  }
  return null;
}

async function provisioningView() {
  const view = await getSub2ApiProvisioningView();
  return safeProvisioningView(view);
}

function safeProvisioningView(view: Awaited<ReturnType<typeof getSub2ApiProvisioningView>>) {
  return {
    configured: view.configured === true,
    missing: view.missing.filter((name) => /^[A-Z][A-Z0-9_]{1,79}$/u.test(name)),
    ...(view.emailMasked ? { emailMasked: view.emailMasked } : {}),
    ...(view.groupId ? { groupId: view.groupId } : {}),
    ...(typeof view.quotaUsd === "number" ? { quotaUsd: view.quotaUsd } : {}),
    baseUrl: "https://sub.shaozhuangai.com"
  };
}

type SupplyStatus = Awaited<ReturnType<typeof listUserSupplyStatus>>[number];

function slotView(slot: SupplyStatus["primary"]) {
  // Project fields explicitly so a future service field cannot expose credentials.
  return slot === null ? null : { id: slot.id, status: slot.status, providerKeyId: slot.providerKeyId };
}

function userView(user: SupplyStatus) {
  return {
    userId: user.userId,
    username: user.username,
    name: user.name,
    accountStatus: user.accountStatus,
    primary: slotView(user.primary),
    backup: slotView(user.backup)
  };
}

function unavailable() {
  return responseError("用户供应 Key 服务暂不可用，请稍后重试", "USER_SUPPLY_UNAVAILABLE", 503);
}

export async function GET() {
  try {
    const denied = await adminGuard();
    if (denied) return denied;
    const [provisioning, users] = await Promise.all([provisioningView(), listUserSupplyStatus()]);
    return NextResponse.json({ data: { provisioning, users: users.map(userView) } }, { headers: PRIVATE_HEADERS });
  } catch {
    return unavailable();
  }
}

export async function POST(request: Request) {
  try {
    const denied = await adminGuard();
    if (denied) return denied;
    if (rejectsCrossSiteMutation(request)) {
      return responseError("跨站操作被拒绝", "CROSS_SITE_REQUEST", 403);
    }
    const body = await readJsonWithLimit(request, 1024);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return responseError("请求必须是有效的 JSON 对象", "INVALID_JSON", 400);
    }
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some((key) => key !== "limit")) {
      return responseError("仅支持批次大小，不能指定用户或凭据", "INVALID_SUPPLY_INPUT", 400);
    }
    const limit = input.limit === undefined ? MAX_BATCH_SIZE : input.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
      return responseError("每批用户数必须是 1 至 10 的整数", "INVALID_SUPPLY_LIMIT", 400);
    }
    const provisioning = await provisioningView();
    if (!provisioning.configured) {
      return responseError("上游 Key 发行服务尚未配置，请先完成服务端配置", "SUPPLY_PROVISIONING_NOT_CONFIGURED", 503);
    }
    const result = await backfillUserSupplyKeys(limit);
    return NextResponse.json({ data: {
      processed: result.processed,
      ready: result.ready,
      failed: result.failed,
      remaining: result.remaining,
      // Provider messages and response payloads never enter this endpoint.
      errors: result.errors.map((entry) => ({ userId: entry.userId,
        code: SAFE_ERROR_CODES.has(entry.code) ? entry.code : "USER_SUPPLY_PROVISION_FAILED" }))
    } }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return responseError("请求不能超过 1 KiB", "REQUEST_TOO_LARGE", 413);
    }
    return unavailable();
  }
}

export async function PUT(request: Request) {
  try {
    const denied = await adminGuard();
    if (denied) return denied;
    if (rejectsCrossSiteMutation(request)) {
      return responseError("跨站操作被拒绝", "CROSS_SITE_REQUEST", 403);
    }
    const body = await readJsonWithLimit(request, 4096);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return responseError("请求必须是有效的 JSON 对象", "INVALID_JSON", 400);
    }
    const input = body as Record<string, unknown>;
    const config = input.config;
    if (Object.keys(input).length !== 1 || config === null || typeof config !== "object" || Array.isArray(config) ||
        !Object.hasOwn(config, "groupId") || !Object.hasOwn(config, "quotaUsd") ||
        Object.keys(config).some((key) => !["email", "password", "groupId", "quotaUsd"].includes(key))) {
      return responseError("请仅提交配发账号、密码、分组和每 Key 额度", "INVALID_SUPPLY_CONFIG", 400);
    }
    const view = await saveSub2ApiProvisionConfig(config);
    return NextResponse.json({ data: safeProvisioningView(view) }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return responseError("配发账号配置请求不能超过 4 KiB", "REQUEST_TOO_LARGE", 413);
    }
    if (error instanceof Sub2ApiProvisionError && Object.hasOwn(CONFIG_ERRORS, error.code)) {
      const safe = CONFIG_ERRORS[error.code];
      return responseError(safe.message, error.code, safe.status);
    }
    return unavailable();
  }
}
