import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";

const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const lab = "labs/image-prompt-lab/";
const profilesKey = "sz_image_prompt_lab_config_profiles_v2";
const legacyKey = "sz_image_prompt_lab_config";
type Config = Record<string, string>;
type Result = { ok: boolean; code?: string; model?: string; modelFallback?: unknown };
type Background = {
  normalizeCfg(config: Config): Config;
  hostedTextUpstreamModel(config: Config, model: string): string;
  hostedImageUpstreamModel(config: Config, model: string): string;
  chatJson(config: Config, messages: object[], model: string, temperature: number, timeout: number): Promise<Result>;
  createGenericJsonImage(config: Config, payload: object): Promise<Result>;
};
type ProxyRequest = { url: string; headers: Record<string, string>; bodyText: string };
const wallet: Config = {
  provider: "openai-compatible", imageAdapter: "generic-json", apiKey: "",
  visionBaseUrl: "https://sub.shaozhuangai.com/v1", visionModel: "chatGPT5.5", textModel: "chatGPT5.5",
  imageEndpoint: "https://sub.shaozhuangai.com/v1/images/generations", imageModel: "image2"
};
const personal: Config = { ...wallet, apiKey: "synthetic-selected-provider-key" };

function backgroundSource(loaded: boolean) {
  if (!loaded) return readFileSync(resolve(assetRoot, lab + "background.js"), "utf8");
  const packed = readFileSync(resolve(assetRoot, lab + "studio-runtime-20261010-credit-v3.js"), "utf8");
  const marker = "/* Frozen source: public/creative/" + lab + "background.js */";
  const start = packed.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = packed.indexOf("/* Frozen source:", start + marker.length);
  expect(end).toBeGreaterThan(start);
  return packed.slice(start + marker.length, end);
}

// Run the real background and website transport; only auth/quote/provider I/O
// is synthetic. Both the raw source and the actual published leaf must agree.
function website(loaded: boolean, status = 200) {
  const values = new Map<string, string>();
  const storage = { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] || null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
  const requests: ProxyRequest[] = [], quotes: unknown[] = [];
  const context = createContext({
    URL, URLSearchParams, Request, Response, Headers, Blob, FormData, TextEncoder, TextDecoder,
    ArrayBuffer, Uint8Array, btoa, atob, console, AbortController, crypto: webcrypto, setTimeout, clearTimeout,
    localStorage: storage, sessionStorage: storage, __SZ_PROMPTLAB_BACKGROUND_TEST_MODE__: true,
    location: { href: "https://site.test/creative/labs/image-prompt-lab/promptlab.html", origin: "https://site.test", search: "" },
    document: { getElementById: () => null, addEventListener() {},
      createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, append() {}, showModal() {}, focus() {}, remove() {} }),
      body: { appendChild() {}, classList: { contains: () => false, toggle() {} } } },
    addEventListener() {}, authCheck: async () => ({ ok: true, user: { id: "alice" } }),
    fetch: async (input: string, init?: RequestInit) => {
      if (input === "/api/auth/me") return Response.json({ data: { id: "alice", tenantId: "shop", username: "alice", creativeEntitlement: { allowed: true } } });
      if (input === "/api/creative/billing/quote") {
        quotes.push(JSON.parse(String(init?.body)));
        return Response.json({ billingMode: "prepaid_quote", quoteCents: 50 });
      }
      expect(input).toBe("/api/creative/proxy");
      requests.push(JSON.parse(String(init?.body)) as ProxyRequest);
      return status === 200 ? Response.json({ data: [{ url: "https://images.test/synthetic.png" }], choices: [{ message: { content: '{"ready":true}' } }] }) :
        Response.json({ error: { code: status === 404 ? "model_not_found" : "invalid_api_key", message: "Synthetic rejection" } }, { status });
    }
  });
  context.window = context;
  for (const file of ["web-chrome.js", lab + "viral-series-contract.js", lab + "style-refresh-contract.js"]) {
    runInContext(readFileSync(resolve(assetRoot, file), "utf8"), context, { filename: file });
  }
  runInContext(backgroundSource(loaded), context, { filename: loaded ? "loaded-background.js" : "background.js" });
  const api = context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__ as Background;
  return { api, requests, quotes, values,
    seed: async () => {
      await context.chrome.storage.local.set({ [profilesKey]: { accounts: { "user:shop:alice": { activeProvider: personal.provider, configs: { [personal.provider]: personal } } } }, [legacyKey]: personal });
      return [...values.entries()];
    } };
}

