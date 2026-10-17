import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const billing = vi.hoisted(() => ({ pricing: vi.fn(), refund: vi.fn(), cancel: vi.fn(), lock: vi.fn() }));
vi.mock("@/lib/model-gateway/billing-hold", () => ({ getGatewayBillingHoldPricing: billing.pricing, refundGatewayBillingHold: billing.refund, cancelGatewayBillingHold: billing.cancel }));
vi.mock("@/lib/model-gateway/billing", () => ({ lockGatewayBillingWallet: billing.lock }));
vi.mock("@/lib/db", () => ({ prisma: { gatewayUsage: { findFirst: vi.fn() }, $queryRaw: vi.fn(), $executeRaw: vi.fn(), $transaction: vi.fn() } }));
import { prisma } from "@/lib/db";
import { findGatewayVideoJob, reconcileGatewayVideoTerminal } from "@/lib/model-gateway/video-jobs";
const find = vi.mocked(prisma.gatewayUsage.findFirst);

beforeEach(() => {
  vi.resetAllMocks(); billing.pricing.mockResolvedValue({billingMode:"prepaid_quote"});
  vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
  vi.mocked(prisma.$transaction).mockImplementation(async fn => typeof fn === "function" ? fn({$queryRaw: vi.fn(async () => [{refundedCents:0}]), $executeRaw: prisma.$executeRaw} as never) : [] as never);
});

describe("gateway video job ownership lookup", () => {
  it("restricts durable ownership lookup to a successful video task for the current user", async () => {
    find.mockResolvedValue({ model: "video-alias", provider: "shaozhuang", metadata: {
      upstreamModel: "upstream-video", baseUrl: "https://relay.example.com/v1", billing: "accepted_task"
    } } as never);
    expect(await findGatewayVideoJob("user-a", "task-1")).toEqual({
      model: "video-alias", provider: "shaozhuang", upstreamModel: "upstream-video", baseUrl: "https://relay.example.com/v1"
    });
    expect(find).toHaveBeenCalledWith({
      where: { userId: "user-a", requestId: "task-1", endpoint: "videos", status: "ok" },
      orderBy: { createdAt: "desc" }, select: { model: true, provider: true, metadata: true, billingEventId: true }
    });
  });
  it("fails closed when ownership is absent", async () => {
    find.mockResolvedValue(null);
    expect(await findGatewayVideoJob("user-b", "task-1")).toBeNull();
  });
  it("returns the immutable credential id for an owned task", async () => {
    find.mockResolvedValue({ model: "video", provider: "shaozhuang", metadata: {
      upstreamModel: "upstream-video", baseUrl: "https://relay.example.com/v1", credentialId: "user-a-backup-1"
    } } as never);
    expect(await findGatewayVideoJob("user-a", "task-1")).toMatchObject({ credentialId: "user-a-backup-1" });
  });
  it.each(["", "../another-user", "key:secret", 10, null])("rejects invalid present credential metadata: %j", async credentialId => {
    find.mockResolvedValue({ model: "video", provider: "shaozhuang", metadata: {
      upstreamModel: "upstream-video", baseUrl: "https://relay.example.com/v1", credentialId
    } } as never);
    expect(await findGatewayVideoJob("user-a", "task-1")).toBeNull();
  });
  it.each([null, [], {}, { baseUrl: "https://relay.example.com/v1" }, { upstreamModel: "video" }])(
    "does not dispatch legacy or invalid video metadata: %j", async (metadata) => {
      find.mockResolvedValue({ model: "video", provider: "shaozhuang", metadata } as never);
      expect(await findGatewayVideoJob("user-a", "task-1")).toBeNull();
    }
  );
});

describe("accepted video terminal customer accounting", () => {
  const job = {billingEventId:"original-event"};
  it("refunds only the original bound prepaid event without rewriting its accepted supplier usage", async () => {
    expect(await reconcileGatewayVideoTerminal("owner", "task-1", job, {data:{id:"task-1",status:"failed"}})).toBe("failed");
    expect(billing.refund).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({userId:"owner",eventId:"original-event",reason:"confirmed_failed"}));
    expect(find).not.toHaveBeenCalled(); expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
  it("keeps provider cancelled tasks charged", async () => {
    expect(await reconcileGatewayVideoTerminal("owner", "task-1", job, {id:"task-1",status:"cancelled"})).toBe("cancelled");
    expect(billing.cancel).toHaveBeenCalledExactlyOnceWith({userId:"owner",eventId:"original-event"}); expect(billing.refund).not.toHaveBeenCalled();
  });
  it("ignores running receipts with no returned id and historical reservation records", async () => {
    await reconcileGatewayVideoTerminal("owner","task-1",job,{status:"processing"}); expect(billing.pricing).not.toHaveBeenCalled();
    billing.pricing.mockResolvedValue({billingMode:"reservation"}); await reconcileGatewayVideoTerminal("owner","task-1",job,{id:"task-1",status:"failed"});
    expect(billing.refund).not.toHaveBeenCalled(); expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
  it.each([{id:"task-other",status:"failed"}, {id:"task-1",status:"failed",data:{state:"succeeded"}}])("refuses unbound or contradictory terminal receipts", async data => {
    await expect(reconcileGatewayVideoTerminal("owner","task-1",job,data)).rejects.toMatchObject({code:"VIDEO_RECEIPT_MISMATCH"}); expect(billing.refund).not.toHaveBeenCalled();
  });
  it("writes a durable success marker under the same wallet lock before future failure refunds", async () => {
    expect(await reconcileGatewayVideoTerminal("owner","task-1",job,{id:"task-1",status:"completed"})).toBe("succeeded");
    expect(billing.lock).toHaveBeenCalledWith(expect.anything(),"owner"); expect(prisma.$executeRaw).toHaveBeenCalledOnce();
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{id:"success-marker"}]);
    await expect(reconcileGatewayVideoTerminal("owner","task-1",job,{id:"task-1",status:"failed"})).rejects.toMatchObject({code:"VIDEO_RECEIPT_MISMATCH"}); expect(billing.refund).not.toHaveBeenCalled();
  });
});
