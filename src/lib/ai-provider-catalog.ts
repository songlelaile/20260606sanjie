import type { AiProvider } from "@/lib/types/domain";

export type AiProviderAdapter = "openai-chat";

export interface AiProviderPreset {
  id: AiProvider;
  label: string;
  description: string;
  baseUrl: string;
  model: string;
  adapter: AiProviderAdapter;
}

/**
 * 诊断模块共用的文本模型目录。
 *
 * 这些服务商都支持 OpenAI 风格的 /chat/completions。Gemini 使用原生
 * generateContent 协议，不在这里伪装成兼容服务；接入时需要单独适配器。
 */
export const AI_PROVIDER_CATALOG: readonly AiProviderPreset[] = [
  {
    id: "shaozhuang",
    label: "少壮托管 / Auto Mode",
    description: "统一托管网关，预填诊断所需的 Base URL 与文本模型。",
    baseUrl: "https://sub.shaozhuangai.com/v1",
    model: "chatGPT5.5",
    adapter: "openai-chat"
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "OpenAI 直连，使用你的 OpenAI API Key。",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5-mini",
    adapter: "openai-chat"
  },
  {
    id: "deepseek",
    label: "DeepSeek V4",
    description: "DeepSeek 文本模型，适合中文诊断与策略生成。",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    adapter: "openai-chat"
  },
  {
    id: "doubao",
    label: "豆包 / 火山方舟",
    description: "火山方舟 OpenAI 兼容文本接口。",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-evolving",
    adapter: "openai-chat"
  },
  {
    id: "minimax",
    label: "MiniMax",
    description: "MiniMax OpenAI 兼容文本接口。",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M2.1",
    adapter: "openai-chat"
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    description: "智谱 BigModel OpenAI 兼容文本接口。",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-plus",
    adapter: "openai-chat"
  },
  {
    id: "dashscope",
    label: "千问 / DashScope",
    description: "阿里云百炼兼容模式文本接口。",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    adapter: "openai-chat"
  },
  {
    id: "custom",
    label: "自定义兼容网关",
    description: "接入企业网关或其他 OpenAI Chat Completions 兼容服务。",
    baseUrl: "",
    model: "",
    adapter: "openai-chat"
  }
] as const satisfies readonly AiProviderPreset[];

const PROVIDER_IDS = new Set<string>(AI_PROVIDER_CATALOG.map((item) => item.id));
const PROVIDER_PRESETS = new Map<AiProvider, AiProviderPreset>(
  AI_PROVIDER_CATALOG.map((item) => [item.id, item])
);

export const DEFAULT_AI_PROVIDER: AiProvider = "shaozhuang";

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === "string" && PROVIDER_IDS.has(value);
}

export function getAiProviderPreset(provider: AiProvider): AiProviderPreset {
  return PROVIDER_PRESETS.get(provider) ?? PROVIDER_PRESETS.get(DEFAULT_AI_PROVIDER)!;
}

export function getAiProviderLabel(provider: AiProvider): string {
  return getAiProviderPreset(provider).label;
}

export function resolveAiProviderBaseUrl(provider: AiProvider, value: unknown): string {
  const raw = typeof value === "string" ? value.trim().slice(0, 240) : "";
  return raw || getAiProviderPreset(provider).baseUrl;
}

export function resolveAiProviderModel(
  provider: AiProvider,
  value: unknown,
  baseUrl: string
): string {
  const raw = typeof value === "string" ? value.trim().slice(0, 80) : "";
  const model = raw || getAiProviderPreset(provider).model;
  if (!isOfficialShaozhuangTextEndpoint(provider, baseUrl)) return model;

  const hostedAliases: Record<string, string> = {
    "gpt-5.5": "chatGPT5.5",
    "chatgpt5.6": "chatGPT5.5"
  };
  return hostedAliases[model.toLowerCase()] ?? model;
}

export function isOfficialShaozhuangTextEndpoint(provider: AiProvider, baseUrl: string): boolean {
  if (provider !== "shaozhuang") return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "sub.shaozhuangai.com";
  } catch {
    return false;
  }
}
