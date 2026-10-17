import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const script = (file: string) => readFileSync(resolve(assetRoot, file), "utf8");
const PROFILES_KEY = "sz_image_prompt_lab_config_profiles_v2";
const CONFIG_KEY = "sz_image_prompt_lab_config";
// The shipped website selector also advertises its keyless platform wallet.
const platformApi = { provider: "openai-compatible", label: "少壮平台积分", imageModel: "image2", imageAdapter: "generic-json", platformWallet: true };
type ImageApi = { provider: string; label: string; imageModel: string; imageAdapter: string };
type MessageResponse = { ok: boolean; accountKey?: string; providers?: ImageApi[]; catalog?: Array<{ provider: string; label: string }>; saved?: boolean; config?: Record<string, string>; error?: string };

function memoryStorage() {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] || null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }, values };
}

function website() {
  let username = "alice";
  const calls = { auth: 0, reads: 0, writes: 0 };
  const localStorage = memoryStorage();
  const context = createContext({ URL, URLSearchParams, Request, Headers, Response, Blob, FormData, TextEncoder,
    ArrayBuffer, Uint8Array, btoa, atob, console, setTimeout, clearTimeout, localStorage, sessionStorage: memoryStorage(),
    __SZ_PROMPTLAB_BACKGROUND_TEST_MODE__: true,
    location: { href: "https://site.test/creative/labs/image-prompt-lab/promptlab.html?studio=1", origin: "https://site.test", search: "?studio=1" },
    document: { getElementById: () => null, addEventListener() {},
      createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, appendChild() {} }),
      body: { appendChild() {}, classList: { contains: () => false, toggle() {} } } },
    addEventListener() {},
    fetch: async (input: string) => {
      if (input !== "/api/auth/me") throw new Error(`Unexpected network request: ${input}`);
      calls.auth++;
      return Response.json({ data: { tenantId: "shop", username, creativeEntitlement: { allowed: true } } });
    } });
  context.window = context;
  for (const file of ["web-chrome.js", "src/business-knowledge.js", "src/subject-orchestration.js", "src/subject-assets.js", "src/reference-detail-contract.js",
    "labs/image-prompt-lab/reference-detail-blueprint.js", "labs/image-prompt-lab/reference-detail-batch.js", "labs/image-prompt-lab/viral-series-contract.js",
    "labs/image-prompt-lab/style-refresh-contract.js", "labs/image-prompt-lab/creative-tools-contract.js", "labs/image-prompt-lab/image-archive-store.js",
    "labs/image-prompt-lab/background.js"]) runInContext(script(file), context, { filename: file });
  const get = context.chrome.storage.local.get.bind(context.chrome.storage.local);
  const set = context.chrome.storage.local.set.bind(context.chrome.storage.local);
  context.chrome.storage.local.get = (...args: unknown[]) => { calls.reads++; return get(...args); };
  context.chrome.storage.local.set = (...args: unknown[]) => { calls.writes++; return set(...args); };
  const send = (type: string, payload: object = {}) => new Promise<MessageResponse>((done) => context.chrome.runtime.sendMessage({ type, ...payload }, done));
  const seed = async (key: string, value: unknown) => {
    // Seed through the actual shim so both published and new storage layouts are
    // exercised. Fixture setup writes are excluded from the read-only operation.
    await context.chrome.storage.local.set({ [key]: value });
    calls.auth = 0; calls.reads = 0; calls.writes = 0;
  };
  const normalize = (config: Record<string, string>) => context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.normalizeCfg(config) as Record<string, string>;
  return { context, calls, send, seed, normalize, localStorage, setUser: (value: string) => { username = value; } };
}

