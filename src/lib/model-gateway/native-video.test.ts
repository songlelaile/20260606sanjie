import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
// These receipt and reconciliation regressions exercise jobs accepted before
// submission_quote_v1. New-default charging has its own real-DB integration suite.
vi.mock("./billing-hold", async importOriginal => {
  const actual = await importOriginal<typeof import("./billing-hold")>();
  return { ...actual, reserveGatewayBillingHold: (input: Parameters<typeof actual.reserveGatewayBillingHold>[0]) =>
    actual.reserveGatewayBillingHold(input.billingMode === "prepaid_quote" ? { ...input, billingMode:"direct_usage", quoteCents:100 } : input) };
});
const mock = vi.hoisted(() => ({ fetch: vi.fn(), runtime: vi.fn(), retained: vi.fn(), key: "fixture-private-key", primaryKey: "fixture-user-private-key", backupKey: "fixture-user-backup-key", retainedKeys: new Map<string, string>(), baseUrl: "https://sub.shaozhuangai.com/v1", nativeConfig: null as Record<string, unknown> | null }));
vi.mock("./relay-config", () => ({ getRelayRuntime: async () => ({ apiKey: mock.key, baseUrl: mock.baseUrl }) }));
vi.mock("./user-supply", () => ({ getUserSupplyRuntime: mock.runtime, getUserSupplyCredential: mock.retained }));
vi.mock("./native-video-supply", async importOriginal => {
  const actual = await importOriginal<typeof import("./native-video-supply")>();
  return { ...actual,
    readNativeVideoSupplyConfig: async () => mock.nativeConfig ? actual.parseNativeVideoSupplyConfig(JSON.stringify(mock.nativeConfig)) : null,
    getNativeVideoCreateSupply: async () => {
      if (!mock.nativeConfig) return actual.getNativeVideoCreateSupply();
      const config = actual.parseNativeVideoSupplyConfig(JSON.stringify(mock.nativeConfig));
      const binding = config.bindings.find(value => value.bindingId === config.activeBindingId)!;
      const { digest, stable } = await import("./native-video-contract");
      return { kind: binding.provider, provider: binding.provider === "ark" ? "volc" : "shaozhuang", key: binding.apiKey,
        endpoint: (binding.provider === "ark" ? actual.ARK_VIDEO_ORIGIN : actual.SUB2_VIDEO_ORIGIN) + "/api/v3/contents/generations/tasks",
        binding: binding.provider === "ark" ? digest(stable({ version: 1, provider: "ark", base: actual.ARK_VIDEO_ORIGIN, path: "/api/v3/contents/generations/tasks", keyHash: digest(binding.apiKey), bindingId: binding.bindingId })) : actual.sub2VideoBindingFingerprint(binding.apiKey, binding.bindingId), models: binding.models };
    }
  };
});
vi.mock("./relay-network", async importOriginal => ({ ...await importOriginal<typeof import("./relay-network")>(), relayFetch: mock.fetch }));
import { prisma } from "@/lib/db";
import { parseNativeVideoConfig, nativeTokenCost, safeVideoUrl, validateNativeRequest, digest, stable } from "./native-video-contract";
import { createNativeVideo, pollNativeVideo, resolveNativeVideo, nativeVideoCapabilities, nativeVideoContent } from "./native-video";
import { reserveGatewayBillingHold } from "./billing-hold";
import { reconcileNativeVideoJobs } from "./native-video-reconcile";
import { getGatewayBillingSnapshot } from "./billing";

const configured = () => ({ enabled: true, bindingId: "fixture-platform-binding-v1", models: [{
  id: "seedance-2.0", label: "Fixture Seedance", upstreamModel: "fixture-upstream-seedance", priceVersion: "fixture-price-v1",
  completionCentsPerMillion: 100000, reservationCents: 100,
  durations: [5, 10], resolutions: ["720p"], ratios: ["16:9"], generateAudio: true, mediaHosts: ["media.example.com"]
}] });
const request = (text = "fixture product video") => ({ expectedAccount: "fixture-tenant:fixture-alice", model: "seedance-2.0",
  content: [{ type: "text", text }], duration: 5, resolution: "720p", ratio: "16:9", generate_audio: false });
const alice = { id: "cfixturealice", tenantId: "cfixturetenant", username: "fixture-alice" };
const bob = { id: "cfixturebob", tenantId: "cfixturetenant", username: "fixture-bob" };
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const complete = (id = "provider-task-1", tokens = 250) => ({ id, status: "succeeded", content: { video_url: "https://media.example.com/result.mp4?signature=fixture" }, usage: { completion_tokens: tokens } });
const privateSub2Binding = () => ({ provider: "sub2api", bindingId: "fixture-private-sub2-v1", apiKey: "fixture-config-global-sub2-key", models: configured().models });
const privateArkBinding = () => {
  const { completionCentsPerMillion, ...model } = configured().models[0];
  return { provider: "ark", bindingId: "fixture-private-ark-v1", apiKey: "fixture-config-ark-key", models: [{ ...model,
    upstreamModel: "doubao-seedance-2-0-260128", priceTiers: [false, true].map(hasVideoInput => ({ resolution: "720p", hasVideoInput, completionCentsPerMillion })) }] };
};

