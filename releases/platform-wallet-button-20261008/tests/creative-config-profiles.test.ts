import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT;
if (!assetRoot) throw new Error("CREATIVE_ASSET_TEST_ROOT must point to the verified replay fixture");
const script = (file: string) => readFileSync(resolve(assetRoot, file), "utf8");
// Published releases scope accounts inside the profile store; newer website
// shims also scope storage operations and therefore perform a second auth check.
const authPerRead = script("web-chrome.js").includes("global.SZ_WEB_ACCOUNT") ? 2 : 1;
const platformWallet = script("web-chrome.js").includes("usesPlatformWallet: usesPlatformWallet");
const platformApi = { provider: "openai-compatible", label: "少壮平台积分", imageModel: "image2", imageAdapter: "generic-json", platformWallet: true };
const PROFILES_KEY = "sz_image_prompt_lab_config_profiles_v2";
const CONFIG_KEY = "sz_image_prompt_lab_config";
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
    document: { getElementById: () => null, addEventListener() {}, body: { classList: { contains: () => false, toggle() {} } } },
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

describe("hosted Shaozhuang model aliases", () => {
  it("keeps public names in saved config and sends the relay ids that are actually running", () => {
    const api = website().context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__;
    const hosted = api.normalizeCfg({
      provider: "openai-compatible",
      textModel: "gpt-5.6-sol",
      visionModel: "gpt-5.5",
      imageModel: "gpt-image-2"
    });
    expect(hosted).toMatchObject({ textModel: "chatGPT5.5", visionModel: "chatGPT5.5", imageModel: "image2" });
    expect(api.hostedTextUpstreamModel(hosted, hosted.textModel)).toBe("gpt-5.6-sol");
    expect(api.hostedImageUpstreamModel(hosted, hosted.imageModel)).toBe("gpt-image-2");
    expect(api.hostedTextUpstreamModel(hosted, "shop-custom-text")).toBe("shop-custom-text");
    expect(api.hostedImageUpstreamModel(hosted, "gpt-image-2.5-sunburst")).toBe("gpt-image-2.5-sunburst");

    const direct = api.normalizeCfg({ provider: "openai", textModel: "gpt-5.5", imageModel: "gpt-image-2" });
    expect(direct.textModel).toBe("gpt-5.5");
    expect(direct.imageModel).toBe("gpt-image-2");
    expect(api.hostedTextUpstreamModel(direct, direct.textModel)).toBe("gpt-5.5");
    expect(api.hostedImageUpstreamModel(direct, direct.imageModel)).toBe("gpt-image-2");
  });
});

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
    expect(h.calls).toEqual({ auth: authPerRead, reads: 1, writes: 0 });
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
    expect(h.calls).toEqual({ auth: 8 * authPerRead, reads: 8, writes: 0 });
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
    expect((await h.send("GET_BOUND_IMAGE_APIS")).providers).toEqual(platformWallet ? [platformApi] : []);
    expect(h.calls.writes).toBe(0);

    const owner = website();
    await owner.seed(CONFIG_KEY, legacy);
    await owner.seed(PROFILES_KEY, { activeAccount: "user:shop:alice", accounts: { "user:shop:alice": { configs: {} } } });
    const response = await owner.send("GET_BOUND_IMAGE_APIS");
    expect(response.providers?.map((entry) => entry.provider)).toEqual(platformWallet ? ["openai-compatible", "openai"] : ["openai"]);
    expect(owner.calls.writes).toBe(0);
  });

  it("rechecks identity on each read and never returns the previous account's APIs after login changes", async () => {
    const h = website();
    await h.seed(PROFILES_KEY, { accounts: { "user:shop:alice": { configs: { openai: { apiKey: "synthetic-alice", imageModel: "gpt-image-1" } } } } });
    expect((await h.send("GET_BOUND_IMAGE_APIS")).providers).toHaveLength(platformWallet ? 2 : 1);
    h.setUser("bob");
    const response = await h.send("GET_BOUND_IMAGE_APIS");
    if (authPerRead === 2) {
      expect(response.ok).toBe(false);
      expect(response.providers).toBeUndefined();
    } else {
      // The published shim allows a new identity. The caller rejects the changed
      // accountKey; the background must still exclude all of Alice's credentials.
      expect(response).toMatchObject({ ok: true, accountKey: "user:shop:bob", providers: platformWallet ? [platformApi] : [] });
    }
    expect(JSON.stringify(response)).not.toContain("synthetic-alice");
    expect(h.calls.auth).toBe(authPerRead + 1);
    expect(h.calls.writes).toBe(0);
  });

  it("provides a temporary website platform default without storing a Key or replacing an external profile", async () => {
    if (!platformWallet) return;
    const h = website();
    const external = h.normalize({ provider: "openai", apiKey: "", imageModel: "gpt-image-2" });
    await h.seed(PROFILES_KEY, { version: 2, configs: {}, legacyConfigImports: {}, accounts: {
      "user:shop:alice": { activeProvider: "openai", configs: { openai: external } }
    } });
    const before = [...h.localStorage.values.entries()];
    const current = await h.send("GET_CONFIG_PROFILE");
    expect(current).toMatchObject({ ok: true, saved: false, activeProvider: "openai-compatible", config: { provider: "openai-compatible", apiKey: "", imageModel: "image2" } });
    expect((await h.send("GET_CONFIG_PROFILE", { provider: "openai" })).config).toEqual(external);
    expect((await h.send("GET_BOUND_IMAGE_APIS")).providers).toEqual([platformApi]);
    expect(h.calls.writes).toBe(0);
    expect([...h.localStorage.values.entries()]).toEqual(before);

    const own = website(), configured = own.normalize({ provider: "openai", apiKey: "synthetic-original-key", imageModel: "original-image" });
    await own.seed(PROFILES_KEY, { version: 2, configs: {}, legacyConfigImports: {}, accounts: {
      "user:shop:alice": { activeProvider: "openai", configs: { openai: configured } }
    } });
    const original = [...own.localStorage.values.entries()];
    expect((await own.send("GET_CONFIG_PROFILE")).config).toEqual(configured);
    expect(own.calls.writes).toBe(0);
    expect([...own.localStorage.values.entries()]).toEqual(original);

    const hosted = website(), selected = hosted.normalize({ provider: "openai-compatible", apiKey: "", imageModel: "selected-platform-model", imageAdapter: "openai-images" });
    await hosted.seed(PROFILES_KEY, { version: 2, configs: {}, legacyConfigImports: {}, accounts: {
      "user:shop:alice": { activeProvider: "openai-compatible", configs: { "openai-compatible": selected } }
    } });
    expect((await hosted.send("GET_CONFIG_PROFILE")).config).toEqual(selected);
    expect((await hosted.send("GET_BOUND_IMAGE_APIS")).providers).toEqual([{ ...platformApi, imageModel: selected.imageModel, imageAdapter: selected.imageAdapter }]);
    expect(hosted.calls.writes).toBe(0);
  });
});
