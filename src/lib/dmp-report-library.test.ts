import { describe, expect, it } from "vitest";
import {
  dmpCanonicalReportIdentity,
  dmpReportGroupIdsByShopAndIdentity,
  dmpReportProductThumbnail,
  dmpReportSubjectThumbnail,
  groupDmpBusinessReports,
  groupDmpBusinessReportsByShop,
  mergeDmpReportGroupDaily
} from "@/lib/dmp-report-library";
import type { DmpBusinessReportRecord } from "@/lib/dmp-report-types";

function report({
  id,
  createdAt,
  subject = "100",
  competitor = "200",
  pictureUrl = "",
  competitorPictureUrl = "",
  shopId = "",
  shopName = ""
}: {
  id: string;
  createdAt: string;
  subject?: string;
  competitor?: string;
  pictureUrl?: string;
  competitorPictureUrl?: string;
  shopId?: string;
  shopName?: string;
}): DmpBusinessReportRecord {
  return {
    id,
    reportType: "growth",
    ...(shopId ? { shopId, shopName } : {}),
    subjectItemId: subject,
    competitorItemId: competitor,
    period: "近30天（2026-07-01 至 2026-07-30）",
    quality: "complete",
    createdAt,
    report: {
      schema_version: "3.0",
      title: "测试报告",
      item_id: subject,
      competitor_ids: competitor.split(","),
      period: "近30天（2026-07-01 至 2026-07-30）",
      tables: [{
        name: "商品与成功品",
        columns: ["对象", "商品ID", "商品标题", "图片/详情"],
        rows: [
          { cells: ["主体", subject, `商品 ${subject}`, "https://detail.tmall.com/item.htm?id=100"] },
          { cells: ["目标对手", competitor, `商品 ${competitor}`, ""] }
        ]
      }],
      ...(pictureUrl || competitorPictureUrl ? {
        render_data: {
          version: "1",
          products: {
            ...(pictureUrl ? { subject: { picture_url: pictureUrl } } : {}),
            ...(competitorPictureUrl ? { competitor: { picture_url: competitorPictureUrl } } : {})
          }
        }
      } : {})
    }
  };
}

