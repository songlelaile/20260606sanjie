import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({ query: vi.fn(), update: vi.fn(), transaction: vi.fn(), poll: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { $transaction: mock.transaction } }));
vi.mock("./native-video", () => ({ pollNativeVideo: mock.poll }));
import { reconcileNativeVideoJobs } from "./native-video-reconcile";

describe("bounded native video reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.query.mockResolvedValue([]); mock.update.mockResolvedValue(1);
    mock.transaction.mockImplementation(async callback => callback({ $queryRaw: mock.query, $executeRaw: mock.update }));
  });
  it.each([{ limit: 0 }, { limit: 101 }, { concurrency: 0 }, { concurrency: 5 }, { minAgeMs: 0 }, { minAgeMs: 86_400_001 }, { limit: 1.5 }])("rejects unbounded options before any database/provider operation: %j", async options => {
    await expect(reconcileNativeVideoJobs(options)).rejects.toThrow("Invalid");
    expect(mock.transaction).not.toHaveBeenCalled(); expect(mock.poll).not.toHaveBeenCalled();
  });
  it("returns an empty summary without contacting the provider", async () => {
    expect(await reconcileNativeVideoJobs()).toEqual({ claimed: 0, completed: 0, failed: 0, pending: 0, settled: 0, errors: 0, errorCodes: {} });
    expect(mock.poll).not.toHaveBeenCalled(); expect(mock.update).not.toHaveBeenCalled();
  });
  it("uses each original owning account, throttles before polling and bounds parallel provider requests", async () => {
    const rows = Array.from({ length: 7 }, (_, index) => ({ id: `job-${index}`, userId: `user-${index}`, tenantId: `tenant-${index}`, username: `name-${index}` }));
    mock.query.mockResolvedValue(rows);
    let active = 0, maximum = 0;
    mock.poll.mockImplementation(async (owner, id) => {
      const row = rows.find(value => value.id === id)!;
      expect(owner).toEqual({ id: row.userId, tenantId: row.tenantId, username: row.username });
      expect(mock.update).toHaveBeenCalledTimes(7);
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 5)); active--;
      return { status: id === "job-0" ? "succeeded" : "running", billing: { settledCents: id === "job-0" ? 25 : null } };
    });
    expect(await reconcileNativeVideoJobs({ limit: 7, concurrency: 2 })).toMatchObject({ claimed: 7, completed: 1, pending: 6, settled: 1, errors: 0 });
    expect(mock.poll).toHaveBeenCalledTimes(7); expect(maximum).toBe(2);
  });
  it("continues after one provider failure and logs only bounded codes", async () => {
    mock.query.mockResolvedValue([{ id: "a", userId: "u", tenantId: "t", username: "name" }, { id: "b", userId: "u", tenantId: "t", username: "name" }]);
    mock.poll.mockRejectedValueOnce(Object.assign(new Error("Bearer fixture-private-key https://private.example"), { code: "unsafe Bearer private" }));
    mock.poll.mockResolvedValueOnce({ status: "failed", billing: { settledCents: null } });
    const result = await reconcileNativeVideoJobs({ concurrency: 1 });
    expect(result).toMatchObject({ claimed: 2, failed: 1, errors: 1, errorCodes: { NATIVE_VIDEO_RECONCILE_ERROR: 1 } });
    expect(JSON.stringify(result)).not.toContain("Bearer"); expect(JSON.stringify(result)).not.toContain("private");
  });
});
