import type { RelayModel } from "@/lib/model-gateway/relay-config";

export type RelayShopKeyDraft = {
  shopName: string;
  purpose: "default" | "image";
  apiKey: string;
  clear: boolean;
};

export type RelaySettingsUpdate = {
  baseUrl: string;
  apiKey?: string;
  clearKey: boolean;
  models: RelayModel[];
  shopKeys?: Array<{ shopName: string; purpose: "default" | "image"; apiKey?: string; clear?: boolean }>;
  usdCnyRate?: number | null;
};

export function prepareRelaySettingsUpdate(input: {
  baseUrl: string;
  apiKey: string;
  clearKey: boolean;
  models: RelayModel[];
  usdCnyRate?: string;
  shopKeys?: RelayShopKeyDraft[];
}): { input: RelaySettingsUpdate; error?: never } | { input?: never; error: string } {
  const baseUrl = input.baseUrl.trim();
  if (!baseUrl) return { error: "请填写中转站 Base URL。" };
  const seen = new Set<string>();
  const models = input.models.map((model) => ({
    ...model,
    id: model.id.trim(),
    upstreamModel: model.upstreamModel.trim(),
    label: model.label.trim() || model.id.trim()
  }));
  for (const model of models) {
    if (!model.id || !model.upstreamModel) return { error: "每个模型都需要填写调用模型名和上游模型名。" };
    if (seen.has(model.id)) return { error: `调用模型名 ${model.id} 重复，请使用不同的名称。` };
    seen.add(model.id);
    if (model.enabled && model.kind === "unknown") return { error: `${model.id} 需要先选择模型类型才能启用。` };
    const rates = [model.promptCentsPer1K, model.completionCentsPer1K, model.imageCents, model.videoCents];
    if (rates.some((rate) => rate !== undefined && (!Number.isFinite(rate) || rate < 0))) {
      return { error: `${model.id} 的费率需为有效的非负数字。` };
    }
    if (!model.enabled) continue;
    if (model.kind === "chat" && (!(Number(model.promptCentsPer1K) > 0) || !(Number(model.completionCentsPer1K) > 0))) {
      return { error: `${model.id} 的输入和输出 Token 费率均需大于 0。` };
    }
    if (model.kind === "image" && (!(Number(model.imageCents) > 0) || !Number.isInteger(model.imageCents))) return { error: `${model.id} 的每张图片费率需为大于 0 的整数分。` };
    if (model.kind === "video" && (!(Number(model.videoCents) > 0) || !Number.isInteger(model.videoCents))) return { error: `${model.id} 的每次视频任务费率需为大于 0 的整数分。` };
  }
  const apiKey = input.apiKey.trim();
  let usdCnyRate: number | null | undefined;
  if (input.usdCnyRate !== undefined) {
    const text = input.usdCnyRate.trim();
    if (!text) usdCnyRate = null;
    else {
      const rate = Number(text);
      if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) return { error: "美元汇率需为大于 0 且不超过 1000 的数字。" };
      usdCnyRate = rate;
    }
  }
  let shopKeys: RelaySettingsUpdate["shopKeys"];
  if (input.shopKeys !== undefined) {
    shopKeys = [];
    const seenShops = new Set<string>();
    for (const item of input.shopKeys) {
      const shopName = item.shopName.trim();
      if (!shopName) return { error: "店铺名称不能为空。" };
      const id = `${item.purpose}\n${shopName}`;
      if (seenShops.has(id)) return { error: `店铺「${shopName}」的同一用途重复。` };
      seenShops.add(id);
      const key = item.apiKey.trim();
      shopKeys.push({ shopName, purpose: item.purpose, ...(item.clear ? { clear: true } : {}), ...(!item.clear && key ? { apiKey: key } : {}) });
    }
  }
  return {
    input: {
      baseUrl,
      clearKey: input.clearKey,
      models,
      ...(!input.clearKey && apiKey ? { apiKey } : {}),
      ...(usdCnyRate !== undefined ? { usdCnyRate } : {}),
      ...(shopKeys ? { shopKeys } : {})
    }
  };
}
