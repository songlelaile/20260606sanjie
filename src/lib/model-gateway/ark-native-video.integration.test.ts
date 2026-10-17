import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
vi.mock("server-only", () => ({}));

// These keys, hosts and rates are synthetic fixtures, never operational credentials or quotes.
const fixture = vi.hoisted(() => ({
  fetch: vi.fn(), raw: "", path: "/fixture/private/ark-native-video.json",
  legacyKey: "independent-sub2-key", legacyBase: "https://sub.shaozhuangai.com/v1"
}));
vi.mock("./relay-config", () => ({ getRelayRuntime: async () => ({ apiKey: fixture.legacyKey, baseUrl: fixture.legacyBase }) }));
vi.mock("./relay-network", async original => ({ ...await original<typeof import("./relay-network")>(), relayFetch: fixture.fetch }));
// Keep the real configuration parser and binding resolver. Only the private file's
// bytes/metadata are virtual, avoiding root-owned files or access to any real secret.
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  const isFixture = (path: unknown) => String(path) === fixture.path;
  const stat = () => ({ uid: 0, gid: 0, mode: 0o100600, nlink: 1, size: Buffer.byteLength(fixture.raw),
    dev: 1, ino: 99, mtimeMs: 1, ctimeMs: 1, mtimeNs: 1n, ctimeNs: 1n,
    isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false });
  return { ...actual,
    lstat: vi.fn(async (path: Parameters<typeof actual.lstat>[0]) => {
      if (isFixture(path)) return stat();
      if (["/", "/fixture", "/fixture/private"].includes(String(path))) return { ...stat(), mode: 0o40755, isFile: () => false, isDirectory: () => true };
      return actual.lstat(path);
    }),
    open: vi.fn(async (path: Parameters<typeof actual.open>[0], flags: Parameters<typeof actual.open>[1], mode?: Parameters<typeof actual.open>[2]) => isFixture(path) ? {
      stat: async () => stat(),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytesRead = Buffer.from(fixture.raw).copy(buffer, offset, position, position + length);
        return { bytesRead, buffer };
      },
      close: async (): Promise<void> => {}
    } : actual.open(path, flags, mode))
  };
});

import { prisma } from "@/lib/db";
import { createNativeVideo, nativeVideoCapabilities, pollNativeVideo, resolveNativeVideo, nativeVideoContent } from "./native-video";
import { reserveGatewayBillingHold, markGatewayBillingHoldDispatched, getGatewayAvailableBalance } from "./billing-hold";
import { getGatewayBillingSnapshot } from "./billing";
import { insertNativeVideoJob, updateNativeVideoJob } from "./native-video-store";

const database = process.env.ARK_NATIVE_VIDEO_TEST_DATABASE_URL;
if (database) {
  const url = new URL(database);
  if (url.hostname !== "127.0.0.1" || url.username !== "ark_native_fixture" || url.pathname !== "/ark_native_video_uat" ||
      process.env.DATABASE_URL !== database || process.env.ARK_NATIVE_VIDEO_TEST_DISPOSABLE !== "1") {
    throw new Error("Independent Ark integration requires its fresh disposable localhost database");
  }
}

const alice = { id: "carkindependent_alice", tenantId: "carkindependent_tenant_a", username: "ark-independent-alice" };
const bob = { id: "carkindependent_bob", tenantId: "carkindependent_tenant_b", username: "ark-independent-bob" };
const digest = (input: string) => createHash("sha256").update(input).digest("hex");
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const success = (tokens = 1_000_000, id = "ark-task-fixture") => ({ id, status: "succeeded", usage: { completion_tokens: tokens }, content: { video_url: "https://media.example.com/ark.mp4?signature=fixture" } });
const model = () => ({ id: "seedance-2.0", label: "Independent Ark fixture", upstreamModel: "doubao-seedance-2-0-260128", priceVersion: "fixture-price-a",
  reservationCents: 5000, durations: [5], resolutions: ["720p", "1080p"], ratios: ["16:9"], generateAudio: true, mediaHosts: ["media.example.com"],
  priceTiers: [
    { resolution: "720p", hasVideoInput: false, completionCentsPerMillion: 101 },
    { resolution: "720p", hasVideoInput: true, completionCentsPerMillion: 202 },
    { resolution: "1080p", hasVideoInput: false, completionCentsPerMillion: 303 },
    { resolution: "1080p", hasVideoInput: true, completionCentsPerMillion: 404 }
  ] });
