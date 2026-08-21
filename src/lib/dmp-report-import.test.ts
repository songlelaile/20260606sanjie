import { describe, expect, it } from "vitest";
import {
  canonicalToDmpReport,
  inferDmpCaptureMeta,
  reconcileDmpCrossTableMetrics,
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

function dates(start: string, days: number) {
  const values: string[] = [];
  const startTime = Date.parse(`${start}T00:00:00Z`);
  for (let index = 0; index < days; index += 1) values.push(new Date(startTime + index * 86_400_000).toISOString().slice(0, 10));
  return values;
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
      tables: [
        {
          name: "报告总览",
          columns: ["项目", "主体", "对手"],
          rows: [{ cells: ["商品ID", "593063365092", "623803508105"] }]
        },
        {
          name: "对标总表",
          columns: ["页面模块", "对标指标", "主体周期值", "对手周期值", "主体相对对手"],
          rows: [{ cells: ["成交", "总GMV", "1530988.18", "945000", ""] }]
        },
        {
          name: "周期汇总",
          columns: ["商品ID", "对象", "周期开始", "周期结束", "天数", "总GMV", "付费成交额", "广告消耗", "付费GMV贡献率", "GMV峰值日", "GMV波动率"],
          rows: [
            { cells: ["593063365092", "主体商品・30日", "2026-07-15", "2026-08-13", "30", "1530988.18", "456075.05", "150211.72", "", "", ""] },
            { cells: ["623803508105", "目标对手・30日", "2026-07-15", "2026-08-13", "30", "945000", "300000~410000", "102.32", "", "", ""] }
          ]
        },
        {
          name: "日GMV与费比",
          columns: ["日期", "日GMV"],
          rows: dates("2026-07-15", 30).map((date, index) => ({ cells: [date, index === 29 ? "46000" : "31000"] }))
        },
        {
          name: "一级场景",
          columns: ["对象", "层级", "一级场景", "二级场景", "sceneId", "消耗(API精确值)", "消耗占比(API原值)", "分配后消耗", "展现", "点击", "CTR", "CPC", "直接成交金额", "直接ROI"],
          rows: [
            { cells: ["主体", "1", "关键词推广", "", "371", "150211.72", "100%", "", "", "33938", "", "", "234836.70", ""] },
            { cells: ["对手", "1", "人群推广", "", "372", "", "46.77%", "", "4千~5千", "90~100", "1%~2.5%", "0~10", "0~10", "0~10"] },
            { cells: ["对手", "1", "关键词推广", "", "371", "", "53.23%", "", "1千~2千", "60~70", "5%~7.5%", "0~10", "300~400", "0~10"] }
          ]
        },
        {
          name: "二级场景",
          columns: ["对象", "层级", "一级场景", "二级场景", "sceneId", "消耗(API精确值)", "消耗占比(API原值)", "分配后消耗", "展现", "点击", "CTR", "CPC", "直接成交金额", "直接ROI"],
          rows: [
            { cells: ["对手", "2", "关键词推广", "智能投放", "37101", "", "50%", "", "", "30~40", "", "0~10", "100~200", "0~10"] }
          ]
        },
        {
          name: "商品与成功品",
          columns: ["角色", "商品ID", "30日GMV", "30日日均成交"],
          rows: [
            { cells: ["主体", "593063365092", "1530988.18", "51032.94"] },
            { cells: ["目标对手", "623803508105", "", ""] },
            { cells: ["备选成功品", "623803508106", "", ""] }
          ]
        }
      ]
    });
    expect(report?.item.competitorId).toBe("623803508105");
    expect(report?.period.days).toBe(30);
    expect(report?.tables[0].rows[0][1]).toBe("593063365092");
    const itemRows = report?.tables.find((table) => table.name === "商品与成功品")?.rows;
    expect(itemRows?.[1][2]).toBe("945000");
    expect(itemRows?.[1][3]).toBe(31500);
    expect(itemRows?.[2][2]).toBe("");
    const periodRows = report?.tables.find((table) => table.name === "周期汇总")?.rows;
    expect(periodRows?.[1][8]).toBe("0.31746~0.433862");
    expect(periodRows?.[1][9]).toBe("2026-08-13");
    expect(Number(periodRows?.[1][10])).toBeGreaterThan(0);
    const level1 = report?.tables.find((table) => table.name === "一级场景")?.rows;
    expect(level1?.[1][7]).toBe(47.86);
    expect(level1?.[1][11]).toBe("0.48~0.53");
    expect(level1?.[1][13]).toBe("0~0.21");
    expect(level1?.[2][7]).toBe(54.46);
    expect(level1?.[2][11]).toBe("0.78~0.91");
    expect(level1?.[2][13]).toBe("5.51~7.34");
    const level2 = report?.tables.find((table) => table.name === "二级场景")?.rows;
    expect(level2?.[0][7]).toBe(27.23);
    expect(level2?.[0][11]).toBe("0.68~0.91");
    expect(level2?.[0][13]).toBe("3.67~7.34");
  });

  it("restores render_data product links, subject daily values, generated time and table presentation", () => {
    const report = canonicalToDmpReport({
      schema_version: "3.0",
      title: "达摩盘报告",
      item_id: "593063365092",
      period: "2026-08-01 至 2026-08-02",
      tables: [
        { name: "报告总览", columns: ["项目", "主体", "对手"], rows: [{ cells: ["商品ID", "593063365092", "623803508105"] }] },
        { name: "对标总表", columns: ["页面模块", "对标指标", "主体周期值", "对手周期值", "主体相对对手"], rows: [{ cells: ["周期", "总GMV", "300", "400", ""] }] },
        {
          name: "商品与成功品",
          columns: ["角色", "商品ID", "商品标题", "图片/详情"],
          rows: [
            { cells: ["主体", "593063365092", "主体商品", "https://img.alicdn.com/old-subject.png"] },
            { cells: ["目标对手", "623803508105", "目标对手", "https://img.alicdn.com/old-competitor.png"] }
          ]
        },
        {
          name: "周期汇总",
          columns: ["商品ID", "对象", "总GMV"],
          rows: [
            { cells: ["593063365092", "主体", "300"] },
            { cells: ["623803508105", "目标对手", "400"] }
          ]
        },
        {
          name: "日GMV与费比",
          columns: ["日期", "日GMV", "人群推广日消耗", "阶段"],
          rows: [
            { cells: ["2026-08-01", "190", "20", "成长期"] },
            { cells: ["2026-08-02", "210", "30", "成长期"] }
          ]
        }
      ],
      render_data: {
        version: "1",
        generated_at: "2026-08-03T12:00:00+08:00",
        products: {
          subject: {
            picture_url: "https://img.alicdn.com/new-subject.png",
            detail_url: "https://item.taobao.com/item.htm?id=593063365092"
          },
          competitor: {
            picture_url: "https://img.alicdn.com/new-competitor.png",
            detail_url: "https://item.taobao.com/item.htm?id=623803508105"
          }
        },
        subject_daily_gmv: [
          { date: "2026-08-01", gmv: "120" },
          { date: "2026-08-02", gmv: "180" }
        ],
        tables: [{ name: "日GMV与费比", subtitle: "主体与目标对手逐日对比", widths: [13, 16, 18, 12] }]
      }
    });

    expect(report?.generatedAt).toBe("2026-08-03T04:00:00.000Z");
    expect(report?.item).toMatchObject({
      pictureUrl: "https://img.alicdn.com/new-subject.png",
      detailUrl: "https://item.taobao.com/item.htm?id=593063365092",
      competitorPictureUrl: "https://img.alicdn.com/new-competitor.png",
      competitorDetailUrl: "https://item.taobao.com/item.htm?id=623803508105"
    });
    const daily = report?.tables.find((table) => table.name === "日GMV与费比");
    expect(daily?.columns).toEqual(["日期", "主体日GMV", "日GMV", "人群推广日消耗", "阶段"]);
    expect(daily?.rows.map((row) => row[1])).toEqual(["120", "180"]);
    expect(daily?.subtitle).toBe("主体与目标对手逐日对比");
    expect(daily?.widths).toEqual([13, 16, 16, 18, 12]);
  });

  it("matches local HTML by omitting the subject series when the platform daily table is short", () => {
    const report = canonicalToDmpReport({
      schema_version: "3.0",
      title: "达摩盘报告",
      item_id: "593063365092",
      period: "2026-08-01 至 2026-08-02",
      tables: [
        { name: "报告总览", columns: ["项目", "主体", "对手"], rows: [{ cells: ["商品ID", "593063365092", "623803508105"] }] },
        {
          name: "周期汇总",
          columns: ["商品ID", "对象", "总GMV"],
          rows: [
            { cells: ["593063365092", "主体", "300"] },
            { cells: ["623803508105", "目标对手", "190"] }
          ]
        },
        { name: "日GMV与费比", columns: ["日期", "日GMV"], rows: [{ cells: ["2026-08-01", "190"] }] }
      ],
      render_data: {
        version: "1",
        subject_daily_gmv: [
          { date: "2026-08-01", gmv: "120" },
          { date: "2026-08-02", gmv: "180" }
        ]
      }
    });
    const daily = report?.tables.find((table) => table.name === "日GMV与费比");
    expect(daily?.columns).toEqual(["日期", "日GMV"]);
    expect(daily?.rows).toEqual([["2026-08-01", "190"]]);
  });

  it("fills blank derived scene cells for both old and concise headers but preserves disclosed values and intervals", () => {
    const tables = [
      {
        name: "周期汇总",
        columns: ["商品ID", "对象", "总GMV", "推广消耗"],
        rows: [
          ["593063365092", "主体", "1000", "100"],
          ["623803508105", "目标对手", "2000", "200"]
        ]
      },
      {
        name: "商品与成功品",
        columns: ["角色", "商品ID", "30日GMV"],
        rows: [
          ["主体", "593063365092", "1000"],
          ["目标对手", "623803508105", "2000"]
        ]
      },
      {
        name: "一级场景",
        columns: ["对象", "层级", "一级场景", "二级场景", "场景编号", "消耗", "消耗占比", "分配后消耗", "展现", "点击量", "CTR", "点击单价", "直接成交额", "ROI"],
        rows: [
          ["主体", "1", "关键词推广", "", "371", "100", "100%", "", "", "20", "", "", "300", ""],
          ["对手", "1", "人群推广", "", "372", "", "50%", "", "", "40~50", "", "0~10", "400~500", "1~2"]
        ]
      }
    ];
    reconcileDmpCrossTableMetrics(tables, "593063365092", "623803508105", 30, { preserveDisclosedRanges: true });
    expect(tables[2].rows[0][7]).toBe(100);
    expect(tables[2].rows[0][11]).toBe(5);
    expect(tables[2].rows[0][13]).toBe(3);
    expect(tables[2].rows[1][7]).toBe(100);
    expect(tables[2].rows[1][11]).toBe("0~10");
    expect(tables[2].rows[1][13]).toBe("1~2");
  });
});
