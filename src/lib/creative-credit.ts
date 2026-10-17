import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { listAvailableGatewayModels } from "@/lib/model-gateway/runtime-catalog";
import { getGatewayBillingSnapshot, listGatewayBillingLedger, safeGatewayBillingError } from "@/lib/model-gateway/billing";
import { applyGatewayBillingCost, centsToPoints, GATEWAY_CENTS_PER_POINT, GATEWAY_MAX_COST_CENTS } from "@/lib/model-gateway/billing-contract";
import type { GatewayModel } from "@/lib/model-gateway/catalog";
import { getGatewayAvailableBalance } from "@/lib/model-gateway/billing-hold";
import type { CreativeCreditModel, CreativeCreditPlan, CreativeCreditsData, CreativeCreditLedgerData } from "@/lib/creative-credit-contract";

function validRate(value: number | undefined, integer = false) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= GATEWAY_MAX_COST_CENTS && (!integer || Number.isSafeInteger(value));
}

/** Explicit whitelist: upstream credentials, URLs and environment-variable names never leave the server. */
export function creativeCreditModelView(model: GatewayModel, plan: CreativeCreditPlan): CreativeCreditModel {
  const view: CreativeCreditModel = {
    id: model.id, label: model.label, provider: model.provider, upstreamModel: model.upstreamModel,
    kind: model.kind, endpoint: model.endpoint, pricingStatus: "unpriced",
    unit: model.kind === "image" ? "image" : model.kind === "video" ? "accepted_task" : "tokens",
    unitCents: null, unitPoints: null, promptPointsPer1K: null, completionPointsPer1K: null
  };
  if (validRate(model.imageCents, true)) view.imageCents = model.imageCents;
  if (validRate(model.videoCents, true) && model.videoCents! > 0) view.videoCents = model.videoCents;
  if (validRate(model.promptCentsPer1K)) view.promptCentsPer1K = model.promptCentsPer1K;
  if (validRate(model.completionCentsPer1K)) view.completionCentsPer1K = model.completionCentsPer1K;
  try {
    if (model.kind === "image" && view.imageCents !== undefined || model.kind === "video" && view.videoCents !== undefined) {
      view.unitCents = applyGatewayBillingCost(model.kind === "image" ? Math.max(1, view.imageCents!) : view.videoCents!, plan);
      view.unitPoints = centsToPoints(view.unitCents);
      view.pricingStatus = "priced";
    } else if (model.kind === "chat" && view.promptCentsPer1K !== undefined && view.completionCentsPer1K !== undefined) {
      // The gateway rounds each input/output component to cents before applying the plan once per call.
      view.promptPointsPer1K = centsToPoints(applyGatewayBillingCost(Math.max(1, Math.ceil(view.promptCentsPer1K)), plan));
      view.completionPointsPer1K = centsToPoints(applyGatewayBillingCost(Math.max(1, Math.ceil(view.completionCentsPer1K)), plan));
      view.pricingStatus = "priced";
    }
  } catch { /* Overflow or invalid plan pricing remains unknown, never a fallback number. */ }
  return view;
}

export async function getCreativeCredits(userId: string): Promise<CreativeCreditsData> {
  // Repeatable read keeps displayed balance/plan/rule coherent without creating or modifying any wallet.
  const account = await prisma.$transaction(async (tx) => {
    const snapshot = await getGatewayBillingSnapshot(userId, tx);
    const wallet = await tx.gatewayWallet.findUnique({ where: { userId }, select: { balanceCents: true } });
    const available = await getGatewayAvailableBalance(tx, userId);
    return {
      wallet: { balanceCents: wallet?.balanceCents ?? 0, balancePoints: centsToPoints(wallet?.balanceCents ?? 0), exists: wallet !== null,
        availableCents: available.availableCents, availablePoints: centsToPoints(available.availableCents),
        reservedCents: available.reservedCents, reservedPoints: centsToPoints(available.reservedCents) },
      plan: { code: snapshot.planCode, name: snapshot.planCode === "free" ? "未购买套餐" : snapshot.planName, multiplierBps: snapshot.multiplierBps, ruleVersion: snapshot.ruleVersion }
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  let models: CreativeCreditModel[] = [];
  let catalogError: string | null = null;
  try { models = (await listAvailableGatewayModels()).map((model) => creativeCreditModelView(model, account.plan)); }
  catch { catalogError = "模型目录暂不可用，请刷新或联系管理员检查模型配置"; }
  return { ...account, models, catalogError, observedAt: new Date().toISOString(), centsPerPoint: GATEWAY_CENTS_PER_POINT };
}

export async function getCreativeCreditLedger(userId: string, page = 1): Promise<CreativeCreditLedgerData> {
  const result = await listGatewayBillingLedger({ userId, page, pageSize: 20, excludeSupplierUsage: true });
  return {
    total: result.total, page: result.page, pageSize: result.pageSize,
    items: result.items.map((row) => ({
      id: row.id, billingEventId: row.billingEventId, kind: row.kind, status: row.status, error: safeGatewayBillingError(row.error), createdAt: row.createdAt,
      planCode: row.planCode, planName: row.planName, multiplierBps: row.multiplierBps, ruleVersion: row.ruleVersion,
      endpoint: row.endpoint, provider: row.provider, model: row.model, requestId: row.requestId,
      deltaCents: row.deltaCents, deltaPoints: centsToPoints(row.deltaCents), baseCostCents: row.baseCostCents,
      chargedCostCents: row.chargedCostCents, chargedPoints: centsToPoints(row.chargedCostCents),
      balanceBeforeCents: row.balanceBeforeCents, balanceBeforePoints: centsToPoints(row.balanceBeforeCents),
      balanceAfterCents: row.balanceAfterCents, balanceAfterPoints: centsToPoints(row.balanceAfterCents),
      promptTokens: row.promptTokens, completionTokens: row.completionTokens, totalTokens: row.totalTokens, imageCount: row.imageCount,
      durationMs: row.durationMs, upstreamStatus: row.upstreamStatus
    }))
  };
}
