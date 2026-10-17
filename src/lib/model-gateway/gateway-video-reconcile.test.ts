import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rows: [] as {eventId:string;userId:string;requestId:string}[], query: vi.fn(), update: vi.fn(), job: vi.fn(), terminal: vi.fn(), credential: vi.fn(), binding: vi.fn(), shared: vi.fn(), relay: vi.fn(), fetch: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {$transaction: async (fn: (tx:unknown)=>Promise<unknown>) => fn({$queryRaw:mocks.query,$executeRaw:mocks.update})} }));
vi.mock("./video-jobs", () => ({ findGatewayVideoJob:mocks.job, reconcileGatewayVideoTerminal:mocks.terminal }));
vi.mock("./user-supply", () => ({getUserSupplyCredential:mocks.credential}));
vi.mock("./billing-hold", () => ({getGatewaySharedVideoSupplyBinding:mocks.binding}));
vi.mock("./shared-wallet-source", () => ({getGatewaySharedPlatformRuntime:mocks.shared}));
vi.mock("./relay-config", () => ({getRelayRuntime:mocks.relay}));
vi.mock("./relay-network", () => ({relayFetch:mocks.fetch}));
import { reconcileGatewayVideoJobs } from "./gateway-video-reconcile";
beforeEach(() => {
  vi.resetAllMocks(); mocks.query.mockResolvedValue([{eventId:"event",userId:"owner",requestId:"task-original"}]);
  mocks.job.mockResolvedValue({billingEventId:"event",provider:"shaozhuang",model:"video",baseUrl:"https://fixture.example/v1",credentialId:"original-key-id"});
  mocks.credential.mockResolvedValue({apiKey:"private-key-fixture",baseUrl:"https://fixture.example/v1"});
  mocks.fetch.mockResolvedValue(Response.json({id:"task-original",status:"failed"})); mocks.terminal.mockResolvedValue("failed");
});
describe("automatic compatibility video refunds", () => {
  it("claims only prepaid accepted tasks and queries their original owner credential with GET", async () => {
    expect(await reconcileGatewayVideoJobs()).toMatchObject({claimed:1,failed:1,errors:0,settled:1});
    const sql = mocks.query.mock.calls[0][0].join(""); expect(sql).toContain("'prepaid_quote'"); expect(sql).toContain("'legacy_video_succeeded'"); expect(sql).toContain("SKIP LOCKED");
    expect(mocks.credential).toHaveBeenCalledExactlyOnceWith("owner","original-key-id");
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith("https://fixture.example/v1/videos/task-original",expect.objectContaining({method:"GET",headers:{Authorization:"Bearer private-key-fixture"}}));
    expect(mocks.terminal).toHaveBeenCalledWith("owner","task-original",expect.objectContaining({billingEventId:"event"}),{id:"task-original",status:"failed"});
  });
  it("retains a pending receipt and exposes sanitized counts only", async () => {
    mocks.terminal.mockResolvedValue(undefined); const result = await reconcileGatewayVideoJobs({limit:1,concurrency:1});
    expect(result).toMatchObject({pending:1,failed:0,errors:0}); expect(JSON.stringify(result)).not.toMatch(/private-key|fixture.example|owner/);
  });
  it("refuses a changed source binding instead of selecting a different supplier key", async () => {
    mocks.credential.mockResolvedValue({apiKey:"different-key",baseUrl:"https://other.example/v1"});
    expect(await reconcileGatewayVideoJobs()).toMatchObject({errors:1,failed:0,errorCodes:{GATEWAY_VIDEO_RECEIPT_UNAVAILABLE:1}});
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.terminal).not.toHaveBeenCalled(); expect(mocks.relay).not.toHaveBeenCalled();
  });
  it("uses an existing shared binding without dispatching or reserving anything new", async () => {
    mocks.job.mockResolvedValue({billingEventId:"event",provider:"shaozhuang",baseUrl:"https://fixture.example/v1"});
    mocks.binding.mockResolvedValue({epochId:"original-epoch",providerBaseUrl:"https://fixture.example/v1",credentialFingerprint:"hash",configVersion:"v"}); mocks.shared.mockResolvedValue({apiKey:"private-key-fixture",baseUrl:"https://fixture.example/v1",epoch:{id:"original-epoch"},credentialFingerprint:"hash",configVersion:"v"});
    await reconcileGatewayVideoJobs(); expect(mocks.shared).toHaveBeenCalledExactlyOnceWith(); expect(mocks.relay).not.toHaveBeenCalled();
  });
  it.each([new Response("unreadable receipt"), Response.json({error:"temporary"},{status:503}), Response.json([])])("retains charges on unreadable/temporary receipts", async response => {
    mocks.fetch.mockResolvedValue(response); expect(await reconcileGatewayVideoJobs()).toMatchObject({errors:1,failed:0}); expect(mocks.terminal).not.toHaveBeenCalled();
  });
  it.each([{limit:0},{limit:101},{concurrency:5},{minAgeMs:999}])("bounds each pass before any database or supplier call", async options => {
    await expect(reconcileGatewayVideoJobs(options)).rejects.toThrow("Invalid"); expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
