import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  reportFindMany: vi.fn(),
  create: vi.fn(),
  transaction: vi.fn(),
  eventCreateMany: vi.fn(),
  sessionUpsert: vi.fn(),
  sessionFindUniqueTx: vi.fn(),
  sessionUpdate: vi.fn(),
  shareUpdate: vi.fn(),
  heatUpsert: vi.fn(),
  executeRaw: vi.fn(),
  eventCountAnalytics: vi.fn(),
  eventFindMany: vi.fn(),
  sessionCount: vi.fn(),
  sessionFindMany: vi.fn(),
  shareCount: vi.fn(),
  shareGroupBy: vi.fn(),
  shareFindMany: vi.fn(),
  heatGroupBy: vi.fn(),
  getDmpBusinessReport: vi.fn(),
  validateDmpCanonicalReport: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  prisma: {
    dmpReportShare: {
      findFirst: mocks.findFirst,
      create: mocks.create,
      count: mocks.shareCount,
      groupBy: mocks.shareGroupBy,
      findMany: mocks.shareFindMany
    },
    dmpBusinessReport: { findMany: mocks.reportFindMany },
    dmpReportShareSession: {
      count: mocks.sessionCount,
      findMany: mocks.sessionFindMany
    },
    dmpReportShareEvent: {
      count: mocks.eventCountAnalytics,
      findMany: mocks.eventFindMany
    },
    dmpReportHeatBucket: { groupBy: mocks.heatGroupBy },
    $transaction: mocks.transaction
  }
}));
vi.mock("@/lib/dmp-report-store", () => ({
  getDmpBusinessReport: mocks.getDmpBusinessReport,
  validateDmpCanonicalReport: mocks.validateDmpCanonicalReport
}));

import {
  getPublicDmpSharedReport,
  getDmpReportShareManagementAnalytics,
  hashDmpReportShareToken,
  recordDmpPublicShareEvent
} from "@/lib/dmp-report-share";

const TOKEN = "b".repeat(64);
const CANONICAL_REPORT = {
  schema_version: "3.0" as const,
  title: "公开报告",
  item_id: "593063365092",
  period: "近30天",
  tables: [],
  render_data: {
    version: "1" as const,
    products: {
      subject: { picture_url: "https://img.alicdn.com/subject-main.png" },
      competitor: { picture_url: "https://img.alicdn.com/competitor-main.png" }
    }
  }
};