describe("native Seedance configuration and arithmetic without network", () => {
  it("is disabled when no explicit configuration exists", () => { expect(parseNativeVideoConfig(undefined).enabled).toBe(false); });
  it.each(["{}", "garbage", JSON.stringify({ enabled: true, bindingId: "binding", models: [] })])("rejects malformed configuration (%s)", raw => {
    expect(() => parseNativeVideoConfig(raw)).toThrow();
  });
  it.each(["completionCentsPerMillion", "reservationCents", "upstreamModel", "priceVersion", "mediaHosts"]) ("does not infer missing %s", field => {
    const value = configured(); delete (value.models[0] as Record<string, unknown>)[field];
    expect(() => parseNativeVideoConfig(JSON.stringify(value))).toThrow();
  });
  it("uses integer ceiling arithmetic including explicit zero tokens", () => {
    const tariff = configured().models[0];
    expect(nativeTokenCost(0, tariff)).toBe(0); expect(nativeTokenCost(1, tariff)).toBe(1); expect(nativeTokenCost(251, tariff)).toBe(26);
    expect(() => nativeTokenCost(NaN, tariff)).toThrow(); expect(() => nativeTokenCost(-1, tariff)).toThrow();
  });
  it.each(["http://media.example.com/a.mp4", "https://media.example.com.evil.com/a.mp4", "https://user:pass@media.example.com/a.mp4", "https://127.0.0.1/a.mp4", "https://media.example.com:8443/a.mp4"]) ("rejects untrusted media %s", raw => {
    expect(safeVideoUrl(raw, ["media.example.com"])).toBeNull();
  });
  it("rejects shared supplier asset IDs without a tenant ownership binding", () => {
    const body = request();
    expect(() => validateNativeRequest({ ...body, content: [...body.content, { type: "image_url", role: "reference_image", image_url: { url: "asset://another-tenant-private-file" } }] }, configured().models[0])).toThrow("素材编号");
  });
  it("preserves supported 2.5 native fields but rejects extra fields and enums", () => {
    expect(validateNativeRequest({ ...request(), omni_reference_task_type: "reference", output_format: "mp4" }, configured().models[0])).toMatchObject({ omni_reference_task_type: "reference", output_format: "mp4" });
    for (const patch of [{ callback_url: "https://evil.example" }, { output_format: "html" }, { omni_reference_task_type: "other" }, { duration: 120 }]) {
      expect(() => validateNativeRequest({ ...request(), ...patch }, configured().models[0])).toThrow();
    }
  });
  it("accepts a 15 MiB decoded image within the 24 MiB JSON envelope without regex stack overflow", () => {
    const body = request(); const encoded = Buffer.alloc(15 * 1024 * 1024).toString("base64");
    const payload = { ...body, content: [...body.content, { type: "image_url", role: "reference_image", image_url: { url: `data:image/png;base64,${encoded}` } }] };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(24 * 1024 * 1024);
    expect(() => validateNativeRequest(payload, configured().models[0])).not.toThrow();
  });
});

