import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { constants } from "node:fs";
vi.mock("server-only", () => ({}));
const fixture = vi.hoisted(() => ({
  bytes: Buffer.alloc(0), filename: "/opt/private-video/config.json", file: { uid: 0, gid: 0, mode: 0o100600, nlink: 1, dev: 1, ino: 20, mtimeMs: 1, ctimeMs: 1 },
  directoryUid: 0, directoryMode: 0o40700, symlink: false, directorySymlink: false,
  partialRead: false, changed: false, openError: false,
  getRelay: vi.fn(), open: vi.fn(), close: vi.fn(), lstat: vi.fn()
}));
vi.mock("./relay-config", () => ({ getRelayRuntime: fixture.getRelay }));
vi.mock("node:fs/promises", () => ({
  lstat: fixture.lstat,
  open: fixture.open
}));
import { parseNativeVideoSupplyConfig, readNativeVideoSupplyConfig, getNativeVideoCreateSupply, getNativeVideoSupplyForJob,
  sub2VideoBindingFingerprint, NATIVE_VIDEO_CONFIG_ENV, NATIVE_VIDEO_DEFAULT_CONFIG_FILE, NATIVE_VIDEO_CONFIG_MAX_BYTES } from "./native-video-supply";
import { nativeTariff, nativeTokenCost, parseNativeVideoConfig, validateNativeRequest, digest, stable } from "./native-video-contract";

// Synthetic test-only amounts. These fixtures are never an operator price proposal.
const model = () => ({ id: "seedance-2.5", label: "Fixture Ark", upstreamModel: "doubao-seedance-2-5-260628", priceVersion: "fixture-v1",
  reservationCents: 50, durations: [4, 8, 30], resolutions: ["720p", "1080p"], ratios: ["16:9", "adaptive"], generateAudio: true,
  mediaHosts: ["media.example.com"], priceTiers: [
    { resolution: "720p", hasVideoInput: false, completionCentsPerMillion: 100 },
    { resolution: "720p", hasVideoInput: true, completionCentsPerMillion: 200 },
    { resolution: "1080p", hasVideoInput: false, completionCentsPerMillion: 300 },
    { resolution: "1080p", hasVideoInput: true, completionCentsPerMillion: 400 }
  ] });
const config = () => ({ version: 1, enabled: true, activeBindingId: "ark-v1", bindings: [
  { provider: "ark", bindingId: "ark-v1", apiKey: "synthetic-ark-key-v1", models: [model()] }
] });
function legacy() {
  const { priceTiers: _tiers, ...common } = model();
  return { enabled: true, bindingId: "legacy-v1", models: [{ ...common, id: "seedance-2.0", upstreamModel: "fixture-legacy-model", ratios: ["16:9"], completionCentsPerMillion: 100 }] };
}
const body = () => ({ model: "seedance-2.5", expectedAccount: "tenant:alice", content: [{ type: "text", text: "fixture" }],
  duration: 4, resolution: "720p", ratio: "16:9", generate_audio: false });
const asset = (type: string, role: string) => ({ type, role, [type]: { url: "https://input.example.com/owned-fixture" } });
const parsedModel = () => parseNativeVideoSupplyConfig(JSON.stringify(config())).bindings[0].models[0];
function fileStat(changed = false) { return { ...fixture.file, size: fixture.bytes.length, ino: changed ? fixture.file.ino + 1 : fixture.file.ino,
  isFile: () => true, isSymbolicLink: () => fixture.symlink }; }