describe("DMP public report bearer-token storage boundary", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.findFirst.mockResolvedValue(null);
    mocks.reportFindMany.mockResolvedValue([]);
    mocks.sessionCount.mockResolvedValue(0);
    mocks.sessionFindMany.mockResolvedValue([]);
    mocks.eventCountAnalytics.mockResolvedValue(0);
    mocks.eventFindMany.mockResolvedValue([]);
    mocks.shareCount.mockResolvedValue(0);
    mocks.shareGroupBy.mockResolvedValue([]);
    mocks.shareFindMany.mockResolvedValue([]);
    mocks.heatGroupBy.mockResolvedValue([]);
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work({
      dmpReportShareEvent: { createMany: mocks.eventCreateMany },
      dmpReportShareSession: {
        upsert: mocks.sessionUpsert,
        findUnique: mocks.sessionFindUniqueTx,
        update: mocks.sessionUpdate
      },
      dmpReportShare: { update: mocks.shareUpdate },
      dmpReportHeatBucket: { upsert: mocks.heatUpsert },
      $executeRaw: mocks.executeRaw
    }));
  });

  it("looks up a public report by token hash and excludes revoked links without owner scope", async () => {
    await expect(getPublicDmpSharedReport(TOKEN)).resolves.toBeNull();
    const query = mocks.findFirst.mock.calls[0]?.[0];
    expect(query.where).toEqual({
      tokenHash: hashDmpReportShareToken(TOKEN),
      revokedAt: null
    });
    expect(JSON.stringify(query.where)).not.toContain(TOKEN);
    expect(query.where).not.toHaveProperty("report");
  });

  it("returns the validated read-only snapshot to an anonymous token holder", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "share-public",
      createdAt: new Date("2026-08-17T00:00:00.000Z"),
      report: {
        id: "report-a",
        tenantId: "tenant-a",
        userId: "user-a",
        shopId: "shop-a",
        shop: { id: "shop-a", name: "西西礼" },
        subjectItemId: "593063365092",
        competitorItemId: "593063365093",
        period: "近30天",
        quality: "complete",
        createdAt: new Date("2026-08-16T00:00:00.000Z"),
        report: CANONICAL_REPORT
      }
    });
    mocks.validateDmpCanonicalReport.mockReturnValue({ report: CANONICAL_REPORT });

    await expect(getPublicDmpSharedReport(TOKEN)).resolves.toMatchObject({
      shareId: "share-public",
      report: {
        id: "report-a",
        shopId: "shop-a",
        shopName: "西西礼",
        subjectItemId: "593063365092",
        report: {
          render_data: {
            products: {
              subject: { picture_url: "https://img.alicdn.com/subject-main.png" },
              competitor: { picture_url: "https://img.alicdn.com/competitor-main.png" }
            }
          }
        }
      }
    });
    expect(mocks.reportFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: "tenant-a",
        userId: "user-a",
        shopId: "shop-a",
        createdAt: { lte: new Date("2026-08-17T00:00:00.000Z") }
      })
    }));
    expect(mocks.reportFindMany.mock.calls[0]?.[0]?.where).not.toHaveProperty("subjectItemId");
  });

  it("does not read storage for malformed tokens", async () => {
    await expect(getPublicDmpSharedReport("too-short")).resolves.toBeNull();
    await expect(recordDmpPublicShareEvent("too-short", {
      type: "view",
      eventId: "event-1234567890abcdef",
      visitorId: "visitor-1234567890abcdef",
      sessionId: "session-1234567890abcdef",
      source: "",
      medium: "",
      campaign: "",
      referrerHost: ""
    })).resolves.toBeNull();
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("applies the same revocation predicate before accepting anonymous events", async () => {
    const event = {
      type: "view" as const,
      eventId: "event-1234567890abcdef",
      visitorId: "visitor-1234567890abcdef",
      sessionId: "session-1234567890abcdef",
      source: "",
      medium: "",
      campaign: "",
      referrerHost: ""
    };
    await expect(recordDmpPublicShareEvent(TOKEN, event)).resolves.toBeNull();
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: {
        tokenHash: hashDmpReportShareToken(TOKEN),
        revokedAt: null
      },
      select: { id: true }
    });
  });

  it("hashes anonymous identifiers before storing an idempotent view receipt and session", async () => {
    mocks.findFirst.mockResolvedValue({ id: "share-public" });
    mocks.eventCreateMany.mockResolvedValue({ count: 1 });
    const event = {
      type: "view" as const,
      eventId: "event-1234567890abcdef",
      visitorId: "visitor-1234567890abcdef",
      sessionId: "session-1234567890abcdef",
      source: "wechat",
      medium: "social",
      campaign: "august",
      referrerHost: "weixin.qq.com"
    };

    await expect(recordDmpPublicShareEvent(TOKEN, event)).resolves.toEqual({ accepted: 1 });
    const receipt = mocks.eventCreateMany.mock.calls[0]?.[0]?.data?.[0];
    const session = mocks.sessionUpsert.mock.calls[0]?.[0];
    expect(receipt).toMatchObject({ shareId: "share-public", eventType: "view" });
    expect(receipt.eventHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.eventHash).not.toBe(event.eventId);
    expect(session.create.visitorHash).toMatch(/^[a-f0-9]{64}$/);
    expect(session.create.sessionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(session.create.visitorHash).not.toBe(event.visitorId);
    expect(session.create.sessionHash).not.toBe(event.sessionId);
    expect(JSON.stringify(session)).not.toContain(event.visitorId);
    expect(JSON.stringify(session)).not.toContain(event.sessionId);
    expect(session.create).not.toHaveProperty("ip");
    expect(session.create).not.toHaveProperty("userAgent");
  });

  it("does not double-count a retried event receipt", async () => {
    mocks.findFirst.mockResolvedValue({ id: "share-public" });
    mocks.eventCreateMany.mockResolvedValue({ count: 0 });
    const event = {
      type: "view" as const,
      eventId: "event-1234567890abcdef",
      visitorId: "visitor-1234567890abcdef",
      sessionId: "session-1234567890abcdef",
      source: "",
      medium: "",
      campaign: "",
      referrerHost: ""
    };
    await expect(recordDmpPublicShareEvent(TOKEN, event)).resolves.toEqual({ accepted: 0 });
    expect(mocks.sessionUpsert).not.toHaveBeenCalled();
    expect(mocks.shareUpdate).not.toHaveBeenCalled();
  });

  it.each(["click", "engagement"] as const)(
    "rejects a %s event until the same visitor has a server-side view session",
    async (type) => {
      mocks.findFirst.mockResolvedValue({ id: "share-public" });
      mocks.sessionFindUniqueTx.mockResolvedValue(null);
      mocks.executeRaw.mockResolvedValue(1);
      const common = {
        eventId: "event-1234567890abcdef",
        visitorId: "visitor-1234567890abcdef",
        sessionId: "session-1234567890abcdef",
        source: "",
        medium: "",
        campaign: "",
        referrerHost: ""
      };
      const event = type === "click"
        ? {
            type,
            ...common,
            events: [{ sectionKey: "hero", elementKey: "button", xBucket: 1, yBucket: 2, count: 1 }]
          }
        : { type, ...common, activeSeconds: 120, maxScrollDepth: 80 };

      await expect(recordDmpPublicShareEvent(TOKEN, event)).resolves.toEqual({ accepted: 0 });
      expect(mocks.eventCreateMany).not.toHaveBeenCalled();
      expect(mocks.sessionUpdate).not.toHaveBeenCalled();
      expect(mocks.shareUpdate).not.toHaveBeenCalled();
    }
  );

  it("caps reported engagement at server-observed elapsed time", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-17T00:00:10.000Z"));
      const visitorId = "visitor-1234567890abcdef";
      mocks.findFirst.mockResolvedValue({ id: "share-public" });
      mocks.executeRaw.mockResolvedValue(1);
      mocks.sessionFindUniqueTx.mockResolvedValue({
        visitorHash: anonymousHash("visitor", "share-public", visitorId),
        pageViews: 1,
        activeSeconds: 1,
        maxScrollDepth: 20,
        firstSeenAt: new Date("2026-08-17T00:00:05.000Z"),
        source: "wechat",
        medium: "social",
        campaign: "august",
        referrerHost: "weixin.qq.com"
      });
      mocks.eventCreateMany.mockResolvedValue({ count: 1 });

      await expect(recordDmpPublicShareEvent(TOKEN, {
        type: "engagement",
        eventId: "event-1234567890abcdef",
        visitorId,
        sessionId: "session-1234567890abcdef",
        source: "forged-source",
        medium: "",
        campaign: "",
        referrerHost: "forged.example",
        activeSeconds: 21_600,
        maxScrollDepth: 80
      })).resolves.toEqual({ accepted: 1 });

      expect(mocks.eventCreateMany.mock.calls[0]?.[0]?.data?.[0]).toMatchObject({
        activeSeconds: 4,
        source: "wechat",
        medium: "social",
        campaign: "august",
        referrerHost: "weixin.qq.com"
      });
      expect(mocks.sessionUpdate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ activeSeconds: 5, maxScrollDepth: 80 })
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("groups the management trend on Asia/Shanghai day boundaries", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-17T00:30:00.000Z"));
      const report = {
        subjectItemId: "593063365092",
        competitorItemId: "593063365093",
        period: "近30天",
        tenant: { id: "tenant-a", name: "租户A" },
        user: { id: "user-a", name: "用户A", username: "user-a" }
      };
      mocks.eventCountAnalytics.mockResolvedValue(2);
      mocks.eventFindMany.mockResolvedValue([
        {
          visitorHash: "visitor-hash-a",
          sessionHash: "session-hash-a",
          eventType: "view",
          source: "direct",
          medium: "direct",
          campaign: "",
          referrerHost: "",
          count: 1,
          activeSeconds: 12,
          maxScrollDepth: 60,
          createdAt: new Date("2026-08-16T15:59:59.000Z"),
          share: { id: "share-a", reportId: "report-a", report }
        },
        {
          visitorHash: "visitor-hash-b",
          sessionHash: "session-hash-b",
          eventType: "view",
          source: "direct",
          medium: "direct",
          campaign: "",
          referrerHost: "",
          count: 1,
          activeSeconds: 0,
          maxScrollDepth: 10,
          createdAt: new Date("2026-08-16T16:00:00.000Z"),
          share: { id: "share-a", reportId: "report-a", report }
        }
      ]);
      mocks.shareCount.mockResolvedValue(1);
      mocks.shareGroupBy.mockResolvedValue([{ reportId: "report-a", _count: { _all: 1 } }]);

      const analytics = await getDmpReportShareManagementAnalytics(7);
      expect(analytics.range.timeZone).toBe("Asia/Shanghai");
      expect(analytics.trend.find((row) => row.date === "2026-08-16")?.sessionCount).toBe(1);
      expect(analytics.trend.find((row) => row.date === "2026-08-17")?.sessionCount).toBe(1);
      expect(analytics.overview).toMatchObject({
        sessionCount: 2,
        uniqueVisitors: 2,
        pageViews: 2,
        engagedSessions: 1
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function anonymousHash(kind: "visitor" | "session" | "event", shareId: string, value: string) {
  return createHash("sha256").update(`dmp-share:${kind}:${shareId}\0${value}`).digest("hex");
}
