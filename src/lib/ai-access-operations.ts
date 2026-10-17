import "server-only";
import { prisma } from "@/lib/db";
import { AIAccessError, setAIAccessActiveShop, type AIAccessAuthorization } from "@/lib/ai-access";
import type { AiAccessOperation } from "@/lib/ai-access-operation-policy";
import { getCreativeAccessForSession } from "@/lib/creative-entitlements";
import { getDmpAutomationAccessForSession } from "@/lib/tool-entitlements";
import { getDmpBusinessReport, listDmpBusinessReportSummaries } from "@/lib/ai-access-production-reports";
import { GATEWAY_MODELS } from "@/lib/model-gateway/catalog";

/** Direct services only. No arbitrary proxy, reusable web session or credential forwarding. */
export async function executeAiAccessOperation(operation: AiAccessOperation, authorization: AIAccessAuthorization): Promise<unknown> {
  const session = { username: authorization.username, tenantId: authorization.tenantId, role: "admin" as const, name: authorization.username };
  switch (operation.action) {
    case "account.read":
      return { role: "admin", channel: "ai-access", scope: authorization.scope, activeShopId: authorization.activeShopId };
    case "creative.access.read":
      return { access: await getCreativeAccessForSession(session) };
    case "shops.list": {
      const shops = await prisma.shop.findMany({ where: { tenantId: authorization.tenantId }, select: { id: true, name: true, platform: true }, orderBy: { createdAt: "asc" } });
      return { shops, activeShopId: authorization.activeShopId };
    }
    case "models.list": {
      const models = GATEWAY_MODELS;
      return { models: models.map(({ id, label, kind, provider }) => ({ id, label, kind, provider })) };
    }
    case "shops.activate": {
      const updated = await setAIAccessActiveShop(authorization, operation.body!.shopId);
      return { activeShopId: updated.activeShopId };
    }
    case "dmp.report.read":
    case "dmp.reports.list": {
      if (!authorization.activeShopId) throw new AIAccessError("SHOP_REQUIRED", "请先为该 AI 授权指定店铺", 409);
      const shop = await prisma.shop.findFirst({ where: { id: authorization.activeShopId, tenantId: authorization.tenantId }, select: { id: true } });
      if (!shop) throw new AIAccessError("SHOP_INVALID", "授权中的店铺已不可用", 403);
      const entitlement = await getDmpAutomationAccessForSession(session);
      if (!entitlement.allowed) throw new AIAccessError("DMP_ACCESS_REQUIRED", "当前管理账号没有有效的报告权限", 403);
      const access = { userId: authorization.userId, tenantId: authorization.tenantId };
      if (operation.action === "dmp.report.read") {
        const report = await getDmpBusinessReport(access, operation.query!.id!, shop.id);
        if (!report) throw new AIAccessError("REPORT_NOT_FOUND", "报告不存在或不属于授权店铺", 404);
        return { report };
      }
      const listed = await listDmpBusinessReportSummaries(access, { shopId: shop.id, page: operation.query!.page, pageSize: operation.query!.pageSize });
      return { reports: listed.summaries, pagination: { page: listed.page, pageSize: listed.pageSize, total: listed.total, totalPages: listed.totalPages, hasNext: listed.hasNext } };
    }
  }
}
