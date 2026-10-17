import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { GatewayBillingError } from "@/lib/model-gateway/billing-contract";
const mocks = vi.hoisted(() => ({ user: vi.fn(), overview: vi.fn(), proposalView: vi.fn(), receipt: vi.fn(),
  prepare: vi.fn(), prepareRefresh: vi.fn(), initialize: vi.fn(), refresh: vi.fn(), sourceRead: vi.fn(), giftPlans: vi.fn() }));
// The source route reaches the server-only shared wallet module; route tests run in Node.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user }));
// Pending gift-plan processing is a separate database service; routes only trigger it.
vi.mock("@/lib/model-gateway/credit-gift-plans", () => ({ tryProcessPendingGiftPlans: mocks.giftPlans }));
vi.mock("@/lib/model-gateway/credit-pool-management-view", () => ({ getCreditPoolManagementOverview: mocks.overview, getCreditPoolProposalView: mocks.proposalView, getCreditPoolOperationReceipt: mocks.receipt }));
vi.mock("@/lib/model-gateway/credit-pool-accounting", () => ({ prepareGatewayPoolAdoption: mocks.prepare, prepareGatewayPoolRefresh: mocks.prepareRefresh, initializeGatewayCreditPool: mocks.initialize, refreshGatewayCreditPool: mocks.refresh, persistGatewaySharedSourceSnapshot: mocks.sourceRead }));
import { GET as overview } from "./route";
import { POST as prepare } from "./proposals/route";
import { GET as proposal } from "./proposals/[id]/route";
import { POST as initialize } from "./initialize/route";
import { POST as refresh } from "./refresh/route";
import { GET as operation } from "./operations/[requestKey]/route";
import { POST as sourceRead } from "./source/route";
const hash = "a".repeat(64), key = "123e4567-e89b-42d3-a456-426614174000";
const prep = { operation: "adoption", snapshotId: "source-1", snapshotHash: hash };
const apply = { proposalId: "proposal-1", version: 1, snapshotHash: hash, requestKey: key };
const request = (body: unknown, headers: Record<string, string> = { origin: "https://shaozhuangai.com" }) => new Request("https://shaozhuangai.com/api/management/credit-pool", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const get = () => new Request("https://shaozhuangai.com/api/management/credit-pool");
const opGet = (query = "operation=adoption", requestKey = key) => operation(new Request(`https://shaozhuangai.com/api/management/credit-pool/operations/${requestKey}?${query}`), { params: Promise.resolve({ requestKey }) });
const writes = [{ name: "source", run: sourceRead, body: { requestKey: key }, service: mocks.sourceRead }, { name: "prepare", run: prepare, body: prep, service: mocks.prepare }, { name: "initialize", run: initialize, body: apply, service: mocks.initialize }, { name: "refresh", run: refresh, body: apply, service: mocks.refresh }];
const privateHeaders = (r: Response) => expect(r.headers.get("cache-control")).toBe("private, no-store");
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("PUBLIC_APP_ORIGIN", "");
  mocks.user.mockResolvedValue({ id: "admin-real", authRole: "admin", role: "operator", status: "active" });
  mocks.overview.mockResolvedValue({ pool: { state: "uninitialized", ready: false, balanceCents: null }, source: { state: "unconfigured", blockers: [{ code: "SOURCE_READ_NOT_CONNECTED" }] } });
  mocks.prepare.mockResolvedValue({ proposalId: "proposal-1" }); mocks.prepareRefresh.mockResolvedValue({ proposalId: "proposal-1" });
  mocks.proposalView.mockResolvedValue({ id: "proposal-1", capacityCents: "1000", walletTotalCents: "200", state: "reviewable" });
  mocks.initialize.mockResolvedValue({ initialized: true, replayed: false, eventId: `adoption:${key}` });
  mocks.refresh.mockResolvedValue({ refreshed: true, replayed: true }); mocks.receipt.mockResolvedValue(null);
  mocks.giftPlans.mockResolvedValue({ state: "checked", attempted: 0 });
});
afterEach(() => vi.unstubAllEnvs());
describe("active platform admin management pool boundary", () => {
  it.each([ [null, 401], [{ id: "tenant", authRole: "tenant", role: "admin", status: "active" }, 403], [{ id: "owner", role: "admin", status: "active" }, 403], [{ id: "disabled", authRole: "admin", status: "disabled" }, 403] ])("rejects all read/write actions for %j", async (user, status) => {
    mocks.user.mockResolvedValue(user);
    const responses = [await overview(), await proposal(get(), { params: Promise.resolve({ id: "proposal-1" }) }), await opGet(), ...await Promise.all(writes.map(w => w.run(request(w.body))))];
    for (const r of responses) { expect(r.status).toBe(status); privateHeaders(r); }
    for (const fn of [mocks.overview, mocks.proposalView, mocks.receipt, mocks.prepare, mocks.prepareRefresh, mocks.initialize, mocks.refresh, mocks.sourceRead]) expect(fn).not.toHaveBeenCalled();
  });
  it("rechecks authentication on the next request after administrator disable", async () => { expect((await overview()).status).toBe(200); mocks.user.mockResolvedValue({ id: "admin-real", authRole: "admin", status: "disabled" }); expect((await initialize(request(apply))).status).toBe(403); expect(mocks.initialize).not.toHaveBeenCalled(); expect(mocks.user).toHaveBeenCalledTimes(2); });
  it("returns missing source as diagnostic blocked facts and unknown pool balance", async () => { const r = await overview(); privateHeaders(r); expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ data: { pool: { state: "uninitialized", ready: false, balanceCents: null }, source: { state: "unconfigured" } } }); expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.initialize).not.toHaveBeenCalled(); });
  it.each(writes)("%s rejects cross-site before any service write", async w => { const r = await w.run(request(w.body, { origin: "https://evil.example" })); expect(r.status).toBe(403); privateHeaders(r); expect(await r.json()).toMatchObject({ code: "CROSS_SITE_REQUEST" }); expect(w.service).not.toHaveBeenCalled(); });
  for (const w of writes) {
    it.each(["budget", "capacityCents", "verified", "adminId", "proof", "balance"])(`${w.name} rejects extra financial authority field %s`, async extra => { const r = await w.run(request({ ...w.body, [extra]: extra === "verified" ? true : 12345 })); expect(r.status).toBe(400); expect(await r.json()).toMatchObject({ code: "POOL_INPUT_INVALID" }); expect(w.service).not.toHaveBeenCalled(); });
    it(`${w.name} rejects oversized request without the core operation`, async () => { const r = await w.run(request({ ...w.body, text: "x".repeat(4097) })); expect(r.status).toBe(413); expect(w.service).not.toHaveBeenCalled(); });
    it(`${w.name} rejects invalid JSON safely`, async () => { const r = await w.run(new Request(get().url, { method: "POST", headers: { origin: "https://shaozhuangai.com" }, body: "invalid-json secret-password" })); expect(r.status).toBe(400); expect(await r.json()).toMatchObject({ code: "INVALID_JSON" }); expect(w.service).not.toHaveBeenCalled(); });
    it(`${w.name} surfaces missing trusted source without leakage or fake success`, async () => { w.service.mockRejectedValue(new GatewayBillingError("POOL_SOURCE_UNVERIFIED", "private-password at provider", 409)); const r = await w.run(request(w.body)); expect(r.status).toBe(409); const body = JSON.stringify(await r.json()); expect(body).toContain("POOL_SOURCE_UNVERIFIED"); expect(body).not.toContain("private-password"); expect(body).not.toContain('"committed":true'); privateHeaders(r); });
  }
  it("preparation delegates canonical references to atomic adoption and scopes the view to actual admin", async () => { const r = await prepare(request(prep)); expect(r.status).toBe(200); expect(mocks.prepare).toHaveBeenCalledWith("admin-real", { snapshotId: "source-1", snapshotHash: hash }); expect(mocks.proposalView).toHaveBeenCalledWith("admin-real", "proposal-1"); expect(mocks.prepareRefresh).not.toHaveBeenCalled(); });
  it("source collects only server binding for actual admin and returns the allowlisted overview", async () => { mocks.sourceRead.mockResolvedValue({ apiKey: "must-not-return", proof: { private: true } }); const r = await sourceRead(request({ requestKey: key.toUpperCase() })); expect(r.status).toBe(200); expect(mocks.sourceRead).toHaveBeenCalledWith("admin-real", key); expect(JSON.stringify(await r.json())).not.toContain("must-not-return"); expect(mocks.giftPlans).not.toHaveBeenCalled(); });
  it("source verification requires exactly one client request key and never reaches the service without it", async () => {
    for (const body of [{}, { requestKey: "not-a-key" }, { requestKey: key, extra: true }]) { const r = await sourceRead(request(body)); expect(r.status).toBe(400); privateHeaders(r); }
    expect(mocks.sourceRead).not.toHaveBeenCalled(); expect(mocks.overview).not.toHaveBeenCalled(); expect(mocks.giftPlans).not.toHaveBeenCalled();
  });
  it("a ready source verification processes pending gift plans once before building the overview", async () => {
    mocks.sourceRead.mockResolvedValue({ ready: true, snapshotId: "source-1" }); const r = await sourceRead(request({ requestKey: key }));
    expect(r.status).toBe(200); expect(mocks.sourceRead).toHaveBeenCalledWith("admin-real", key); expect(mocks.giftPlans).toHaveBeenCalledOnce();
    expect(mocks.sourceRead.mock.invocationCallOrder[0]).toBeLessThan(mocks.giftPlans.mock.invocationCallOrder[0]);
    expect(mocks.giftPlans.mock.invocationCallOrder[0]).toBeLessThan(mocks.overview.mock.invocationCallOrder[0]);
  });
  it.each([
    [new Error("private database key"), 503, "CREDIT_POOL_SERVICE_UNAVAILABLE"],
    [new GatewayBillingError("FX_RATE_STALE", "private provider key", 409), 409, "FX_RATE_STALE"]
  ])("source POST can fail while building the overview after its source update has completed", async (failure, status, code) => {
    let sourceUpdated = false;
    mocks.sourceRead.mockImplementationOnce(async () => { sourceUpdated = true; return { snapshotId: "committed-source" }; });
    mocks.overview.mockImplementationOnce(async () => { expect(sourceUpdated).toBe(true); throw failure; });
    const response = await sourceRead(request({ requestKey: key }));
    expect(sourceUpdated).toBe(true); expect(response.status).toBe(status); expect(mocks.sourceRead).toHaveBeenCalledOnce(); expect(mocks.overview).toHaveBeenCalledOnce();
    expect(mocks.sourceRead.mock.invocationCallOrder[0]).toBeLessThan(mocks.overview.mock.invocationCallOrder[0]);
    const body = await response.json(); expect(body.code).toBe(code); expect(JSON.stringify(body)).not.toContain("private");
    expect(body).not.toHaveProperty("sourceUpdated", false); expect(body).not.toHaveProperty("committed", false);
  });
  it.each(["privateKeyRef", "origin", "ownerId", "groupId", "credentialFingerprint", "externalCommittedUsd"])("source clients cannot choose %s", async field => { const r = await sourceRead(request({ [field]: "client-authority" })); expect(r.status).toBe(400); expect(mocks.sourceRead).not.toHaveBeenCalled(); });
  it("refresh proposal delegates to same-cycle service rather than adoption", async () => { expect((await prepare(request({ ...prep, operation: "source_refresh" }))).status).toBe(200); expect(mocks.prepareRefresh).toHaveBeenCalledWith("admin-real", { snapshotId: "source-1", snapshotHash: hash }); expect(mocks.prepare).not.toHaveBeenCalled(); });
  it("initialization preserves normalized original key and returns allowlisted commit", async () => { mocks.initialize.mockResolvedValue({ initialized: true, replayed: true, eventId: `adoption:${key}`, secret: "not-allowed" }); const r = await initialize(request({ ...apply, requestKey: key.toUpperCase() })); expect(mocks.initialize).toHaveBeenCalledWith("admin-real", apply); expect(await r.json()).toEqual({ data: { operation: "adoption", committed: true, replayed: true, eventId: `adoption:${key}`, requestKey: key, automaticGifts: { state: "checked", attempted: 0 } } }); expect(mocks.giftPlans).toHaveBeenCalledOnce(); expect(mocks.initialize.mock.invocationCallOrder[0]).toBeLessThan(mocks.giftPlans.mock.invocationCallOrder[0]); });
  it("same-cycle refresh retains original references and idempotent receipt", async () => { const r = await refresh(request(apply)); expect(mocks.refresh).toHaveBeenCalledWith("admin-real", apply); expect(await r.json()).toMatchObject({ data: { operation: "source_refresh", committed: true, replayed: true, eventId: `source-refresh:${key}`, requestKey: key } }); });
  it("proposal reads bind to current admin and invalid IDs never reach DB view", async () => { expect((await proposal(get(), { params: Promise.resolve({ id: "proposal-1" }) })).status).toBe(200); expect(mocks.proposalView).toHaveBeenCalledWith("admin-real", "proposal-1"); mocks.proposalView.mockClear(); expect((await proposal(get(), { params: Promise.resolve({ id: "../secret" }) })).status).toBe(400); expect(mocks.proposalView).not.toHaveBeenCalled(); });
  it("original operation recovery is read-only and scoped by actor, kind and normalized key", async () => { mocks.receipt.mockResolvedValue({ eventId: `adoption:${key}`, capacityCents: "12345678901234567890" }); const r = await opGet("operation=adoption", key.toUpperCase()); expect(mocks.receipt).toHaveBeenCalledWith("admin-real", "adoption", key); expect(await r.json()).toMatchObject({ data: { state: "committed", requestKey: key, receipt: { capacityCents: "12345678901234567890" } } }); expect(mocks.initialize).not.toHaveBeenCalled(); });
  it.each(["operation=adoption&operation=source_refresh", "operation=adoption&budget=123", "operation=unknown", ""])("recovery rejects ambiguous authority query %s", async query => { expect((await opGet(query)).status).toBe(400); expect(mocks.receipt).not.toHaveBeenCalled(); });
  it("absence of an operation receipt does not invent committed status", async () => { expect(await (await opGet()).json()).toMatchObject({ data: { state: "not_found", receipt: null } }); });
  it("generic read failure is distinct from missing source and omits secrets", async () => { mocks.overview.mockRejectedValue(new Error("postgres password raw secret")); const r = await overview(); expect(r.status).toBe(503); expect(await r.json()).toEqual({ error: "总积分池核对服务暂时不可用，请稍后重试", code: "CREDIT_POOL_SERVICE_UNAVAILABLE" }); });
});
