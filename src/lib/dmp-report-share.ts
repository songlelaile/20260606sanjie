import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { getDmpBusinessReport, type DmpReportAccess, validateDmpCanonicalReport } from "@/lib/dmp-report-store";
import { groupDmpBusinessReports, mergeDmpReportGroupDaily } from "@/lib/dmp-report-library";
import type { DmpNormalizedPublicShareEvent } from "@/lib/dmp-report-share-events";
import type {
  DmpBusinessReportRecord,
  DmpReportAnalyticsDays,
  DmpReportManagementAnalytics
} from "@/lib/dmp-report-types";

const SHARE_TOKEN_PATTERN = /^[a-f0-9]{64}$/i;
const MAX_ANALYTICS_EVENTS = 100_000;
const MAX_TOP_REPORTS = 30;
const MAX_RECENT_SHARES = 30;
const MAX_SOURCE_ROWS = 50;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface DmpSharedReportSnapshot {
  shareId: string;
  createdAt: string;
  report: DmpBusinessReportRecord;
}

export function hashDmpReportShareToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createDmpReportShare(access: DmpReportAccess, reportId: string) {
  const report = await getDmpBusinessReport(access, reportId);
  if (!report) return null;
  const token = randomBytes(32).toString("hex");
  const row = await prisma.dmpReportShare.create({
    data: {
      reportId: report.id,
      tokenHash: hashDmpReportShareToken(token)
    },
    select: { id: true, createdAt: true }
  });
  return {
    id: row.id,
    token,
    path: `/shared/dmp-reports/${token}`,
    createdAt: row.createdAt.toISOString()
  };
}

/** 公开只读报告仅凭高熵 bearer token 授权；创建权限仍由 createDmpReportShare 单独校验。 */
export async function getPublicDmpSharedReport(token: string): Promise<DmpSharedReportSnapshot | null> {
  const clean = cleanShareToken(token);
  if (!clean) return null;
  const row = await prisma.dmpReportShare.findFirst({
    where: {
      tokenHash: hashDmpReportShareToken(clean),
      revokedAt: null
    },
    select: {
      id: true,
      createdAt: true,
      report: {
        select: {
          id: true,
          tenantId: true,
          userId: true,
          shopId: true,
          shop: { select: { id: true, name: true } },
          subjectItemId: true,
          competitorItemId: true,
          period: true,
          quality: true,
          createdAt: true,
          report: true
        }
      }
    }
  });
  if (!row) return null;
  const checked = validateDmpCanonicalReport(row.report.report);
  if (!checked.report) return null;
  const baseRecord: DmpBusinessReportRecord = {
    id: row.report.id,
    reportType: checked.report.report_type === "competition" ? "competition" : "growth",
    ...(row.report.shop ? { shopId: row.report.shop.id, shopName: row.report.shop.name } : {}),
    subjectItemId: row.report.subjectItemId,
    competitorItemId: row.report.competitorItemId,
    period: row.report.period,
    quality: row.report.quality === "partial" ? "partial" : "complete",
    createdAt: row.report.createdAt.toISOString(),
    report: checked.report
  };
  const report = baseRecord.reportType === "growth"
    ? await sharedGroupReport(baseRecord, row.report.tenantId, row.report.userId, row.createdAt)
    : baseRecord;
  return {
    shareId: row.id,
    createdAt: row.createdAt.toISOString(),
    report
  };
}

async function sharedGroupReport(
  base: DmpBusinessReportRecord,
  tenantId: string,
  userId: string,
  sharedAt: Date
) {
  const rows = await prisma.dmpBusinessReport.findMany({
    where: {
      tenantId,
      userId,
      shopId: base.shopId || null,
      createdAt: { lte: sharedAt }
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      shopId: true,
      shop: { select: { id: true, name: true } },
      subjectItemId: true,
      competitorItemId: true,
      period: true,
      quality: true,
      createdAt: true,
      report: true
    }
  }).catch(() => []);
  const records = rows.flatMap((candidate) => {
    const checked = validateDmpCanonicalReport(candidate.report);
    if (!checked.report) return [];
    return [{
      id: candidate.id,
      reportType: checked.report.report_type === "competition" ? "competition" as const : "growth" as const,
      ...(candidate.shop ? { shopId: candidate.shop.id, shopName: candidate.shop.name } : {}),
      subjectItemId: candidate.subjectItemId,
      competitorItemId: candidate.competitorItemId,
      period: candidate.period,
      quality: candidate.quality === "partial" ? "partial" as const : "complete" as const,
      createdAt: candidate.createdAt.toISOString(),
      report: checked.report
    }];
  });
  if (!records.some((record) => record.id === base.id)) records.push(base);
  const group = groupDmpBusinessReports(records).find((candidate) => candidate.records.some((record) => record.id === base.id));
  return group ? mergeDmpReportGroupDaily(group.records, base.id) ?? base : base;
}