describe("bound image API selector snapshots", () => {
  it("reads once with fresh identity, returns the same selector as eight profile reads and never writes or leaks credentials", async () => {
    const h = website();
    await h.seed(PROFILES_KEY, { version: 2, configs: {}, legacyConfigImports: {}, accounts: {
      "user:shop:alice": { activeProvider: "openai-compatible", configs: {
        "openai-compatible": h.normalize({ provider: "openai-compatible", apiKey: "synthetic-alice-key", imageModel: "private-reference-model" }),
        openai: h.normalize({ provider: "openai", apiKey: "synthetic-openai-key", imageModel: "gpt-image-1" }),
        "deepseek-v4": h.normalize({ provider: "deepseek-v4", apiKey: "synthetic-text-key" }),
        zhipu: h.normalize({ provider: "zhipu", apiKey: "synthetic-cogview-key", imageModel: "cogview-4" }),
        "nano-banana": h.normalize({ provider: "nano-banana", apiKey: " " })
      } },
      "user:shop:bob": { activeProvider: "doubao", configs: { doubao: h.normalize({ provider: "doubao", apiKey: "synthetic-bob-key" }) } }
    } });
    const before = [...h.localStorage.values.entries()];
    const bulk = await h.send("GET_BOUND_IMAGE_APIS");
    expect(bulk).toMatchObject({ ok: true, accountKey: "user:shop:alice" });
    expect(bulk.providers?.map((entry) => entry.provider)).toEqual(["openai-compatible", "openai"]);
    expect(h.calls).toEqual({ auth: 1, reads: 1, writes: 0 });
    expect([...h.localStorage.values.entries()]).toEqual(before);
    expect(JSON.stringify(bulk)).not.toContain("synthetic-");
    expect(bulk.providers?.every((entry) => Object.keys(entry).sort().join(",") === "imageAdapter,imageModel,label,provider")).toBe(true);

    h.calls.auth = 0; h.calls.reads = 0; h.calls.writes = 0;
    const catalog = (await h.send("GET_CONFIG_CATALOG")).catalog || [];
    const old = await Promise.all(catalog.map(async (entry) => {
      const profile = await h.send("GET_CONFIG_PROFILE", { provider: entry.provider });
      const config = profile.config || {};
      if (!profile.saved || !String(config.apiKey || "").trim() || !config.imageEndpoint || !config.imageModel ||
        !h.context.SZ_CREATIVE_TOOLS_CONTRACT.supportsReferenceConfig(config)) return null;
      return { provider: config.provider, label: entry.label, imageModel: config.imageModel, imageAdapter: config.imageAdapter };
    }));
    expect(bulk.providers).toEqual(old.filter(Boolean));
    // Each queued profile operation still reads fresh identity once, with no
    // extra storage-level auth trip or writes and no credential exposure.
    expect(h.calls).toEqual({ auth: 8, reads: 8, writes: 0 });
  });

  it("uses normalized saved defaults while excluding unsaved presets and leaving old configuration untouched", async () => {
    const h = website();
    await h.seed(PROFILES_KEY, { accounts: { "user:shop:alice": { configs: {
      "openai-compatible": { apiKey: "synthetic-private-key" },
      doubao: { apiKey: "synthetic-volc-key", imageAdapter: "volcengine-image", imageModel: "doubao-seedream-3-0-t2i-250415" }
    } } } });
    const before = [...h.localStorage.values.entries()];
    const response = await h.send("GET_BOUND_IMAGE_APIS");
    expect(response.providers).toEqual([
      { provider: "openai-compatible", label: "少壮托管 / Auto Mode", imageModel: "image2", imageAdapter: "generic-json" },
      { provider: "doubao", label: "集梦 / 豆包 / 火山方舟", imageModel: "doubao-seedream-5-0-260128", imageAdapter: "doubao-image" }
    ]);
    expect(h.calls.writes).toBe(0);
    expect([...h.localStorage.values.entries()]).toEqual(before);
  });

  it("includes only owned legacy credentials and never falls back to shared or another account's API", async () => {
    const h = website();
    const legacy = h.normalize({ provider: "openai", apiKey: "synthetic-owned-key", imageModel: "gpt-image-1" });
    await h.seed(CONFIG_KEY, legacy);
    await h.seed(PROFILES_KEY, { activeAccount: "user:shop:bob", configs: { openai: legacy }, accounts: {
      "user:shop:bob": { configs: { openai: legacy } }, "user:shop:alice": { configs: {} }
    } });
    expect((await h.send("GET_BOUND_IMAGE_APIS")).providers).toEqual([platformApi]);
    expect(h.calls.writes).toBe(0);

    const owner = website();
    await owner.seed(CONFIG_KEY, legacy);
    await owner.seed(PROFILES_KEY, { activeAccount: "user:shop:alice", accounts: { "user:shop:alice": { configs: {} } } });
    const response = await owner.send("GET_BOUND_IMAGE_APIS");
    expect(response.providers?.map((entry) => entry.provider)).toEqual(["openai-compatible", "openai"]);
    expect(response.providers?.[0]).toEqual(platformApi);
    expect(owner.calls.writes).toBe(0);
  });

  it("rechecks identity on each read and never returns the previous account's APIs after login changes", async () => {
    const h = website();
    await h.seed(PROFILES_KEY, { accounts: { "user:shop:alice": { configs: { openai: { apiKey: "synthetic-alice", imageModel: "gpt-image-1" } } } } });
    const initial = await h.send("GET_BOUND_IMAGE_APIS");
    expect(initial.providers?.map((entry) => entry.provider)).toEqual(["openai-compatible", "openai"]);
    expect(initial.providers?.[0]).toEqual(platformApi);
    h.setUser("bob");
    const response = await h.send("GET_BOUND_IMAGE_APIS");
    expect(response.ok).toBe(false);
    expect(response.providers).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain("synthetic-alice");
    expect(h.calls.auth).toBe(2);
    expect(h.calls.writes).toBe(0);
  });
});
