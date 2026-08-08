import { AiChatServiceError, requestAiChat } from "@/lib/ai-chat-client";
import { diagnosisJson, requireDiagnosisApiAccess } from "@/lib/diagnosis-route-security";
import { getAiApiRuntimeConfig } from "@/lib/store/runtime-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const unauthorized = await requireDiagnosisApiAccess("credentials");
  if (unauthorized) return unauthorized;

  const config = await getAiApiRuntimeConfig();
  if (!config.hasApiKey || !config.apiKey) {
    return diagnosisJson({ error: "请先保存当前服务商的 API Key" }, { status: 409 });
  }

  try {
    const result = await requestAiChat(config, {
      messages: [
        {
          role: "system",
          content: "这是 API 连通性检查。只回复 OK，不需要任何业务分析。"
        },
        { role: "user", content: "OK" }
      ],
      temperature: 0,
      maxTokens: 8,
      timeoutMs: 15_000,
      maxResponseBytes: 128 * 1024
    });
    return diagnosisJson({
      data: {
        ok: true,
        provider: result.provider,
        model: result.model
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI API 连接测试失败";
    return diagnosisJson(
      { error: message },
      { status: error instanceof AiChatServiceError ? 502 : 500 }
    );
  }
}