describe("DMP report history library", () => {
  it("groups the same subject and competitor set and sorts every group newest first", () => {
    const groups = groupDmpBusinessReports([
      report({ id: "old", createdAt: "2026-08-19T03:00:00.000Z", competitor: "300,200" }),
      report({ id: "other", createdAt: "2026-08-21T03:00:00.000Z", competitor: "400" }),
      report({ id: "new", createdAt: "2026-08-20T03:00:00.000Z", competitor: "200、300" })
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ subjectItemId: "100", competitorItemId: "400" });
    expect(groups[1].records.map((record) => record.id)).toEqual(["new", "old"]);
    expect(groups[1].competitorItemId).toBe("200、300");
  });

  it("uses the safe subject render image and keeps a text fallback for legacy reports", () => {
    expect(dmpReportSubjectThumbnail(report({
      id: "image",
      createdAt: "2026-08-21T03:00:00.000Z",
      pictureUrl: "https://img.alicdn.com/subject.png"
    }))).toEqual({ url: "https://img.alicdn.com/subject.png", title: "商品 100" });

    expect(dmpReportSubjectThumbnail(report({
      id: "legacy",
      createdAt: "2026-08-20T03:00:00.000Z"
    }))).toEqual({ url: "", title: "商品 100" });
  });

  it("keeps subject and competitor thumbnails on a canonical group and uses the newest available image", () => {
    const groups = groupDmpBusinessReports([
      report({
        id: "older-image",
        createdAt: "2026-08-20T03:00:00.000Z",
        pictureUrl: "https://img.alicdn.com/subject.png",
        competitorPictureUrl: "https://img.alicdn.com/competitor.png"
      }),
      report({ id: "newer-without-image", createdAt: "2026-08-21T03:00:00.000Z" })
    ]);

    expect(groups[0].subjectThumbnail).toEqual({
      url: "https://img.alicdn.com/subject.png",
      title: "商品 100"
    });
    expect(groups[0].competitorThumbnail).toEqual({
      url: "https://img.alicdn.com/competitor.png",
      title: "商品 200"
    });
    expect(dmpReportProductThumbnail(groups[0].records[1], "competitor")).toEqual({
      url: "https://img.alicdn.com/competitor.png",
      title: "商品 200"
    });
  });

  it("partitions history by shop before canonical identity and keeps newest shop/group/report ordering", () => {
    const partitions = groupDmpBusinessReportsByShop([
      report({ id: "a-old", createdAt: "2026-08-19T03:00:00.000Z", shopId: "shop-a", shopName: "西西礼" }),
      report({ id: "unassigned", createdAt: "2026-08-18T03:00:00.000Z" }),
      report({ id: "b-new", createdAt: "2026-08-22T03:00:00.000Z", shopId: "shop-b", shopName: "北北店" }),
      report({ id: "a-new", createdAt: "2026-08-21T03:00:00.000Z", shopId: "shop-a", shopName: "西西礼" })
    ]);

    expect(partitions.map((partition) => [partition.shopId, partition.shopName, partition.reportCount]))
      .toEqual([
        ["shop-b", "北北店", 1],
        ["shop-a", "西西礼", 2],
        ["", "未归类店铺", 1]
      ]);
    expect(partitions[1].groups).toHaveLength(1);
    expect(partitions[1].groups[0].records.map((record) => record.id)).toEqual(["a-new", "a-old"]);
    expect(partitions[0].groups[0].records.map((record) => record.id)).toEqual(["b-new"]);
  });

  it("resolves assignment IDs from the complete shop and identity group after history is filtered", () => {
    const completeGroups = groupDmpBusinessReportsByShop([
      report({ id: "a-new", createdAt: "2026-08-22T03:00:00.000Z", shopId: "shop-a", shopName: "西西礼" }),
      report({ id: "a-old", createdAt: "2026-08-19T03:00:00.000Z", shopId: "shop-a", shopName: "西西礼" }),
      report({ id: "a-other-product", createdAt: "2026-08-18T03:00:00.000Z", competitor: "300", shopId: "shop-a", shopName: "西西礼" }),
      report({ id: "b-same-product", createdAt: "2026-08-17T03:00:00.000Z", shopId: "shop-b", shopName: "北北店" }),
      report({ id: "unassigned-same-product", createdAt: "2026-08-16T03:00:00.000Z" })
    ]);
    const visibleGroups = groupDmpBusinessReportsByShop([
      report({ id: "a-new", createdAt: "2026-08-22T03:00:00.000Z", shopId: "shop-a", shopName: "西西礼" })
    ]);
    const visibleShop = visibleGroups[0];
    const visibleGroup = visibleShop.groups[0];

    expect(dmpReportGroupIdsByShopAndIdentity(
      completeGroups,
      visibleShop.key,
      visibleGroup.key
    )).toEqual(["a-new", "a-old"]);
  });

  it("prefers canonical identities for legacy metadata and labels competition-store fallbacks correctly", () => {
    const legacy = report({ id: "legacy-id", createdAt: "2026-08-20T03:00:00.000Z", competitor: "200" });
    legacy.subjectItemId = "999";
    legacy.competitorItemId = "999";
    expect(groupDmpBusinessReports([legacy])[0]).toMatchObject({
      subjectItemId: "100",
      competitorItemId: "200"
    });

    const competition = report({ id: "shop", createdAt: "2026-08-21T03:00:00.000Z", competitor: "300,200" });
    competition.reportType = "competition";
    competition.report.report_type = "competition";
    competition.report.competitor_ids = ["300", "200"];
    competition.report.tables = [];
    expect(dmpReportSubjectThumbnail(competition)).toEqual({ url: "", title: "本店 100" });
  });

  it("uses the same canonical identity for a newly uploaded report before it is archived", () => {
    const incoming = report({ id: "incoming", createdAt: "2026-08-21T03:00:00.000Z", competitor: "300,200" });
    expect(dmpCanonicalReportIdentity(incoming.report, {
      subjectItemId: "999",
      competitorItemId: "888"
    })).toEqual({
      reportType: "growth",
      subjectItemId: "100",
      competitorItemIds: ["200", "300"],
      competitorItemId: "200、300"
    });

    incoming.report.report_type = "competition";
    incoming.report.competitor_ids = ["400", "300"];
    incoming.report.tables = [];
    expect(dmpCanonicalReportIdentity(incoming.report, { competitorItemId: "888" })).toMatchObject({
      reportType: "competition",
      subjectItemId: "100",
      competitorItemIds: ["300", "400"]
    });
  });

  it("extends same-group daily data by date and lets the newest report fill duplicate dates first", () => {
    const older = report({ id: "older", createdAt: "2026-08-19T03:00:00.000Z" });
    const newer = report({ id: "newer", createdAt: "2026-08-20T03:00:00.000Z" });
    older.report.tables.push(dailyTable([
      ["2026-08-18", "100", "10"],
      ["2026-08-19", "110", "11"]
    ]));
    newer.report.tables.push(dailyTable([
      ["2026-08-19", "120", ""],
      ["2026-08-20", "130", "13"]
    ]));

    const merged = mergeDmpReportGroupDaily([older, newer], "newer");
    const daily = merged?.report.tables.find((table) => table.name === "日GMV与费比");
    expect(daily?.rows.map((row) => row.cells)).toEqual([
      ["2026-08-18", "100", "10"],
      ["2026-08-19", "120", "11"],
      ["2026-08-20", "130", "13"]
    ]);
    expect(merged?.id).toBe("newer");
    expect(merged?.report.render_data?.tables?.find((table) => table.name === "日GMV与费比")?.subtitle)
      .toBe("同组分日合并｜2026-08-18 至 2026-08-20｜3天");
  });

  it("extends validated subject-daily values together with the competitor timeline", () => {
    const older = exactDailyReport("older-exact", "2026-08-19T03:00:00.000Z", [
      ["2026-08-18", "10", "100"],
      ["2026-08-19", "11", "110"]
    ]);
    const newer = exactDailyReport("newer-exact", "2026-08-20T03:00:00.000Z", [
      ["2026-08-19", "12", "120"],
      ["2026-08-20", "13", "130"]
    ]);

    const merged = mergeDmpReportGroupDaily([older, newer], "newer-exact");
    const daily = merged?.report.tables.find((table) => table.name === "日GMV与费比");
    expect(daily?.columns.slice(0, 3)).toEqual(["日期", "主体日GMV", "日GMV"]);
    expect(daily?.rows.map((row) => row.cells.slice(0, 3))).toEqual([
      ["2026-08-18", "10", "100"],
      ["2026-08-19", "12", "120"],
      ["2026-08-20", "13", "130"]
    ]);
  });
});

function dailyTable(rows: string[][]) {
  return {
    name: "日GMV与费比",
    columns: ["日期", "日GMV", "日总消耗"],
    rows: rows.map((cells) => ({ cells }))
  };
}

function exactDailyReport(id: string, createdAt: string, rows: string[][]) {
  const value = report({ id, createdAt });
  const dates = rows.map((row) => row[0]);
  const subjectTotal = rows.reduce((sum, row) => sum + Number(row[1]), 0);
  value.period = `近2天（${dates[0]} 至 ${dates.at(-1)}）`;
  value.report.period = value.period;
  value.report.tables.push({
    name: "周期汇总",
    columns: ["对象", "商品ID", "总GMV"],
    rows: [{ cells: ["主体", "100", String(subjectTotal)] }]
  });
  value.report.tables.push(dailyTable(rows.map(([date, , competitor]) => [date, competitor, "0"])));
  value.report.render_data = {
    version: "1",
    subject_daily_gmv: rows.map(([date, subject]) => ({ date, gmv: subject }))
  };
  return value;
}
