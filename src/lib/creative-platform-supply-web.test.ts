import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";

const script = (file: string) => readFileSync(resolve(process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative", file), "utf8");
const supplied = {
  provider: "openai-compatible", imageAdapter: "generic-json", apiKey: "",
  imageEndpoint: "https://sub.shaozhuangai.com/v1/images/generations", imageModel: "image2",
  visionBaseUrl: "https://sub.shaozhuangai.com/v1", visionModel: "chatGPT5.5", textModel: "chatGPT5.5"
};
function storage() {
  const records = new Map<string, string>();
  return { get length() { return records.size; }, key: (index: number) => [...records.keys()][index] || null,
    getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); },
    removeItem: (key: string) => { records.delete(key); } };
}
function website(config = supplied) {
  const requests: Array<{ url: string; headers: Record<string, string>; bodyText?: string; bodyBase64?: string; form?: FormData; credentials?: RequestCredentials; expectedAccount?: string }> = [];
  const events: string[] = [], parentEvents: string[] = [];
  let allowed = true, failure = false, revokeAfterQuote = false, providerSubmissions = 0;
  const quotes: unknown[] = [];
  const denied = () => Response.json({ error: "作图权限未开通", code: "CREATIVE_ACCESS_REQUIRED", providerSubmitted: false, definitiveFailure: true }, { status: 403, headers: { "X-Sanjie-Provider-Submission": "not-submitted" } });
  let username: string | null = "alice", onProxy: (() => void) | null = null;
  let reply: { body: unknown; status: number; headers?: Record<string, string> } | null = null;
  const inputs = Object.fromEntries(Object.entries(config).map(([key, value]) => [key, {
    value, focus() {}, setAttribute() {}, classList: { toggle() {} }
  }]));
  const context = createContext({
    URL, URLSearchParams, Request, Headers, Response, Blob, FormData, TextEncoder, TextDecoder, ArrayBuffer, Uint8Array,
    btoa, atob, console, setTimeout, clearTimeout, AbortController, Event, crypto: webcrypto,
    localStorage: storage(), sessionStorage: storage(), __SZ_PROMPTLAB_BACKGROUND_TEST_MODE__: true, __SZ_PROMPTLAB_TEST_MODE__: true,
    location: { href: "https://shaozhuangai.com/creative/labs/image-prompt-lab/promptlab.html?source=web", origin: "https://shaozhuangai.com", search: "?source=web" },
    document: { getElementById: (id: string) => inputs[id] || null, addEventListener() {},
      createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, appendChild() {} }),
      body: { appendChild() {}, classList: { contains() { return false; }, toggle() {} } } },
    addEventListener() {}, dispatchEvent: (event: Event) => { events.push(event.type); },
    parent: { Event, dispatchEvent: (event: Event) => { parentEvents.push(event.type); } },
    fetch: async (input: string | Request, init?: RequestInit) => {
      if (input === "/api/auth/me") return username === null ? Response.json({ error: "未登录" }, { status: 401 }) : Response.json({ data: { tenantId: "tenant-a", username, creativeEntitlement: { allowed } } });
      if (input === "/api/creative/billing/quote") {
        quotes.push(JSON.parse(String(init?.body)));
        if (!allowed) return denied();
        if (revokeAfterQuote) allowed = false;
        return Response.json({ billingMode: "prepaid_quote", quoteCents: 50, refundOnFailure: true, refundOnCancel: false });
      }
      const directUrl = typeof input === "string" ? input : input.url;
      if (/^(?:https:\/\/shaozhuangai.com)?\/(?:api\/)?v1\//.test(directUrl)) {
        const headers = Object.fromEntries(new Headers(init?.headers || (input instanceof Request ? input.headers : undefined)).entries());
        requests.push({ url: directUrl, headers, bodyText: input instanceof Request ? await input.text() : String(init?.body) });
        return Response.json({ data: [{ url: "https://fixture.test/output.png" }] });
      }
      if (input !== "/api/creative/proxy") throw new Error(`Unexpected native request ${input}`);
      let envelope: typeof requests[number];
      if (init?.body instanceof FormData) {
        envelope = { url: String(init.body.get("__sz_url")), headers: JSON.parse(String(init.body.get("__sz_headers"))), form: init.body };
      } else envelope = JSON.parse(String(init?.body));
      envelope.credentials = init?.credentials;
      requests.push(envelope);
      if (!allowed) return denied();
      providerSubmissions++;
      if (onProxy) onProxy();
      if (reply) return Response.json(reply.body, { status: reply.status, headers: reply.headers });
      if (failure) return Response.json({ error: "积分余额不足，请先购买积分" }, { status: 402 });
      if (envelope.url.includes("/chat/completions")) return Response.json({ choices: [{ message: { content: JSON.stringify({ productName: "测试商品", identityPoints: ["保留商品证据"], confidence: 90 }) } }] });
      return Response.json({ data: [{ url: "https://fixture.test/output.png" }] });
    }
  });
  context.window = context;
  for (const file of ["web-chrome.js", "src/business-knowledge.js", "src/subject-orchestration.js", "src/subject-assets.js", "src/reference-detail-contract.js",
    "labs/image-prompt-lab/reference-detail-blueprint.js", "labs/image-prompt-lab/reference-detail-batch.js", "labs/image-prompt-lab/viral-series-contract.js",
    "labs/image-prompt-lab/style-refresh-contract.js", "labs/image-prompt-lab/creative-tools-contract.js",
    "labs/image-prompt-lab/studio-genesis-contract.js", "labs/image-prompt-lab/scene-extension-contract.js", "labs/image-prompt-lab/image-archive-store.js",
    "labs/image-prompt-lab/background.js", "labs/image-prompt-lab/promptlab.js"]) runInContext(script(file), context, { filename: file });
  return { context, requests, events, parentEvents, inputs, quotes, get providerSubmissions() { return providerSubmissions; }, revokeOnQuote: () => { revokeAfterQuote = true; }, setUser: (value: string | null) => { username = value; }, onProxy: (handler: () => void) => { onProxy = handler; }, setReply: (body: unknown, status = 200, headers?: Record<string, string>) => { reply = { body, status, headers }; }, setAllowed: (value: boolean) => { allowed = value; }, setFailure: (value: boolean) => { failure = value; } };
}

