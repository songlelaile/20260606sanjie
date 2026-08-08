import "server-only";

export type GatewayPlan = {
  code: string;
  name: string;
  description: string;
  priceCents: number;
  creditCents: number;
  badge: string;
  features: string[];
  recommended?: boolean;
};

export type GatewayModel = {
  id: string;
  label: string;
  provider: "openai" | "deepseek" | "dashscope" | "volc" | "zhipu";
  upstreamModel: string;
  kind: "chat" | "image";
  endpoint: "chat.completions" | "images.generations";
  baseUrlEnv: string;
  apiKeyEnv: string;
  defaultBaseUrl: string;
  promptCentsPer1K?: number;
  completionCentsPer1K?: number;
  imageCents?: number;
};

export const GATEWAY_PLANS: GatewayPlan[] = [
  {
    code: "starter",
    name: "体验版",
    description: "适合先把插件和脚本接进统一网关，验证模型稳定性。",
    priceCents: 9900,
    creditCents: 12000,
    badge: "入门",
    features: ["120 元模型额度", "1 个 API Key", "基础文本与图片模型", "人工审核开通"]
  },
  {
    code: "growth",
    name: "增长版",
    description: "适合店铺日常主图提示词、生图和批量链接清单任务。",
    priceCents: 29900,
    creditCents: 38000,
    badge: "推荐",
    recommended: true,
    features: ["380 元模型额度", "5 个 API Key", "多模型自动路由", "调用流水和余额提醒"]
  },
  {
    code: "business",
    name: "团队版",
    description: "适合团队共享网关、集中采购模型额度和插件调用。",
    priceCents: 89900,
    creditCents: 120000,
    badge: "团队",
    features: ["1200 元模型额度", "20 个 API Key", "独立模型策略", "可接企业付款和发票流程"]
  }
];

export const GATEWAY_MODELS: GatewayModel[] = [
  {
    id: "gpt-4o-mini",
    label: "OpenAI GPT-4o mini",
    provider: "openai",
    upstreamModel: "gpt-4o-mini",
    kind: "chat",
    endpoint: "chat.completions",
    baseUrlEnv: "MODEL_GATEWAY_OPENAI_BASE_URL",
    apiKeyEnv: "MODEL_GATEWAY_OPENAI_API_KEY",
    defaultBaseUrl: "https://api.openai.com/v1",
    promptCentsPer1K: 1,
    completionCentsPer1K: 4
  },
  {
    id: "deepseek-chat",
    label: "DeepSeek Chat",
    provider: "deepseek",
    upstreamModel: "deepseek-chat",
    kind: "chat",
    endpoint: "chat.completions",
    baseUrlEnv: "MODEL_GATEWAY_DEEPSEEK_BASE_URL",
    apiKeyEnv: "MODEL_GATEWAY_DEEPSEEK_API_KEY",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    promptCentsPer1K: 1,
    completionCentsPer1K: 2
  },
  {
    id: "qwen-plus",
    label: "通义千问 Plus",
    provider: "dashscope",
    upstreamModel: "qwen-plus",
    kind: "chat",
    endpoint: "chat.completions",
    baseUrlEnv: "MODEL_GATEWAY_DASHSCOPE_BASE_URL",
    apiKeyEnv: "MODEL_GATEWAY_DASHSCOPE_API_KEY",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    promptCentsPer1K: 1,
    completionCentsPer1K: 3
  },
  {
    id: "doubao-seed-evolving",
    label: "豆包 Seed Evolving",
    provider: "volc",
    upstreamModel: "doubao-seed-evolving",
    kind: "chat",
    endpoint: "chat.completions",
    baseUrlEnv: "MODEL_GATEWAY_VOLC_BASE_URL",
    apiKeyEnv: "MODEL_GATEWAY_VOLC_API_KEY",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    promptCentsPer1K: 1,
    completionCentsPer1K: 3
  },
  {
    id: "glm-4.5",
    label: "智谱 GLM",
    provider: "zhipu",
    upstreamModel: "glm-4.5",
    kind: "chat",
    endpoint: "chat.completions",
    baseUrlEnv: "MODEL_GATEWAY_ZHIPU_BASE_URL",
    apiKeyEnv: "MODEL_GATEWAY_ZHIPU_API_KEY",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    promptCentsPer1K: 1,
    completionCentsPer1K: 3
  },
  {
    id: "gpt-image-1",
    label: "OpenAI Image",
    provider: "openai",
    upstreamModel: "gpt-image-1",
    kind: "image",
    endpoint: "images.generations",
    baseUrlEnv: "MODEL_GATEWAY_OPENAI_BASE_URL",
    apiKeyEnv: "MODEL_GATEWAY_OPENAI_API_KEY",
    defaultBaseUrl: "https://api.openai.com/v1",
    imageCents: 80
  },
  {
    id: "doubao-seedream-5-0-260128",
    label: "豆包 Seedream 5.0",
    provider: "volc",
    upstreamModel: "doubao-seedream-5-0-260128",
    kind: "image",
    endpoint: "images.generations",
    baseUrlEnv: "MODEL_GATEWAY_VOLC_BASE_URL",
    apiKeyEnv: "MODEL_GATEWAY_VOLC_API_KEY",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    imageCents: 60
  }
];

export function findGatewayPlan(code: string) {
  return GATEWAY_PLANS.find((plan) => plan.code === code);
}

export function findGatewayModel(model: string, endpoint: GatewayModel["endpoint"]) {
  return GATEWAY_MODELS.find((item) => item.endpoint === endpoint && (item.id === model || item.upstreamModel === model));
}

export function centsToYuan(cents: number) {
  return (cents / 100).toFixed(2);
}
