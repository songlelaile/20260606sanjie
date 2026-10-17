/** Fish's native TTS schema. No SDK defaults or fallback to a paid model are used. */
export const FISH_SPEECH_ENDPOINT = "https://api.fish.audio/v1/tts";
export const FISH_SPEECH_MODELS = ["s1", "s2-pro", "s2.1-pro", "s2.1-pro-free", "drama-3"] as const;
export type FishSpeechModel = typeof FISH_SPEECH_MODELS[number];
export type FishSpeechConfiguration = { endpoint: string; apiKey: string; model: string; referenceId: string };

export function fishSpeechConfigurationIssue(config: Pick<FishSpeechConfiguration, "endpoint" | "model" | "referenceId">): "endpoint" | "model" | "referenceId" | null {
  // An unrecognized model header falls back upstream to a paid model, so refuse it locally.
  if (!(FISH_SPEECH_MODELS as readonly string[]).includes(config.model)) return "model";
  if (config.endpoint !== FISH_SPEECH_ENDPOINT) return "endpoint";
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(config.referenceId)) return "referenceId";
  return null;
}

export function fishSpeechRequest(config: FishSpeechConfiguration, text: string) {
  if (fishSpeechConfigurationIssue(config) || !config.apiKey.trim() || !text.trim()) throw new TypeError("Fish Audio 配音配置或口播文本无效；已阻止供应商默认模型回退。");
  return { endpoint: FISH_SPEECH_ENDPOINT, init: {
    method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", model: config.model },
    body: JSON.stringify({ text, format: "wav", reference_id: config.referenceId })
  } satisfies RequestInit };
}