function payloadBody(envelope: ReturnType<typeof website>["requests"][number]) {
  return JSON.parse(envelope.bodyText || Buffer.from(envelope.bodyBase64 || "", "base64").toString());
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("website platform supply authentication and request identity", () => {
  it("preserves production generic local and session storage prefixes without migrating personal credentials", async () => {
    const h = website();
    const saved = { provider: "openai", apiKey: "fixture-personal-key" };
    await h.context.chrome.storage.local.set({ customProfile: saved });
    await h.context.chrome.storage.session.set({ selectedTask: "fixture-task" });
    expect(JSON.parse(h.context.localStorage.getItem("sz.chrome.local.v1:customProfile"))).toEqual(saved);
    expect(JSON.parse(h.context.sessionStorage.getItem("sz.chrome.session.v1:selectedTask"))).toBe("fixture-task");
    expect(h.context.localStorage.getItem("sz.chrome.local.v1:account:tenant-a%3Aalice:customProfile")).toBeNull();
    expect(await h.context.chrome.storage.local.get("customProfile")).toEqual({ customProfile: saved });
    expect(h.requests).toHaveLength(0);
  });
  it("generates through actual background transports with no client Key and displays the same ready state", async () => {
    const h = website();
    expect(h.context.SZ_CREATIVE_TOOLS_BRIDGE.modelInfo().ready).toBe(true);
    expect(h.context.SZCreativeCreditChannel("image")).toBe("platform_wallet");
    const api = h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__;
    expect(await api.createGenericJsonImage(supplied, { prompt: "商品白底图", count: 1 })).toMatchObject({ ok: true });
    expect(await api.chatJson(supplied, [{ role: "user", content: "核对商品证据" }], "chatGPT5.5")).toMatchObject({ ok: true });
    expect(h.requests).toHaveLength(2);
    expect(payloadBody(h.requests[0]).model).toBe("gpt-image-2");
    expect(payloadBody(h.requests[1]).model).toBe("gpt-5.6-sol");
    for (const request of h.requests) {
      expect(Object.keys(request.headers).some(key => key.toLowerCase() === "authorization")).toBe(false);
      expect(request.headers["idempotency-key"]).toMatch(uuid);
    }
    expect(h.requests[0].headers["idempotency-key"]).not.toBe(h.requests[1].headers["idempotency-key"]);
    expect(h.parentEvents).toEqual(["sanjie:credits-changed", "sanjie:credits-changed"]);
  });

  it("dispatches keyless subject analysis through the production bridge and preserves the product", async () => {
    const h = website();
    expect(await h.context.SZ_CREATIVE_TOOLS_BRIDGE.refresh({ deferArchive: true })).toMatchObject({ ok: true, accountKey: "user:tenant-a:alice" });
    const original = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8N45sAAAAASUVORK5CYII=";
    expect(await h.context.SZ_CREATIVE_TOOLS_BRIDGE.analyze({ tool: "product", products: [original], purpose: "brief" })).toMatchObject({ ok: true });
    expect(h.requests).toHaveLength(1);
    const body = payloadBody(h.requests[0]);
    expect(JSON.stringify(body.messages)).toContain(original);
    expect(body.model).toBe("gpt-5.6-sol");
  });

  it("adds request identity to same-origin gateway calls while retaining gateway credentials", async () => {
    const h = website();
    await h.context.fetch("/api/v1/images/generations", { method: "POST", headers: { authorization: "Bearer own-gateway-key" }, body: JSON.stringify({ model: "image2" }) });
    const logicalId = "7b6771b5-83ab-4ecf-a16e-7f4e8fc0f121";
    await h.context.fetch(new Request("https://shaozhuangai.com/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer own-gateway-key", "Idempotency-Key": logicalId }, body: JSON.stringify({ model: "chatGPT5.5" }) }));
    expect(h.requests[0].headers["idempotency-key"]).toMatch(uuid);
    expect(h.requests[1].headers["idempotency-key"]).toBe(logicalId);
    for (const request of h.requests) expect(request.headers.authorization).toBe("Bearer own-gateway-key");
    expect(payloadBody(h.requests[1]).model).toBe("chatGPT5.5");
    expect(h.context.SZ_WEB_SUPPLY.usesServerCredentials("https://shaozhuangai.com/v1")).toBe(false);
  });

  it("preserves the personal API key and supplied logical request ID in JSON and multipart", async () => {
    const h = website();
    const logicalId = "4c1ef10b-bbb3-4d7b-95d1-e1cf4b311973";
    await h.context.fetch(supplied.imageEndpoint, { method: "POST", headers: { Authorization: "Bearer personal-client-key", "Proxy-Authorization": "Bearer unrelated-proxy-key", "Idempotency-Key": logicalId }, body: JSON.stringify({ model: "image2", n: 1 }) });
    const form = new FormData();
    form.set("model", "image2"); form.set("image", new Blob(["original pixels"], { type: "image/png" }), "original.png");
    await h.context.fetch("https://sub.shaozhuangai.com/v1/images/edits", { method: "POST", headers: { authorization: "Bearer personal-client-key", "proxy-authorization": "Bearer unrelated-proxy-key", "idempotency-key": logicalId }, body: form });
    expect(h.requests).toHaveLength(2);
    for (const request of h.requests) {
      const auth = Object.keys(request.headers).find(key => key.toLowerCase() === "authorization")!;
      expect(request.headers[auth]).toBe("Bearer personal-client-key");
      expect(Object.keys(request.headers).some(key => key.toLowerCase() === "proxy-authorization")).toBe(false);
      const key = Object.keys(request.headers).find(key => key.toLowerCase() === "idempotency-key")!;
      expect(request.headers[key]).toBe(logicalId);
    }
    expect(h.requests[1].form?.get("model")).toBe("image2");
    expect(await (h.requests[1].form?.get("image") as Blob).text()).toBe("original pixels");
  });

  it("keeps BYOK credentials and blocks an empty BYOK key before network dispatch", async () => {
    const external = { ...supplied, visionBaseUrl: "https://api.openai.com/v1", imageEndpoint: "https://api.openai.com/v1/images/generations", apiKey: "account-own-key" };
    const h = website(external);
    const api = h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__;
    expect(await api.createGenericJsonImage(external, { prompt: "商品白底图", count: 1 })).toMatchObject({ ok: true });
    expect(h.requests[0].headers.Authorization || h.requests[0].headers.authorization).toBe("Bearer account-own-key");
    expect(h.requests[0].headers).not.toHaveProperty("idempotency-key");
    expect(await api.createGenericJsonImage({ ...external, apiKey: "" }, { prompt: "商品白底图" })).toMatchObject({ ok: false, error: "未配置 API Key" });
    expect(h.requests).toHaveLength(1);
    expect(h.parentEvents).toEqual([]);
    expect(h.inputs.apiKey.value).toBe("account-own-key");
  });

  it("does not retry failed payment checks and refreshes the authoritative balance", async () => {
    const h = website(); h.setFailure(true);
    const api = h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__;
    expect(await api.createGenericJsonImage(supplied, { prompt: "商品白底图", count: 1 })).toMatchObject({ ok: false });
    expect(h.requests).toHaveLength(1);
    expect(h.parentEvents).toEqual(["sanjie:credits-changed"]);
  });

  it("rejects current entitlement in the account gate and authoritative quote without submitting a provider request", async () => {
    const h = website(); h.setAllowed(false);
    await expect(h.context.SZ_WEB_ACCOUNT.requireAccess()).rejects.toMatchObject({ code: "CREATIVE_ACCESS_REQUIRED" });
    const result = await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(supplied, { prompt: "商品白底图", count: 1 });
    expect(result).toMatchObject({ ok: false });
    expect(result.images).toBeUndefined();
    expect(h.quotes).toHaveLength(1);
    expect(h.requests).toHaveLength(0);
    expect(h.providerSubmissions).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/fixture-personal-key|Bearer|Authorization/);
  });

  it("honors authoritative proxy denial after entitlement is revoked between quote and dispatch", async () => {
    const h = website(); h.revokeOnQuote();
    const result = await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(supplied, { prompt: "商品白底图", count: 1 });
    expect(result).toMatchObject({ ok: false });
    expect(result.images).toBeUndefined();
    expect(h.quotes).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
    expect(h.providerSubmissions).toBe(0);
    expect(h.requests[0].headers.Authorization).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/fixture-personal-key|Bearer|Authorization/);
  });

  it("never declares lookalike, insecure or unknown platform routes ready", () => {
    const h = website();
    for (const url of ["http://sub.shaozhuangai.com/v1", "https://other.sub.shaozhuangai.com/v1", "https://sub.shaozhuangai.com.evil.test/v1", "https://sub.shaozhuangai.com:8443/v1", "https://sub.shaozhuangai.com/admin", "https://sub.shaozhuangai.com/v1beta"]) {
      expect(h.context.SZ_WEB_SUPPLY.usesServerCredentials(url), url).toBe(false);
    }
    expect(h.context.SZ_WEB_SUPPLY.usesServerCredentials(supplied.visionBaseUrl)).toBe(true);
  });
});


