import "server-only";
import { postJsonToSafeAiEndpoint } from "@/lib/ai-endpoint";
import { resolveAiProviderModel } from "@/lib/ai-provider-catalog";
import type { AiProvider } from "@/lib/types/domain";

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiChatRuntimeConfig {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

export interface AiChatRequest {
  messages: AiChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface AiChatResult {
  content: string;
  provider: AiProvider;
  model: string;
}

export class AiChatServiceError extends Error {
  readonly kind: "config" | "timeout" | "network" | "upstream" | "invalid-response";
  readonly upstreamStatus: number | null;

  constructor(
    message: string,
    kind: AiChatServiceError["kind"],
    upstreamStatus: number | null = null
  ) {
    super(message);
    this.name = "AiChatServiceError";
    this.kind = kind;
    this.upstreamStatus = upstreamStatus;
  }
}

export function isAiChatTimeoutError(error: unknown): error is AiChatServiceError {
  return (
    error instanceof AiChatServiceError &&
    (error.kind === "timeout" || error.upstreamStatus === 408 || error.upstreamStatus === 504)
  );
}

interface ChatCompletionPayload {
  choices?: Array<{
    message?: { content?: string };
    text?: string;
  }>;
  output_text?: string;
  error?: unknown;
}

/** 所有诊断 AI 请求都从这里出站，避免各路由各自处理 Key、端点和错误正文。 */
export async function requestAiChat(
  config: AiChatRuntimeConfig,
  request: AiChatRequest
): Promise<AiChatResult> {
  const apiKey = config.apiKey?.trim() ?? "";
  const baseUrl = config.baseUrl.trim();
  const model = resolveAiProviderModel(config.provider, config.model, baseUrl);
  if (!apiKey) throw new AiChatServiceError("AI API Key 尚未保存", "config");
  if (!baseUrl) throw new AiChatServiceError("AI Base URL 尚未配置", "config");
  if (!model) throw new AiChatServiceError("AI 模型名称尚未配置", "config");
  if (request.messages.length === 0) {
    throw new AiChatServiceError("AI 请求缺少消息内容", "config");
  }

  try {
    const response = await postJsonToSafeAiEndpoint<ChatCompletionPayload>(
      buildAiChatCompletionsUrl(baseUrl),
      {
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages: request.messages,
          ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
          ...(typeof request.maxTokens === "number" ? { max_tokens: request.maxTokens } : {})
        }),
        timeoutMs: request.timeoutMs,
        maxResponseBytes: request.maxResponseBytes
      }
    );

    if (!response.ok) {
      // 不透传不可信上游的错误正文。自定义端点可能故意把 Authorization 回显在正文中。
      throw new AiChatServiceError(
        mapUpstreamStatusToMessage(response.status),
        "upstream",
        response.status
      );
    }
    const content = extractAiContent(response.payload);
    if (!content) {
      throw new AiChatServiceError("AI 服务没有返回可展示的文本内容", "invalid-response", response.status);
    }
    if (containsCredentialEcho(content, apiKey)) {
      throw new AiChatServiceError(
        "AI 服务返回内容包含凭据特征，已阻止展示；请检查所配置的模型服务",
        "invalid-response",
        response.status
      );
    }
    return { content, provider: config.provider, model };
  } catch (error) {
    if (error instanceof AiChatServiceError) throw error;
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" ||
        error.name === "AbortError" ||
        (error as NodeJS.ErrnoException).code === "ABORT_ERR")
    ) {
      throw new AiChatServiceError("AI 服务响应超时，请稍后重试", "timeout");
    }
    if (error instanceof Error && isSafeTransportMessage(error.message)) {
      throw new AiChatServiceError(error.message, "network");
    }
    throw new AiChatServiceError("无法连接 AI 服务，请检查 Base URL、网络与服务状态", "network");
  }
}

export function buildAiChatCompletionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  const pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/chat/completions")) {
    url.pathname = `${pathname}/chat/completions`.replace(/^\/?/, "/");
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

function extractAiContent(payload: ChatCompletionPayload | null): string {
  return (
    payload?.choices?.[0]?.message?.content?.trim() ||
    payload?.choices?.[0]?.text?.trim() ||
    payload?.output_text?.trim() ||
    ""
  );
}

function mapUpstreamStatusToMessage(status: number): string {
  if (status === 401 || status === 403) return "AI 服务鉴权失败，请检查 API Key 与账号权限";
  if (status === 404) return "AI 服务地址或模型不存在，请检查 Base URL 与模型名称";
  if (status === 408 || status === 504) return "AI 服务响应超时，请稍后重试";
  if (status === 429) return "AI 服务请求过于频繁或额度不足，请稍后重试";
  if (status >= 500) return "AI 服务暂时不可用，请稍后重试";
  return `AI 服务拒绝了本次请求（HTTP ${status}）`;
}

function isSafeTransportMessage(message: string): boolean {
  return (
    message.startsWith("AI Base URL") ||
    message.startsWith("AI 服务响应超过") ||
    message.startsWith("AI Base URL 解析到了")
  );
}

function containsCredentialEcho(content: string, apiKey: string): boolean {
  const variants = new Set([
    apiKey,
    `Bearer ${apiKey}`,
    encodeURIComponent(apiKey),
    Buffer.from(apiKey, "utf8").toString("base64")
  ]);
  return [...variants].some((value) => value.length > 0 && content.includes(value));
}
