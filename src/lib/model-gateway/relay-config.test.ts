import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseEcbXml } from "./exchange-rate-core.mjs";
import { tmpdir } from "node:os";

const network = vi.hoisted(() => ({ assertPublicRelayUrl: vi.fn(), relayFetch: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/model-gateway/relay-network", async (importOriginal) => {
  const original = await importOriginal<typeof import("./relay-network")>();
  return { ...original, assertPublicRelayUrl: network.assertPublicRelayUrl, relayFetch: network.relayFetch };
});

import {
  getRelayConfigPath, getRelayRuntime, getRelaySettings, relayManagementError,
  saveRelaySettings, syncRelayModels, testRelayConnection
} from "./relay-config";

const secret = "test-only-relay-secret-never-return";
const manual = {
  id: "my-video", label: "我的视频", upstreamModel: "video-v1", kind: "video", enabled: true, videoCents: 300
};

describe("relay server-only configuration", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "gateway-relay-test-"));
    vi.stubEnv("MODEL_GATEWAY_CONFIG_FILE", path.join(directory, "private", "relay.json"));
    vi.stubEnv("MODEL_GATEWAY_SHAOZHUANG_API_KEY", "");
    vi.stubEnv("MODEL_GATEWAY_FX_AUTOMATIC", "0");
    vi.stubEnv("MODEL_GATEWAY_FX_CACHE_FILE", path.join(directory,"fx.json"));
    vi.stubEnv("MODEL_GATEWAY_SHAOZHUANG_BASE_URL", "");
    network.assertPublicRelayUrl.mockReset().mockResolvedValue({ address: { address: "1.1.1.1", family: 4 } });
    network.relayFetch.mockReset().mockImplementation(async () => Response.json({ data: [{ id: "gpt-5.6-sol" }, { id: "new-unknown" }] }));
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

  it("preserves old env fallback and default relay models without exposing the key", async () => {
    vi.stubEnv("MODEL_GATEWAY_SHAOZHUANG_API_KEY", secret);
    vi.stubEnv("MODEL_GATEWAY_SHAOZHUANG_BASE_URL", "https://relay.example.com");
    const settings = await getRelaySettings();
    expect(settings).toMatchObject({ baseUrl: "https://relay.example.com/v1", keyConfigured: true, keySource: "env", updatedAt: null });
    expect(settings.models.map((item) => item.id)).toEqual(["chatGPT5.5", "image2"]);
    expect(settings.models.map((item) => item.upstreamModel)).toEqual(["gpt-5.6-sol", "gpt-image-2"]);
    expect(JSON.stringify(settings)).not.toContain(secret);
    expect(await getRelayRuntime()).toMatchObject({ apiKey: secret });
  });

  it("stores atomically with private permissions, and keeps a key when the field is empty", async () => {
    const result = await saveRelaySettings({ baseUrl: "https://relay.example.com/compatible-mode/v1/", apiKey: secret });
    expect(result).toMatchObject({ baseUrl: "https://relay.example.com/compatible-mode/v1", keySource: "file", keyConfigured: true });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect((await stat(getRelayConfigPath())).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(getRelayConfigPath()))).mode & 0o777).toBe(0o700);
    expect((await readFile(getRelayConfigPath(), "utf8"))).toContain(secret);
    await saveRelaySettings({ apiKey: "" });
    expect((await getRelayRuntime()).apiKey).toBe(secret);
  });

  it.each(["clearKey", "clearApiKey"])("%s disables env fallback until a new nonempty key is saved", async (option) => {
    vi.stubEnv("MODEL_GATEWAY_SHAOZHUANG_API_KEY", secret);
    await saveRelaySettings({ [option]: true });
    expect(await getRelaySettings()).toMatchObject({ keyConfigured: false, keySource: "none" });
    expect((await getRelayRuntime()).apiKey).toBe("");
    await saveRelaySettings({ apiKey: " " });
    expect((await getRelayRuntime()).apiKey).toBe("");
    await saveRelaySettings({ apiKey: "replacement-key" });
    expect((await getRelayRuntime()).apiKey).toBe("replacement-key");
  });

  it("stores a shop key and exchange rate without returning the key", async () => {
    const shopSecret = "shop-route-secret-never-return";
    const saved = await saveRelaySettings({
      apiKey: secret,
      usdCnyRate: 7.2,
      shopKeys: [{ shopName: "西西礼", purpose: "default", apiKey: shopSecret }]
    });
    expect(saved.shopKeys).toEqual([{ shopName: "西西礼", purpose: "default" }]);
    expect(saved.usdCnyRate).toBe(7.2);
    expect(JSON.stringify(saved)).not.toContain(shopSecret);
    expect(await getRelayRuntime()).toMatchObject({ usdCnyRate: 7.2, shopKeys: [{ shopName: "西西礼", purpose: "default", apiKey: shopSecret }] });
    const kept = await saveRelaySettings({ shopKeys: [{ shopName: "西西礼", purpose: "default", apiKey: "" }] });
    expect(JSON.stringify(kept)).not.toContain(shopSecret);
    expect((await getRelayRuntime()).shopKeys[0].apiKey).toBe(shopSecret);
    await saveRelaySettings({ shopKeys: [] });
    expect((await getRelayRuntime()).shopKeys).toEqual([]);
  });

  it("keeps a custom upstream and rewrites only the old public-id aliases", async () => {
    await saveRelaySettings({
      apiKey: secret,
      models: [
        { id: "chatGPT5.5", label: "少壮中转 · chatGPT5.5", upstreamModel: "chatGPT5.5", kind: "chat", enabled: true, promptCentsPer1K: 2, completionCentsPer1K: 6 },
        { id: "image2", label: "少壮中转 · image2", upstreamModel: "image2", kind: "image", enabled: true, imageCents: 50 },
        { id: "custom-chat", label: "指定文本", upstreamModel: "gpt-5.5", kind: "chat", enabled: true, promptCentsPer1K: 1, completionCentsPer1K: 1 }
      ]
    });
    expect((await getRelayRuntime()).models).toEqual([
      expect.objectContaining({ id: "chatGPT5.5", upstreamModel: "gpt-5.6-sol" }),
      expect.objectContaining({ id: "image2", upstreamModel: "gpt-image-2" }),
      expect.objectContaining({ id: "custom-chat", upstreamModel: "gpt-5.5" })
    ]);
  });

  it("syncs read-only, retains manual and default models, and disables unknown modalities", async () => {
    await saveRelaySettings({ apiKey: secret });
    const existing = await getRelaySettings();
    await saveRelaySettings({ models: [...existing.models, manual] });
    const result = await syncRelayModels();
    expect(result.syncedCount).toBe(2);
    expect(result.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "chatGPT5.5", enabled: true, kind: "chat" }),
      expect.objectContaining({ id: "image2", enabled: true, kind: "image" }),
      manual,
      expect.objectContaining({ id: "new-unknown", enabled: false, kind: "unknown" })
    ]));
    expect(network.relayFetch).toHaveBeenCalledWith("https://sub.shaozhuangai.com/v1/models", expect.objectContaining({ headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" } }));
    expect(network.relayFetch.mock.calls[0][1]).not.toHaveProperty("body");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not shadow an existing direct model when syncing its upstream name", async () => {
    await saveRelaySettings({ apiKey: secret });
    network.relayFetch.mockResolvedValueOnce(Response.json({ data: [{ id: "gpt-4o-mini" }] }));
    const result = await syncRelayModels();
    expect(result.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "relay:gpt-4o-mini", upstreamModel: "gpt-4o-mini", enabled: false })]));
    await expect(saveRelaySettings({ models: [{ ...manual, id: "gpt-4o-mini" }] })).rejects.toThrow("直连模型冲突");
  });

  it("requires explicit classification and positive rates before enabling discovered models", async () => {
    await expect(saveRelaySettings({ models: [{ ...manual, kind: "unknown" }] })).rejects.toThrow("未分类模型");
    await expect(saveRelaySettings({ models: [{ ...manual, videoCents: 0 }] })).rejects.toThrow("视频费率");
    await expect(saveRelaySettings({ models: [{ ...manual, videoCents: 0.5 }] })).rejects.toThrow("必须是整数");
    await expect(saveRelaySettings({ models: [{ ...manual, kind: "chat", promptCentsPer1K: 0, completionCentsPer1K: 1 }] })).rejects.toThrow("输入、输出费率");
    await expect(saveRelaySettings({ models: [{ ...manual, kind: "image", imageCents: Number.NaN }] })).rejects.toThrow("有限的非负数字");
  });

  it("rejects a sync if the saved configuration changes while fetching the old directory", async () => {
    await saveRelaySettings({ apiKey: secret });
    let resolveDirectory!: (response: Response) => void;
    network.relayFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveDirectory = resolve; }));
    const pending = syncRelayModels();
    await vi.waitFor(() => expect(resolveDirectory).toBeTypeOf("function"));
    await saveRelaySettings({ baseUrl: "https://other.example.com/v1" });
    resolveDirectory(Response.json({ data: [{ id: "belongs-to-old-provider" }] }));
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect((await getRelaySettings()).models.map((item) => item.id)).not.toContain("belongs-to-old-provider");
  });

  it("fails closed without credentials and never returns upstream authentication error text", async () => {
    await expect(testRelayConnection()).rejects.toThrow("尚未配置 API Key");
    expect(network.relayFetch).not.toHaveBeenCalled();
    await saveRelaySettings({ apiKey: secret });
    network.relayFetch.mockResolvedValueOnce(Response.json({ error: { message: `Invalid key ${secret}` } }, { status: 401 }));
    const error = await testRelayConnection().catch((err: unknown) => err);
    expect(relayManagementError(error)).toEqual({ message: "中转站拒绝认证，请检查 API Key 和模型权限", status: 502 });
    expect(JSON.stringify(relayManagementError(error))).not.toContain(secret);
    expect(relayManagementError(new Error(secret))).toEqual({ message: "中转站操作失败，请检查配置后重试", status: 500 });
  });

  it("reports read-only successful connection metrics", async () => {
    await saveRelaySettings({ apiKey: secret });
    expect(await testRelayConnection()).toMatchObject({ ok: true, modelCount: 2, message: "中转站连接成功，已只读验证模型目录" });
  });

  it("discards upstream model identifiers that echo the credential", async () => {
    await saveRelaySettings({ apiKey: secret });
    network.relayFetch.mockResolvedValueOnce(Response.json({ data: [{ id: `model-${secret}` }, { id: "safe-model" }] }));
    const synced = await syncRelayModels();
    expect(synced.syncedCount).toBe(1);
    expect(JSON.stringify(synced)).not.toContain(secret);
  });

  it("does not echo malformed persisted key or parser exception", async () => {
    await saveRelaySettings({ apiKey: secret });
    await writeFile(getRelayConfigPath(), `{ invalid ${secret}`);
    const error = await getRelaySettings().catch((err: unknown) => err);
    expect(relayManagementError(error)).toEqual({ message: "中转站配置文件无效，请由管理员修复服务端配置", status: 500 });
    expect(JSON.stringify(relayManagementError(error))).not.toContain(secret);
  });

  it("rejects unsafe base URLs without saving any credentials", async () => {
    await expect(saveRelaySettings({ baseUrl: "http://localhost", apiKey: secret })).rejects.toThrow("HTTPS");
    await expect(stat(getRelayConfigPath())).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("returns automatic effective FX while preserving the saved manual rate and credential", async () => {
    await saveRelaySettings({apiKey:secret,usdCnyRate:7.2});
    const now=new Date();const date=now.toISOString().slice(0,10);
    const xml=`<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><gesmes:subject>Reference rates</gesmes:subject><gesmes:Sender><gesmes:name>European Central Bank</gesmes:name></gesmes:Sender><Cube><Cube time="${date}"><Cube currency="USD" rate="1"/><Cube currency="CNY" rate="6.9"/></Cube></Cube></gesmes:Envelope>`;
    const cache=parseEcbXml(xml,now);await writeFile(process.env.MODEL_GATEWAY_FX_CACHE_FILE!,JSON.stringify(cache));vi.stubEnv("MODEL_GATEWAY_FX_AUTOMATIC","1");
    expect(await getRelaySettings()).toMatchObject({usdCnyRate:6.9,exchangeRate:{mode:"automatic",status:"ready",id:cache.id}});
    expect(await getRelayRuntime()).toMatchObject({usdCnyRate:6.9,apiKey:secret});
    await expect(saveRelaySettings({usdCnyRate:7.5})).rejects.toThrow("不接受手动覆盖");
    await saveRelaySettings({usdCnyRate:6.9,apiKey:"",baseUrl:"https://relay.example.com/v1"});
    const disk=JSON.parse(await readFile(getRelayConfigPath(),"utf8"));expect(disk).toMatchObject({usdCnyRate:7.2,apiKey:secret});
    await saveRelaySettings({models:[manual]});expect(JSON.parse(await readFile(getRelayConfigPath(),"utf8"))).toMatchObject({usdCnyRate:7.2,apiKey:secret});
    expect(JSON.stringify(await getRelaySettings())).not.toContain(secret);
    const next=parseEcbXml(xml.replace('rate="6.9"','rate="7.1"'),new Date());await writeFile(process.env.MODEL_GATEWAY_FX_CACHE_FILE!,JSON.stringify(next));
    expect(await getRelayRuntime()).toMatchObject({usdCnyRate:7.1,exchangeRate:{id:next.id}});
    expect(network.relayFetch).not.toHaveBeenCalled();
  });
  it("shows unavailable automatic FX without falling back to a stored manual rate",async()=>{
    await saveRelaySettings({apiKey:secret,usdCnyRate:7.2});vi.stubEnv("MODEL_GATEWAY_FX_AUTOMATIC","1");
    expect(await getRelaySettings()).toMatchObject({usdCnyRate:null,exchangeRate:{mode:"automatic",status:"unavailable"}});
    await saveRelaySettings({models:[manual]});expect(JSON.parse(await readFile(getRelayConfigPath(),"utf8"))).toMatchObject({usdCnyRate:7.2,apiKey:secret});
  });

});