const inputImage = (marker: number) => {
  const bytes = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(64, 16); bytes.writeUInt32BE(64, 20); bytes[26] = marker;
  return `data:image/png;base64,${bytes.toString("base64")}`;
};
const inputBytes = (image: string) => Buffer.from(image.split(",")[1], "base64");
const edits = "https://sub.shaozhuangai.com/v1/images/edits";

describe("hosted Image 2 uses the fixed Sub2API OpenAI image input protocol", () => {
  it.each(["image2", "gpt-image-2"].flatMap(imageModel => ["", "personal-browser-key"].map(apiKey => ({ imageModel, apiKey }))))("adapts saved generic-json $imageModel with API key '$apiKey' without rewriting the saved profile", async ({ imageModel, apiKey }) => {
    const config = { ...supplied, imageModel, apiKey }, original = { ...config };
    const h = website(config), api = h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__;
    const base = inputImage(1), products = [inputImage(2), inputImage(3)], model = inputImage(4), reference = inputImage(5), mask = inputImage(6);
    expect(await api.createGenericJsonImage(config, { prompt: "保留商品纹理", negativePrompt: "文字", size: "1024*1024", count: 1,
      editBaseImage: base, productImages: products, modelImages: [model], referenceImages: [base, reference], editMaskImage: mask })).toMatchObject({ ok: true });
    expect(config).toEqual(original);
    expect(h.requests).toHaveLength(1);
    const request = h.requests[0], form = request.form!;
    expect(request.url).toBe(edits);
    expect(request.credentials).toBe("same-origin");
    // Personal credentials retain the user's exact model namespace. Only the
    // explicitly selected platform route resolves its advertised image2 alias.
    expect(form.get("model")).toBe(apiKey ? imageModel : "gpt-image-2");
    expect(form.get("n")).toBe("1");
    expect(form.get("size")).toBe("1024x1024");
    expect(form.get("prompt")).toContain("保留商品纹理");
    expect(form.get("prompt")).toContain("Avoid: 文字");
    expect(form.has("input_fidelity")).toBe(false);
    expect(form.has("reference_images")).toBe(false);
    const images = form.getAll("image[]") as File[];
    expect(images.map(image => image.name)).toEqual(["guide-edit-base.png", "product-subject-1.png", "product-subject-2.png", "model-reference-1.png", "style-reference-page-1.png"]);
    expect(await Promise.all(images.map(async image => Buffer.from(await image.arrayBuffer())))).toEqual([base, ...products, model, reference].map(inputBytes));
    expect(Buffer.from(await (form.get("mask") as File).arrayBuffer())).toEqual(inputBytes(mask));
    const auth = Object.keys(request.headers).find(key => key.toLowerCase() === "authorization");
    if (apiKey) expect(auth && request.headers[auth]).toBe(`Bearer ${apiKey}`);
    else expect(auth).toBeUndefined();
    expect(request.headers["idempotency-key"]).toMatch(uuid);
    expect(h.parentEvents).toEqual(["sanjie:credits-changed"]);
  });

  it("uses valid generation JSON for a text-only material, including a saved edits endpoint", async () => {
    const h = website(), api = h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__;
    expect(await api.createGenericJsonImage({ ...supplied, imageEndpoint: edits }, { prompt: "空白摄影棚", size: "1024*1024", count: 1 })).toMatchObject({ ok: true });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].url).toBe(supplied.imageEndpoint);
    expect(payloadBody(h.requests[0])).toMatchObject({ model: "gpt-image-2", prompt: expect.stringContaining("空白摄影棚"), size: "1024x1024", n: 1 });
    expect(payloadBody(h.requests[0])).not.toHaveProperty("product_images");
  });

  it("retains a model-only image input and chooses edits", async () => {
    const h = website();
    expect(await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(supplied, { prompt: "保持模特", modelImages: [inputImage(4)] })).toMatchObject({ ok: true });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].url).toBe(edits);
    expect(Buffer.from(await (h.requests[0].form!.get("image") as File).arrayBuffer())).toEqual(inputBytes(inputImage(4)));
  });

  it("keeps SKU immutable base first, subject second and applies the existing provider size rule", async () => {
    const h = website(), api = h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__;
    const payload = { promptSource: "sku", labMode: "sku", detailMode: "sku", prompt: "替换同款商品", size: "800*1200", outputSize: "800*1200", outputRatio: "2:3", outputResolution: "custom",
      editBaseImage: inputImage(1), productImages: [inputImage(2)] };
    const original = JSON.stringify(payload);
    expect(await api.createGenericJsonImage(supplied, payload)).toMatchObject({ ok: true });
    expect(JSON.stringify(payload)).toBe(original);
    const form = h.requests[0].form!;
    expect(form.get("size")).toBe("1024x1536");
    expect((form.getAll("image[]") as File[]).map(image => image.name)).toEqual(["immutable-sku-base.png", "replacement-subject.png"]);
    expect(form.has("mask")).toBe(false);
    expect(String(form.get("prompt"))).toContain("STRICT SKU SUBJECT REPLACEMENT CONTRACT");
  });

  it.each(["main", "detail", "ad"])("runs the real %s studio contract through one keyless edits dispatch", async mode => {
    const h = website(), studio = h.context.SZ_STUDIO_GENESIS;
    const settings = { ...studio.defaults(mode), count: 1 };
    const task = { id: "product-a", name: "原商品", requirements: "保留纹理", products: [{ image: inputImage(1), name: "正面", width: 64, height: 64 }], overrides: null, analysis: "", plan: null };
    const plan = studio.createPlan(task, settings); expect(plan.ok).toBe(true);
    const payload = studio.createPayload(plan, plan.shots[0].id);
    expect(await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createImageTask(supplied, payload)).toMatchObject({ ok: true });
    expect(h.requests).toHaveLength(1); expect(h.requests[0].url).toBe(edits);
    expect(h.requests[0].form!.get("size")).toBe(mode === "detail" ? "768x1024" : "1024x1024");
  });

  it("preserves the scene contract preflight and submits all material views once", async () => {
    const h = website(), scene = h.context.SZ_SCENE_EXTENSION_CONTRACT;
    const plan = scene.createPlan({ config: { materialName: "同款原木", category: "material", sameMaterialConfirmed: true, scene: "明亮客厅", shots: ["macro"], count: 1, ratio: "3:4", resolution: "2K" }, images: [{ role: "front", image: inputImage(1) }, { role: "detail", image: inputImage(2) }] });
    expect(plan.ok).toBe(true);
    const payload = scene.createPayload(plan, plan.shots[0].id);
    expect(await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createImageTask(supplied, payload)).toMatchObject({ ok: true });
    expect(h.requests).toHaveLength(1); expect(h.requests[0].url).toBe(edits);
    expect(h.requests[0].form!.getAll("image[]")).toHaveLength(2);
    expect(h.requests[0].form!.get("size")).toBe("1536x2048");
    const broken = { ...payload, scenePlanSignature: "tampered" };
    expect(await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createImageTask(supplied, broken)).toMatchObject({ ok: false, definitiveFailure: true });
    expect(h.requests).toHaveLength(1);
  });

  it.each(["clothing", "buyer", "refinement"])("preserves %s creative options and image evidence", async tool => {
    const h = website(), creative = h.context.SZ_CREATIVE_TOOLS_CONTRACT;
    const plan = creative.createPlan({ tool, mode: tool === "clothing" ? "tryon" : tool, config: { count: 1, ratio: "3:4", resolution: "1K" }, products: [{ image: inputImage(1), name: "商品" }], ...(tool === "clothing" ? { modelImage: inputImage(2) } : {}) });
    expect(plan.ok).toBe(true);
    expect(await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createImageTask(supplied, creative.createPayload(plan, plan.shots[0].id))).toMatchObject({ ok: true });
    expect(h.requests).toHaveLength(1); expect(h.requests[0].url).toBe(edits);
    const form = h.requests[0].form!;
    expect(form.get("size")).toBe("768x1024");
    expect(form.getAll(tool === "clothing" ? "image[]" : "image")).toHaveLength(tool === "clothing" ? 2 : 1);
  });

  it.each(["data:image/png;base64,bm90IGFuIGltYWdl", "data:image/jpeg;base64,iVBORw0KGgo=", "file:///private/product.png"])("rejects invalid image input before dispatch: %s", async source => {
    const h = website();
    expect(await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(supplied, { prompt: "商品", productImages: [source] })).toMatchObject({ ok: false, definitiveFailure: true, stateUncertain: false });
    expect(h.requests).toHaveLength(0); expect(h.parentEvents).toEqual([]);
  });

  it("rejects a non-PNG mask without silently dropping it or dispatching", async () => {
    const h = website();
    const jpeg = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 0]).toString("base64")}`;
    expect(await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(supplied, { prompt: "编辑", editBaseImage: inputImage(1), editMaskImage: jpeg })).toMatchObject({ ok: false, definitiveFailure: true });
    expect(h.requests).toHaveLength(0);
  });

  it("measures UTF-8 multipart bytes before dispatch and reserves the web envelope budget", async () => {
    const h = website(), api = h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__;
    for (const prompt of ["中".repeat(11 * 1024 * 1024), "a".repeat(24 * 1024 * 1024 - 32 * 1024)]) {
      expect(await api.createGenericJsonImage(supplied, { prompt, productImages: [inputImage(1)] })).toMatchObject({ ok: false, code: "hosted_image_request_too_large", definitiveFailure: true, stateUncertain: false });
    }
    expect(h.requests).toHaveLength(0); expect(h.parentEvents).toEqual([]);
  });

  it("does not reinterpret BYOK generic transports or nonstandard platform models and paths", async () => {
    for (const config of [
      { ...supplied, imageEndpoint: "https://api.openai.com/v1/images/generations", apiKey: "own-key" },
      { ...supplied, imageModel: "custom-image", apiKey: "own-key" },
      { ...supplied, imageEndpoint: supplied.imageEndpoint + "?custom=1", apiKey: "own-key" }
    ]) {
      const h = website(config);
      expect(await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(config, { prompt: "原协议", productImages: [inputImage(1)] })).toMatchObject({ ok: true });
      expect(h.requests).toHaveLength(1); expect(h.requests[0].form).toBeUndefined();
      expect(payloadBody(h.requests[0]).product_images).toEqual([inputImage(1)]);
    }
  });

  it("requires an owned key for a nonstandard platform query path", async () => {
    for (const config of [
      { ...supplied, imageEndpoint: supplied.imageEndpoint + "?custom=1" }
    ]) {
      const h = website(config);
      expect(await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(config, { prompt: "商品", productImages: [inputImage(1)] })).toMatchObject({ ok: false, error: "未配置 API Key" });
      expect(h.requests).toHaveLength(0);
    }
  });

  it.each(["http://sub.shaozhuangai.com/v1/images/generations", "https://other.sub.shaozhuangai.com/v1/images/generations", "https://sub.shaozhuangai.com.evil.test/v1/images/generations", "https://user@sub.shaozhuangai.com/v1/images/generations", "https://sub.shaozhuangai.com:8443/v1/images/generations"])("does not grant keyless platform access to %s", async imageEndpoint => {
    const config = { ...supplied, imageEndpoint }, h = website(config);
    expect(await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(config, { prompt: "商品", productImages: [inputImage(1)] })).toMatchObject({ ok: false, error: "未配置 API Key" });
    expect(h.requests).toHaveLength(0);
  });

  it("does not retry or turn malformed/failed provider receipts into success", async () => {
    for (const [body, status] of [[{ data: [] }, 200], [{ error: "provider unavailable" }, 503]] as const) {
      const h = website(); h.setReply(body, status);
      expect(await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(supplied, { prompt: "商品", productImages: [inputImage(1)] })).toMatchObject({ ok: false });
      expect(h.requests).toHaveLength(1);
    }
  });
});


describe("hosted image account binding survives asynchronous preparation and response", () => {
  it("keeps the captured owner when image decoding switches the browser account and sends no POST", async () => {
    const h = website();
    h.context.Blob = class extends Blob { async arrayBuffer() { h.setUser("bob"); return super.arrayBuffer(); } };
    const result = await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(supplied, { prompt: "A的商品", productImages: [inputImage(1)] });
    expect(result).toMatchObject({ ok: false, code: "CREATIVE_ACCOUNT_UNAVAILABLE", providerSubmitted: false, definitiveFailure: true, stateUncertain: false });
    expect(result.images).toBeUndefined(); expect(h.requests).toHaveLength(0);
  });

  it("captures before asynchronous mask reading too", async () => {
    const h = website();
    h.context.Blob = class extends Blob { async arrayBuffer() { h.setUser("bob"); return super.arrayBuffer(); } };
    const result = await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(supplied, { prompt: "原图局部编辑", editBaseImage: inputImage(1), editMaskImage: inputImage(2) });
    expect(result).toMatchObject({ ok: false, code: "CREATIVE_ACCOUNT_UNAVAILABLE", providerSubmitted: false });
    expect(h.requests).toHaveLength(0);
  });

  it("binds multipart to A through the check-to-cookie window and recognizes only the trusted 409", async () => {
    const h = website();
    // Switch at the mocked server dispatch boundary, after the client's complete
    // identity-and-entitlement response. The server's trusted 409 remains the
    // proof that this request was rejected before provider submission.
    h.onProxy(() => h.setUser("bob"));
    h.setReply({ error: "账号已变化", code: "CREATIVE_ACCOUNT_CHANGED", providerSubmitted: false, definitiveFailure: true }, 409, { "X-Sanjie-Provider-Submission": "not-submitted" });
    const result = await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(supplied, { prompt: "A的商品", productImages: [inputImage(1)] });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].form!.get("__sz_expected_account")).toBe("tenant-a:alice");
    expect(JSON.stringify(h.requests[0].headers)).not.toContain("tenant-a:alice");
    expect(result).toMatchObject({ ok: false, code: "CREATIVE_ACCOUNT_CHANGED", httpStatus: 409, providerSubmitted: false, definitiveFailure: true, stateUncertain: false });
  });

  it("binds text-only generation JSON without adding account identity to provider body or headers", async () => {
    const h = website();
    expect(await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(supplied, { prompt: "空摄影棚" })).toMatchObject({ ok: true });
    expect(h.requests[0].expectedAccount).toBe("tenant-a:alice");
    expect(JSON.stringify(payloadBody(h.requests[0]))).not.toContain("tenant-a:alice");
    expect(JSON.stringify(h.requests[0].headers)).not.toContain("tenant-a:alice");
    expect(supplied).not.toHaveProperty("szExpectedAccount");
  });

  it("preserves transient ownership when fetch receives a standard Request object", async () => {
    const h = website();
    const request = new Request(supplied.imageEndpoint, { method: "POST", body: JSON.stringify({ model: "image2", prompt: "商品" }), headers: { "Content-Type": "application/json" } });
    await h.context.fetch(request, { szExpectedAccount: "tenant-a:alice" });
    expect(h.requests).toHaveLength(1); expect(h.requests[0].expectedAccount).toBe("tenant-a:alice");
    expect(payloadBody(h.requests[0])).toEqual({ model: "image2", prompt: "商品" });
  });

  it.each(["bob", null])("does not deliver a returned image after the original account becomes %s", async username => {
    const h = website(); h.onProxy(() => h.setUser(username));
    const result = await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(supplied, { prompt: "A的商品", productImages: [inputImage(1)] });
    expect(h.requests).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, definitiveFailure: false, stateUncertain: true });
    expect(result.images).toBeUndefined(); expect(result.raw).toBeUndefined(); expect(result.providerSubmitted).not.toBe(false);
  });

  it.each([null, ""])("rejects missing or empty authenticated owner %s before image preparation or POST", async username => {
    const h = website(); h.setUser(username);
    const result = await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(supplied, { prompt: "商品", productImages: [inputImage(1)] });
    expect(result).toMatchObject({ ok: false, code: "CREATIVE_ACCOUNT_UNAVAILABLE", providerSubmitted: false, definitiveFailure: true });
    expect(h.requests).toHaveLength(0);
  });

  it("does not add website account checks or ownership metadata to an external BYOK adapter", async () => {
    const cfg = { ...supplied, provider: "openai", imageAdapter: "openai-images", imageEndpoint: "https://api.openai.com/v1/images/generations", apiKey: "own-key" };
    const h = website(cfg); h.setUser(null);
    expect(await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createOpenAIImage(cfg, { prompt: "商品", productImages: [inputImage(1)] })).toMatchObject({ ok: true });
    expect(h.requests[0].form!.has("__sz_expected_account")).toBe(false);
    expect(h.requests[0].headers.Authorization).toBe("Bearer own-key");
    await h.context.fetch(cfg.imageEndpoint, { method: "POST", body: "{}", szExpectedAccount: "tenant-a:alice" });
    expect(h.requests[1].expectedAccount).toBeUndefined();
  });

  it.each([
    { status: 409, code: "CREATIVE_ACCOUNT_CHANGED", marked: false },
    { status: 503, code: "CREATIVE_ACCOUNT_CHANGED", marked: true },
    { status: 409, code: "CREATIVE_SUPPLY_UNAVAILABLE", marked: true },
    { status: 400, code: "CREATIVE_SUPPLY_NOT_CONFIGURED", marked: true },
    { status: 401, code: "CREATIVE_ACCOUNT_CHANGED", marked: true },
    { status: 402, code: "CREATIVE_SUPPLY_UNAVAILABLE", marked: true },
    { status: 403, code: "CREATIVE_SUPPLY_UNAVAILABLE", marked: true },
    { status: 429, code: "CREATIVE_SUPPLY_UNAVAILABLE", marked: true },
    { status: 502, code: "CREATIVE_SUPPLY_NOT_CONFIGURED", marked: true },
    { status: 504, code: "CREATIVE_SUPPLY_UNAVAILABLE", marked: true },
    { status: 503, code: "INSUFFICIENT_BALANCE", marked: true },
    { status: 402, code: "CREDIT_SERVICE_UNAVAILABLE", marked: true },
    { status: 503, code: "POOL_PROVIDER_ASSERTION", marked: true },
    { status: 503, code: "CREDIT_POOL_PROVIDER_ASSERTION", marked: true },
    { status: 409, code: "CREATIVE_REQUEST_NOT_SUBMITTED", marked: true },
    { status: 500, code: "CREATIVE_REQUEST_NOT_SUBMITTED", marked: true },
    { status: 504, code: "CREATIVE_REQUEST_NOT_SUBMITTED", marked: true },
    { status: 503, code: "creative_supply_unavailable", marked: true },
    { status: 400, code: "UNRECOGNIZED_PROVIDER_REJECTION", marked: true },
    { status: 400, code: "UNRECOGNIZED_PROVIDER_REJECTION", marked: false }
  ])("does not trust a supplier assertion or a wrong status/code pair: $status $code $marked", async ({ status, code, marked }) => {
    const h = website();
    h.setReply({ error: "provider assertion", code, providerSubmitted: false, definitiveFailure: true }, status, marked ? { "X-Sanjie-Provider-Submission": "not-submitted" } : {});
    const result = await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(supplied, { prompt: "商品", productImages: [inputImage(1)] });
    expect(result.ok).toBe(false); expect(result.providerSubmitted).not.toBe(false); expect(result.definitiveFailure).not.toBe(true);
    expect(result.stateUncertain).toBe(true); expect(result.proxyNotSubmitted).not.toBe(true);
    expect(result.error).not.toContain("本次未提交生图"); expect(result.error).not.toMatch(/重试|未扣费|未收费/);
    expect(h.requests).toHaveLength(1);
  });

  it.each([
    { name: "missing marker", headers: {} as Record<string, string>, proof: { providerSubmitted: false, definitiveFailure: true } },
    { name: "wrong marker", headers: { "X-Sanjie-Provider-Submission": "unknown" }, proof: { providerSubmitted: false, definitiveFailure: true } },
    { name: "empty marker", headers: { "X-Sanjie-Provider-Submission": "" }, proof: { providerSubmitted: false, definitiveFailure: true } },
    { name: "submitted", proof: { providerSubmitted: true, definitiveFailure: true } },
    { name: "missing submission flag", proof: { definitiveFailure: true } },
    { name: "string submission flag", proof: { providerSubmitted: "false", definitiveFailure: true } },
    { name: "missing definitive flag", proof: { providerSubmitted: false } },
    { name: "non-definitive", proof: { providerSubmitted: false, definitiveFailure: false } },
    { name: "string definitive flag", proof: { providerSubmitted: false, definitiveFailure: "true" } },
    { name: "contradictory uncertainty", proof: { providerSubmitted: false, definitiveFailure: true, stateUncertain: true } },
    { name: "invalid uncertainty type", proof: { providerSubmitted: false, definitiveFailure: true, stateUncertain: "false" } },
    { name: "nested proof", proof: { detail: { providerSubmitted: false, definitiveFailure: true } } }
  ])("retains receipt uncertainty for $name instead of accepting contradictory or incomplete proxy proof", async ({ headers, proof }) => {
    const h = website();
    h.setReply({ error: "supplier-only.fixture / provider-synthetic-key / FX_RATE_STALE / $0.04", code: "CREATIVE_SUPPLY_UNAVAILABLE", ...proof }, 503,
      headers ?? { "X-Sanjie-Provider-Submission": "not-submitted" });
    const result = await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(supplied, { prompt: "商品", productImages: [inputImage(1)] });
    expect(result).toMatchObject({ ok: false, definitiveFailure: false, stateUncertain: true });
    expect(result.providerSubmitted).not.toBe(false); expect(result.proxyNotSubmitted).not.toBe(true);
    expect(result.error).not.toContain("本次未提交生图"); expect(result.error).not.toMatch(/重试|未扣费|未收费|supplier-only|provider-synthetic-key|FX_RATE|\$0\.04/);
    expect(result.raw).toBeUndefined(); expect(result.data).toBeUndefined(); expect(h.requests).toHaveLength(1);
  });

  it.each([
    { multipart: false, status: 401, proof: { providerSubmitted: false, definitiveFailure: true } },
    { multipart: true, status: 503, proof: { providerSubmitted: false, definitiveFailure: true, stateUncertain: true } }
  ])("preserves uncertainty through the OpenAI adapter for mismatched or contradictory proof: $status multipart=$multipart", async ({ multipart, status, proof }) => {
    const cfg = { ...supplied, imageAdapter: "openai-images" }, h = website(cfg);
    h.setReply({ error: "supplier-only.fixture", code: "CREATIVE_SUPPLY_UNAVAILABLE", ...proof }, status,
      { "X-Sanjie-Provider-Submission": "not-submitted" });
    const result = await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createOpenAIImage(cfg, { prompt: "商品", ...(multipart ? { productImages: [inputImage(1)] } : {}) });
    expect(result).toMatchObject({ ok: false, definitiveFailure: false, stateUncertain: true });
    expect(result.providerSubmitted).not.toBe(false); expect(result.proxyNotSubmitted).not.toBe(true);
    expect(result.error).not.toMatch(/本次未提交生图|supplier-only|重试/); expect(h.requests).toHaveLength(1);
  });

  it.each([
    { adapter: "generic-json", multipart: false, code: "CREATIVE_SUPPLY_NOT_CONFIGURED" },
    { adapter: "generic-json", multipart: true, code: "CREATIVE_SUPPLY_NOT_CONFIGURED" },
    { adapter: "openai-images", multipart: false, code: "CREATIVE_SUPPLY_NOT_CONFIGURED" },
    { adapter: "openai-images", multipart: true, code: "CREATIVE_SUPPLY_NOT_CONFIGURED" },
    { adapter: "generic-json", multipart: false, code: "CREATIVE_SUPPLY_UNAVAILABLE" },
    { adapter: "generic-json", multipart: true, code: "CREATIVE_SUPPLY_UNAVAILABLE" },
    { adapter: "openai-images", multipart: false, code: "CREATIVE_SUPPLY_UNAVAILABLE" },
    { adapter: "openai-images", multipart: true, code: "CREATIVE_SUPPLY_UNAVAILABLE" }
  ])("keeps sanitized local $code proof and explicit retry through $adapter multipart=$multipart", async ({ adapter, multipart, code }) => {
    const cfg = { ...supplied, imageAdapter: adapter }, h = website(cfg);
    const api = h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__;
    const generate = (payload: { prompt: string; productImages?: string[] }) => adapter === "openai-images" ? api.createOpenAIImage(cfg, payload) : api.createGenericJsonImage(cfg, payload);
    const payload = { prompt: "商品", ...(multipart ? { productImages: [inputImage(1)] } : {}) };
    h.setReply({ error: "supplier-only.fixture / provider-synthetic-key / FX_RATE_STALE / $0.04", code,
      providerSubmitted: false, definitiveFailure: true, stateUncertain: false, billingEventId: "fixture-billing-1" }, 503,
      { "X-Sanjie-Provider-Submission": "not-submitted" });
    const result = await generate(payload);
    expect(result).toMatchObject({ ok: false, code, httpStatus: 503, proxyNotSubmitted: true, providerSubmitted: false,
      definitiveFailure: true, stateUncertain: false, billingEventId: "fixture-billing-1" });
    expect(result.error).toBe("本次未提交生图。生成服务暂时繁忙，请稍后重试。");
    expect(result.error).not.toMatch(/supplier-only|provider-synthetic-key|FX_RATE|\$0\.04|未扣费|未收费/);
    expect(result.raw).toBeUndefined(); expect(result.data).toBeUndefined(); expect(h.requests).toHaveLength(1);
    h.setReply({ data: [{ url: "https://fixture.test/retry-output.png" }] });
    expect(await generate(payload)).toMatchObject({ ok: true });
    expect(h.requests).toHaveLength(2);
    expect(h.requests[0].headers["idempotency-key"]).not.toBe(h.requests[1].headers["idempotency-key"]);
  });

  it.each([
    { status: 400, code: "CREATIVE_REQUEST_NOT_SUBMITTED" },
    { status: 401, code: "CREATIVE_REQUEST_NOT_SUBMITTED" },
    { status: 402, code: "CREATIVE_REQUEST_NOT_SUBMITTED" },
    { status: 403, code: "CREATIVE_REQUEST_NOT_SUBMITTED" },
    { status: 404, code: "CREATIVE_REQUEST_NOT_SUBMITTED" },
    { status: 413, code: "CREATIVE_REQUEST_NOT_SUBMITTED" },
    { status: 429, code: "CREATIVE_REQUEST_NOT_SUBMITTED" },
    { status: 502, code: "CREATIVE_REQUEST_NOT_SUBMITTED" },
    { status: 503, code: "CREATIVE_REQUEST_NOT_SUBMITTED" },
    { status: 402, code: "INSUFFICIENT_BALANCE" },
    { status: 503, code: "CREDIT_SERVICE_UNAVAILABLE" }
  ])("recognizes proven local $status $code rejections without displaying supplier diagnostics", async ({ status, code }) => {
    const h = website();
    h.setReply({ error: "supplier-only.fixture / provider-synthetic-key", code, providerSubmitted: false, definitiveFailure: true, purchaseUrl: "/models" }, status,
      { "X-Sanjie-Provider-Submission": "not-submitted" });
    const result = await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(supplied, { prompt: "商品" });
    expect(result).toMatchObject({ ok: false, code, httpStatus: status, proxyNotSubmitted: true, providerSubmitted: false,
      definitiveFailure: true, stateUncertain: false, purchaseUrl: "/models" });
    expect(result.error).toContain("本次未提交生图"); expect(result.error).not.toMatch(/supplier-only|provider-synthetic-key|未扣费|未收费/);
    expect(h.requests).toHaveLength(1);
  });

  it("accepts a multipart request just below the 24 MiB conservative budget", async () => {
    const h = website();
    expect(await h.context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.createGenericJsonImage(supplied, { prompt: "a".repeat(24 * 1024 * 1024 - 128 * 1024), productImages: [inputImage(1)] })).toMatchObject({ ok: true });
    expect(h.requests).toHaveLength(1);
    expect((await new Response(h.requests[0].form).blob()).size).toBeLessThan(24 * 1024 * 1024);
  });
});
