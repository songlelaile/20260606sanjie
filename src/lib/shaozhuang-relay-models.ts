/**
 * 网站对外仍使用 chatGPT5.5 / image2。
 * 发往 sub.shaozhuangai.com 时改写成中转站正在计费的模型名。
 */
export const SHAOZHUANG_RELAY_UPSTREAM = {
  "chatGPT5.5": "gpt-5.6-sol",
  image2: "gpt-image-2"
} as const;

export function shaozhuangRelayUpstream(modelId: string): string | undefined {
  return SHAOZHUANG_RELAY_UPSTREAM[modelId as keyof typeof SHAOZHUANG_RELAY_UPSTREAM];
}