export async function recordDmpPublicShareEvent(token: string, event: DmpNormalizedPublicShareEvent) {
  const clean = cleanShareToken(token);
  if (!clean) return null;
  const share = await prisma.dmpReportShare.findFirst({
    where: { tokenHash: hashDmpReportShareToken(clean), revokedAt: null },
    select: { id: true }
  });
  if (!share) return null;

  const now = new Date();
  const visitorHash = hashAnonymousValue("visitor", share.id, event.visitorId);
  const sessionHash = hashAnonymousValue("session", share.id, event.sessionId);
  const eventHash = hashAnonymousValue("event", share.id, event.eventId);
  const attribution = {
    source: event.source,
    medium: event.medium,
    campaign: event.campaign,
    referrerHost: event.referrerHost
  };

  if (event.type === "view") {
    return prisma.$transaction(async (tx) => {
      const claimed = await tx.dmpReportShareEvent.createMany({
        data: [{
          shareId: share.id,
          eventHash,
          eventType: "view",
          visitorHash,
          sessionHash,
          ...attribution,
          count: 1,
          createdAt: now
        }],
        skipDuplicates: true
      });
      if (!claimed.count) return { accepted: 0 };
      await tx.dmpReportShareSession.upsert({
        where: { shareId_sessionHash: { shareId: share.id, sessionHash } },
        create: {
          shareId: share.id,
          visitorHash,
          sessionHash,
          ...attribution,
          pageViews: 1,
          firstSeenAt: now,
          lastSeenAt: now
        },
        update: {
          visitorHash,
          ...nonEmptyAttribution(attribution),
          pageViews: { increment: 1 },
          lastSeenAt: now
        }
      });
      await tx.dmpReportShare.update({
        where: { id: share.id },
        data: { viewCount: { increment: 1 }, lastViewedAt: now }
      });
      return { accepted: 1 };
    });
  }

  if (event.type === "click") {
    const accepted = event.events.reduce((sum, item) => sum + item.count, 0);
    if (!accepted) return { accepted: 0 };
    return prisma.$transaction(async (tx) => {
      const knownSession = await tx.dmpReportShareSession.findUnique({
        where: { shareId_sessionHash: { shareId: share.id, sessionHash } },
        select: {
          visitorHash: true,
          pageViews: true,
          source: true,
          medium: true,
          campaign: true,
          referrerHost: true
        }
      });
      // click/engagement 不能自行建立会话：必须先由同一匿名访客成功写入 view。
      // 这既约束事件顺序，也避免随机 sessionId 直接制造点击、停留和 UV。
      if (!knownSession || knownSession.pageViews < 1 || knownSession.visitorHash !== visitorHash) {
        return { accepted: 0 };
      }
      const clickAttribution = {
        source: knownSession.source,
        medium: knownSession.medium,
        campaign: knownSession.campaign,
        referrerHost: knownSession.referrerHost
      };
      const claimed = await tx.dmpReportShareEvent.createMany({
        data: [{
          shareId: share.id,
          eventHash,
          eventType: "click",
          visitorHash,
          sessionHash,
          ...clickAttribution,
          count: accepted,
          createdAt: now
        }],
        skipDuplicates: true
      });
      if (!claimed.count) return { accepted: 0 };
      await tx.dmpReportShareSession.update({
        where: { shareId_sessionHash: { shareId: share.id, sessionHash } },
        data: {
          clickCount: { increment: accepted },
          lastSeenAt: now
        }
      });
      await tx.dmpReportShare.update({
        where: { id: share.id },
        data: { clickCount: { increment: accepted }, lastClickedAt: now }
      });
      for (const item of event.events) {
        await tx.dmpReportHeatBucket.upsert({
          where: {
            shareId_sectionKey_elementKey_xBucket_yBucket: {
              shareId: share.id,
              sectionKey: item.sectionKey,
              elementKey: item.elementKey,
              xBucket: item.xBucket,
              yBucket: item.yBucket
            }
          },
          update: { count: { increment: item.count } },
          create: { shareId: share.id, ...item }
        });
      }
      return { accepted };
    });
  }

  return prisma.$transaction(async (tx) => {
    // pg_advisory_xact_lock 返回 PostgreSQL void；$queryRaw 会尝试反序列化并触发 P2010。
    // $executeRaw 只读取影响行数，既能持有事务级锁，也不会解析 void 返回值。
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dmp-share-session:${share.id}:${sessionHash}`}))`;
    const existing = await tx.dmpReportShareSession.findUnique({
      where: { shareId_sessionHash: { shareId: share.id, sessionHash } },
      select: {
        visitorHash: true,
        pageViews: true,
        activeSeconds: true,
        maxScrollDepth: true,
        firstSeenAt: true,
        source: true,
        medium: true,
        campaign: true,
        referrerHost: true
      }
    });
    if (!existing || existing.pageViews < 1 || existing.visitorHash !== visitorHash) {
      return { accepted: 0 };
    }
    // activeSeconds 是客户端累计活跃时长，但绝不能超过服务端观察到的会话墙钟时长。
    // 因此即使有人直接提交 6 小时，也只能增长到 firstSeenAt 之后实际经过的秒数。
    const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - existing.firstSeenAt.getTime()) / 1_000));
    const boundedActiveSeconds = Math.min(event.activeSeconds, elapsedSeconds);
    const nextActiveSeconds = Math.max(existing.activeSeconds, boundedActiveSeconds);
    const nextScrollDepth = Math.max(existing.maxScrollDepth, event.maxScrollDepth);
    const activeSecondsDelta = Math.max(0, nextActiveSeconds - existing.activeSeconds);
    const sessionAttribution = {
      source: existing.source,
      medium: existing.medium,
      campaign: existing.campaign,
      referrerHost: existing.referrerHost
    };
    const claimed = await tx.dmpReportShareEvent.createMany({
      data: [{
        shareId: share.id,
        eventHash,
        eventType: "engagement",
        visitorHash,
        sessionHash,
        ...sessionAttribution,
        activeSeconds: activeSecondsDelta,
        maxScrollDepth: event.maxScrollDepth,
        createdAt: now
      }],
      skipDuplicates: true
    });
    if (!claimed.count) return { accepted: 0 };
    await tx.dmpReportShareSession.update({
      where: { shareId_sessionHash: { shareId: share.id, sessionHash } },
      data: {
        activeSeconds: nextActiveSeconds,
        maxScrollDepth: nextScrollDepth,
        lastSeenAt: now
      }
    });
    return { accepted: 1 };
  });
}

