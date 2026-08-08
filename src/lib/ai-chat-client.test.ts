import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postJsonToSafeAiEndpoint: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai-endpoint", () => ({
  postJsonToSafeAiEndpoint: mocks.postJsonToSafeAiEndpoint
}));

import {
  AiChatServiceError,
  buildAiChatCompletionsUrl,
  isAiChatTimeoutError,
  requestAiChat
} from "@/lib/ai-chat-client";

describe("unified AI chat client", () => {
  beforeEach(() => {
    mocks.postJsonToSafeAiEndpoint.mockReset();
  });

  it("uses the pinned transport, canonical hosted model and one chat completions suffix", async () => {
    mocks.postJsonToSafeAiEndpoint.mockResolvedValue({
      ok: true,
      status: 200,
      payload: { choices: [{ message: { content: "  诊断完成  " } }] }
    });

    const result = await requestAiChat(
      {
        provider: "shaozhuang",
        baseUrl: "https://sub.shaozhuangai.com/v1/",
        model: "gpt-5.5",
        apiKey: "secret-key"
      },
      {
        messages: [{ role: "user", content: "分析" }],
        temperature: 0.2,
        maxTokens: 200
      }
    );

    expect(result).toEqual({ content: "诊断完成", provider: "shaozhuang", model: "chatGPT5.5" });
    const [endpoint, input] = mocks.postJsonToSafeAiEndpoint.mock.calls[0];
    expect(endpoint).toBe("https://sub.shaozhuangai.com/v1/chat/completions");
    expect(input.headers.authorization).toBe("Bearer secret-key");
    expect(JSON.parse(input.body)).toMatchObject({
      model: "chatGPT5.5",
      messages: [{ role: "user", content: "分析" }],
      temperature: 0.2,
      max_tokens: 200
    });
  });

  it("never exposes an untrusted upstream error body that echoes the saved key", async () => {
    mocks.postJsonToSafeAiEndpoint.mockResolvedValue({
      ok: false,
      status: 401,
      payload: { error: { message: "Authorization Bearer secret-key" } }
    });

    const promise = requestAiChat(
      {
        provider: "custom",
        baseUrl: "https://gateway.example.com/v1",
        model: "model-a",
        apiKey: "secret-key"
      },
      { messages: [{ role: "user", content: "test" }] }
    );
    await expect(promise).rejects.toMatchObject({
      message: "AI 服务鉴权失败，请检查 API Key 与账号权限",
      kind: "upstream",
      upstreamStatus: 401
    });
    await expect(promise).rejects.not.toThrow(/secret-key/);
  });

  it("blocks a successful model response that echoes the saved credential", async () => {
    mocks.postJsonToSafeAiEndpoint.mockResolvedValue({
      ok: true,
      status: 200,
      payload: { choices: [{ message: { content: "Authorization Bearer secret-key" } }] }
    });

    const promise = requestAiChat(
      {
        provider: "custom",
        baseUrl: "https://gateway.example.com/v1",
        model: "model-a",
        apiKey: "secret-key"
      },
      { messages: [{ role: "user", content: "test" }] }
    );
    await expect(promise).rejects.toMatchObject({
      kind: "invalid-response",
      message: expect.stringContaining("已阻止展示")
    });
    await expect(promise).rejects.not.toThrow(/secret-key/);
  });

  it("maps timeouts and empty responses to safe service errors", async () => {
    const timeout = new Error("socket details");
    timeout.name = "TimeoutError";
    mocks.postJsonToSafeAiEndpoint.mockRejectedValueOnce(timeout);
    await expect(requestAiChat(
      { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini", apiKey: "key" },
      { messages: [{ role: "user", content: "test" }] }
    )).rejects.toMatchObject({ kind: "timeout", message: "AI 服务响应超时，请稍后重试" });

    const aborted = new Error("request aborted");
    aborted.name = "AbortError";
    mocks.postJsonToSafeAiEndpoint.mockRejectedValueOnce(aborted);
    await expect(requestAiChat(
      { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini", apiKey: "key" },
      { messages: [{ role: "user", content: "test" }] }
    )).rejects.toMatchObject({ kind: "timeout", message: "AI 服务响应超时，请稍后重试" });

    mocks.postJsonToSafeAiEndpoint.mockResolvedValueOnce({ ok: true, status: 200, payload: { choices: [] } });
    await expect(requestAiChat(
      { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini", apiKey: "key" },
      { messages: [{ role: "user", content: "test" }] }
    )).rejects.toBeInstanceOf(AiChatServiceError);
  });

  it("normalizes endpoint paths and drops query credentials", () => {
    expect(buildAiChatCompletionsUrl("https://api.example.com/v1/chat/completions"))
      .toBe("https://api.example.com/v1/chat/completions");
    expect(buildAiChatCompletionsUrl("https://api.example.com/v1/?api_key=unsafe#part"))
      .toBe("https://api.example.com/v1/chat/completions");
  });

  it("distinguishes local and upstream timeout failures from other upstream errors", () => {
    expect(isAiChatTimeoutError(new AiChatServiceError("local", "timeout"))).toBe(true);
    expect(isAiChatTimeoutError(new AiChatServiceError("gateway", "upstream", 504))).toBe(true);
    expect(isAiChatTimeoutError(new AiChatServiceError("server", "upstream", 500))).toBe(false);
    expect(isAiChatTimeoutError(new Error("timeout text only"))).toBe(false);
  });
});