const binding = (id = "fixture-ark-a", key = "independent-ark-key-a") => ({ provider: "ark", bindingId: id, apiKey: key, models: [model()] });
const configuration = () => ({ version: 1, enabled: true, activeBindingId: "fixture-ark-a", bindings: [binding()] });
const setConfig = (cfg: unknown) => { fixture.raw = JSON.stringify(cfg); };
const request = (resolution = "720p", video = false, text = "independent fixture product") => ({ expectedAccount: `${alice.tenantId}:${alice.username}`,
  model: "seedance-2.0", content: [{ type: "text", text }, ...(video ? [{ type: "video_url", role: "reference_video", video_url: { url: "https://input.example.com/reference.mp4" } }] : [])],
  duration: 5, resolution, ratio: "16:9", generate_audio: false });
const legacyModel = () => ({ ...model(), id: "seedance-2.5", upstreamModel: "legacy-frozen-upstream-model", priceVersion: "legacy-price-v1", completionCentsPerMillion: 100000, priceTiers: undefined });
const legacyConfig = () => ({ enabled: false, bindingId: "legacy-sub2-v1-binding", models: [legacyModel()] });

// Real Prisma transactions, indexes, wallet/hold/usage rows, mocked supplier I/O.
// Deliberately opt-in and isolated from the original NATIVE_VIDEO_TEST_DATABASE_URL suite.
describe.skipIf(!database)("independent direct Ark persisted billing and binding integration", () => {
  beforeEach(async () => {
    fixture.fetch.mockReset(); fixture.legacyKey = "independent-sub2-key"; fixture.legacyBase = "https://sub.shaozhuangai.com/v1";
    fixture.fetch.mockImplementation(async () => { throw new Error("Unconfigured mock request; external requests prohibited"); });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("External network prohibited in independent Ark fixtures"); }));
    process.env.MODEL_GATEWAY_NATIVE_VIDEO_CONFIG_FILE = fixture.path;
    process.env.MODEL_GATEWAY_SEEDANCE_CONFIG = JSON.stringify(legacyConfig());
    setConfig(configuration());
    await prisma.$executeRaw`TRUNCATE TABLE "GatewayNativeVideoJob", "GatewayBillingHoldEvent", "GatewayBillingHold", "GatewayBillingLedger", "GatewayUsage", "GatewayWallet", "User", "Tenant" CASCADE`;
    for (const owner of [alice, bob]) {
      await prisma.tenant.create({ data: { id: owner.tenantId, slug: owner.tenantId, name: "Independent fixture" } });
      await prisma.user.create({ data: { ...owner, password: "fixture-not-a-login", name: owner.username, gatewayWallet: { create: { balanceCents: 100000 } } } });
    }
  });
  afterAll(async () => {
    await prisma.$disconnect(); vi.unstubAllGlobals();
    delete process.env.MODEL_GATEWAY_NATIVE_VIDEO_CONFIG_FILE; delete process.env.MODEL_GATEWAY_SEEDANCE_CONFIG;
  });
  async function state() {
    return {
      wallet: await prisma.gatewayWallet.findUniqueOrThrow({ where: { userId: alice.id } }),
      jobs: await prisma.$queryRaw<Array<{ id: string; state: string; upstreamModel: string; bindingFingerprint: string; tariff: Record<string, unknown>; providerTaskId: string | null }>>`SELECT * FROM "GatewayNativeVideoJob" WHERE "userId"=${alice.id}`,
      holds: await prisma.$queryRaw<Array<{ status: string; heldCents: number; settledCents: number | null }>>`SELECT "status","heldCents","settledCents" FROM "GatewayBillingHold" WHERE "userId"=${alice.id}`,
      usages: await prisma.gatewayUsage.findMany({ where: { userId: alice.id } }),
      debits: await prisma.gatewayBillingLedger.findMany({ where: { userId: alice.id, kind: "debit" } })
    };
  }
  async function create(body = request(), key = "ark-fixture-idem") {
    fixture.fetch.mockResolvedValueOnce(reply({ id: "ark-task-fixture" }));
    return createNativeVideo(alice, body, key);
  }
  async function importPreUpgradeSub2Job() {
    const old = legacyConfig(); const tariff = legacyModel();
    // Independent reproduction of the published v1 hash byte order, not the new resolver's helper.
    const oldFingerprint = digest(JSON.stringify({ base: "https://sub.shaozhuangai.com", bindingId: old.bindingId, keyHash: digest(fixture.legacyKey) }));
    const snapshot = await getGatewayBillingSnapshot(alice.id);
    await reserveGatewayBillingHold({ auth: { userId: alice.id, username: alice.username, apiKeyId: null, keyPrefix: "fixture" }, billingSnapshot: snapshot,
      eventId: "legacy-event-id", quoteCents: 5000, requestFingerprint: "a".repeat(64), endpoint: "seedance.tasks", provider: "shaozhuang", model: tariff.id,
      onReserved: async (tx, hold) => insertNativeVideoJob(tx, { id: "nv_legacy_preupgrade", userId: alice.id, tenantId: alice.tenantId,
        eventId: hold.eventId, idempotencyHash: digest("legacy-idem"), requestFingerprint: "a".repeat(64), bindingFingerprint: oldFingerprint,
        model: tariff.id, upstreamModel: tariff.upstreamModel, tariff: { completionCentsPerMillion: tariff.completionCentsPerMillion, reservationCents: tariff.reservationCents, priceVersion: tariff.priceVersion, mediaHosts: tariff.mediaHosts } }) });
    await markGatewayBillingHoldDispatched({ userId: alice.id, eventId: "legacy-event-id" });
    await updateNativeVideoJob(alice, "nv_legacy_preupgrade", { state: "processing", providerTaskId: "legacy-provider-task" });
    return "nv_legacy_preupgrade";
  }

  it("exposes capabilities without supplier keys, private file path or upstream model", async () => {
    const caps = await nativeVideoCapabilities(alice);
    expect(caps.configured).toBe(true); expect(caps.models[0].reservationCents).toBe(5000);
    const json = JSON.stringify(caps);
    for (const privateValue of [fixture.path, "independent-ark-key-a", "doubao-seedance-2-0-260128", "ark.cn-beijing.volces.com"]) expect(json).not.toContain(privateValue);
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["720p", false, 101], ["720p", true, 202], ["1080p", false, 303], ["1080p", true, 404]
  ] as const)("freezes only matching %s/video=%s tier in cents per million", async (resolution, hasVideo, cents) => {
    const value = await create(request(resolution, hasVideo));
    const first = fixture.fetch.mock.calls[0];
    expect(first[0]).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks");
    expect(first[1].headers.Authorization).toBe("Bearer independent-ark-key-a");
    expect(JSON.parse(first[1].body)).toMatchObject({ model: "doubao-seedance-2-0-260128", resolution });
    expect(JSON.parse(first[1].body)).not.toHaveProperty("expectedAccount");
    const before = await state(); expect(before.jobs[0].tariff.completionCentsPerMillion).toBe(cents);
    expect(before.jobs[0].tariff).not.toHaveProperty("priceTiers");
    fixture.fetch.mockResolvedValueOnce(reply(success()));
    const completed = await pollNativeVideo(alice, value.id);
    expect(completed.billing.settledCents).toBe(cents);
    const after = await state(); expect(after.wallet.balanceCents).toBe(100000 - cents); expect(after.debits).toHaveLength(1); expect(after.usages).toHaveLength(1);
    expect(after.usages[0].provider).toBe("volc"); expect(after.usages[0].model).toBe("seedance-2.0");
  });
  it("rounds sub-cent token use upward exactly once without a thousandfold unit conversion", async () => {
    const cfg = configuration(); cfg.bindings[0].models[0].priceTiers.forEach(t => { t.completionCentsPerMillion = 1200; }); setConfig(cfg);
    const value = await create(); fixture.fetch.mockResolvedValueOnce(reply(success(1001)));
    const result = await pollNativeVideo(alice, value.id);
    expect(result.billing.settledCents).toBe(2); expect((await state()).wallet.balanceCents).toBe(99998);
  });
  it.each(["missing", "duplicate", "unconfigured", "scalar-only"])("rejects %s Ark tier before any hold or POST", async kind => {
    const cfg = configuration(); const m = cfg.bindings[0].models[0];
    if (kind === "missing") (m as Record<string, unknown>).priceTiers = undefined;
    if (kind === "duplicate") m.priceTiers.push({ ...m.priceTiers[0] });
    if (kind === "unconfigured") m.priceTiers = m.priceTiers.filter(t => t.resolution !== "720p" || t.hasVideoInput);
    if (kind === "scalar-only") { (m as Record<string, unknown>).priceTiers = undefined; (m as Record<string, unknown>).completionCentsPerMillion = 101; }
    setConfig(cfg); await expect(createNativeVideo(alice, request(), "invalid-tier")).rejects.toBeInstanceOf(Error);
    expect(fixture.fetch).not.toHaveBeenCalled(); const s = await state(); expect(s.holds).toHaveLength(0); expect(s.jobs).toHaveLength(0);
  });
  it("keeps original provider/model/scalar after active binding changes, disabled creation and changed prices", async () => {
    const value = await create(); const original = (await state()).jobs[0];
    const cfg = configuration(); cfg.bindings[0].models = [];
    const next = binding("fixture-ark-b", "independent-ark-key-b"); next.models[0].id = "seedance-2.5"; next.models[0].upstreamModel = "doubao-seedance-2-5-260628"; next.models[0].priceVersion = "fixture-price-b";
    next.models[0].priceTiers.forEach(t => { t.completionCentsPerMillion = 99000; }); cfg.bindings.push(next); cfg.activeBindingId = next.bindingId; cfg.enabled = false; setConfig(cfg);
    await expect(createNativeVideo(alice, request("720p", false, "different input"), "different-input")).rejects.toBeInstanceOf(Error);
    fixture.fetch.mockResolvedValueOnce(reply(success())); const result = await pollNativeVideo(alice, value.id);
    expect(result.billing.settledCents).toBe(101);
    const call = fixture.fetch.mock.calls[1]; expect(call[0]).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/ark-task-fixture");
    expect(call[1].headers.Authorization).toBe("Bearer independent-ark-key-a");
    const s = await state(); expect(s.jobs[0].bindingFingerprint).toBe(original.bindingFingerprint); expect(s.jobs[0].upstreamModel).toBe("doubao-seedance-2-0-260128");
    expect(s.jobs[0].tariff).toMatchObject({ priceVersion: "fixture-price-a", completionCentsPerMillion: 101 }); expect(s.usages[0].provider).toBe("volc");
    expect(fixture.fetch.mock.calls.map(c => c[1].method)).toEqual(["POST", "GET"]);
  });
  it("dispatches a distinct new request to the new active binding while the old job polls its original binding", async () => {
    const first = await create(); const cfg = configuration(); cfg.bindings[0].models = [];
    const next = binding("fixture-ark-b", "independent-ark-key-b"); next.models[0].id = "seedance-2.5"; next.models[0].upstreamModel = "doubao-seedance-2-5-260628";
    cfg.bindings.push(next); cfg.activeBindingId = next.bindingId; setConfig(cfg);
    fixture.fetch.mockResolvedValueOnce(reply({ id: "ark-task-b" }));
    const second = await createNativeVideo(alice, { ...request("720p", false, "distinct new request"), model: "seedance-2.5" }, "new-binding-idem");
    expect(second.id).not.toBe(first.id);
    expect(fixture.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer independent-ark-key-b");
    expect(JSON.parse(fixture.fetch.mock.calls[1][1].body).model).toBe("doubao-seedance-2-5-260628");
    fixture.fetch.mockResolvedValueOnce(reply(success()));
    expect((await pollNativeVideo(alice, first.id)).billing.settledCents).toBe(101);
    expect(fixture.fetch.mock.calls[2][1].headers.Authorization).toBe("Bearer independent-ark-key-a");
    expect((await state()).jobs).toHaveLength(2);
  });
  it.each(["remove", "rotate"])("never borrows an active/replacement Key when original binding is %s", async kind => {
    const value = await create(); const cfg = configuration();
    if (kind === "remove") { cfg.bindings = [binding("fixture-ark-b", "independent-ark-key-b")]; cfg.activeBindingId = "fixture-ark-b"; }
    else cfg.bindings[0].apiKey = "rotated-private-key";
    setConfig(cfg); await expect(pollNativeVideo(alice, value.id)).rejects.toMatchObject({ code: "NATIVE_VIDEO_BINDING_CHANGED" });
    expect(fixture.fetch).toHaveBeenCalledTimes(1); const s = await state(); expect(s.holds[0].status).toBe("dispatched"); expect(s.holds[0].heldCents).toBe(5000); expect(s.debits).toHaveLength(0);
  });
  it.each(["network", "http408", "http409", "http503", "no-id", "invalid-json"])("persists %s create uncertainty across module reload, new keys and active binding changes", async mode => {
    if (mode === "network") fixture.fetch.mockRejectedValueOnce(new Error("fixture disconnect"));
    else if (mode === "no-id") fixture.fetch.mockResolvedValueOnce(reply({ status: "queued" }));
    else if (mode === "invalid-json") fixture.fetch.mockResolvedValueOnce(new Response("not-json"));
    else fixture.fetch.mockResolvedValueOnce(reply({ error: "fixture response" }, Number(mode.slice(4))));
    const value = await createNativeVideo(alice, request(), "unknown-create"); expect(value.stateUncertain).toBe(true);
    const cfg = configuration(); cfg.bindings = [binding("fixture-ark-b", "independent-ark-key-b")]; cfg.activeBindingId = "fixture-ark-b"; setConfig(cfg);
    vi.resetModules(); const restarted = await import("./native-video");
    expect((await restarted.createNativeVideo(alice, request(), "unknown-create")).id).toBe(value.id);
    expect((await restarted.createNativeVideo(alice, request(), "brand-new-key")).id).toBe(value.id);
    expect((await restarted.resolveNativeVideo(alice, "unknown-create")).id).toBe(value.id);
    expect((await restarted.pollNativeVideo(alice, value.id)).stateUncertain).toBe(true);
    expect(fixture.fetch).toHaveBeenCalledTimes(1); const s = await state(); expect(s.jobs).toHaveLength(1); expect(s.holds[0].status).toBe("unknown"); expect(s.debits).toHaveLength(0);
  });
  it.each([undefined, null, 1, -1, "0", 0.5])("does not release Ark failed receipt with unproven zero usage (%s)", async tokens => {
    const value = await create(); fixture.fetch.mockResolvedValueOnce(reply({ id: "ark-task-fixture", status: "failed", ...(tokens !== undefined ? { usage: { completion_tokens: tokens } } : {}) }));
    await expect(pollNativeVideo(alice, value.id)).rejects.toMatchObject({ code: "NATIVE_VIDEO_FAILURE_AMBIGUOUS" });
    const s = await state(); expect(s.holds[0].status).toBe("dispatched"); expect(s.holds[0].heldCents).toBe(5000); expect(s.jobs[0].state).toBe("processing"); expect(s.debits).toHaveLength(0);
  });
  it.each(["failed", "succeeded"])("retains an Ark %s receipt with contradictory total token accounting", async status => {
    const value = await create();
    const body = status === "failed"
      ? { id: "ark-task-fixture", status, usage: { completion_tokens: 0, total_tokens: 1 } }
      : { ...success(250), usage: { completion_tokens: 250, total_tokens: 251 } };
    fixture.fetch.mockResolvedValueOnce(reply(body));
    await expect(pollNativeVideo(alice, value.id)).rejects.toBeInstanceOf(Error);
    const s = await state(); expect(s.holds[0].status).toBe("dispatched"); expect(s.jobs[0].state).toBe("processing");
    expect(s.usages).toHaveLength(0); expect(s.debits).toHaveLength(0); expect(s.wallet.balanceCents).toBe(100000);
  });
  it("releases explicit Ark zero-use failure once under concurrent polling", async () => {
    const value = await create(); fixture.fetch.mockImplementation(async () => reply({ id: "ark-task-fixture", status: "failed", usage: { completion_tokens: 0 } }));
    const results = await Promise.all(Array.from({ length: 5 }, () => pollNativeVideo(alice, value.id)));
    expect(results.every(r => r.status === "failed")).toBe(true);
    const s = await state(); expect(s.holds[0].status).toBe("released"); expect(s.holds[0].heldCents).toBe(5000); expect(s.wallet.balanceCents).toBe(100000);
    expect(await prisma.$transaction(tx => getGatewayAvailableBalance(tx, alice.id))).toMatchObject({ availableCents: 100000, reservedCents: 0 }); expect(s.debits).toHaveLength(0);
    const events = await prisma.$queryRaw<Array<{ transition: string }>>`SELECT "transition" FROM "GatewayBillingHoldEvent" WHERE "transition" IN ('released','settled')`;
    expect(events).toEqual([{ transition: "released" }]);
  });
  it.each([404, 409, 503])("retains the hold and never creates a fresh task after status HTTP %s", async status => {
    const value = await create(); fixture.fetch.mockResolvedValueOnce(reply({ error: "fixture status" }, status));
    await expect(pollNativeVideo(alice, value.id)).rejects.toMatchObject({ code: "NATIVE_VIDEO_STATUS_UNAVAILABLE" });
    expect((await createNativeVideo(alice, request(), "new-key")).id).toBe(value.id);
    expect(fixture.fetch.mock.calls.map(c => c[1].method)).toEqual(["POST", "GET"]); expect((await state()).holds[0].status).toBe("dispatched");
  });
  it("protects cross-tenant status/resolve/media and never sends an Ark Key to the CDN", async () => {
    const value = await create(); fixture.fetch.mockResolvedValueOnce(reply(success())); await pollNativeVideo(alice, value.id);
    const before = fixture.fetch.mock.calls.length;
    await expect(pollNativeVideo(bob, value.id)).rejects.toMatchObject({ status: 404 });
    await expect(resolveNativeVideo(bob, "ark-fixture-idem")).rejects.toMatchObject({ status: 404 });
    await expect(nativeVideoContent({ ...alice, tenantId: bob.tenantId }, value.id, new Request("https://fixture.local"))).rejects.toMatchObject({ status: 404 });
    expect(fixture.fetch).toHaveBeenCalledTimes(before);
    fixture.fetch.mockImplementationOnce(async (url, init) => {
      expect(url).toBe("https://media.example.com/ark.mp4?signature=fixture");
      expect(init.headers).toEqual({ Range: "bytes=0-" }); expect(JSON.stringify(init)).not.toContain("independent-ark-key");
      return new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { "Content-Type": "video/mp4", "Content-Length": "3", "Content-Range": "bytes 0-2/3" } });
    });
    const out = await nativeVideoContent(alice, value.id, new Request("https://fixture.local", { headers: { Range: "bytes=0-" } }));
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3])); expect(out.headers.get("cache-control")).toBe("private, no-store");
  });
  it("resolves the exact pre-upgrade Sub2 fingerprint while direct Ark is active, using old frozen tariff", async () => {
    const id = await importPreUpgradeSub2Job(); fixture.fetch.mockResolvedValueOnce(reply(success(250, "legacy-provider-task")));
    const result = await pollNativeVideo(alice, id); expect(result.billing.settledCents).toBe(25);
    expect(fixture.fetch.mock.calls[0][0]).toBe("https://sub.shaozhuangai.com/api/v3/contents/generations/tasks/legacy-provider-task");
    expect(fixture.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer independent-sub2-key");
    const s = await state(); expect(s.jobs[0].upstreamModel).toBe("legacy-frozen-upstream-model"); expect(s.usages[0].provider).toBe("shaozhuang"); expect(s.wallet.balanceCents).toBe(99975);
  });
  it("preserves the published Sub2 no-usage failed receipt policy for old tasks only", async () => {
    const id = await importPreUpgradeSub2Job(); fixture.fetch.mockResolvedValueOnce(reply({ id: "legacy-provider-task", status: "failed" }));
    expect((await pollNativeVideo(alice, id)).status).toBe("failed"); expect((await state()).holds[0].status).toBe("released");
  });
});