function install(value: unknown = config()) { fixture.bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value)); }

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(NATIVE_VIDEO_CONFIG_ENV, "/opt/private-video/config.json");
  vi.stubEnv("MODEL_GATEWAY_SEEDANCE_CONFIG", JSON.stringify(legacy()));
  Object.assign(fixture.file, { uid: 0, gid: 0, mode: 0o100600, nlink: 1, dev: 1, ino: 20, mtimeMs: 1, ctimeMs: 1 });
  Object.assign(fixture, { filename: "/opt/private-video/config.json", directoryUid: 0, directoryMode: 0o40700, symlink: false, directorySymlink: false, partialRead: false, changed: false, openError: false });
  install();
  fixture.getRelay.mockResolvedValue({ apiKey: "legacy-image-key", baseUrl: "https://sub.shaozhuangai.com/v1" });
  fixture.lstat.mockImplementation(async (filename: string) => filename === fixture.filename ? fileStat()
    : { uid: fixture.directoryUid, mode: fixture.directoryMode, isDirectory: () => true, isSymbolicLink: () => fixture.directorySymlink });
  fixture.close.mockResolvedValue(undefined);
  fixture.open.mockImplementation(async (filename: string) => {
    if (filename !== fixture.filename) throw Object.assign(new Error("fixture absent"), { code: "ENOENT" });
    if (fixture.openError) throw new Error("secret-original-error synthetic-ark-key-v1");
    let stats = 0;
    return { stat: async () => fileStat(fixture.changed && ++stats > 1), close: fixture.close,
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const size = Math.min(length, fixture.bytes.length - position, fixture.partialRead ? 7 : Infinity);
        if (size > 0) fixture.bytes.copy(buffer, offset, position, position + size);
        return { bytesRead: Math.max(0, size), buffer };
      } };
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("private native-video configuration and exact tariffs", () => {
  it("accepts a disabled empty configuration without a key or invented price", () => {
    expect(parseNativeVideoSupplyConfig('{"version":1,"enabled":false,"activeBindingId":"","bindings":[]}')).toEqual({ version: 1, enabled: false, activeBindingId: "", bindings: [] });
  });
  it("selects the exact resolution and reference-video tier and freezes a scalar", () => {
    const m = parsedModel();
    for (const resolution of ["720p", "1080p"]) for (const hasVideo of [false, true]) {
      const request = { ...body(), resolution, content: [...body().content, ...(hasVideo ? [asset("video_url", "reference_video")] : [])] };
      validateNativeRequest(request, m);
      const tariff = nativeTariff(m, request);
      expect(tariff.completionCentsPerMillion).toBe(resolution === "720p" ? hasVideo ? 200 : 100 : hasVideo ? 400 : 300);
      expect(tariff).not.toHaveProperty("priceTiers");
      m.priceTiers![0].completionCentsPerMillion = 999;
      expect(tariff.completionCentsPerMillion).not.toBe(999);
      m.priceTiers![0].completionCentsPerMillion = 100;
    }
    expect(nativeTokenCost(1000001, nativeTariff(m, body()))).toBe(101);
  });
  it.each(["missing", "duplicate", "wrong-resolution", "fraction", "negative", "scalar", "unknown-tier-field"])("rejects malformed tier %s", kind => {
    const cfg = config(); const m = cfg.bindings[0].models[0];
    if (kind === "missing") m.priceTiers.pop();
    if (kind === "duplicate") m.priceTiers[1] = { ...m.priceTiers[0] };
    if (kind === "wrong-resolution") m.priceTiers[0].resolution = "480p";
    if (kind === "fraction") m.priceTiers[0].completionCentsPerMillion = 1.5;
    if (kind === "negative") m.priceTiers[0].completionCentsPerMillion = -1;
    if (kind === "scalar") Object.assign(m, { completionCentsPerMillion: 100 });
    if (kind === "unknown-tier-field") Object.assign(m.priceTiers[0], { upstreamUrl: "https://evil.example" });
    expect(() => parseNativeVideoSupplyConfig(JSON.stringify(cfg))).toThrow();
  });
  it.each(["root", "binding", "model", "duplicate-id", "unknown-active", "empty-key", "header-key"])("rejects unsupported config %s", kind => {
    const cfg = config();
    if (kind === "root") Object.assign(cfg, { baseUrl: "https://evil.example" });
    if (kind === "binding") Object.assign(cfg.bindings[0], { endpoint: "https://evil.example" });
    if (kind === "model") Object.assign(cfg.bindings[0].models[0], { arbitrary: true });
    if (kind === "duplicate-id") cfg.bindings.push({ ...cfg.bindings[0] });
    if (kind === "unknown-active") cfg.activeBindingId = "unknown";
    if (kind === "empty-key") cfg.bindings[0].apiKey = "";
    if (kind === "header-key") cfg.bindings[0].apiKey = "key\r\nAuthorization: leak";
    expect(() => parseNativeVideoSupplyConfig(JSON.stringify(cfg))).toThrow();
  });
  it.each(['{"version":1,"version":1}', '{"version":1,"\\u0076ersion":1}', 'null', '[]', '{broken'])("rejects duplicate keys and invalid JSON %s", raw => {
    expect(() => parseNativeVideoSupplyConfig(raw)).toThrow();
  });
  it("rejects oversized config and does not infer a tariff for unmatched requests", () => {
    expect(() => parseNativeVideoSupplyConfig(" ".repeat(NATIVE_VIDEO_CONFIG_MAX_BYTES + 1))).toThrow();
    expect(() => nativeTariff(parsedModel(), { ...body(), resolution: "480p" })).toThrow();
  });
  it("preserves the explicit legacy scalar configuration", () => {
    const m = parseNativeVideoConfig(JSON.stringify(legacy())).models[0];
    expect(nativeTariff(m).completionCentsPerMillion).toBe(100);
  });
});

describe("official model constraints before reservation or provider dispatch", () => {
  it.each(["duration-low", "duration-high", "duration-smart", "resolution-4k", "model-id-mismatch", "unknown-model", "opaque-endpoint"])("rejects unsafe 2.5 configuration %s", kind => {
    const cfg = config(); const m = cfg.bindings[0].models[0];
    if (kind === "duration-low") m.durations = [3];
    if (kind === "duration-high") m.durations = [31];
    if (kind === "duration-smart") m.durations = [-1];
    if (kind === "resolution-4k") m.resolutions = ["4k"];
    if (kind === "model-id-mismatch") m.upstreamModel = "doubao-seedance-2-0-260128";
    if (kind === "unknown-model") m.upstreamModel = "doubao-seedance-unverified-review";
    if (kind === "opaque-endpoint") m.upstreamModel = "ep-unverified-endpoint";
    expect(() => parseNativeVideoSupplyConfig(JSON.stringify(cfg))).toThrow();
  });
  it("preserves first/last roles and requires 2.5 adaptive without rewriting the request", () => {
    const request = { ...body(), content: [...body().content, asset("image_url", "first_frame"), asset("image_url", "last_frame")] };
    expect(() => validateNativeRequest(request, parsedModel())).toThrow();
    expect(request.ratio).toBe("16:9");
    const valid = { ...request, ratio: "adaptive" };
    expect(validateNativeRequest(valid, parsedModel())).toMatchObject({ content: valid.content });
    expect(() => validateNativeRequest({ ...valid, content: [...body().content, asset("image_url", "last_frame")] }, parsedModel())).toThrow();
  });
  it("permits 2.5 audio-only references but requires an image or video for 2.0", () => {
    const audio = asset("audio_url", "reference_audio"); const request = { ...body(), content: [...body().content, audio] };
    expect(() => validateNativeRequest(request, parsedModel())).not.toThrow();
    const cfg = config(); Object.assign(cfg.bindings[0].models[0], { id: "seedance-2.0", upstreamModel: "doubao-seedance-2-0-260128", durations: [4, 15] });
    const m = parseNativeVideoSupplyConfig(JSON.stringify(cfg)).bindings[0].models[0];
    expect(() => validateNativeRequest(request, m)).toThrow();
    expect(() => validateNativeRequest({ ...request, content: [...request.content, asset("image_url", "reference_image")] }, m)).not.toThrow();
  });
  it("does not open edit, extend, draft, arbitrary fields or smart duration", () => {
    for (const patch of [{ duration: -1 }, { omni_reference_task_type: "edit" }, { omni_reference_task_type: "extend" }, { draft: true }, { callback_url: "https://evil.example" }]) {
      expect(() => validateNativeRequest({ ...body(), ...patch }, parsedModel())).toThrow();
    }
  });
});

describe("root-owned stable file reader and supply isolation", () => {
  it("reads bounded partial IO using NOFOLLOW, never image relay for configured Ark", async () => {
    fixture.partialRead = true;
    const selected = await getNativeVideoCreateSupply();
    expect(selected).toMatchObject({ kind: "ark", provider: "volc", key: "synthetic-ark-key-v1", endpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks" });
    expect(fixture.open.mock.calls[0][1] & constants.O_NOFOLLOW).toBeTruthy();
    expect(fixture.close).toHaveBeenCalledOnce(); expect(fixture.getRelay).not.toHaveBeenCalled();
  });
  it.each(["file-owner", "file-mode", "file-setuid", "hardlink", "symlink", "ancestor-owner", "ancestor-write", "ancestor-symlink", "changed", "io-error", "invalid-utf8"])("rejects %s without secret leakage or legacy creation fallback", async kind => {
    if (kind === "file-owner") fixture.file.uid = 501;
    if (kind === "file-mode") fixture.file.mode = 0o100644;
    if (kind === "file-setuid") fixture.file.mode = 0o104600;
    if (kind === "hardlink") fixture.file.nlink = 2;
    if (kind === "symlink") fixture.symlink = true;
    if (kind === "ancestor-owner") fixture.directoryUid = 501;
    if (kind === "ancestor-write") fixture.directoryMode = 0o40777;
    if (kind === "ancestor-symlink") fixture.directorySymlink = true;
    if (kind === "changed") fixture.changed = true;
    if (kind === "io-error") fixture.openError = true;
    if (kind === "invalid-utf8") fixture.bytes = Buffer.from([0xff]);
    await expect(getNativeVideoCreateSupply()).rejects.toMatchObject({ code: "NATIVE_VIDEO_CONFIG_INVALID" });
    await expect(getNativeVideoCreateSupply()).rejects.not.toThrow("synthetic-ark-key-v1");
    expect(fixture.getRelay).not.toHaveBeenCalled();
  });
  it.each(["", "relative.json", "/opt/private/../config.json", "/opt//config.json"])("rejects noncanonical private path %s", async filename => {
    vi.stubEnv(NATIVE_VIDEO_CONFIG_ENV, filename);
    await expect(readNativeVideoSupplyConfig()).rejects.toThrow(); expect(fixture.open).not.toHaveBeenCalled();
  });
  it("explicit disabled file does not fall back to an enabled image relay", async () => {
    install({ version: 1, enabled: false, activeBindingId: "", bindings: [] });
    await expect(getNativeVideoCreateSupply()).rejects.toMatchObject({ code: "NATIVE_VIDEO_DISABLED" });
    expect(fixture.getRelay).not.toHaveBeenCalled();
  });
  it("preserves explicit legacy creation only when independent configuration is absent", async () => {
    vi.stubEnv(NATIVE_VIDEO_CONFIG_ENV, undefined);
    const selected = await getNativeVideoCreateSupply();
    expect(selected).toMatchObject({ kind: "sub2api", provider: "shaozhuang", key: "legacy-image-key" });
    expect(selected.binding).toBe(digest(stable({ base: "https://sub.shaozhuangai.com", keyHash: digest("legacy-image-key"), bindingId: "legacy-v1" })));
    expect(selected.binding).toBe(sub2VideoBindingFingerprint("legacy-image-key", "legacy-v1"));
    expect(fixture.open).toHaveBeenCalledWith(NATIVE_VIDEO_DEFAULT_CONFIG_FILE, expect.any(Number));
    vi.stubEnv("MODEL_GATEWAY_SEEDANCE_CONFIG", undefined);
    await expect(getNativeVideoCreateSupply()).rejects.toMatchObject({ code: "NATIVE_VIDEO_SUPPLY_UNAVAILABLE" });
  });
  it("keeps original Ark key and endpoint after active switch, disable and price change", async () => {
    const original = await getNativeVideoCreateSupply();
    const cfg = config(); cfg.enabled = false; cfg.activeBindingId = "ark-v2";
    cfg.bindings[0].models = [];
    cfg.bindings.push({ provider: "ark", bindingId: "ark-v2", apiKey: "synthetic-ark-key-v2", models: [model()] });
    cfg.bindings[1].models[0].priceTiers[0].completionCentsPerMillion = 999;
    install(cfg);
    const retained = await getNativeVideoSupplyForJob(original.binding);
    expect(retained.key).toBe(original.key); expect(retained.endpoint).toBe(original.endpoint);
    expect(retained.binding).toBe(original.binding); expect(fixture.getRelay).not.toHaveBeenCalled();
    cfg.bindings.shift(); install(cfg);
    await expect(getNativeVideoSupplyForJob(original.binding)).rejects.toMatchObject({ code: "NATIVE_VIDEO_BINDING_CHANGED" });
  });
  it("reads the fixed default file on every call without environment edits or restart", async () => {
    vi.stubEnv(NATIVE_VIDEO_CONFIG_ENV, undefined);
    fixture.filename = NATIVE_VIDEO_DEFAULT_CONFIG_FILE;
    expect((await getNativeVideoCreateSupply()).kind).toBe("ark");
    const cfg = config(); cfg.enabled = false; install(cfg);
    await expect(getNativeVideoCreateSupply()).rejects.toMatchObject({ code: "NATIVE_VIDEO_DISABLED" });
    expect(fixture.getRelay).not.toHaveBeenCalled();
  });
  it("does not treat disappearance after opening the default file as permission to switch supply", async () => {
    vi.stubEnv(NATIVE_VIDEO_CONFIG_ENV, undefined);
    fixture.filename = NATIVE_VIDEO_DEFAULT_CONFIG_FILE;
    fixture.lstat.mockImplementation(async (filename: string) => {
      if (filename === fixture.filename) throw Object.assign(new Error("fixture removed while reading"), { code: "ENOENT" });
      return { uid: 0, mode: 0o40700, isDirectory: () => true, isSymbolicLink: () => false };
    });
    await expect(getNativeVideoCreateSupply()).rejects.toMatchObject({ code: "NATIVE_VIDEO_CONFIG_INVALID" });
    expect(fixture.getRelay).not.toHaveBeenCalled();
  });
  it("queries an exact original Sub2 job even when Ark is now active or invalid", async () => {
    const fingerprint = sub2VideoBindingFingerprint("legacy-image-key", "legacy-v1");
    expect((await getNativeVideoSupplyForJob(fingerprint)).kind).toBe("sub2api");
    install("invalid-private-config");
    expect((await getNativeVideoSupplyForJob(fingerprint)).key).toBe("legacy-image-key");
    fixture.getRelay.mockResolvedValue({ apiKey: "changed-key", baseUrl: "https://sub.shaozhuangai.com/v1" });
    await expect(getNativeVideoSupplyForJob(fingerprint)).rejects.toMatchObject({ code: "NATIVE_VIDEO_BINDING_CHANGED" });
  });
});
