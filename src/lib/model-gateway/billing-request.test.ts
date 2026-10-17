import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { gatewayRequestFingerprint, prepareGatewayBillingQuote } from "./billing-request";
import { GATEWAY_MODELS } from "./catalog";

describe("supplier request budget and replay identity", () => {
  const model = { ...GATEWAY_MODELS[0], promptCentsPer1K: 2, completionCentsPer1K: 6 };
  it("reserves output as well as input and sends that default output limit", () => {
    const body: Record<string, unknown> = { messages: [{ role: "user", content: "hello" }] };
    expect(prepareGatewayBillingQuote(model, "chat.completions", body)).toBe(8);
    expect(body.max_completion_tokens).toBe(1024);
  });
  it("preserves an explicit budget and rejects conflicting or unusable limits", () => {
    const body = { messages: [], max_tokens: 2000 };
    expect(prepareGatewayBillingQuote(model, "chat.completions", body)).toBe(13);
    expect(body).not.toHaveProperty("max_completion_tokens");
    for (const max_tokens of [0, -1, 1.5, "200", Number.MAX_SAFE_INTEGER]) expect(() => prepareGatewayBillingQuote(model, "chat.completions", { max_tokens })).toThrow();
    expect(() => prepareGatewayBillingQuote(model, "chat.completions", { max_tokens: 2, max_completion_tokens: 2 })).toThrow();
  });
  it("rejects multiple text choices and reserves supplied tool and schema context", () => {
    for (const n of [2, 10, 0, "1", null]) expect(() => prepareGatewayBillingQuote(model, "chat.completions", { messages: [], n })).toThrow();
    expect(prepareGatewayBillingQuote(model, "chat.completions", { messages: [], n: 1, max_tokens: 1 })).toBe(2);
    const small = prepareGatewayBillingQuote(model, "chat.completions", { messages: [], max_tokens: 1 });
    const large = prepareGatewayBillingQuote(model, "chat.completions", { messages: [], max_tokens: 1, tools: [{ description: "x".repeat(16000) }] });
    expect(large).toBeGreaterThan(small);
  });
  it("does not discount multi-byte Chinese input to one quarter of its character count", () => {
    const chinese = prepareGatewayBillingQuote(model, "chat.completions", { messages: [{ role: "user", content: "中".repeat(1000) }], max_tokens: 1 });
    const ascii = prepareGatewayBillingQuote(model, "chat.completions", { messages: [{ role: "user", content: "x".repeat(1000) }], max_tokens: 1 });
    expect(chinese).toBeGreaterThanOrEqual(7);
    expect(chinese).toBeGreaterThan(ascii);
    expect(prepareGatewayBillingQuote(model, "chat.completions", { messages: [], max_tokens: 1, response_format: { schema: "中".repeat(1000) } })).toBeGreaterThanOrEqual(7);
  });
  it("makes JSON ordering immaterial but separates changed prompts and multipart bytes", async () => {
    const args = { endpoint: "images.edits", model: "image" };
    const first = await gatewayRequestFingerprint({ ...args, body: { prompt: "private", n: 1 } });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await gatewayRequestFingerprint({ ...args, body: { n: 1, prompt: "private" } })).toBe(first);
    expect(await gatewayRequestFingerprint({ ...args, body: { n: 1, prompt: "changed" } })).not.toBe(first);
    const form = new FormData(); form.set("image", new Blob(["first"]));
    const image = await gatewayRequestFingerprint({ ...args, body: {}, form });
    form.set("image", new Blob(["second"]));
    expect(await gatewayRequestFingerprint({ ...args, body: {}, form })).not.toBe(image);
  });
});
