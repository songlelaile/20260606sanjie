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
            { cells: ["主体", "1", "关键词推广", "", "", "150211.72", "100%", "", "", "33938", "", "", "234836.70", ""] },
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
    expect(level1).toHaveLength(4);
    const competitorCrowd = level1?.find((row) => row[0] === "对手" && row[2] === "人群推广");
    const competitorKeyword = level1?.find((row) => row[0] === "对手" && row[2] === "关键词推广");
    const subjectCrowd = level1?.find((row) => row[0] === "主体" && row[2] === "人群推广");
    expect(subjectCrowd?.[7]).toBe("");
    expect(competitorCrowd?.[7]).toBe(47.86);
    expect(competitorCrowd?.[11]).toBe("0.48~0.53");
    expect(competitorCrowd?.[13]).toBe("0~0.21");
    expect(competitorKeyword?.[7]).toBe(54.46);
    expect(competitorKeyword?.[11]).toBe("0.78~0.91");
    expect(competitorKeyword?.[13]).toBe("5.51~7.34");
    const level2 = report?.tables.find((table) => table.name === "二级场景")?.rows;
    const level2Competitor = level2?.find((row) => row[0] === "对手");
    expect(level2?.find((row) => row[0] === "主体")?.[7]).toBe("");
    expect(level2Competitor?.[7]).toBe(27.23);
    expect(level2Competitor?.[11]).toBe("0.68~0.91");
    expect(level2Competitor?.[13]).toBe("3.67~7.34");
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

  it.each([
    ["30 vs 29", dates("2026-07-20", 30).slice(0, -1)],
    ["missing middle date", [...dates("2026-07-20", 30).filter((_, index) => index !== 14), "2026-08-19"]],
    ["out of order", (() => {
      const values = dates("2026-07-20", 30);
      [values[9], values[10]] = [values[10], values[9]];
      return values;
    })()]
  ])("aligns subject and competitor daily series by date union for %s platform dates", (_case, platformDates) => {
    const renderDates = dates("2026-07-20", 30);
    const report = canonicalToDmpReport({
      schema_version: "3.0",
      title: "达摩盘报告",
      item_id: "593063365092",
      period: "2026-07-20 至 2026-08-18",
      tables: [
        { name: "报告总览", columns: ["项目", "主体", "对手"], rows: [{ cells: ["商品ID", "593063365092", "623803508105"] }] },
        {
          name: "周期汇总",
          columns: ["商品ID", "对象", "总GMV"],
          rows: [
            { cells: ["593063365092", "主体", "3000"] },
            { cells: ["623803508105", "目标对手", "3000"] }
          ]
        },
        {
          name: "日GMV与费比",
          columns: ["日期", "日GMV"],
          rows: platformDates.map((date) => ({ cells: [date, "100"] }))
        }
      ],
      render_data: {
        version: "1",
        subject_daily_gmv: renderDates.map((date) => ({ date, gmv: "100" }))
      }
    });
    const daily = report?.tables.find((table) => table.name === "日GMV与费比");
    expect(daily?.columns).toEqual(["日期", "主体日GMV", "日GMV"]);
    expect(daily?.rows.map((row) => row[0])).toEqual(renderDates);
    expect(daily?.rows.map((row) => row[1])).toEqual(renderDates.map(() => "100"));
    const competitorByDate = new Map(platformDates.map((date) => [date, "100"]));
    expect(daily?.rows.map((row) => row[2])).toEqual(renderDates.map((date) => competitorByDate.get(date) ?? ""));
  });

  it("deduplicates repeated platform dates and preserves disclosed cells from the repeated rows", () => {
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
            { cells: ["623803508105", "目标对手", "400"] }
          ]
        },
        {
          name: "日GMV与费比",
          columns: ["日期", "日GMV", "人群推广日消耗", "阶段"],
          rows: [
            { cells: ["2026-08-01", "190", "", "成长期"] },
            { cells: ["2026-08-01", "", "20", ""] },
            { cells: ["2026-08-02", "210", "30", "成长期"] }
          ]
        }
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
    expect(daily?.rows).toHaveLength(2);
    expect(daily?.rows[0]).toEqual(["2026-08-01", "120", "190", "20", "成长期"]);
  });

  it("canonicalizes archived range objects before paid-metric reconciliation", () => {
    const report = canonicalToDmpReport({
      schema_version: "3.0",
      title: "达摩盘报告",
      item_id: "593063365092",
      period: "2026-07-20 至 2026-08-18",
      tables: [
        {
          name: "报告总览",
          columns: ["项目", "主体", "对手", "范围"],
          rows: [{ cells: ["商品ID", "593063365092", "623803508105", ""] }]
        },
        {
          name: "周期汇总",
          columns: ["商品ID", "对象", "付费成交额", "推广消耗", "ROI", "付费PPC"],
          rows: [
            { cells: ["593063365092", "主体", "200000", "50000", "", ""] },
            { cells: ["623803508105", "目标对手", { min: "800000.00", max: "900000.00" }, "80000", "", ""] }
          ]
        },
        {
          name: "对标总表",
          columns: ["页面模块", "对标指标", "主体周期值", "对手周期值", "主体相对对手"],
          rows: [
            { cells: ["投放", "付费成交额", "", "", ""] },
            { cells: ["投放", "ROI", "", "", ""] },
            { cells: ["投放", "付费PPC", "", "", ""] }
          ]
        },
        {
          name: "基础指标对比",
          columns: ["指标", "主体值", "对手值", "主体相对对手"],
          rows: [
            { cells: ["营销推广点击量", "25000", '{"min":30000,"max":40000}', ""] },
            { cells: ["付费成交额", "", "", ""] },
            { cells: ["ROI", "", "", ""] },
            { cells: ["付费PPC", "", "", ""] }
          ]
        }
      ]
    });

    const benchmark = report?.tables.find((table) => table.name === "对标总表");
    const metric = (name: string) => benchmark?.rows.find((row) => row[1] === name);
    expect(metric("付费成交额")?.[3]).toBe("800000.00~900000.00");
    expect(metric("ROI")?.[3]).toBe("10~11.25");
    expect(metric("付费PPC")?.[3]).toBe("2~2.666667");
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

  it("continues period and scene reconciliation when the product table has no 30-day GMV column", () => {
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
        columns: ["角色", "商品ID", "商品标题"],
        rows: [
          ["主体", "593063365092", "主体商品"],
          ["目标对手", "623803508105", "目标对手"]
        ]
      },
      {
        name: "一级场景",
        columns: ["对象", "层级", "一级场景", "二级场景", "场景编号", "消耗", "消耗占比", "分配后消耗", "展现", "点击", "CTR", "CPC", "直接成交金额", "直接ROI"],
        rows: [
          ["主体", "1", "关键词推广", "", "371", "", "100%", "", "", "20", "", "", "300", ""],
          ["对手", "1", "关键词推广", "", "371", "", "50%", "", "", "40", "", "", "400", ""]
        ]
      },
      {
        name: "二级场景",
        columns: ["对象", "层级", "一级场景", "二级场景", "场景编号", "消耗", "消耗占比", "分配后消耗", "展现", "点击", "CTR", "CPC", "直接成交金额", "直接ROI"],
        rows: [
          ["主体", "2", "关键词推广", "智能投放", "37101", "", "50%", "", "", "10", "", "", "100", ""],
          ["对手", "2", "关键词推广", "智能投放", "37101", "", "25%", "", "", "5", "", "", "75", ""]
        ]
      }
    ];

    reconcileDmpCrossTableMetrics(tables, "593063365092", "623803508105", 30, { preserveDisclosedRanges: true });

    expect(tables[2].rows[0].slice(7, 14)).toEqual([100, "", "20", "", 5, "300", 3]);
    expect(tables[2].rows[1].slice(7, 14)).toEqual([100, "", "40", "", 2.5, "400", 4]);
    expect(tables[3].rows[0].slice(7, 14)).toEqual([50, "", "10", "", 5, "100", 2]);
    expect(tables[3].rows[1].slice(7, 14)).toEqual([25, "", "5", "", 5, "75", 3]);
  });

  it("backfills both sides from 1-day-short daily spend and writes the disclosed coverage across existing metric cells", () => {
    const metricRows = (metrics: string[]) => metrics.map((metric) => ["投放", metric, "", "", ""]);
    const tables = [
      {
        name: "报告总览",
        columns: ["项目", "主体", "对手", "范围"],
        rows: [
          ["商品ID", "593063365092", "623803508105", ""],
          ["总GMV", "300", "700", "3日严格同周期"],
          ["付费成交额", "90", "140", "3日严格同周期"],
          ...["推广消耗", "费比", "ROI", "PPC", "关键词消耗占比", "全域ROAS"].map((metric) => [metric, "", "", "3日严格同周期"])
        ]
      },
      {
        name: "周期汇总",
        columns: ["商品ID", "对象", "周期开始", "周期结束", "天数", "总GMV", "付费成交额", "推广消耗", "费比", "ROI", "PPC", "关键词消耗占比", "全域ROAS"],
        rows: [
          ["593063365092", "主体", "2026-08-01", "2026-08-03", "3", "300", "90", "", "", "", "", "", ""],
          ["623803508105", "目标对手", "2026-08-01", "2026-08-03", "3", "700", "140", "", "", "", "", "", ""]
        ]
      },
      {
        name: "日GMV与费比",
        columns: ["日期", "主体日GMV", "对手日GMV", "主体关键词推广日消耗", "对手关键词推广日消耗", "主体日总消耗", "对手日总消耗"],
        rows: [
          ["2026-08-01", "100", "200", "2", "6", "10", "30"],
          ["2026-08-02", "100", "200", "8", "999", "20", ""],
          ["2026-08-03", "100", "300", "999", "14", "", "40"]
        ]
      },
      {
        name: "对标总表",
        columns: ["页面模块", "对标指标", "主体周期值", "对手周期值", "主体相对对手"],
        rows: metricRows(["推广消耗", "费比", "ROI", "PPC", "关键词消耗占比", "全域ROAS"])
      },
      {
        name: "基础指标对比",
        columns: ["指标", "主体值", "对手值", "主体相对对手"],
        rows: [
          ["营销推广点击量", "15", "35", ""],
          ...["广告/推广消耗", "费比", "ROI", "PPC", "关键词消耗占比", "全域ROAS"].map((metric) => [metric, "", "", ""])
        ]
      }
    ];

    reconcileDmpCrossTableMetrics(tables, "593063365092", "623803508105", 3, {
      preserveDisclosedRanges: true,
      periodStartDate: "2026-08-01",
      periodEndDate: "2026-08-03"
    });

    expect(tables[1].rows[0].slice(7, 12)).toEqual([30, 0.1, 3, 2, 0.333333]);
    expect(tables[1].rows[1].slice(7, 12)).toEqual([70, 0.1, 2, 2, 0.285714]);
    expect(tables[1].rows.map((row) => row[12])).toEqual([10, 10]);
    const overviewMetric = (metric: string) => tables[0].rows.find((row) => row[0] === metric);
    expect(overviewMetric("推广消耗")?.slice(1, 3)).toEqual([30, 70]);
    expect(overviewMetric("费比")?.slice(1, 3)).toEqual([0.1, 0.1]);
    expect(overviewMetric("ROI")?.slice(1, 3)).toEqual([3, 2]);
    expect(overviewMetric("PPC")?.slice(1, 3)).toEqual([2, 2]);
    expect(overviewMetric("关键词消耗占比")?.slice(1, 3)).toEqual([0.333333, 0.285714]);
    expect(overviewMetric("全域ROAS")?.slice(1, 3)).toEqual([10, 10]);
    expect(String(overviewMetric("推广消耗")?.[3])).toContain("主体已返回2/3日");
    expect(String(overviewMetric("推广消耗")?.[3])).toContain("对手已返回2/3日");
    const coverage = overviewMetric("花费覆盖");
    expect(String(coverage?.[1])).toContain("已返回2/3日（实际2026-08-01 至 2026-08-02；缺少2026-08-03；缺失日未按0计入）");
    expect(String(coverage?.[2])).toContain("已返回2/3日（实际2026-08-01 至 2026-08-03；缺少2026-08-02；缺失日未按0计入）");
    expect(tables[3].rows.map((row) => row.slice(2, 4))).toEqual([
      [30, 70], [0.1, 0.1], [3, 2], [2, 2], [0.333333, 0.285714], [10, 10]
    ]);
    expect(tables[4].rows.slice(1).map((row) => row.slice(1, 3))).toEqual([
      [30, 70], [0.1, 0.1], [3, 2], [2, 2], [0.333333, 0.285714], [10, 10]
    ]);
  });

  it("preserves explicit zero and disclosed intervals while carrying interval formulas into blank cells", () => {
    const tables = [
      {
        name: "报告总览",
        columns: ["项目", "主体", "对手", "范围"],
        rows: [
          ["商品ID", "593063365092", "623803508105", ""],
          ["推广消耗", 0, "", "已披露范围"],
          ["费比", "", "", ""],
          ["ROI", "2~5", "", "已披露范围"],
          ["PPC", "", "", ""],
          ["关键词消耗占比", "", "", ""],
          ["全域ROAS", "", "", ""]
        ]
      },
      {
        name: "周期汇总",
        columns: ["商品ID", "对象", "周期开始", "周期结束", "天数", "总GMV", "付费成交额", "推广消耗", "费比", "ROI", "PPC", "关键词消耗占比", "全域ROAS"],
        rows: [
          ["593063365092", "主体", "2026-08-01", "2026-08-03", "3", "240~300", "90~120", "", "", "", "", "", ""],
          ["623803508105", "目标对手", "2026-08-01", "2026-08-03", "3", "500", "100", 0, "", "", "", "", ""]
        ]
      },
      {
        name: "日GMV与费比",
        columns: ["日期", "主体关键词推广日消耗", "对手关键词推广日消耗", "主体日总消耗", "对手日总消耗"],
        rows: [
          ["2026-08-01", "3", "5", "10", "10"],
          ["2026-08-02", "6", "5", "20", "10"],
          ["2026-08-03", "999", "5", "", ""]
        ]
      },
      {
        name: "对标总表",
        columns: ["页面模块", "对标指标", "主体周期值", "对手周期值", "主体相对对手"],
        rows: [
          ["投放", "推广消耗", "", 0, ""],
          ["投放", "费比", "", "", ""],
          ["投放", "ROI", 0, "", ""],
          ["投放", "PPC", "", "", ""],
          ["结构", "关键词消耗占比", 0, "", ""],
          ["投放", "全域ROAS", "", "", ""]
        ]
      },
      {
        name: "基础指标对比",
        columns: ["指标", "主体值", "对手值", "主体相对对手"],
        rows: [
          ["营销推广点击量", "10~15", "20", ""],
          ["广告/推广消耗", "", "", ""],
          ["费比", "0.08~0.2", "", ""],
          ["ROI", "", "", ""],
          ["PPC", "", "", ""],
          ["关键词消耗占比", "", "", ""],
          ["全域ROAS", "", "", ""]
        ]
      }
    ];

    reconcileDmpCrossTableMetrics(tables, "593063365092", "623803508105", 3, {
      preserveDisclosedRanges: true,
      periodStartDate: "2026-08-01",
      periodEndDate: "2026-08-03"
    });

    expect(tables[1].rows[0].slice(7, 12)).toEqual([30, "0.1~0.125", "3~4", "2~3", 0.3]);
    expect(tables[1].rows[0][12]).toBe("8~10");
    expect(tables[1].rows[1][7]).toBe(0);
    expect(tables[0].rows.find((row) => row[0] === "推广消耗")?.[1]).toBe(0);
    expect(tables[0].rows.find((row) => row[0] === "ROI")?.[1]).toBe("2~5");
    expect(tables[3].rows.find((row) => row[1] === "推广消耗")?.[3]).toBe(0);
    expect(tables[3].rows.find((row) => row[1] === "ROI")?.[2]).toBe(0);
    expect(tables[3].rows.find((row) => row[1] === "关键词消耗占比")?.[2]).toBe(0);
    expect(tables[4].rows.find((row) => row[0] === "费比")?.[1]).toBe("0.08~0.2");
    expect(tables[4].rows.find((row) => row[0] === "ROI")?.[1]).toBe("3~4");
    expect(tables[4].rows.find((row) => row[0] === "PPC")?.[1]).toBe("2~3");
    expect(tables[4].rows.find((row) => row[0] === "关键词消耗占比")?.[1]).toBe(0.3);
    expect(tables[4].rows.find((row) => row[0] === "全域ROAS")?.[1]).toBe("8~10");
    const coverage = tables[0].rows.find((row) => row[0] === "花费覆盖");
    expect(String(coverage?.[1])).toContain("已返回2/3日");
    expect(coverage?.[2]).toBe("");
  });

  it("propagates paid-GMV ranges and derives ROI/PPC ranges from exact spend without inventing a difference", () => {
    const tables = [
      {
        name: "报告总览",
        columns: ["项目", "主体", "对手", "范围"],
        rows: [
          ["商品ID", "593063365092", "623803508105", ""],
          ["付费成交额", "", "", ""],
          ["ROI", "", "", ""],
          ["付费PPC", "", "", ""]
        ]
      },
      {
        name: "周期汇总",
        columns: ["商品ID", "对象", "付费成交额", "推广消耗", "ROI", "付费PPC"],
        rows: [
          ["593063365092", "主体", "200000", "50000", "", ""],
          ["623803508105", "目标对手", "800000.00~900000.00", "80000", "", ""]
        ]
      },
      {
        name: "对标总表",
        columns: ["页面模块", "对标指标", "主体周期值", "对手周期值", "主体相对对手"],
        rows: [
          ["投放", "付费成交额", "", "", "-75%"],
          ["投放", "ROI", "", "", "-60%"],
          ["投放", "付费PPC", "", "", "10%"]
        ]
      },
      {
        name: "基础指标对比",
        columns: ["指标", "主体值", "对手值", "主体相对对手"],
        rows: [
          ["营销推广点击量", "25000", "30000~40000", ""],
          ["付费成交额", "", "", "-75%"],
          ["ROI", "", "", "-60%"],
          ["付费PPC", "", "", "10%"]
        ]
      }
    ];

    reconcileDmpCrossTableMetrics(tables, "593063365092", "623803508105", 30, {
      preserveDisclosedRanges: true
    });

    const benchmarkMetric = (metric: string) => tables[2].rows.find((row) => row[1] === metric);
    expect(benchmarkMetric("付费成交额")?.slice(2, 5)).toEqual(["200000", "800000.00~900000.00", ""]);
    expect(benchmarkMetric("ROI")?.slice(2, 5)).toEqual([4, "10~11.25", ""]);
    expect(benchmarkMetric("付费PPC")?.slice(2, 5)).toEqual([2, "2~2.666667", ""]);
    expect(tables[1].rows[1].slice(4, 6)).toEqual(["10~11.25", "2~2.666667"]);
  });

  it("does not backfill a requested period when daily total spend is missing more than one day", () => {
    const tables = [
      {
        name: "报告总览",
        columns: ["项目", "主体", "对手", "范围"],
        rows: [["商品ID", "593063365092", "623803508105", ""]]
      },
      {
        name: "周期汇总",
        columns: ["商品ID", "对象", "周期开始", "周期结束", "天数", "总GMV", "推广消耗"],
        rows: [
          ["593063365092", "主体", "2026-08-01", "2026-08-03", "3", "300", ""],
          ["623803508105", "目标对手", "2026-08-01", "2026-08-03", "3", "300", "100"]
        ]
      },
      {
        name: "日GMV与费比",
        columns: ["日期", "主体日总消耗", "对手日总消耗"],
        rows: [
          ["2026-08-01", "10", "30"],
          ["2026-08-02", "", "30"],
          ["2026-08-03", "", "40"]
        ]
      }
    ];

    reconcileDmpCrossTableMetrics(tables, "593063365092", "623803508105", 3, {
      periodStartDate: "2026-08-01",
      periodEndDate: "2026-08-03"
    });

    expect(tables[1].rows[0][6]).toBe("");
    expect(tables[0].rows.some((row) => row[0] === "花费覆盖")).toBe(false);
  });
});
