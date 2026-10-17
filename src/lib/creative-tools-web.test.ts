import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";

const asset = (marker: number) => {
  const bytes = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(64, 16);
  bytes.writeUInt32BE(64, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  bytes[26] = marker;
  return `data:image/png;base64,${bytes.toString("base64")}`;
};
const PRODUCT = asset(1), SECOND_PRODUCT = asset(2), MODEL = asset(3), SCENE = asset(4), OUTPUT = asset(5);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const script = (file: string) => readFileSync(resolve(assetRoot, file), "utf8");
const hasAccountGuards = script("web-chrome.js").includes("global.SZ_WEB_ACCOUNT");
const configuration = {
  provider: "openai-compatible", imageAdapter: "generic-json", apiKey: "synthetic-key",
  imageEndpoint: "https://configured-provider.test/v1/custom-images", imageModel: "configured-image-model",
  visionBaseUrl: "https://configured-provider.test/v1", visionModel: "configured-vision-model", textModel: "configured-text-model"
};

function storage() {
  const records = new Map<string, string>();
  return {
    get length() { return records.size; },
    key: (index: number) => [...records.keys()][index] || null,
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); },
    removeItem: (key: string) => { records.delete(key); }
  };
}

function website() {
  let username = "alice", allowed = true;
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const inputs = Object.fromEntries(Object.entries(configuration).map(([key, value]) => [key, {
    value, focus() {}, setAttribute() {}, classList: { toggle() {} }
  }]));
  const context = createContext({
    URL, URLSearchParams, Request, Headers, Response, Blob, FormData, TextEncoder, TextDecoder,
    ArrayBuffer, Uint8Array, btoa, atob, console, setTimeout, clearTimeout, AbortController,
    crypto: webcrypto, localStorage: storage(), sessionStorage: storage(),
    __SZ_PROMPTLAB_BACKGROUND_TEST_MODE__: true, __SZ_PROMPTLAB_TEST_MODE__: true,
    location: { href: "https://shaozhuangai.com/creative/labs/image-prompt-lab/promptlab.html?mode=creative&tool=buyer&source=web", origin: "https://shaozhuangai.com", search: "?mode=creative&tool=buyer&source=web" },
    document: {
      getElementById: (id: string) => inputs[id] || null, addEventListener() {},
      createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, appendChild() {} }),
      body: { appendChild() {}, classList: { contains() { return false; }, toggle() {} } }
    },
    addEventListener() {}, dispatchEvent() {},
    fetch: async (input: string, init?: RequestInit) => {
      if (input === "/api/auth/me") return Response.json({ data: { id: `fixture-${username}`, tenantId: "shop", username, creativeEntitlement: { allowed } } });
      if (input !== "/api/creative/proxy") throw new Error(`Unexpected native network request: ${String(input)}`);
      const envelope = JSON.parse(String(init?.body));
      const bodyText = envelope.bodyText || Buffer.from(envelope.bodyBase64, "base64").toString();
      requests.push({ url: envelope.url, method: envelope.method, headers: envelope.headers, body: JSON.parse(bodyText) });
      return Response.json({ data: [{ url: OUTPUT }] });
    }
  });
  context.window = context;
  for (const file of [
    "web-chrome.js", "src/business-knowledge.js", "src/subject-orchestration.js", "src/subject-assets.js", "src/reference-detail-contract.js",
    "labs/image-prompt-lab/reference-detail-blueprint.js", "labs/image-prompt-lab/reference-detail-batch.js",
    "labs/image-prompt-lab/viral-series-contract.js", "labs/image-prompt-lab/style-refresh-contract.js",
    "labs/image-prompt-lab/creative-tools-contract.js", "labs/image-prompt-lab/image-archive-store.js", "labs/image-prompt-lab/background.js"
  ]) runInContext(script(file), context, { filename: file });
  runInContext(script("labs/image-prompt-lab/promptlab.js"), context, { filename: "promptlab.js" });
  const send = (type: string, message: object) => new Promise((done) => context.chrome.runtime.sendMessage({ type, ...message }, done));
  return { context, bridge: context.SZ_CREATIVE_TOOLS_BRIDGE, requests, send, setUser: (next: string) => { username = next; }, setAllowed: (next: boolean) => { allowed = next; } };
}