describe.each([false, true])("strict selected image-workflow models (loaded=%s)", loaded => {
  it("preserves explicit BYOK model IDs, aliases, endpoint and Key during normalization and wire mapping", () => {
    const h = website(loaded);
    for (const imageModel of ["image2", "gpt-image-2", "gpt-image-2.5-sunburst", "image-model"]) {
      for (const visionModel of ["gpt-5.5", "chatGPT5.6", "gpt-5.6-sol", "vision-model", "chat-model"]) {
        const selected = { ...personal, imageModel, visionModel, textModel: visionModel };
        expect(h.api.normalizeCfg(selected)).toEqual(selected);
        expect(h.api.hostedImageUpstreamModel(selected, imageModel)).toBe(imageModel);
        expect(h.api.hostedTextUpstreamModel(selected, visionModel)).toBe(visionModel);
      }
    }
    const selected = { ...personal, visionBaseUrl: "https://api.example.com/v1", imageEndpoint: "https://api.example.com/v1/images/generations" };
    expect(h.api.normalizeCfg(selected)).toEqual(selected);
    const doubao = { ...personal, provider: "doubao", imageAdapter: "doubao-image", imageModel: "doubao-seedream-3-0-t2i-250415", visionModel: "doubao-1.5-vision-pro", textModel: "doubao-1.5-pro" };
    expect(h.api.normalizeCfg(doubao)).toEqual(doubao);
  });

  it("fills only missing model defaults and retains the advertised platform wire aliases", () => {
    const h = website(loaded), normalized = h.api.normalizeCfg({ ...wallet, imageModel: "", visionModel: "", textModel: "" });
    expect(normalized).toEqual(wallet);
    expect(h.api.hostedImageUpstreamModel(wallet, "image2")).toBe("gpt-image-2");
    expect(h.api.hostedTextUpstreamModel(wallet, "chatGPT5.5")).toBe("gpt-5.6-sol");
    expect(h.api.normalizeCfg({ ...wallet, visionModel: "gpt-5.5", imageModel: "gpt-image-2" })).toMatchObject({ visionModel: "gpt-5.5", imageModel: "gpt-image-2" });
  });

  it.each(["openai-compatible", "openai"])("submits exactly the selected BYOK alias and Key for %s without a wallet quote", async provider => {
    const h = website(loaded), config: Config = { ...personal, provider }, original = { ...config };
    expect(await h.api.createGenericJsonImage(config, { prompt: "Synthetic fixture", size: "1024*1024", count: 1 })).toMatchObject({ ok: true });
    expect(h.requests).toHaveLength(1); expect(h.quotes).toHaveLength(0);
    expect(h.requests[0].url).toBe(config.imageEndpoint);
    expect(h.requests[0].headers.Authorization).toBe("Bearer " + config.apiKey);
    expect(JSON.parse(h.requests[0].bodyText).model).toBe("image2");
    expect(config).toEqual(original);
  });

  it("sends the selected BYOK analysis alias unchanged with the same Key and no wallet quote", async () => {
    const h = website(loaded);
    expect(await h.api.chatJson(personal, [{ role: "user", content: "Synthetic analysis" }], personal.visionModel, 0, 1000)).toMatchObject({ ok: true });
    expect(h.requests).toHaveLength(1); expect(h.quotes).toHaveLength(0);
    expect(JSON.parse(h.requests[0].bodyText).model).toBe("chatGPT5.5");
    expect(h.requests[0].headers.Authorization).toBe("Bearer " + personal.apiKey);
  });

  it("keeps explicitly selected platform supply and its advertised wire model", async () => {
    const h = website(loaded);
    expect(await h.api.createGenericJsonImage(wallet, { prompt: "Synthetic fixture", size: "1024*1024", count: 1 })).toMatchObject({ ok: true });
    expect(h.requests).toHaveLength(1); expect(h.quotes).toHaveLength(1);
    expect(JSON.parse(h.requests[0].bodyText).model).toBe("gpt-image-2");
    expect(h.requests[0].headers.Authorization).toBeUndefined();
    expect(wallet.imageModel).toBe("image2");
  });

  it.each([401, 403, 404, 503])("does not retry rejected BYOK image %i using another model, key or platform", async status => {
    const h = website(loaded, status), config: Config = { ...personal, imageModel: "selected-unavailable-image" };
    expect(await h.api.createGenericJsonImage(config, { prompt: "Synthetic fixture", size: "1024*1024", count: 1 })).toMatchObject({ ok: false });
    expect(h.requests).toHaveLength(1); expect(h.quotes).toHaveLength(0);
    expect(JSON.parse(h.requests[0].bodyText).model).toBe(config.imageModel);
    expect(h.requests[0].headers.Authorization).toBe("Bearer " + config.apiKey);
  });

  it.each([false, true])("stops unavailable image-workflow text analysis without a default request or config mutation (BYOK=%s)", async byok => {
    const h = website(loaded, 404), before = await h.seed();
    const config: Config = { ...(byok ? personal : wallet), visionModel: "selected-unavailable-text", textModel: "selected-unavailable-text" };
    const result = await h.api.chatJson(config, [{ role: "user", content: "Synthetic analysis" }], config.visionModel, 0, 1000);
    expect(result).toMatchObject({ ok: false, code: "model_not_found", model: config.visionModel });
    expect(result.modelFallback).toBeUndefined(); expect(h.requests).toHaveLength(1);
    expect(JSON.parse(h.requests[0].bodyText).model).toBe(config.visionModel);
    expect(h.requests[0].headers.Authorization).toBe(byok ? "Bearer " + config.apiKey : undefined);
    expect([...h.values.entries()]).toEqual(before);
    expect(h.quotes).toHaveLength(byok ? 0 : 1);
  });
});
