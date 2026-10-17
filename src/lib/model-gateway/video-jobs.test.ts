import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { gatewayUsage: { findFirst: vi.fn() } } }));
import { prisma } from "@/lib/db";
import { findGatewayVideoJob } from "@/lib/model-gateway/video-jobs";
const find = vi.mocked(prisma.gatewayUsage.findFirst);

beforeEach(() => { vi.resetAllMocks(); });

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
      orderBy: { createdAt: "desc" }, select: { model: true, provider: true, metadata: true }
    });
  });
  it("fails closed when ownership is absent", async () => {
    find.mockResolvedValue(null);
    expect(await findGatewayVideoJob("user-b", "task-1")).toBeNull();
  });
  it("returns the immutable credential ID from successful per-user video creation", async () => {
    find.mockResolvedValue({ model: "video-alias", provider: "shaozhuang", metadata: {
      upstreamModel: "upstream-video", baseUrl: "https://relay.example.com/v1", credentialId: "credential-b"
    } } as never);
    expect(await findGatewayVideoJob("user-a", "task-1")).toMatchObject({ credentialId: "credential-b" });
  });
  it.each(["", "../other", 123, null])("rejects an invalid stored credential ID %j", async (credentialId) => {
    find.mockResolvedValue({ model: "video-alias", provider: "shaozhuang", metadata: {
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
