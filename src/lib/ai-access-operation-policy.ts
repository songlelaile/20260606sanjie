export type AiAccessOperationScope = "read" | "action";

export const AI_ACCESS_OPERATION_CATALOG = [
  { action: "account.read", method: "GET", path: "/api/auth/me", requiredScope: "read", label: "读取授权账号身份" },
  { action: "creative.access.read", method: "GET", path: "/api/auth/creative-access", requiredScope: "read", label: "读取创作工作台权限" },
  { action: "shops.list", method: "GET", path: "/api/shops", requiredScope: "read", label: "读取可见店铺及 AI 当前店铺" },
  { action: "models.list", method: "GET", path: "/api/v1/models", requiredScope: "read", label: "读取可用模型目录" },
  { action: "dmp.reports.list", method: "GET", path: "/api/dmp-reports", requiredScope: "read", label: "读取 AI 当前店铺的报告列表" },
  { action: "dmp.report.read", method: "GET", path: "/api/dmp-reports?id=REPORT_ID", requiredScope: "read", label: "读取 AI 当前店铺的单份报告" },
  { action: "shops.activate", method: "PATCH", path: "/api/shops/active", requiredScope: "action", label: "切换此 AI 授权的当前店铺" }
] as const;

type ReadOperation = { method: "GET"; requiredScope: "read"; body?: never };
type SimpleReadAction = "account.read" | "creative.access.read" | "shops.list" | "models.list";
export type AiAccessOperation = { path: string } & (
  | (ReadOperation & { action: SimpleReadAction; query?: never })
  | (ReadOperation & { action: "dmp.reports.list"; query: { page: number; pageSize: number } })
  | (ReadOperation & { action: "dmp.report.read"; query: { id: string } })
  | { action: "shops.activate"; method: "PATCH"; requiredScope: "action"; body: { shopId: string }; query?: never }
);

export type AiAccessOperationResult =
  | { allowed: true; operation: AiAccessOperation }
  | { allowed: false; status: 400 | 403; code: "INVALID_AI_OPERATION" | "AI_OPERATION_NOT_ALLOWED" | "AI_SCOPE_REQUIRED"; error: string };

function invalid(): AiAccessOperationResult {
  return { allowed: false, status: 400, code: "INVALID_AI_OPERATION", error: "操作参数无效，请按授权操作目录提供 method、path 和必要的 body" };
}

function forbidden(): AiAccessOperationResult {
  return { allowed: false, status: 403, code: "AI_OPERATION_NOT_ALLOWED", error: "该操作不在 AI 授权目录内" };
}

function plainObject(input: unknown): input is Record<string, unknown> {
  return Boolean(input && typeof input === "object" && !Array.isArray(input) &&
    (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null));
}

/** Classifies only the explicit catalog. Callers dispatch by action; path is never a proxy target. */
export function resolveAiAccessOperation(input: unknown): AiAccessOperationResult {
  if (!plainObject(input) || Object.keys(input).some(key => !["method", "path", "body"].includes(key)) ||
      typeof input.method !== "string" || !/^[A-Z]{3,10}$/.test(input.method) ||
      typeof input.path !== "string" || input.path.length > 512 ||
      !/^\/[A-Za-z0-9_/?=&-]+$/.test(input.path) || input.path.includes("//")) return invalid();

  const pathParts = input.path.split("?");
  if (pathParts.length > 2 || (pathParts.length === 2 && !pathParts[1])) return invalid();
  const pathname = pathParts[0];
  const rawQuery = pathParts[1];
  const query = new Map<string, string>();
  if (rawQuery) {
    for (const item of rawQuery.split("&")) {
      const match = /^([A-Za-z][A-Za-z0-9]*)=([A-Za-z0-9_-]+)$/.exec(item);
      if (!match || query.has(match[1])) return invalid();
      query.set(match[1], match[2]);
    }
  }

  if (input.method === "PATCH" && pathname === "/api/shops/active") {
    if (query.size || !plainObject(input.body) || Object.keys(input.body).length !== 1 || !Object.hasOwn(input.body, "shopId") ||
        typeof input.body.shopId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(input.body.shopId)) return invalid();
    return { allowed: true, operation: { action: "shops.activate", method: "PATCH", path: pathname, requiredScope: "action", body: { shopId: input.body.shopId } } };
  }
  if (input.method !== "GET") return forbidden();
  if (Object.hasOwn(input, "body")) return invalid();

  if (pathname === "/api/dmp-reports") {
    if ([...query.keys()].some(key => !["id", "page", "pageSize"].includes(key))) return invalid();
    const id = query.get("id");
    if (id) {
      if (query.size !== 1 || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) return invalid();
      return { allowed: true, operation: { action: "dmp.report.read", method: "GET", path: `${pathname}?id=${id}`, requiredScope: "read", query: { id } } };
    }
    const page = query.get("page") ?? "1";
    const pageSize = query.get("pageSize") ?? "24";
    if (!/^[1-9]\d{0,6}$/.test(page) || Number(page) > 1_000_000 || !/^[1-9]\d?$/.test(pageSize) || Number(pageSize) > 50) return invalid();
    return { allowed: true, operation: { action: "dmp.reports.list", method: "GET", path: `${pathname}?page=${page}&pageSize=${pageSize}`, requiredScope: "read", query: { page: Number(page), pageSize: Number(pageSize) } } };
  }

  if (query.size) return invalid();
  const readActions: Readonly<Record<string, SimpleReadAction>> = {
    "/api/auth/me": "account.read",
    "/api/auth/creative-access": "creative.access.read",
    "/api/shops": "shops.list",
    "/api/v1/models": "models.list"
  };
  const action = readActions[pathname];
  if (!action) return forbidden();
  return { allowed: true, operation: { action, method: "GET", path: pathname, requiredScope: "read" } };
}

/** An action grant includes catalog reads; neither grant permits unlisted operations. */
export function evaluateAiAccessOperation(input: unknown, scope: AiAccessOperationScope): AiAccessOperationResult {
  const result = resolveAiAccessOperation(input);
  if (!result.allowed) return result;
  if ((scope !== "read" && scope !== "action") || (result.operation.requiredScope === "action" && scope !== "action")) {
    return { allowed: false, status: 403, code: "AI_SCOPE_REQUIRED", error: "该 AI 授权没有此操作权限" };
  }
  return result;
}
