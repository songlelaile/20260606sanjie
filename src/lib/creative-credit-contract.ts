import { applyGatewayBillingCost, centsToPoints, GATEWAY_MAX_COST_CENTS } from "@/lib/model-gateway/billing-contract";

/** A display contract only. Reading or calculating this data never executes or charges a model. */
export type CreativeCreditChannel = "external_key" | "platform_wallet" | "preview" | "local";
export type CreativeCreditModel = {
  id: string;
  label: string;
  provider: string;
  upstreamModel: string;
  kind: "chat" | "image" | "video";
  endpoint: "chat.completions" | "images.generations" | "videos";
  imageCents?: number;
  videoCents?: number;
  promptCentsPer1K?: number;
  completionCentsPer1K?: number;
  unitCents: number | null;
  unitPoints: number | null;
  promptPointsPer1K: number | null;
  completionPointsPer1K: number | null;
  pricingStatus: "priced" | "unpriced";
  unit: "image" | "accepted_task" | "tokens";
};

export type CreativeCreditPlan = { code: string; name: string; multiplierBps: number; ruleVersion: number };
export type CreativeCreditsData = {
  wallet: { balanceCents: number; balancePoints: number; exists: boolean };
  plan: CreativeCreditPlan;
  models: CreativeCreditModel[];
  catalogError: string | null;
  observedAt: string;
  centsPerPoint: number;
};

export type CreativeCreditLedgerItem = {
  id: string;
  billingEventId: string;
  kind: string;
  status: string;
  error: string;
  createdAt: string;
  planCode: string;
  planName: string;
  multiplierBps: number;
  ruleVersion: number;
  endpoint: string;
  provider: string;
  model: string;
  requestId: string;
  deltaCents: number;
  deltaPoints: number;
  baseCostCents: number;
  chargedCostCents: number;
  chargedPoints: number;
  balanceBeforeCents: number;
  balanceBeforePoints: number;
  balanceAfterCents: number;
  balanceAfterPoints: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  imageCount: number;
  durationMs: number | null;
  upstreamStatus: number | null;
};
export type CreativeCreditLedgerData = { items: CreativeCreditLedgerItem[]; total: number; page: number; pageSize: number };

export type CreativeCreditRequest = { imageCount?: number; promptTokens?: number; completionTokens?: number };
export type CreativeCreditEstimate = {
  channel: CreativeCreditChannel;
  priceStatus: "exact" | "estimated" | "unknown";
  points: number | null;
  platformPoints: number | null;
  charged: false;
  note: string;
};

function configuredFee(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= GATEWAY_MAX_COST_CENTS;
}

/** Sum after each request's rounding, matching the gateway's per-call settlement. */
export function estimateCreativeCreditRequests(channel: CreativeCreditChannel, model: CreativeCreditModel | undefined, requests: CreativeCreditRequest[], plan: CreativeCreditPlan): CreativeCreditEstimate {
  if (channel === "local") return { channel, priceStatus: "exact", points: 0, platformPoints: 0, charged: false, note: "本机操作，不扣积分" };
  if (channel === "external_key") return { channel, priceStatus: "exact", points: 0, platformPoints: 0, charged: false, note: "本站不扣积分，费用由所配置服务商计收" };
  const unknown = (note: string): CreativeCreditEstimate => ({ channel, priceStatus: "unknown", points: null, platformPoints: channel === "preview" ? 0 : null, charged: false, note });
  if (!model || model.pricingStatus !== "priced") return unknown("当前模型尚无可信价格");
  if (!Array.isArray(requests) || requests.length > 1000) return unknown("请求数量无效");
  let cents = 0;
  try {
    for (const request of requests) {
      let base: number;
      if (model.kind === "image") {
        const count = request.imageCount ?? 1;
        if (!Number.isSafeInteger(count) || count < 1 || count > 10 || !configuredFee(model.imageCents) || !Number.isSafeInteger(model.imageCents)) return unknown("图片数量或模型费率尚未确认");
        base = Math.max(1, count * model.imageCents!);
      } else if (model.kind === "video") {
        if (!configuredFee(model.videoCents) || model.videoCents! <= 0 || !Number.isSafeInteger(model.videoCents)) return unknown("视频任务费率尚未确认");
        base = model.videoCents!; // Fixed fee per accepted task, never seconds or polling.
      } else {
        if (!configuredFee(model.promptCentsPer1K) || !configuredFee(model.completionCentsPer1K)) return unknown("文本模型费率尚未确认");
        if (!Number.isSafeInteger(request.promptTokens) || Number(request.promptTokens) < 0 || !Number.isSafeInteger(request.completionTokens) || Number(request.completionTokens) < 0) return unknown("文本/视觉分析按实际 token 结算，当前无法确定用量");
        base = Math.max(1, Math.ceil(Number(request.promptTokens) / 1000 * model.promptCentsPer1K!) + Math.ceil(Number(request.completionTokens) / 1000 * model.completionCentsPer1K!));
      }
      cents += applyGatewayBillingCost(base, plan);
      if (!Number.isSafeInteger(cents)) return unknown("累计价格超过计算范围");
    }
  } catch { return unknown("价格或套餐倍率暂不可用"); }
  const points = centsToPoints(cents);
  return {
    channel, priceStatus: channel === "preview" || model.kind === "chat" ? "estimated" : "exact", points,
    platformPoints: channel === "preview" ? 0 : points, charged: false,
    note: channel === "preview" ? "演示估算，不执行模型、不扣积分" : model.kind === "chat" ? "按预估 token 计算，实际以单次调用结算为准" : "按当前套餐与模型费率估价，成功调用后结算"
  };
}