export async function revokeDmpReportShare(shareId: string) {
  const clean = String(shareId ?? "").trim();
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(clean)) return null;
  const now = new Date();
  await prisma.dmpReportShare.updateMany({
    where: { id: clean, revokedAt: null },
    data: { revokedAt: now }
  });
  const row = await prisma.dmpReportShare.findUnique({
    where: { id: clean },
    select: { id: true, revokedAt: true }
  });
  return row?.revokedAt ? { id: row.id, revokedAt: row.revokedAt.toISOString() } : null;
}

export async function getDmpReportShareManagementAnalytics(
  days: DmpReportAnalyticsDays
): Promise<DmpReportManagementAnalytics> {
  const now = new Date();
  const from = beijingRangeStart(now, days);
  const [
    eventTotal,
    events,
    totalShares,
    activeShares,
    reportShareGroups,
    recentShareRows,
    sectionGroups,
    elementGroups
  ] = await Promise.all([
    prisma.dmpReportShareEvent.count({ where: { createdAt: { gte: from, lte: now } } }),
    prisma.dmpReportShareEvent.findMany({
      where: { createdAt: { gte: from, lte: now } },
      orderBy: { createdAt: "asc" },
      take: MAX_ANALYTICS_EVENTS,
      select: {
        visitorHash: true,
        sessionHash: true,
        eventType: true,
        source: true,
        medium: true,
        campaign: true,
        referrerHost: true,
        count: true,
        activeSeconds: true,
        maxScrollDepth: true,
        createdAt: true,
        share: {
          select: {
            id: true,
            reportId: true,
            report: {
              select: {
                subjectItemId: true,
                competitorItemId: true,
                period: true,
                tenant: { select: { id: true, name: true } },
                user: { select: { id: true, name: true, username: true } }
              }
            }
          }
        }
      }
    }),
    prisma.dmpReportShare.count(),
    prisma.dmpReportShare.count({ where: { revokedAt: null } }),
    prisma.dmpReportShare.groupBy({ by: ["reportId"], _count: { _all: true } }),
    prisma.dmpReportShare.findMany({
      orderBy: { createdAt: "desc" },
      take: MAX_RECENT_SHARES,
      select: {
        id: true,
        reportId: true,
        createdAt: true,
        revokedAt: true,
        viewCount: true,
        clickCount: true,
        lastViewedAt: true,
        lastClickedAt: true,
        _count: { select: { sessions: true } },
        report: {
          select: {
            subjectItemId: true,
            competitorItemId: true,
            tenant: { select: { id: true, name: true } },
            user: { select: { id: true, name: true, username: true } }
          }
        }
      }
    }),
    prisma.dmpReportHeatBucket.groupBy({
      by: ["sectionKey"],
      _sum: { count: true },
      orderBy: { _sum: { count: "desc" } },
      take: 30
    }),
    prisma.dmpReportHeatBucket.groupBy({
      by: ["sectionKey", "elementKey"],
      _sum: { count: true },
      orderBy: { _sum: { count: "desc" } },
      take: 50
    })
  ]);

  const shareCountByReport = new Map(reportShareGroups.map((row) => [row.reportId, row._count._all]));
  const trendMap = createTrendMap(from, days);
  const analyticsSessions = new Map<string, AnalyticsSessionAccumulator>();

  for (const event of events) {
    const sessionKey = `${event.share.id}\u001f${event.sessionHash}`;
    const report = event.share.report;
    const session = analyticsSessions.get(sessionKey) ?? {
      shareId: event.share.id,
      reportId: event.share.reportId,
      visitorHash: event.visitorHash,
      source: event.source,
      medium: event.medium,
      campaign: event.campaign,
      referrerHost: event.referrerHost,
      subjectItemId: report.subjectItemId,
      competitorItemId: report.competitorItemId,
      period: report.period,
      tenantId: report.tenant.id,
      tenantName: report.tenant.name,
      userId: report.user.id,
      userName: report.user.name,
      username: report.user.username,
      pageViews: 0,
      clickCount: 0,
      activeSeconds: 0,
      maxScrollDepth: 0,
      firstSeenAt: event.createdAt,
      lastSeenAt: event.createdAt
    };
    if (!session.source && event.source) session.source = event.source;
    if (!session.medium && event.medium) session.medium = event.medium;
    if (!session.campaign && event.campaign) session.campaign = event.campaign;
    if (!session.referrerHost && event.referrerHost) session.referrerHost = event.referrerHost;
    if (event.eventType === "view") session.pageViews += event.count;
    if (event.eventType === "click") session.clickCount += event.count;
    session.activeSeconds += event.activeSeconds;
    session.maxScrollDepth = Math.max(session.maxScrollDepth, event.maxScrollDepth);
    if (event.createdAt < session.firstSeenAt) session.firstSeenAt = event.createdAt;
    if (event.createdAt > session.lastSeenAt) session.lastSeenAt = event.createdAt;
    analyticsSessions.set(sessionKey, session);

    const date = beijingDateKey(event.createdAt);
    const trend = trendMap.get(date);
    if (trend) {
      trend.sessions.add(sessionKey);
      trend.visitors.add(event.visitorHash);
      if (event.eventType === "view") trend.pageViews += event.count;
      if (event.eventType === "click") trend.clickCount += event.count;
      trend.activeSeconds += event.activeSeconds;
      const engagement = trend.engagementBySession.get(sessionKey) ?? { activeSeconds: 0, maxScrollDepth: 0 };
      engagement.activeSeconds += event.activeSeconds;
      engagement.maxScrollDepth = Math.max(engagement.maxScrollDepth, event.maxScrollDepth);
      trend.engagementBySession.set(sessionKey, engagement);
    }
  }

  const visitorHashes = new Set<string>();
  const activeShareIds = new Set<string>();
  const sourceMap = new Map<string, SourceAccumulator>();
  const reportMap = new Map<string, ReportAccumulator>();
  let pageViews = 0;
  let clickCount = 0;
  let engagedSessions = 0;
  let totalActiveSeconds = 0;
  let totalScrollDepth = 0;

  for (const session of analyticsSessions.values()) {
    const engaged = isEngaged(session.activeSeconds, session.maxScrollDepth);
    visitorHashes.add(session.visitorHash);
    activeShareIds.add(session.shareId);
    pageViews += session.pageViews;
    clickCount += session.clickCount;
    totalActiveSeconds += session.activeSeconds;
    totalScrollDepth += session.maxScrollDepth;
    if (engaged) engagedSessions += 1;

    const sourceLabel = session.source || session.referrerHost || "direct";
    const mediumLabel = session.medium || (session.referrerHost ? "referral" : "direct");
    const sourceKey = [sourceLabel, mediumLabel, session.campaign, session.referrerHost].join("\u001f");
    const source = sourceMap.get(sourceKey) ?? {
      source: sourceLabel,
      medium: mediumLabel,
      campaign: session.campaign,
      referrerHost: session.referrerHost,
      sessionCount: 0,
      visitors: new Set<string>(),
      pageViews: 0,
      clickCount: 0,
      engagedSessions: 0,
      activeSeconds: 0
    };
    source.sessionCount += 1;
    source.visitors.add(session.visitorHash);
    source.pageViews += session.pageViews;
    source.clickCount += session.clickCount;
    source.activeSeconds += session.activeSeconds;
    if (engaged) source.engagedSessions += 1;
    sourceMap.set(sourceKey, source);

    const aggregate = reportMap.get(session.reportId) ?? {
      reportId: session.reportId,
      subjectItemId: session.subjectItemId,
      competitorItemId: session.competitorItemId,
      period: session.period,
      tenantId: session.tenantId,
      tenantName: session.tenantName,
      userId: session.userId,
      userName: session.userName,
      username: session.username,
      sessionCount: 0,
      visitors: new Set<string>(),
      pageViews: 0,
      clickCount: 0,
      engagedSessions: 0,
      activeSeconds: 0,
      scrollDepthTotal: 0,
      lastSeenAt: null as Date | null
    };
    aggregate.sessionCount += 1;
    aggregate.visitors.add(session.visitorHash);
    aggregate.pageViews += session.pageViews;
    aggregate.clickCount += session.clickCount;
    aggregate.activeSeconds += session.activeSeconds;
    aggregate.scrollDepthTotal += session.maxScrollDepth;
    if (engaged) aggregate.engagedSessions += 1;
    if (!aggregate.lastSeenAt || session.lastSeenAt > aggregate.lastSeenAt) aggregate.lastSeenAt = session.lastSeenAt;
    reportMap.set(session.reportId, aggregate);
  }

  return {
    days,
    range: { from: from.toISOString(), to: now.toISOString(), timeZone: "Asia/Shanghai" },
    overview: {
      totalShares,
      activeShares,
      activeSharesInRange: activeShareIds.size,
      reportCount: reportShareGroups.length,
      sessionCount: analyticsSessions.size,
      uniqueVisitors: visitorHashes.size,
      pageViews,
      clickCount,
      engagedSessions,
      totalActiveSeconds,
      averageActiveSeconds: average(totalActiveSeconds, analyticsSessions.size),
      averageScrollDepth: average(totalScrollDepth, analyticsSessions.size),
      dataTruncated: eventTotal > events.length
    },
    trend: [...trendMap.values()].map((row) => ({
      date: row.date,
      sessionCount: row.sessions.size,
      uniqueVisitors: row.visitors.size,
      pageViews: row.pageViews,
      clickCount: row.clickCount,
      engagedSessions: [...row.engagementBySession.values()].filter((entry) => isEngaged(entry.activeSeconds, entry.maxScrollDepth)).length,
      activeSeconds: row.activeSeconds
    })),
    sources: [...sourceMap.values()]
      .sort((left, right) => right.visitors.size - left.visitors.size || right.pageViews - left.pageViews)
      .slice(0, MAX_SOURCE_ROWS)
      .map((row) => ({
        source: row.source,
        medium: row.medium,
        campaign: row.campaign,
        referrerHost: row.referrerHost,
        sessionCount: row.sessionCount,
        uniqueVisitors: row.visitors.size,
        pageViews: row.pageViews,
        clickCount: row.clickCount,
        engagedSessions: row.engagedSessions,
        activeSeconds: row.activeSeconds
      })),
    topReports: [...reportMap.values()]
      .sort((left, right) => right.visitors.size - left.visitors.size || right.pageViews - left.pageViews || right.clickCount - left.clickCount)
      .slice(0, MAX_TOP_REPORTS)
      .map((row) => ({
        reportId: row.reportId,
        subjectItemId: row.subjectItemId,
        competitorItemId: row.competitorItemId,
        period: row.period,
        tenantId: row.tenantId,
        tenantName: row.tenantName,
        userId: row.userId,
        userName: row.userName,
        username: row.username,
        shareCount: shareCountByReport.get(row.reportId) ?? 0,
        sessionCount: row.sessionCount,
        uniqueVisitors: row.visitors.size,
        pageViews: row.pageViews,
        clickCount: row.clickCount,
        engagedSessions: row.engagedSessions,
        activeSeconds: row.activeSeconds,
        averageScrollDepth: average(row.scrollDepthTotal, row.sessionCount),
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null
      })),
    recentShares: recentShareRows.map((row) => ({
      shareId: row.id,
      reportId: row.reportId,
      subjectItemId: row.report.subjectItemId,
      competitorItemId: row.report.competitorItemId,
      tenantId: row.report.tenant.id,
      tenantName: row.report.tenant.name,
      userId: row.report.user.id,
      userName: row.report.user.name,
      username: row.report.user.username,
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
      viewCount: row.viewCount,
      clickCount: row.clickCount,
      sessionCount: row._count.sessions,
      lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
      lastClickedAt: row.lastClickedAt?.toISOString() ?? null
    })),
    sections: sectionGroups.map((row) => ({ sectionKey: row.sectionKey, count: row._sum.count ?? 0 })),
    topElements: elementGroups.map((row) => ({
      sectionKey: row.sectionKey,
      elementKey: row.elementKey,
      count: row._sum.count ?? 0
    })),
    heatmapScope: "all_time"
  };
}

