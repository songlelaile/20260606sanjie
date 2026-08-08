import { getAiApiConfig, updateAiApiConfig } from "@/lib/store/runtime-store";
import type { AiProvider } from "@/lib/types/domain";
import { isSafeAiEndpointUrl } from "@/lib/ai-endpoint";
import {
  isAiProvider,
  resolveAiProviderBaseUrl,
  resolveAiProviderModel
} from "@/lib/ai-provider-catalog";
import { diagnosisJson, requireDiagnosisApiAccess } from "@/lib/diagnosis-route-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const unauthorized = await requireDiagnosisApiAccess();
  if (unauthorized) return unauthorized;
  const config = await getAiApiConfig();
  return diagnosisJson({
    data: {
      config: {
        ...config,
        apiKeyHint: config.hasApiKey ? "已保存" : "",
        updatedBy: ""
      }
    }
  });
}

export async function PATCH(request: Request) {
  const unauthorized = await requireDiagnosisApiAccess("credentials");
  if (unauthorized) return unauthorized;
  const current = await getAiApiConfig();
  const body = (await request.json().catch(() => null)) as
    | {
        provider?: string;
        baseUrl?: string;
        model?: string;
        enabled?: boolean;
        apiKey?: string;
        clearApiKey?: boolean;
      }
    | null;

  const provider = normalizeProvider(body?.provider);
  const rawBaseUrl = normalizeString(body?.baseUrl, 240);
  const rawModel = normalizeString(body?.model, 80);
  const baseUrl = provider ? resolveAiProviderBaseUrl(provider, rawBaseUrl) : rawBaseUrl;
  const model = provider ? resolveAiProviderModel(provider, rawModel, baseUrl) : rawModel;
  const apiKey = normalizeString(body?.apiKey, 1024);
  const enabled = Boolean(body?.enabled);
  const clearApiKey = Boolean(body?.clearApiKey);
  const credentialScopeChanged = Boolean(
    provider &&
      current.hasApiKey &&
      (provider !== current.provider ||
        normalizeEndpoint(baseUrl) !== normalizeEndpoint(current.baseUrl))
  );
  const errors: string[] = [];

  if (!provider) {
    errors.push("请选择 AI 服务商");
  }
  if (provider === "custom" && !baseUrl) {
    errors.push("自定义服务需要填写 Base URL");
  }
  if (baseUrl && !isSafeAiEndpointUrl(baseUrl)) {
    errors.push("Base URL 只支持公开的 HTTPS 地址，不能指向本机或内网");
  }
  if (baseUrl && hasQueryOrHash(baseUrl)) {
    errors.push("Base URL 不能包含查询参数或片段；API Key 请单独保存在 Key 输入框");
  }
  if (!model) {
    errors.push("请填写模型名称");
  }
  if (enabled && !apiKey && (clearApiKey || !current.hasApiKey)) {
    errors.push("启用 AI API 前需要先填写 API Key");
  }
  if (credentialScopeChanged && !apiKey && !clearApiKey) {
    errors.push("服务商或 Base URL 已变化；为防止旧 Key 泄露，请重新填写对应 API Key");
  }
  if (errors.length > 0 || !provider) {
    return diagnosisJson({ error: errors.join("；") || "AI API 配置不合法" }, { status: 400 });
  }

  const config = await updateAiApiConfig({
    provider,
    baseUrl,
    model,
    enabled,
    apiKey,
    clearApiKey
  });
  return diagnosisJson({ data: { config } });
}

function normalizeProvider(value: unknown): AiProvider | null {
  return isAiProvider(value) ? value : null;
}

function normalizeString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeEndpoint(value: string) {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function hasQueryOrHash(value: string) {
  try {
    const url = new URL(value);
    return Boolean(url.search || url.hash);
  } catch {
    return false;
  }
}
