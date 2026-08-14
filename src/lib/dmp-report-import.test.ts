import { describe, expect, it } from "vitest";
import {
  canonicalToDmpReport,
  inferDmpCaptureMeta,
  unwrapDmpRecords
} from "./dmp-report-import";

function datasetRecord(subject: string, competitor: string, start: string, end: string, capturedAt: string) {
  const filters = (id: string) => JSON.stringify([
    { expression: "thedate", description: "thedate", values: [start, end] },
    { expression: "item_id", description: "宝贝ID", values: [id] }
  ]);
  return {
    kind: "Network",
    pathname: "/dataplatform/dataset/report/query.json",
    capturedAt,
    requestBody: JSON.stringify({
      filterCondition: filters(subject),
      filterCompareCondition: filters(competitor)
    })
  };
}

describe("DMP JSON 工程文件识别", () => {
  it("优先选择文件名指定对象且完整 30 天的同周期请求", () => {
    const records = [
      datasetRecord("593063365092", "644284068612", "2026-07-14", "2026-07-21", "2026-08-14T14:55:18Z"),
      datasetRecord("593063365092", "623803508105", "2026-07-14", "2026-07-23", "2026-08-14T14:55:19Z"),
      datasetRecord("593063365092", "623803508105", "2026-07-15", "2026-08-13", "2026-08-14T14:55:28Z")
    ];
    const meta = inferDmpCaptureMeta(
      records,
      "达摩盘_监听记录_593063365092_vs_623803508105_2026-08-14.json"
    );
    expect(meta.subjectItemId).toBe("593063365092");
    expect(meta.successItemId).toBe("623803508105");
    expect(meta.period).toEqual({ startDate: "2026-07-15", endDate: "2026-08-13", days: 30 });
    expect(meta.periodConfirmed).toBe(true);
    expect(meta.periodPrecision).toBe("exact");
  });

  it("接受 records 包装结构，并把标准业务 JSON 还原为页面报告", () => {
    expect(unwrapDmpRecords({ records: [{ kind: "Network" }] })).toHaveLength(1);
    const report = canonicalToDmpReport({
      schema_version: "3.0",
      title: "达摩盘报告",
      item_id: "593063365092",
      period: "近30天（2026-07-15 至 2026-08-13）",
      tables: [{
        name: "报告总览",
        columns: ["项目", "主体", "对手"],
        rows: [{ cells: ["商品ID", "593063365092", "623803508105"] }]
      }]
    });
    expect(report?.item.competitorId).toBe("623803508105");
    expect(report?.period.days).toBe(30);
    expect(report?.tables[0].rows[0][1]).toBe("593063365092");
  });
});
