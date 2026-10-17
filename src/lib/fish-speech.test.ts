import { describe, expect, it } from "vitest";
import { FISH_SPEECH_ENDPOINT, FISH_SPEECH_MODELS, fishSpeechConfigurationIssue, fishSpeechRequest } from "./fish-speech";

const config = { endpoint: FISH_SPEECH_ENDPOINT, apiKey: "synthetic-fish-key", model: "s2.1-pro-free", referenceId: "confirmed_voice_model_id" };
describe("Fish Audio native TTS request", () => {
  it("pins the official endpoint, sends the exact model header and the confirmed voice reference in the native JSON schema", () => {
    const request = fishSpeechRequest(config, "只朗读这句确认台词🙂");
    expect(request.endpoint).toBe("https://api.fish.audio/v1/tts");
    expect(request.init.headers).toEqual({ Authorization: "Bearer synthetic-fish-key", "Content-Type": "application/json", model: "s2.1-pro-free" });
    expect(JSON.parse(request.init.body)).toEqual({ text: "只朗读这句确认台词🙂", format: "wav", reference_id: "confirmed_voice_model_id" });
    expect(request.init.body).not.toContain('"model"'); expect(request.init.body).not.toContain('"voice"'); expect(request.init.body).not.toContain("response_format");
  });
  it.each(FISH_SPEECH_MODELS)("keeps the explicitly selected supported model %s without defaulting", model => {
    expect(fishSpeechRequest({ ...config, model }, "确认台词").init.headers.model).toBe(model);
  });
  it.each(["", "s2.1-pro-fre", "S2.1-PRO-FREE", "latest", "s2.1-pro-free\r\nmodel:s2.1-pro"])("refuses missing, misspelled, or injected model %j to prevent paid upstream fallback", model => {
    expect(fishSpeechConfigurationIssue({ ...config, model })).toBe("model"); expect(() => fishSpeechRequest({ ...config, model }, "确认台词")).toThrow();
  });
  it.each(["https://api.fish.audio/v1/tts?key=private", "http://api.fish.audio/v1/tts", "https://api.fish.audio.evil.test/v1/tts", "https://api.fish.audio/v1/tts/"])("rejects a changed endpoint %s", endpoint => {
    expect(fishSpeechConfigurationIssue({ ...config, endpoint })).toBe("endpoint"); expect(() => fishSpeechRequest({ ...config, endpoint }, "确认台词")).toThrow();
  });
  it("requires an explicit stable voice reference instead of using a random/default voice or OpenAI voice name", () => {
    expect(fishSpeechConfigurationIssue({ ...config, referenceId: "" })).toBe("referenceId");
    expect(() => fishSpeechRequest({ ...config, referenceId: "" }, "确认台词")).toThrow();
  });
});
