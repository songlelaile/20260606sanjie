import { describe, expect, it } from "vitest";
import {
  AI_PROVIDER_CATALOG,
  getAiProviderPreset,
  isAiProvider,
  resolveAiProviderBaseUrl,
  resolveAiProviderModel
} from "@/lib/ai-provider-catalog";

describe("AI provider catalog", () => {
  it("contains unique presets for every supported OpenAI-compatible provider", () => {
    expect(AI_PROVIDER_CATALOG.map((item) => item.id)).toEqual([
      "shaozhuang",
      "openai",
      "deepseek",
      "doubao",
      "minimax",
      "zhipu",
      "dashscope",
      "custom"
    ]);
    expect(new Set(AI_PROVIDER_CATALOG.map((item) => item.id)).size).toBe(AI_PROVIDER_CATALOG.length);
    expect(AI_PROVIDER_CATALOG.every((item) => item.adapter === "openai-chat")).toBe(true);
  });

  it("keeps the reference plugin Base URLs and default text models", () => {
    expect(getAiProviderPreset("shaozhuang")).toMatchObject({
      baseUrl: "https://sub.shaozhuangai.com/v1",
      model: "chatGPT5.5"
    });
    expect(getAiProviderPreset("openai")).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5-mini"
    });
    expect(getAiProviderPreset("dashscope")).toMatchObject({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus"
    });
  });

  it("canonicalizes hosted aliases only for the official Shaozhuang endpoint", () => {
    expect(resolveAiProviderModel("shaozhuang", "gpt-5.5", "https://sub.shaozhuangai.com/v1"))
      .toBe("chatGPT5.5");
    expect(resolveAiProviderModel("shaozhuang", "chatGPT5.6", "https://sub.shaozhuangai.com/v1"))
      .toBe("chatGPT5.5");
    expect(resolveAiProviderModel("custom", "gpt-5.5", "https://sub.shaozhuangai.com/v1"))
      .toBe("gpt-5.5");
    expect(resolveAiProviderModel("shaozhuang", "gpt-5.5", "https://gateway.example.com/v1"))
      .toBe("gpt-5.5");
  });

  it("fills preset defaults but keeps custom provider values explicit", () => {
    expect(resolveAiProviderBaseUrl("deepseek", "")).toBe("https://api.deepseek.com");
    expect(resolveAiProviderBaseUrl("custom", "")).toBe("");
    expect(resolveAiProviderModel("custom", "", "")).toBe("");
    expect(isAiProvider("gemini")).toBe(false);
    expect(isAiProvider("deepseek")).toBe(true);
  });
});