async function reviewedPlan(h: ReturnType<typeof website>, tool: "clothing" | "buyer" | "refinement") {
  const saved = await h.send("SAVE_CONFIG", { config: configuration }) as { ok: boolean; error?: string };
  expect(saved.ok, saved.error).toBe(true);
  expect(h.bridge).toBeDefined();
  const accountKey = await h.bridge.getAccountKey();
  h.context.__SZ_PROMPTLAB_TEST_API__.state.archiveAccountKey = accountKey;
  const input = {
    tool,
    products: tool === "refinement" ? [PRODUCT, SECOND_PRODUCT] : [PRODUCT],
    ...(tool !== "refinement" ? { modelImage: MODEL, sceneImage: SCENE } : {}),
    config: { name: "网站测试商品", count: 1, ratio: "3:4", resolution: "1K", requirements: "保持商品原貌" }
  };
  const archived: Array<{ item: Record<string, unknown>; owner: Record<string, unknown> }> = [];
  let pending: unknown = null;
  const controller = h.context.SZ_CREATIVE_TOOLS_CONTRACT.createController({
    readInput: () => input,
    config: h.bridge.config,
    send: h.bridge.send,
    archiveContext: h.bridge.archiveContext,
    archive: async (item: Record<string, unknown>, owner: Record<string, unknown>) => { archived.push({ item: clone(item), owner: clone(owner) }); return { ok: true }; },
    journal: { read: () => pending, write: (receipt: unknown) => { pending = receipt; }, clear: () => { pending = null; } }
  });
  const plan = controller.buildPlan();
  expect(plan.ok, plan.error).toBe(true);
  return { controller, archived, accountKey };
}

describe("creative tools through the website runtime and provider proxy", () => {
  it("exposes the actual page bridge at script load and reads only this account's saved API", async () => {
    const h = website();
    expect(h.bridge).toBeDefined();
    const f = await reviewedPlan(h, "buyer");
    const catalog = await h.bridge.listBoundApis();
    expect(catalog.ok, catalog.error).toBe(true);
    expect(catalog.accountKey).toBe(f.accountKey);
    expect(catalog.providers.map((provider: { provider: string }) => provider.provider)).toEqual(["openai-compatible"]);
    expect(JSON.stringify(catalog)).not.toContain("synthetic-key");
    expect(h.bridge.modelInfo().ready).toBe(true);
    expect(h.requests).toEqual([]);
  });
  for (const tool of ["clothing", "buyer", "refinement"] as const) {
    it(`${tool} reviews locally and sends only explicit generation through the website proxy`, async () => {
      const h = website();
      const f = await reviewedPlan(h, tool);
      expect(h.requests).toEqual([]);
      const result = await f.controller.generate();
      expect(result.ok, f.controller.state.message).toBe(true);
      expect(h.requests).toHaveLength(tool === "refinement" ? 2 : 1);
      h.requests.forEach((request, index) => {
        expect(request.url).toBe("https://configured-provider.test/v1/custom-images");
        expect(request.method).toBe("POST");
        expect(request.headers.authorization ?? request.headers.Authorization).toBe("Bearer synthetic-key");
        expect(request.body.model).toBe("configured-image-model");
        expect(request.body.n).toBe(1);
        expect(request.body.product_images).toEqual([tool === "refinement" && index === 1 ? SECOND_PRODUCT : PRODUCT]);
        expect(request.body.model_images).toEqual(tool === "refinement" ? [] : [MODEL]);
        expect(request.body.reference_images).toEqual(tool === "refinement" ? [] : [SCENE]);
      });
      expect(f.archived).toHaveLength(h.requests.length);
      expect(f.archived.every(({ owner, item }) => owner.accountKey === f.accountKey && item.creativeTool === tool)).toBe(true);
      await f.controller.generate();
      expect(h.requests).toHaveLength(f.archived.length);
    });
  }

  it.skipIf(!hasAccountGuards)("blocks an old reviewed page after the website login account changes", async () => {
    const h = website();
    const f = await reviewedPlan(h, "buyer");
    h.setUser("bob");
    expect((await h.context.authCheck()).ok).toBe(false);
    expect((await f.controller.generate()).ok).toBe(false);
    expect(h.requests).toEqual([]);
    expect(f.archived).toEqual([]);
    expect(f.controller.state.plan).not.toBeNull();
  });

  it.skipIf(!hasAccountGuards)("rechecks studio entitlement before a reviewed plan can call the provider", async () => {
    const h = website();
    const f = await reviewedPlan(h, "buyer");
    h.setAllowed(false);
    expect((await f.controller.generate()).ok).toBe(false);
    expect(h.requests).toEqual([]);
    expect(f.archived).toEqual([]);
  });
});