// This suite intentionally never reads application .env or any production URL.
// Its runner creates a fresh private localhost PostgreSQL cluster/database.
const database = process.env.NATIVE_VIDEO_TEST_DATABASE_URL;
if (database) {
  const url = new URL(database);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/native_video_uat" || process.env.DATABASE_URL !== database) throw new Error("Native video integration tests require the disposable local database");
}
describe.skipIf(!database)("native Seedance persisted lifecycle on disposable PostgreSQL", () => {
  beforeEach(async () => {
    mock.fetch.mockReset(); mock.runtime.mockReset();mock.retained.mockReset();mock.retainedKeys.clear();
    mock.key = "fixture-private-key"; mock.primaryKey = "fixture-user-private-key";mock.backupKey = "fixture-user-backup-key";mock.baseUrl = "https://sub.shaozhuangai.com/v1";mock.nativeConfig = null;
    mock.runtime.mockImplementation(async (userId: string) => ({ baseUrl: mock.baseUrl, primary: { id: `${userId}-primary`, apiKey: mock.primaryKey }, backup: mock.backupKey ? { id: `${userId}-backup`, apiKey: mock.backupKey } : null, usdCnyRate: null }));
    mock.retained.mockImplementation(async (userId: string, id: string) => {
      if (!id.startsWith(`${userId}-`) || !mock.retainedKeys.has(id)) throw new Error("Unowned fixture credential");
      return { baseUrl: mock.baseUrl, apiKey: mock.retainedKeys.get(id)! };
    });
    process.env.MODEL_GATEWAY_SEEDANCE_CONFIG = JSON.stringify(configured());
    // These identities exist only inside the disposable cluster.
    await prisma.$executeRaw`TRUNCATE TABLE "GatewayNativeVideoJob", "GatewayBillingHoldEvent", "GatewayBillingHold", "GatewayBillingLedger", "GatewayUsage", "GatewayWallet", "User", "Tenant" CASCADE`;
    await prisma.tenant.create({ data: { id: alice.tenantId, slug: "fixture-native-video", name: "Fixture" } });
    for (const owner of [alice, bob]) {
      await prisma.user.create({ data: { ...owner, password: "not-a-real-login", name: owner.username,
        gatewayWallet: { create: { balanceCents: 1000 } } } });
      for (const slot of ["primary", "backup"]) {
        const id = `${owner.id}-${slot}`;
        await prisma.$executeRaw`INSERT INTO "GatewaySupplyCredential" ("id","userId","slot","name","sealedKey","status") VALUES (${id},${owner.id},${slot},${id},'fixture-sealed-test-only','ready')`;
        mock.retainedKeys.set(id, slot === "primary" ? mock.primaryKey : mock.backupKey);
      }
    }
  });
  afterAll(async () => { await prisma.$disconnect(); delete process.env.MODEL_GATEWAY_SEEDANCE_CONFIG; });
  async function stats() {
    return { wallet: await prisma.gatewayWallet.findUniqueOrThrow({ where: { userId: alice.id } }),
      holds: await prisma.$queryRaw<Array<{ status: string; quoteCents: number; heldCents: number; settledCents: number | null; billingMode: string; amountDueCents: number; credentialId: string | null }>>`SELECT "status","quoteCents","heldCents","settledCents","billingMode","amountDueCents","credentialId" FROM "GatewayBillingHold" WHERE "userId"=${alice.id}`,
      jobs: await prisma.$queryRaw<Array<{ state: string; providerTaskId: string | null; tariff: unknown; credentialId: string | null }>>`SELECT "state","providerTaskId","tariff","credentialId" FROM "GatewayNativeVideoJob" WHERE "userId"=${alice.id}`,
      usages: await prisma.gatewayUsage.findMany({ where: { userId: alice.id } }), ledger: await prisma.gatewayBillingLedger.findMany({ where: { userId: alice.id, kind: "debit" } }) };
  }
  async function created() { mock.fetch.mockResolvedValueOnce(reply({ id: "provider-task-1" })); return createNativeVideo(alice, request(), "fixture-idem-1"); }
  it("accepts positive balance below the old arbitrary reservation without freezing it", async () => {
    await prisma.gatewayWallet.update({ where: { userId: alice.id }, data: { balanceCents: 99 } });
    const value = await created();
    expect(value.billing.reservedCents).toBe(0);
    const s = await stats(); expect(s.wallet.balanceCents).toBe(99); expect(s.holds[0]).toMatchObject({ heldCents: 0, quoteCents: 100, billingMode: "direct_usage" });
    expect(s.ledger).toHaveLength(0); expect(mock.fetch).toHaveBeenCalledTimes(1);
  });
  it("fails closed with missing supply, price, or balance before a provider POST", async () => {
    mock.primaryKey = "";mock.backupKey = "";
    await expect(createNativeVideo(alice, request(), "i1")).rejects.toMatchObject({ code: "NATIVE_VIDEO_SUPPLY_UNAVAILABLE" });
    mock.primaryKey = "fixture-user-private-key";mock.backupKey = "fixture-user-backup-key"; const cfg = configured(); cfg.models[0].completionCentsPerMillion = 0;
    process.env.MODEL_GATEWAY_SEEDANCE_CONFIG = JSON.stringify(cfg);
    await expect(createNativeVideo(alice, request(), "i1")).rejects.toMatchObject({ code: "NATIVE_VIDEO_CONFIG_INVALID" });
    process.env.MODEL_GATEWAY_SEEDANCE_CONFIG = JSON.stringify(configured());
    await prisma.gatewayWallet.update({ where: { userId: alice.id }, data: { balanceCents: 0 } });
    await expect(createNativeVideo(alice, request(), "i1")).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    expect(mock.fetch).not.toHaveBeenCalled(); expect((await stats()).holds).toHaveLength(0);
  });
  it.each([
    { type: "image_url", role: "reference_image", image_url: { url: "data:audio/mpeg;base64,aGVsbG8=" } },
    { type: "audio_url", role: "reference_audio", audio_url: { url: "data:image/png;base64,aGVsbG8=" } },
    { type: "image_url", role: "reference_image", image_url: { url: "data:image/png;base64,aGVsbG8==" } },
    { type: "image_url", role: "reference_image", image_url: { url: "data:image/png;base64," } },
    { type: "image_url", role: "reference_image", image_url: { url: "asset://private-other-tenant" } }
  ])("rejects invalid/shared input media before hold or provider POST (%j)", async asset => {
    const body = request();
    await expect(createNativeVideo(alice, { ...body, content: [...body.content, asset] }, "fixture-bad-media")).rejects.toBeInstanceOf(Error);
    expect(mock.fetch).not.toHaveBeenCalled(); expect((await stats()).holds).toHaveLength(0);
  });
  it("returns only public direct usage configuration without a reservation", async () => {
    const view = await nativeVideoCapabilities(alice);
    expect(view.configured).toBe(true); expect(view.models[0].reservationCents).toBe(0); expect(view.billingMode).toBe("prepaid_quote"); expect(view.billing.billingMode).toBe("prepaid_quote");
    expect(view.limits.bodyBytes).toBe(24 * 1024 * 1024);
    expect(JSON.stringify(view)).not.toContain(mock.key);expect(JSON.stringify(view)).not.toContain(mock.primaryKey);expect(JSON.stringify(view)).not.toContain(mock.backupKey); expect(JSON.stringify(view)).not.toContain("fixture-upstream"); expect(mock.fetch).not.toHaveBeenCalled();
  });
  it("persists owner, frozen tariff, zero reservation, and unique dispatch before contacting the supplier", async () => {
    mock.fetch.mockImplementationOnce(async (_url, init) => {
      const s = await stats(); expect(s.holds[0]).toMatchObject({status:"dispatched",billingMode:"direct_usage",heldCents:0,quoteCents:100}); expect(s.wallet.balanceCents).toBe(1000);
      expect(s.jobs[0].state).toBe("submitting"); expect(s.jobs[0].tariff).toMatchObject({ priceVersion: "fixture-price-v1" });
      expect(s.jobs[0].credentialId).toBe(`${alice.id}-primary`);expect(s.holds[0].credentialId).toBe(`${alice.id}-primary`);
      expect(init.headers.Authorization).toBe(`Bearer ${mock.primaryKey}`);
      expect(JSON.parse(init.body)).toMatchObject({ model: "fixture-upstream-seedance" });
      expect(JSON.parse(init.body)).not.toHaveProperty("expectedAccount");
      expect(init.headers["Idempotency-Key"]).toMatch(/^native-video:/);
      return reply({ id: "provider-task-1" });
    });
    const value = await createNativeVideo(alice, request(), "fixture-idem-1");
    expect(value.status).toBe("running"); expect(value.id).toMatch(/^nv_/); expect(value.billing.settledCents).toBeNull(); expect(value.billing.reservedCents).toBe(0); expect(value.billing.billingMode).toBe("direct_usage");
    const s = await stats(); expect(s.usages).toHaveLength(0); expect(s.ledger).toHaveLength(0);
  });
  it.each([
    [401, "INVALID_API_KEY"], [401, "API_KEY_DISABLED"], [403, "API_KEY_EXPIRED"]
  ])("switches an authentication-rejected create once (%s %s), persists backup before POST, and settles one final receipt", async (status, code) => {
    mock.key = ""; // New tasks require only their own supply credentials.
    mock.fetch.mockResolvedValueOnce(reply({ code, message: "fixture authentication rejection" }, status as number));
    mock.fetch.mockImplementationOnce(async (_url, init) => {
      const s = await stats();expect(s.holds).toHaveLength(1);expect(s.jobs).toHaveLength(1);
      expect(s.holds[0]).toMatchObject({ status: "dispatched", credentialId: `${alice.id}-backup`, heldCents: 0 });
      expect(s.jobs[0]).toMatchObject({ state: "submitting", credentialId: `${alice.id}-backup` });
      expect(init.headers.Authorization).toBe(`Bearer ${mock.backupKey}`);return reply({ id: "provider-task-1" });
    });
    const value = await createNativeVideo(alice, request(), "fixture-idem-1");
    expect(mock.fetch).toHaveBeenCalledTimes(2);
    const [first, second] = mock.fetch.mock.calls.map(call => call[1]);
    expect(first.headers.Authorization).toBe(`Bearer ${mock.primaryKey}`);
    expect(first.headers["Idempotency-Key"]).toBe(second.headers["Idempotency-Key"]);expect(first.body).toBe(second.body);
    const primary = mock.primaryKey, backup = mock.backupKey;
    mock.primaryKey = "rotated-current-primary";mock.backupKey = "rotated-current-backup";
    mock.fetch.mockImplementationOnce(async (_url, init) => {expect(init.headers.Authorization).toBe(`Bearer ${backup}`);return reply(complete());});
    expect((await pollNativeVideo(alice, value.id)).status).toBe("succeeded");
    const s = await stats();expect(s.holds[0].status).toBe("settled");expect(s.wallet.balanceCents).toBe(975);
    expect(s.usages).toHaveLength(1);expect(s.ledger).toHaveLength(1);
    expect(s.usages[0].metadata).toMatchObject({ credentialId: `${alice.id}-backup` });
    expect(JSON.stringify({ value, usage: s.usages, ledger: s.ledger })).not.toContain(primary);
    expect(JSON.stringify({ value, usage: s.usages, ledger: s.ledger })).not.toContain(backup);
    expect(mock.retained).toHaveBeenCalledWith(alice.id, `${alice.id}-backup`);
  });
  it("retains the backup binding on an uncertain second POST and never reposts", async () => {
    mock.fetch.mockResolvedValueOnce(reply({ code: "INVALID_API_KEY", message: "fixture invalid" }, 401));
    mock.fetch.mockImplementationOnce(async () => {
      const s = await stats();expect(s.jobs[0].credentialId).toBe(`${alice.id}-backup`);expect(s.holds[0].credentialId).toBe(`${alice.id}-backup`);
      throw new Error("fixture backup timeout");
    });
    const value = await createNativeVideo(alice, request(), "fixture-idem-1");
    expect(value.stateUncertain).toBe(true);
    expect((await createNativeVideo(alice, request(), "new-key")).id).toBe(value.id);
    expect((await resolveNativeVideo(alice, "fixture-idem-1")).id).toBe(value.id);
    const s = await stats();expect(s.holds[0]).toMatchObject({ status: "unknown", credentialId: `${alice.id}-backup`, heldCents: 0 });
    expect(s.jobs[0]).toMatchObject({ state: "unknown", credentialId: `${alice.id}-backup`, providerTaskId: null });
    expect(s.ledger).toHaveLength(0);expect(s.usages).toHaveLength(0);expect(mock.fetch).toHaveBeenCalledTimes(2);
  });
  it("uses own keys for a private Sub2 binding and retains its backup after new creation switches to disabled Ark", async () => {
    const sub2 = privateSub2Binding();mock.nativeConfig = { version: 1, enabled: true, activeBindingId: sub2.bindingId, bindings: [sub2] };
    mock.key = "";
    mock.fetch.mockResolvedValueOnce(reply({ code: "API_KEY_EXPIRED", message: "fixture expired" }, 403));
    mock.fetch.mockResolvedValueOnce(reply({ id: "provider-task-1" }));
    const value = await createNativeVideo(alice, request(), "fixture-private-sub2");
    expect(mock.fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${mock.primaryKey}`);
    expect(mock.fetch.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${mock.backupKey}`);
    expect(mock.fetch.mock.calls.every(([url]) => String(url).startsWith("https://sub.shaozhuangai.com/"))).toBe(true);
    const ark = privateArkBinding();mock.nativeConfig = { version: 1, enabled: false, activeBindingId: ark.bindingId, bindings: [{ ...sub2, models: [] }, ark] };
    mock.primaryKey = "rotated-current-key";mock.backupKey = "rotated-current-backup";
    mock.fetch.mockImplementationOnce(async (_url, init) => {expect(init.headers.Authorization).toBe("Bearer fixture-user-backup-key");return reply(complete());});
    expect((await pollNativeVideo(alice, value.id)).status).toBe("succeeded");
    const s = await stats();expect(s.holds[0]).toMatchObject({ status: "settled", credentialId: `${alice.id}-backup` });
    expect(s.usages).toHaveLength(1);expect(s.usages[0]).toMatchObject({ provider: "shaozhuang", metadata: { credentialId: `${alice.id}-backup` } });
    expect(mock.runtime).toHaveBeenCalledTimes(1);expect(mock.retained).toHaveBeenCalledWith(alice.id, `${alice.id}-backup`);
  });
  it("does not transfer an owned Sub2 job to an active Ark binding when its original protocol binding is missing", async () => {
    const sub2 = privateSub2Binding();mock.nativeConfig = { version: 1, enabled: true, activeBindingId: sub2.bindingId, bindings: [sub2] };
    const value = await created();const ark = privateArkBinding();mock.nativeConfig = { version: 1, enabled: true, activeBindingId: ark.bindingId, bindings: [ark] };
    await expect(pollNativeVideo(alice, value.id)).rejects.toMatchObject({ code: "NATIVE_VIDEO_BINDING_CHANGED" });
    expect(mock.fetch).toHaveBeenCalledTimes(1);expect((await stats()).holds[0]).toMatchObject({ status: "dispatched", heldCents: 0 });
  });
  it("dispatches an explicitly selected Ark binding without provisioning or borrowing any Sub2 user key", async () => {
    const ark = privateArkBinding();mock.nativeConfig = { version: 1, enabled: true, activeBindingId: ark.bindingId, bindings: [ark] };
    mock.fetch.mockResolvedValueOnce(reply({ id: "provider-task-1" }));
    await createNativeVideo(alice, request(), "fixture-ark-create");
    expect(mock.fetch.mock.calls[0][0]).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks");
    expect(mock.fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${ark.apiKey}`);
    expect(mock.runtime).not.toHaveBeenCalled();expect(mock.retained).not.toHaveBeenCalled();
    const s = await stats();expect(s.jobs[0].credentialId).toBeNull();expect(s.holds[0].credentialId).toBeNull();
  });
  it("rejects another user's supply binding before a provider POST", async () => {
    mock.runtime.mockResolvedValue({ baseUrl: mock.baseUrl, primary: { id: `${bob.id}-primary`, apiKey: mock.primaryKey }, backup: null, usdCnyRate: null });
    const value = await createNativeVideo(alice, request(), "fixture-idem-1");
    expect(value.stateUncertain).toBe(true);expect(mock.fetch).not.toHaveBeenCalled();
    expect((await stats()).holds[0]).toMatchObject({ status: "unknown", credentialId: null });
  });
  it("rolls back reservation when durable job insertion fails", async () => {
    await expect(reserveGatewayBillingHold({ auth: { userId: alice.id, username: alice.username, apiKeyId: null, keyPrefix: "fixture" },
      billingSnapshot: await getGatewayBillingSnapshot(alice.id), eventId: "fixture-event", quoteCents: 100,
      requestFingerprint: "a".repeat(64), endpoint: "seedance.tasks", provider: "shaozhuang", model: "seedance-2.0",
      onReserved: async () => { throw new Error("injected job persistence fault"); } })).rejects.toThrow("injected");
    expect((await stats()).holds).toHaveLength(0); expect(mock.fetch).not.toHaveBeenCalled();
  });
  it("serializes concurrent same-key and new-key duplicates into one held job and one POST", async () => {
    mock.fetch.mockImplementation(async () => reply({ id: "provider-task-1" }));
    const values = await Promise.all(Array.from({ length: 8 }, (_, i) => createNativeVideo(alice, request(), i < 4 ? "same" : `other-${i}`)));
    expect(new Set(values.map(v => v.id)).size).toBe(1); expect(mock.fetch).toHaveBeenCalledTimes(1);
    const s = await stats(); expect(s.holds).toHaveLength(1); expect(s.jobs).toHaveLength(1);
  });
  it.each(["network", "malformed", "no-id", "http408", "http409", "http500", "http402"]) ("persists %s create uncertainty and never retries via same/new keys", async kind => {
    if (kind === "network") mock.fetch.mockRejectedValueOnce(new Error("fixture interrupted"));
    else if (kind === "malformed") mock.fetch.mockResolvedValueOnce(new Response("not-json"));
    else if (kind === "no-id") mock.fetch.mockResolvedValueOnce(reply({ status: "queued" }));
    else mock.fetch.mockResolvedValueOnce(reply({ error: "fixture" }, Number(kind.slice(4))));
    const value = await createNativeVideo(alice, request(), "fixture-idem-1");
    expect(value.stateUncertain).toBe(true); expect(value.status).toBe("running");
    expect((await createNativeVideo(alice, request(), "fixture-idem-1")).id).toBe(value.id);
    expect((await createNativeVideo(alice, request(), "new-key")).id).toBe(value.id);
    expect((await resolveNativeVideo(alice, "fixture-idem-1")).id).toBe(value.id);
    expect((await pollNativeVideo(alice, value.id)).stateUncertain).toBe(true);
    expect(mock.fetch).toHaveBeenCalledTimes(1); const s = await stats();
    expect(s.holds[0].status).toBe("unknown"); expect(s.holds[0].heldCents).toBe(0); expect(s.ledger).toHaveLength(0);
  });
  it("keeps request fingerprint bound to an idempotency key", async () => {
    await created(); await expect(createNativeVideo(alice, request("different"), "fixture-idem-1")).rejects.toMatchObject({ code: "NATIVE_VIDEO_IDEMPOTENCY_CONFLICT" });
    expect(mock.fetch).toHaveBeenCalledTimes(1);
  });
  it("a provider acceptance followed by local receipt-write failure is never reposted", async () => {
    await prisma.$executeRawUnsafe(`CREATE FUNCTION fixture_reject_video_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."providerTaskId" IS NOT NULL THEN RAISE EXCEPTION 'injected receipt persistence fault'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER fixture_reject_video_receipt BEFORE UPDATE ON "GatewayNativeVideoJob" FOR EACH ROW EXECUTE FUNCTION fixture_reject_video_receipt()`);
    try {
      const value = await created(); expect(value.stateUncertain).toBe(true);
      expect((await createNativeVideo(alice, request(), "fresh-key")).id).toBe(value.id);
      expect((await resolveNativeVideo(alice, "fixture-idem-1")).id).toBe(value.id);
      expect(mock.fetch).toHaveBeenCalledTimes(1);
      const s = await stats(); expect(s.holds[0].status).toBe("unknown"); expect(s.jobs[0].providerTaskId).toBeNull();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER fixture_reject_video_receipt ON "GatewayNativeVideoJob"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION fixture_reject_video_receipt()`);
    }
  });
  it("isolates exact account and tenant on resolve/status/media before any supplier read", async () => {
    const value = await created();
    await expect(resolveNativeVideo(bob, "fixture-idem-1")).rejects.toMatchObject({ status: 404 });
    await expect(pollNativeVideo(bob, value.id)).rejects.toMatchObject({ status: 404 });
    await expect(pollNativeVideo({ ...alice, tenantId: "foreign-tenant" }, value.id)).rejects.toMatchObject({ status: 404 });
    await expect(nativeVideoContent(bob, value.id, new Request("https://local.example"))).rejects.toMatchObject({ status: 404 });
    expect(mock.fetch).toHaveBeenCalledTimes(1);
  });
  it("read-only resolve does not dispatch even when the original create response was lost", async () => {
    const value = await created(); const count = mock.fetch.mock.calls.length;
    expect(await resolveNativeVideo(alice, "fixture-idem-1")).toEqual(value);
    await expect(resolveNativeVideo(alice, "unknown-idem")).rejects.toMatchObject({ status: 404 });
    expect(mock.fetch).toHaveBeenCalledTimes(count);
  });
  it.each([404, 409, 500, 503])("does not refund, debit, or recreate on status HTTP %s", async code => {
    const value = await created(); mock.fetch.mockResolvedValueOnce(reply({ error: "fixture status" }, code));
    await expect(pollNativeVideo(alice, value.id)).rejects.toMatchObject({ code: "NATIVE_VIDEO_STATUS_UNAVAILABLE" });
    const s = await stats(); expect(s.holds[0].status).toBe("dispatched"); expect(s.ledger).toHaveLength(0);
    expect(mock.fetch.mock.calls.map(call => call[1].method)).toEqual(["POST", "GET"]);
  });
  it("uses the original immutable credential after current keys rotate", async () => {
    const value = await created();const original = mock.primaryKey;mock.primaryKey = "rotated-current-key";mock.key = "rotated-global-key";
    mock.fetch.mockImplementationOnce(async (_url, init) => {expect(init.headers.Authorization).toBe(`Bearer ${original}`);return reply({ id: "provider-task-1", status: "running" });});
    expect((await pollNativeVideo(alice, value.id)).status).toBe("running");
    expect(mock.runtime).toHaveBeenCalledTimes(1);expect(mock.retained).toHaveBeenCalledWith(alice.id, `${alice.id}-primary`);
    expect((await stats()).holds[0].heldCents).toBe(0);
  });
  async function legacyCreated() {
    const value = await created();
    const fingerprint = digest(stable({ base: "https://sub.shaozhuangai.com", keyHash: digest(mock.key), bindingId: configured().bindingId }));
    await prisma.$executeRaw`UPDATE "GatewayNativeVideoJob" SET "credentialId"=NULL,"bindingFingerprint"=${fingerprint} WHERE "id"=${value.id}`;
    await prisma.$executeRaw`UPDATE "GatewayBillingHold" SET "credentialId"=NULL WHERE "userId"=${alice.id}`;
    return value;
  }
  it("keeps a legacy credential-less task on its original global binding", async () => {
    const value = await legacyCreated();mock.runtime.mockClear();mock.retained.mockClear();mock.primaryKey = "new-own-key";
    mock.fetch.mockImplementationOnce(async (_url, init) => {expect(init.headers.Authorization).toBe(`Bearer ${mock.key}`);return reply({ id: "provider-task-1", status: "running" });});
    expect((await pollNativeVideo(alice, value.id)).status).toBe("running");
    expect(mock.runtime).not.toHaveBeenCalled();expect(mock.retained).not.toHaveBeenCalled();
    expect((await stats()).jobs[0].credentialId).toBeNull();expect((await stats()).holds[0].credentialId).toBeNull();
  });
  it("preserves binding-change protection for a legacy credential-less task", async () => {
    const value = await legacyCreated();mock.key = "rotated-fixture-key";
    await expect(pollNativeVideo(alice, value.id)).rejects.toMatchObject({ code: "NATIVE_VIDEO_BINDING_CHANGED" });
    expect(mock.fetch).toHaveBeenCalledTimes(1);expect(mock.retained).not.toHaveBeenCalled();expect((await stats()).holds[0].heldCents).toBe(0);
  });
  it("retains binding-change protection when the configured native protocol binding changes", async () => {
    const value = await created();process.env.MODEL_GATEWAY_SEEDANCE_CONFIG = JSON.stringify({ ...configured(), bindingId: "changed-protocol-binding" });
    await expect(pollNativeVideo(alice, value.id)).rejects.toMatchObject({ code: "NATIVE_VIDEO_BINDING_CHANGED" });
    expect(mock.fetch).toHaveBeenCalledTimes(1);
  });
  it("requires exact original provider id, explicit valid usage and safe media for delivery", async () => {
    const value = await created(); mock.fetch.mockResolvedValueOnce(reply(complete("foreign-task")));
    await expect(pollNativeVideo(alice, value.id)).rejects.toMatchObject({ code: "NATIVE_VIDEO_RECEIPT_MISMATCH" });
    mock.fetch.mockResolvedValueOnce(reply({ id: "provider-task-1", status: "succeeded", content: complete().content }));
    await expect(pollNativeVideo(alice, value.id)).rejects.toMatchObject({ code: "NATIVE_VIDEO_USAGE_INVALID" });
    mock.fetch.mockResolvedValueOnce(reply({ ...complete(), content: { video_url: "https://evil.example.com/private" } }));
    expect((await pollNativeVideo(alice, value.id)).status).toBe("running");
    expect((await stats()).ledger).toHaveLength(1); expect((await stats()).holds[0].status).toBe("settled");
    expect((await stats()).wallet.balanceCents).toBe(975);
  });
  it("settles concurrent terminal success exactly once using frozen price despite disabled/changed live tariff", async () => {
    const value = await created(); const cfg = configured(); cfg.enabled = false; cfg.models[0].completionCentsPerMillion = 900000; cfg.models[0].priceVersion = "changed";
    process.env.MODEL_GATEWAY_SEEDANCE_CONFIG = JSON.stringify(cfg);
    mock.fetch.mockImplementation(async () => reply(complete()));
    const values = await Promise.all(Array.from({ length: 6 }, () => pollNativeVideo(alice, value.id)));
    expect(values.every(v => v.status === "succeeded" && v.billing.settledCents === 25)).toBe(true);
    expect(JSON.stringify(values)).not.toContain("media.example.com");
    expect(values[0].content?.video_url).toBe(`/api/creative/native-video/${value.id}/content`);
    const s = await stats(); expect(s.wallet.balanceCents).toBe(975); expect(s.usages).toHaveLength(1); expect(s.ledger).toHaveLength(1); expect(s.holds[0].status).toBe("settled");
    const count = mock.fetch.mock.calls.length; await pollNativeVideo(alice, value.id); expect(mock.fetch).toHaveBeenCalledTimes(count);
  });
  it("records explicit zero-use success once without inventing consumption", async () => {
    const value = await created(); mock.fetch.mockResolvedValueOnce(reply(complete("provider-task-1", 0)));
    expect((await pollNativeVideo(alice, value.id)).billing.settledCents).toBe(0);
    const s = await stats(); expect(s.wallet.balanceCents).toBe(1000); expect(s.ledger).toHaveLength(1); expect(s.holds[0].status).toBe("settled");
  });
  it("debits known completion usage before the media URL arrives and delivers later without a second debit", async () => {
    const value = await created();
    mock.fetch.mockImplementation(async () => reply({ id: "provider-task-1", status: "succeeded", usage: { completion_tokens: 250 } }));
    const pending = await Promise.all(Array.from({ length: 5 }, () => pollNativeVideo(alice, value.id)));
    expect(pending.every(job => job.status === "running" && job.billing.settledCents === 25 && job.billing.reservedCents === 0)).toBe(true);
    let s = await stats(); expect(s.wallet.balanceCents).toBe(975); expect(s.ledger).toHaveLength(1); expect(s.usages).toHaveLength(1);
    expect(s.jobs[0].state).toBe("processing"); expect(s.holds[0].status).toBe("settled");
    mock.fetch.mockResolvedValueOnce(reply(complete()));
    expect((await pollNativeVideo(alice, value.id)).status).toBe("succeeded");
    s = await stats(); expect(s.wallet.balanceCents).toBe(975); expect(s.ledger).toHaveLength(1); expect(s.usages).toHaveLength(1);
  });
  it("does not refund a later contradictory failed receipt after proven consumption", async () => {
    const value = await created();
    mock.fetch.mockResolvedValueOnce(reply({ id: "provider-task-1", status: "succeeded", usage: { completion_tokens: 250 } }));
    await pollNativeVideo(alice, value.id);
    mock.fetch.mockResolvedValueOnce(reply({ id: "provider-task-1", status: "failed", usage: { completion_tokens: 0 } }));
    await expect(pollNativeVideo(alice, value.id)).rejects.toMatchObject({ code: "NATIVE_VIDEO_FAILURE_AMBIGUOUS" });
    const s = await stats(); expect(s.wallet.balanceCents).toBe(975); expect(s.ledger).toHaveLength(1); expect(s.holds[0].status).toBe("settled"); expect(s.jobs[0].state).toBe("processing");
  });
  it("rejects changed completed usage before mutating settled delivery-pending state", async () => {
    const value = await created();
    mock.fetch.mockResolvedValueOnce(reply({ id: "provider-task-1", status: "succeeded", usage: { completion_tokens: 250 } }));
    await pollNativeVideo(alice, value.id);
    mock.fetch.mockResolvedValueOnce(reply(complete("provider-task-1", 251)));
    await expect(pollNativeVideo(alice, value.id)).rejects.toMatchObject({ code: "NATIVE_VIDEO_USAGE_INVALID" });
    const rows = await prisma.$queryRaw<Array<{ state: string; completionTokens: number; resultUrl: string | null }>>`SELECT "state", "completionTokens", "resultUrl" FROM "GatewayNativeVideoJob" WHERE "id" = ${value.id}`;
    expect(rows[0]).toEqual({ state: "processing", completionTokens: 250, resultUrl: null });
    const s = await stats(); expect(s.wallet.balanceCents).toBe(975); expect(s.ledger).toHaveLength(1); expect(s.holds[0].settledCents).toBe(25);
  });
  it("reconciles an accepted aged task through its original GET without an open browser or another POST", async () => {
    const value = await created();
    await prisma.$executeRaw`UPDATE "GatewayNativeVideoJob" SET "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '2 minutes' WHERE "id" = ${value.id}`;
    mock.primaryKey = "rotated-current-key";
    mock.fetch.mockImplementationOnce(async (_url, init) => { expect(init.method).toBe("GET"); expect(init.headers.Authorization).toBe("Bearer fixture-user-private-key"); return reply(complete()); });
    expect(await reconcileNativeVideoJobs({ limit: 1, concurrency: 1, minAgeMs: 1000 })).toMatchObject({ claimed: 1, completed: 1, settled: 1, errors: 0 });
    const s = await stats(); expect(s.wallet.balanceCents).toBe(975); expect(s.ledger).toHaveLength(1); expect(mock.fetch.mock.calls.map(call => call[1].method)).toEqual(["POST", "GET"]);
    expect((await reconcileNativeVideoJobs({ minAgeMs: 1000 })).claimed).toBe(0);
  });
  it("reconciles settled delivery-pending jobs but excludes uncertain creates without a provider ID", async () => {
    const value = await created();
    mock.fetch.mockResolvedValueOnce(reply({ id: "provider-task-1", status: "succeeded", usage: { completion_tokens: 250 } }));
    await pollNativeVideo(alice, value.id);
    mock.fetch.mockRejectedValueOnce(new Error("fixture uncertain create"));
    const uncertain = await createNativeVideo(alice, request("different scheme"), "fixture-uncertain-2");
    await prisma.$executeRaw`UPDATE "GatewayNativeVideoJob" SET "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '2 minutes' WHERE "userId" = ${alice.id}`;
    mock.fetch.mockResolvedValueOnce(reply(complete()));
    expect(await reconcileNativeVideoJobs({ minAgeMs: 1000 })).toMatchObject({ claimed: 1, completed: 1, errors: 0 });
    const s = await stats(); expect(s.wallet.balanceCents).toBe(975); expect(s.ledger).toHaveLength(1);
    expect((await pollNativeVideo(alice, uncertain.id)).stateUncertain).toBe(true); expect(mock.fetch.mock.calls.map(call => call[1].method)).toEqual(["POST", "GET", "POST", "GET"]);
  });
  it("retains a known larger liability when actual settlement exceeds available balance", async () => {
    const value = await created(); mock.fetch.mockResolvedValueOnce(reply(complete("provider-task-1", 20000)));
    await expect(pollNativeVideo(alice, value.id)).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    const s = await stats(); expect(s.holds[0].status).toBe("unknown"); expect(s.holds[0].heldCents).toBe(0); expect(s.holds[0].amountDueCents).toBe(2000); expect(s.wallet.balanceCents).toBe(1000); expect(s.ledger).toHaveLength(0);
  });
  it("retains proven unpaid consumption when a later failed receipt reports zero usage", async () => {
    const value = await created(); mock.fetch.mockResolvedValueOnce(reply(complete("provider-task-1", 20000)));
    await expect(pollNativeVideo(alice, value.id)).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    mock.fetch.mockResolvedValueOnce(reply({ id: "provider-task-1", status: "failed", usage: { completion_tokens: 0 } }));
    await expect(pollNativeVideo(alice, value.id)).rejects.toMatchObject({ code: "NATIVE_VIDEO_FAILURE_AMBIGUOUS" });
    const s = await stats(); expect(s.holds[0]).toMatchObject({ status: "unknown", heldCents: 0, amountDueCents: 2000, settledCents: null });
    expect(s.jobs[0].state).toBe("processing"); expect(s.wallet.balanceCents).toBe(1000); expect(s.ledger).toHaveLength(0);
  });
  it("marks a pre-dispatch balance rejection failed without a provider POST or an active duplicate", async () => {
    await prisma.$executeRawUnsafe(`CREATE FUNCTION direct_native_empty_wallet() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE "GatewayWallet" SET "balanceCents"=0 WHERE "userId"=NEW."userId"; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER direct_native_empty_wallet AFTER INSERT ON "GatewayNativeVideoJob" FOR EACH ROW EXECUTE FUNCTION direct_native_empty_wallet()`);
    try {
      await expect(createNativeVideo(alice, request(), "fixture-dispatch-balance-race")).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE", status: 402 });
      const s = await stats(); expect(s.holds[0]).toMatchObject({ status: "released", heldCents: 0, amountDueCents: 0 });
      expect(s.jobs[0]).toMatchObject({ state: "failed", providerTaskId: null }); expect(mock.fetch).not.toHaveBeenCalled(); expect(s.ledger).toHaveLength(0);
      expect(await resolveNativeVideo(alice, "fixture-dispatch-balance-race")).toMatchObject({ status: "failed", error: { code: "NATIVE_VIDEO_BALANCE_REJECTED" } });
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER direct_native_empty_wallet ON "GatewayNativeVideoJob"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION direct_native_empty_wallet()`);
    }
  });
  it("releases a definitive matching failed receipt once without creating a usage debit", async () => {
    const value = await created(); mock.fetch.mockImplementation(async () => reply({ id: "provider-task-1", status: "failed" }));
    const values = await Promise.all(Array.from({ length: 6 }, () => pollNativeVideo(alice, value.id)));
    expect(values.every(v => v.status === "failed")).toBe(true);
    const s = await stats(); expect(s.holds[0].status).toBe("released"); expect(s.wallet.balanceCents).toBe(1000); expect(s.ledger).toHaveLength(0);
    const events = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "GatewayBillingHoldEvent" WHERE "transition"='released'`;
    expect(Number(events[0].count)).toBe(1);
  });
  it("does not release contradictory failure usage or canceled/expired/unknown states", async () => {
    const value = await created();
    for (const receipt of [{ id: "provider-task-1", status: "failed", usage: { completion_tokens: 2 } }, { id: "provider-task-1", status: "cancelled" }, { id: "provider-task-1", status: "expired" }]) {
      mock.fetch.mockResolvedValueOnce(reply(receipt)); await expect(pollNativeVideo(alice, value.id)).rejects.toBeInstanceOf(Error);
    }
    expect((await stats()).holds[0].status).toBe("dispatched");
  });
  it("competing success/failure polls cannot settle and release the same hold or roll a terminal state back", async () => {
    const value = await created();
    let count = 0; let release: () => void = () => {};
    const arrived = new Promise<void>(resolve => { release = resolve; });
    mock.fetch.mockImplementation(async () => {
      const index = count++; if (count === 6) release(); await arrived;
      return reply(index % 2 ? complete() : { id: "provider-task-1", status: "failed" });
    });
    await Promise.allSettled(Array.from({ length: 6 }, () => pollNativeVideo(alice, value.id)));
    const s = await stats();
    expect(["settled", "released"]).toContain(s.holds[0].status);
    if (s.holds[0].status === "settled") { expect(s.jobs[0].state).toBe("succeeded"); expect(s.ledger).toHaveLength(1); expect(s.wallet.balanceCents).toBe(975); }
    else { expect(s.jobs[0].state).toBe("failed"); expect(s.ledger).toHaveLength(0); expect(s.wallet.balanceCents).toBe(1000); }
    const transitions = await prisma.$queryRaw<Array<{ transition: string }>>`SELECT "transition" FROM "GatewayBillingHoldEvent" WHERE "transition" IN ('settled','released')`;
    expect(transitions).toHaveLength(1);
    const before = mock.fetch.mock.calls.length; await pollNativeVideo(alice, value.id); expect(mock.fetch).toHaveBeenCalledTimes(before);
  });
  it("streams only settled owner media without forwarding a supplier credential", async () => {
    const value = await created(); mock.fetch.mockResolvedValueOnce(reply(complete())); await pollNativeVideo(alice, value.id);
    mock.fetch.mockImplementationOnce(async (url, init) => {
      expect(url).toMatch(/^https:\/\/media.example.com\//); expect(init.headers).toEqual({ Range: "bytes=0-" });
      return new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { "Content-Type": "video/mp4", "Content-Length": "3", "Content-Range": "bytes 0-2/3" } });
    });
    const response = await nativeVideoContent(alice, value.id, new Request("https://local.example", { headers: { Range: "bytes=0-" } }));
    expect(response.status).toBe(206); expect((await response.arrayBuffer()).byteLength).toBe(3); expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