interface TrendAccumulator {
  date: string;
  sessions: Set<string>;
  visitors: Set<string>;
  pageViews: number;
  clickCount: number;
  activeSeconds: number;
  engagementBySession: Map<string, { activeSeconds: number; maxScrollDepth: number }>;
}

interface AnalyticsSessionAccumulator {
  shareId: string;
  reportId: string;
  visitorHash: string;
  source: string;
  medium: string;
  campaign: string;
  referrerHost: string;
  subjectItemId: string;
  competitorItemId: string;
  period: string;
  tenantId: string;
  tenantName: string;
  userId: string;
  userName: string;
  username: string;
  pageViews: number;
  clickCount: number;
  activeSeconds: number;
  maxScrollDepth: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

interface SourceAccumulator {
  source: string;
  medium: string;
  campaign: string;
  referrerHost: string;
  sessionCount: number;
  visitors: Set<string>;
  pageViews: number;
  clickCount: number;
  engagedSessions: number;
  activeSeconds: number;
}

interface ReportAccumulator {
  reportId: string;
  subjectItemId: string;
  competitorItemId: string;
  period: string;
  tenantId: string;
  tenantName: string;
  userId: string;
  userName: string;
  username: string;
  sessionCount: number;
  visitors: Set<string>;
  pageViews: number;
  clickCount: number;
  engagedSessions: number;
  activeSeconds: number;
  scrollDepthTotal: number;
  lastSeenAt: Date | null;
}

function cleanShareToken(token: string) {
  const clean = String(token ?? "").trim();
  return SHARE_TOKEN_PATTERN.test(clean) ? clean : null;
}

function hashAnonymousValue(kind: "visitor" | "session" | "event", shareId: string, value: string) {
  return createHash("sha256").update(`dmp-share:${kind}:${shareId}\0${value}`).digest("hex");
}

function nonEmptyAttribution(attribution: {
  source: string;
  medium: string;
  campaign: string;
  referrerHost: string;
}) {
  return {
    ...(attribution.source ? { source: attribution.source } : {}),
    ...(attribution.medium ? { medium: attribution.medium } : {}),
    ...(attribution.campaign ? { campaign: attribution.campaign } : {}),
    ...(attribution.referrerHost ? { referrerHost: attribution.referrerHost } : {})
  };
}

function beijingRangeStart(now: Date, days: number) {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MS);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - (days - 1)) - BEIJING_OFFSET_MS
  );
}

function beijingDateKey(value: Date) {
  return new Date(value.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

function createTrendMap(from: Date, days: number) {
  const map = new Map<string, TrendAccumulator>();
  for (let offset = 0; offset < days; offset += 1) {
    const date = beijingDateKey(new Date(from.getTime() + offset * DAY_MS));
    map.set(date, {
      date,
      sessions: new Set<string>(),
      visitors: new Set<string>(),
      pageViews: 0,
      clickCount: 0,
      activeSeconds: 0,
      engagementBySession: new Map()
    });
  }
  return map;
}

function isEngaged(activeSeconds: number, maxScrollDepth: number) {
  return activeSeconds >= 10 || maxScrollDepth >= 50;
}

function average(total: number, count: number) {
  return count > 0 ? Math.round(total / count * 100) / 100 : 0;
}
