import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { getDmpBusinessReport, type DmpReportAccess, validateDmpCanonicalReport } from "@/lib/dmp-report-store";
import { normalizeDmpClickEvents } from "@/lib/dmp-report-share-events";
import type {
  DmpBusinessReportRecord,
  DmpReportInteractionSummary
} from "@/lib/dmp-report-types";

const SHARE_TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

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

export async function getDmpSharedReport(access: DmpReportAccess, token: string): Promise<DmpSharedReportSnapshot | null> {
  const clean = token.trim();
  if (!SHARE_TOKEN_PATTERN.test(clean)) return null;
  const row = await prisma.dmpReportShare.findFirst({
    where: {
      tokenHash: hashDmpReportShareToken(clean),
      report: { tenantId: access.tenantId, userId: access.userId }
    },
    select: {
      id: true,
      createdAt: true,
      report: {
        select: {
          id: true,
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
  return {
    shareId: row.id,
    createdAt: row.createdAt.toISOString(),
    report: {
      id: row.report.id,
      reportType: checked.report.report_type === "competition" ? "competition" : "growth",
      subjectItemId: row.report.subjectItemId,
      competitorItemId: row.report.competitorItemId,
      period: row.report.period,
      quality: row.report.quality === "partial" ? "partial" : "complete",
      createdAt: row.report.createdAt.toISOString(),
      report: checked.report
    }
  };
}

export async function recordDmpSharedReportView(access: DmpReportAccess, token: string) {
  const clean = token.trim();
  if (!SHARE_TOKEN_PATTERN.test(clean)) return false;
  const share = await prisma.dmpReportShare.findFirst({
    where: {
      tokenHash: hashDmpReportShareToken(clean),
      report: { tenantId: access.tenantId, userId: access.userId }
    },
    select: { id: true }
  });
  if (!share) return false;
  await prisma.dmpReportShare.update({
    where: { id: share.id },
    data: { viewCount: { increment: 1 }, lastViewedAt: new Date() }
  });
  return true;
}

export async function recordDmpSharedReportClicks(access: DmpReportAccess, token: string, rawEvents: unknown) {
  const clean = token.trim();
  if (!SHARE_TOKEN_PATTERN.test(clean)) return null;
  const events = normalizeDmpClickEvents(rawEvents);
  if (!events.length) return { accepted: 0 };
  const share = await prisma.dmpReportShare.findFirst({
    where: {
      tokenHash: hashDmpReportShareToken(clean),
      report: { tenantId: access.tenantId, userId: access.userId }
    },
    select: { id: true }
  });
  if (!share) return null;
  const accepted = events.reduce((sum, event) => sum + event.count, 0);
  await prisma.$transaction([
    prisma.dmpReportShare.update({
      where: { id: share.id },
      data: { clickCount: { increment: accepted }, lastClickedAt: new Date() }
    }),
    ...events.map((event) => prisma.dmpReportHeatBucket.upsert({
      where: {
        shareId_sectionKey_elementKey_xBucket_yBucket: {
          shareId: share.id,
          sectionKey: event.sectionKey,
          elementKey: event.elementKey,
          xBucket: event.xBucket,
          yBucket: event.yBucket
        }
      },
      update: { count: { increment: event.count } },
      create: { shareId: share.id, ...event }
    }))
  ]);
  return { accepted };
}

export async function getDmpReportInteractionSummary(
  access: DmpReportAccess,
  reportId: string
): Promise<DmpReportInteractionSummary | null> {
  const owned = await getDmpBusinessReport(access, reportId);
  if (!owned) return null;
  const shares = await prisma.dmpReportShare.findMany({
    where: { reportId },
    select: {
      id: true,
      viewCount: true,
      clickCount: true,
      lastViewedAt: true,
      lastClickedAt: true
    }
  });
  if (!shares.length) return emptyInteractionSummary(reportId);
  const shareIds = shares.map((share) => share.id);
  const grouped = await prisma.dmpReportHeatBucket.groupBy({
    by: ["sectionKey", "elementKey", "xBucket", "yBucket"],
    where: { shareId: { in: shareIds } },
    _sum: { count: true }
  });
  const buckets = grouped.map((row) => ({
    sectionKey: row.sectionKey,
    elementKey: row.elementKey,
    xBucket: row.xBucket,
    yBucket: row.yBucket,
    count: row._sum.count ?? 0
  }));
  const sectionMap = new Map<string, number>();
  const elementMap = new Map<string, { sectionKey: string; elementKey: string; count: number }>();
  for (const bucket of buckets) {
    sectionMap.set(bucket.sectionKey, (sectionMap.get(bucket.sectionKey) ?? 0) + bucket.count);
    const key = `${bucket.sectionKey}\u001f${bucket.elementKey}`;
    const entry = elementMap.get(key) ?? { sectionKey: bucket.sectionKey, elementKey: bucket.elementKey, count: 0 };
    entry.count += bucket.count;
    elementMap.set(key, entry);
  }
  return {
    reportId,
    shareCount: shares.length,
    viewCount: shares.reduce((sum, share) => sum + share.viewCount, 0),
    clickCount: shares.reduce((sum, share) => sum + share.clickCount, 0),
    lastViewedAt: latestDate(shares.map((share) => share.lastViewedAt)),
    lastClickedAt: latestDate(shares.map((share) => share.lastClickedAt)),
    sections: [...sectionMap].map(([sectionKey, count]) => ({ sectionKey, count })).sort((left, right) => right.count - left.count),
    topElements: [...elementMap.values()].sort((left, right) => right.count - left.count).slice(0, 20),
    buckets
  };
}

function latestDate(values: Array<Date | null>) {
  const dates = values.filter((value): value is Date => value instanceof Date);
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((date) => date.getTime()))).toISOString();
}

function emptyInteractionSummary(reportId: string): DmpReportInteractionSummary {
  return {
    reportId,
    shareCount: 0,
    viewCount: 0,
    clickCount: 0,
    lastViewedAt: null,
    lastClickedAt: null,
    sections: [],
    topElements: [],
    buckets: []
  };
}
