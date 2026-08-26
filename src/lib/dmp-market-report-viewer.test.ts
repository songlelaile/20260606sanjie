import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DMP_MARKET_TIME_ZONE,
  buildDmpMarketTrackMatrix,
  dmpMarketTrackPeriodOptions,
  dmpMarketTrackHeatOpacity,
  dmpMarketCategoryLabel,
  formatDmpMarketTrackScore,
  marketKpiMetrics,
  marketMedianMetrics,
  normalizeDmpMarketPriceBand,
  parseBusinessNumber,
  projectDmpMarketReport,
  shanghaiDateKey,
  selectDmpMarketPeriod,
  selectDmpMarketTrackPeriod
} from "@/components/tools/DmpMarketReportViewModel";
import type { DmpBusinessReportRecord } from "@/lib/dmp-report-types";

function marketRecord(): DmpBusinessReportRecord {
  return {
    id: "market-report-1",
    reportType: "market",
    subjectItemId: "350511",
    competitorItemId: "",
    period: "2026-03-31 至 2026-04-02",
    quality: "complete",
    createdAt: "2026-08-22T00:00:00.000Z",
    report: {
      schema_version: "3.0",
      report_type: "market",
      title: "达摩盘类目大盘报告｜少壮AI自动化",
      item_id: "350511",
      period: "2026-03-31 至 2026-04-02",
      market_scope: {
        category_id: "350511",
        category_name: "油烟机",
        category_path: ["大家电", "厨房大电", "油烟机"]
      },
      tables: [{
        name: "滚动7天市场数据",
        columns: ["请求截止日", "窗口开始", "成交金额", "新客人数", "periodType"],
        rows: [
          { cells: ["2026-03-31", "2026-03-25", "3000万~4000万", "1500", "1"] },
          { cells: ["2026-04-01", "2026-03-26", "2000万~3000万", "1700", "1"] },
          { cells: ["2026-04-02", "2026-03-27", "3000万~4000万", "1600", "1"] }
        ]
      }]
    }
  };
}

describe("DMP category-market viewer", () => {
  it("projects only business fields and offers natural day/week/month periods", () => {
    const model = projectDmpMarketReport(marketRecord());
    expect(model.scope.category_path).toEqual(["大家电", "厨房大电", "油烟机"]);
    expect(model.tables[0].name).toBe("市场核心指标");
    expect(model.tables[0].columns).toEqual(["日期", "成交金额", "新客人数"]);
    expect(JSON.stringify(model.tables)).not.toMatch(/窗口开始|periodType|请求截止日/);
    expect(model.periods.day.map((option) => option.key)).toEqual(["2026-03-31", "2026-04-01", "2026-04-02"]);
    expect(model.periods.month.map((option) => option.key)).toEqual(["2026-03", "2026-04"]);
    expect(model.periods.week).toEqual([expect.objectContaining({
      key: "2026-03-30",
      start: "2026-03-30",
      end: "2026-04-05"
    })]);
    expect(selectDmpMarketPeriod(model, "day", "2026-04-01").tables[0].rows)
      .toEqual([["2026-04-01", "2000万~3000万", "1700"]]);
    expect(selectDmpMarketPeriod(model, "month", "2026-04").tables[0].rows).toHaveLength(2);
  });

  it("selects one natural day, keeps explicit zero, prunes missing fields and switches back to week/month", () => {
    const record = marketRecord();
    record.report.tables = [
      {
        name: "自然日汇总",
        columns: ["日期", "成交金额", "新客人数", "内容运营日消耗"],
        rows: [
          { cells: ["2026-07-18", "2800万", "520", "100"] },
          { cells: ["2026-07-19", "0", "—", "0"] },
          { cells: ["2026-07-20", "—", "—", "—"] }
        ]
      },
      {
        name: "自然周汇总",
        columns: ["周期", "成交金额"],
        rows: [{ cells: ["2026-07-13 至 2026-07-19", "1.8亿"] }]
      },
      {
        name: "自然月汇总",
        columns: ["周期", "成交金额"],
        rows: [{ cells: ["2026-07-01 至 2026-07-31", "7.2亿"] }]
      }
    ];

    const model = projectDmpMarketReport(record);
    expect(model.periods.day.map((option) => option.key)).toEqual(["2026-07-18", "2026-07-19", "2026-07-20"]);
    const day = selectDmpMarketPeriod(model, "day", "2026-07-19");
    expect(day.selected?.label).toBe("2026-07-19");
    expect(day.tables.map((table) => table.name)).toEqual(["自然日汇总"]);
    expect(day.tables[0].columns).toEqual(["日期", "成交金额", "内容运营日消耗"]);
    expect(day.tables[0].rows).toEqual([["2026-07-19", "0", "0"]]);
    expect(marketKpiMetrics(day.tables)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "成交金额", value: 0 }),
      expect.objectContaining({ label: "内容运营日消耗", value: 0 })
    ]));

    expect(selectDmpMarketPeriod(model, "day", "2026-07-20").tables).toEqual([]);
    expect(selectDmpMarketPeriod(model, "week", "2026-07-13").tables.map((table) => table.name)).toEqual(["自然周汇总"]);
    expect(selectDmpMarketPeriod(model, "month", "2026-07").tables.map((table) => table.name)).toEqual(["自然月汇总"]);
  });

  it("uses Asia/Shanghai at the UTC+8 natural-day boundary", () => {
    expect(DMP_MARKET_TIME_ZONE).toBe("Asia/Shanghai");
    expect(shanghaiDateKey("2026-08-23T15:59:59.999Z")).toBe("2026-08-23");
    expect(shanghaiDateKey("2026-08-23T16:00:00.000Z")).toBe("2026-08-24");

    const record = marketRecord();
    record.report.tables = [{
      name: "自然日汇总",
      columns: ["日期", "成交金额"],
      rows: [
        { cells: ["2026-08-23T15:59:59.999Z", "100"] },
        { cells: ["2026-08-23T16:00:00.000Z", "200"] }
      ]
    }];
    const model = projectDmpMarketReport(record);
    expect(model.periods.day.map((option) => option.key)).toEqual(["2026-08-23", "2026-08-24"]);
    expect(selectDmpMarketPeriod(model, "day", "2026-08-24").tables[0].rows)
      .toEqual([["2026-08-24", "200"]]);
  });

  it("uses interval midpoints and reports the median as a direct reference value", () => {
    const model = projectDmpMarketReport(marketRecord());
    const april = selectDmpMarketPeriod(model, "month", "2026-04");
    expect(parseBusinessNumber("2000万~3000万", "成交金额")).toBe(25_000_000);
    expect(marketMedianMetrics(april.tables)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "成交金额", value: 30_000_000 }),
      expect.objectContaining({ label: "新客人数", value: 1650 })
    ]));
  });

  it("prefers an archived direct KPI over a second aggregation of daily values", () => {
    const record = marketRecord();
    record.report.tables.unshift({
      name: "市场总览",
      columns: ["指标", "当前值"],
      rows: [
        { cells: ["成交金额期间中位", "1.23亿"] },
        { cells: ["新客人数", "1888"] }
      ]
    });
    const model = projectDmpMarketReport(record);
    const april = selectDmpMarketPeriod(model, "month", "2026-04");
    expect(marketKpiMetrics(april.tables)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "成交金额", value: 123_000_000 }),
      expect.objectContaining({ label: "新客人数", value: 1888 })
    ]));
    expect(april.tables[0].rows[0][0]).toBe("成交金额");
  });

  it("switches real archived natural-week and natural-month summary rows instead of reusing the latest period", () => {
    const record = marketRecord();
    record.period = "2026-07-01 至 2026-07-31";
    record.report.period = record.period;
    record.report.tables = [
      {
        name: "规模与成交",
        columns: ["指标", "本月", "上月", "环比"],
        rows: [
          { cells: ["成交金额", "1.2亿", "8000万", "50%"] },
          { cells: ["新客人数", "2600", "1800", "44.44%"] }
        ]
      },
      {
        name: "自然周汇总",
        columns: ["周期", "成交金额", "新客人数"],
        rows: [
          { cells: ["2026-07-06 至 2026-07-12", "2400万", "510"] },
          { cells: ["2026-07-13 至 2026-07-19", "3100万", "620"] }
        ]
      },
      {
        name: "自然月汇总",
        columns: ["周期", "成交金额", "新客人数"],
        rows: [
          { cells: ["2026-06-01 至 2026-06-30", "8000万", "1800"] },
          { cells: ["2026-07-01 至 2026-07-31", "1.2亿", "2600"] }
        ]
      }
    ];

    const model = projectDmpMarketReport(record);
    expect(model.periods.week.map((option) => option.key)).toEqual(["2026-07-06", "2026-07-13"]);
    expect(model.periods.month.map((option) => option.key)).toEqual(["2026-06", "2026-07"]);

    const june = selectDmpMarketPeriod(model, "month", "2026-06");
    expect(june.tables.map((table) => table.name)).toEqual(["自然月汇总"]);
    expect(june.tables[0].rows).toEqual([["2026-06-01 至 2026-06-30", "8000万", "1800"]]);
    expect(marketKpiMetrics(june.tables)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "成交金额", value: 80_000_000 }),
      expect.objectContaining({ label: "新客人数", value: 1800 })
    ]));

    const secondWeek = selectDmpMarketPeriod(model, "week", "2026-07-13");
    expect(secondWeek.tables.map((table) => table.name)).toEqual(["自然周汇总"]);
    expect(marketKpiMetrics(secondWeek.tables)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "成交金额", value: 31_000_000 }),
      expect.objectContaining({ label: "新客人数", value: 620 })
    ]));
  });

  it("keeps v2.3.4 price-band tracks and period comparisons beside the selected natural summary", () => {
    const record = marketRecord();
    record.period = "2026-07-01 至 2026-07-31";
    record.report.period = record.period;
    record.report.tables = [
      {
        name: "细分赛道周期对比-产品剂型",
        columns: ["属性维度", "属性值", "价格带", "指标", "2026-07-01 至 2026-07-31", "2026-06-01 至 2026-06-30", "变化值"],
        rows: [
          { cells: ["产品剂型", "口服液", "0~330", "增长潜力得分(dScore)", "0", "12", "-12"] },
          { cells: ["产品剂型", "片剂", "0~330", "增长潜力得分(dScore)", "—", "20", "—"] },
          { cells: ["产品剂型", "胶囊", "0~330", "增长潜力得分(dScore)", "88", "63", "+25"] },
          { cells: ["产品剂型", "口服液", "1800以上", "增长潜力得分(dScore)", "35", "30", "+5"] },
          { cells: ["产品剂型", "口服液", "0~330", "蓝海指数(eScore)", "4", "2", "+2"] }
        ]
      },
      {
        name: "类目周期环比",
        columns: ["指标", "本月", "上月", "环比"],
        rows: [{ cells: ["成交金额", "1.2亿", "8000万", "50%"] }]
      },
      {
        name: "类目历史周期",
        columns: ["指标", "2026-07-01 至 2026-07-31", "2026-06-01 至 2026-06-30"],
        rows: [{ cells: ["成交金额", "1.2亿", "8000万"] }]
      },
      {
        name: "自然日汇总",
        columns: ["日期", "成交金额"],
        rows: [{ cells: ["2026-07-31", "500万"] }]
      },
      {
        name: "自然周汇总",
        columns: ["周期", "成交金额"],
        rows: [{ cells: ["2026-07-27 至 2026-08-02", "3200万"] }]
      },
      {
        name: "自然月汇总",
        columns: ["周期", "成交金额", "新客人数"],
        rows: [{ cells: ["2026-07-01 至 2026-07-31", "1.2亿", "2600"] }]
      }
    ];

    const model = projectDmpMarketReport(record);
    const month = selectDmpMarketPeriod(model, "month", "2026-07");
    expect(month.tables.map((table) => table.name)).toEqual([
      "细分赛道周期对比-产品剂型",
      "类目周期环比",
      "类目历史周期",
      "自然月汇总"
    ]);
    expect(month.tables[0].rows[0].slice(-3)).toEqual(["0", "12", "-12"]);
    const matrix = buildDmpMarketTrackMatrix(month.tables[0]);
    expect(matrix).toMatchObject({
      propertyName: "产品剂型",
      currentLabel: "2026-07-01 至 2026-07-31",
      previousLabel: "2026-06-01 至 2026-06-30",
      propertyValues: ["口服液", "片剂", "胶囊"],
      priceBands: ["0~330", "≥1800"]
    });
    expect(matrix?.metrics.map((metric) => metric.label)).toEqual([
      "增长潜力得分(dScore)",
      "蓝海指数(eScore)"
    ]);
    const dScore = matrix?.metrics[0];
    expect(dScore?.rows[0].cells[0]).toMatchObject({ current: 0, previous: 12, change: -12 });
    expect(dScore?.rows[0].cells[1]).toMatchObject({ current: null, previous: 20, change: null });
    expect(dScore?.rows[0].cells[2]).toMatchObject({ current: 88, previous: 63, change: 25 });
    expect(dScore?.rows[1].priceBand).toBe("≥1800");
    expect(formatDmpMarketTrackScore(0)).toBe("0");
    expect(formatDmpMarketTrackScore(null)).toBe("—");
    expect(formatDmpMarketTrackScore(25, true)).toBe("+25");
    expect(dmpMarketTrackHeatOpacity(0, dScore?.scale ?? 0)).toBe(0);
    expect(dmpMarketTrackHeatOpacity(null, dScore?.scale ?? 0)).toBe(0);
    expect(dmpMarketTrackHeatOpacity(88, dScore?.scale ?? 0)).toBeGreaterThan(0);
    expect(normalizeDmpMarketPriceBand("1800及以上")).toBe("≥1800");
    expect(normalizeDmpMarketPriceBand("330以下")).toBe("≤330");
    expect(buildDmpMarketTrackMatrix(month.tables[1])).toBeNull();
    expect(marketKpiMetrics(month.tables)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "成交金额", value: 120_000_000 }),
      expect.objectContaining({ label: "新客人数", value: 2600 })
    ]));
    expect(marketKpiMetrics(month.tables).some((metric) => /dScore|增长潜力/.test(metric.label))).toBe(false);

    expect(selectDmpMarketPeriod(model, "day", "2026-07-31").tables.map((table) => table.name)).toEqual([
      "细分赛道周期对比-产品剂型",
      "类目周期环比",
      "类目历史周期",
      "自然日汇总"
    ]);
  });

  it("renders the all-period long-form track archive and pairs the selected period with its predecessor", () => {
    const record = marketRecord();
    record.period = "2026-07-01 至 2026-07-31";
    record.report.period = record.period;
    const longColumns = ["周期", "周期开始", "周期结束", "属性维度", "属性值", "价格带", "指标", "数值"];
    const trackRow = (
      start: string,
      end: string,
      propertyName: string,
      propertyValue: string,
      priceBand: string,
      metric: string,
      value: string
    ) => ({ cells: [`${start} 至 ${end}`, start, end, propertyName, propertyValue, priceBand, metric, value] });
    record.report.tables = [
      {
        name: "细分赛道矩阵",
        columns: longColumns,
        rows: [
          trackRow("2026-07-01", "2026-07-31", "机身材质", "不锈钢", "0~2300", "搜索潜力", "131"),
          trackRow("2026-07-01", "2026-07-31", "机身材质", "不锈钢", "0~2300", "成交潜力", "64"),
          trackRow("2026-07-01", "2026-07-31", "机身材质", "不锈钢", "0~2300", "拉新潜力", "26"),
          trackRow("2026-07-01", "2026-07-31", "机身材质", "不锈钢", "0~2300", "蓝海指数", "346"),
          trackRow("2026-06-01", "2026-06-30", "机身材质", "不锈钢", "0~2300", "搜索潜力", "120"),
          trackRow("2026-06-01", "2026-06-30", "机身材质", "不锈钢", "0~2300", "成交潜力", "60"),
          trackRow("2026-06-01", "2026-06-30", "机身材质", "不锈钢", "0~2300", "拉新潜力", "20"),
          trackRow("2026-06-01", "2026-06-30", "机身材质", "不锈钢", "0~2300", "蓝海指数", "300"),
          trackRow("2026-05-01", "2026-05-31", "机身材质", "不锈钢", "0~2300", "蓝海指数", "280"),
          trackRow("2026-07-01", "2026-07-31", "智能类型", "非智能", "2300~3900", "蓝海指数", "143"),
          trackRow("2026-06-01", "2026-06-30", "智能类型", "非智能", "2300~3900", "蓝海指数", "100")
        ]
      },
      {
        name: "自然月汇总",
        columns: ["周期", "成交金额"],
        rows: [
          { cells: ["2026-05-01 至 2026-05-31", "8000万"] },
          { cells: ["2026-06-01 至 2026-06-30", "9000万"] },
          { cells: ["2026-07-01 至 2026-07-31", "1.2亿"] }
        ]
      }
    ];

    const model = projectDmpMarketReport(record);
    expect(model.tables.map((table) => table.name)).toEqual([
      "细分赛道矩阵-机身材质",
      "细分赛道矩阵-智能类型",
      "自然月汇总"
    ]);
    expect(model.tables[0].rows).toHaveLength(9);

    const july = selectDmpMarketPeriod(model, "month", "2026-07");
    expect(july.tables.map((table) => table.name)).toEqual([
      "细分赛道矩阵-机身材质",
      "细分赛道矩阵-智能类型",
      "自然月汇总"
    ]);
    expect(july.tables[0].selectedTrackPeriod).toEqual({ start: "2026-07-01", end: "2026-07-31" });
    const allTrackPeriods = dmpMarketTrackPeriodOptions(july.tables[0]);
    expect(allTrackPeriods.map((option) => option.label)).toEqual([
      "2026-07-01 至 2026-07-31",
      "2026-06-01 至 2026-06-30",
      "2026-05-01 至 2026-05-31"
    ]);
    const matrix = buildDmpMarketTrackMatrix(july.tables[0]);
    expect(matrix).toMatchObject({
      propertyName: "机身材质",
      currentLabel: "2026-07-01 至 2026-07-31",
      previousLabel: "2026-06-01 至 2026-06-30",
      propertyValues: ["不锈钢"],
      priceBands: ["0~2300"]
    });
    expect(matrix?.metrics.map((metric) => metric.label)).toEqual([
      "搜索潜力",
      "成交潜力",
      "拉新潜力",
      "蓝海指数"
    ]);
    expect(matrix?.metrics[0].rows[0].cells[0]).toMatchObject({ current: 131, previous: 120, change: 11 });
    expect(matrix?.metrics[3].rows[0].cells[0]).toMatchObject({ current: 346, previous: 300, change: 46 });
    const mayTable = selectDmpMarketTrackPeriod(july.tables[0], allTrackPeriods[2].key);
    expect(buildDmpMarketTrackMatrix(mayTable)).toMatchObject({
      currentLabel: "2026-05-01 至 2026-05-31",
      previousLabel: "—"
    });

    const june = selectDmpMarketPeriod(model, "month", "2026-06");
    const juneMatrix = buildDmpMarketTrackMatrix(june.tables[0]);
    expect(juneMatrix).toMatchObject({
      currentLabel: "2026-06-01 至 2026-06-30",
      previousLabel: "2026-05-01 至 2026-05-31"
    });
    expect(juneMatrix?.metrics.find((metric) => metric.label === "蓝海指数")?.rows[0].cells[0])
      .toMatchObject({ current: 300, previous: 280, change: 20 });
    expect(marketKpiMetrics(july.tables).some((metric) => /潜力|蓝海/.test(metric.label))).toBe(false);
  });

  it("does not fall back to an unrelated track period when the selected period has no overlap", () => {
    const record = marketRecord();
    record.report.tables = [
      {
        name: "细分赛道矩阵",
        columns: ["周期", "周期开始", "周期结束", "属性维度", "属性值", "价格带", "指标", "数值"],
        rows: [
          { cells: ["2026-07-01 至 2026-07-31", "2026-07-01", "2026-07-31", "机身材质", "不锈钢", "0~2300", "蓝海指数", "346"] }
        ]
      },
      {
        name: "自然月汇总",
        columns: ["周期", "成交金额"],
        rows: [
          { cells: ["2026-01-01 至 2026-01-31", "8000万"] },
          { cells: ["2026-07-01 至 2026-07-31", "1.2亿"] }
        ]
      }
    ];

    const january = selectDmpMarketPeriod(projectDmpMarketReport(record), "month", "2026-01");
    expect(january.tables.map((table) => table.name)).toEqual(["自然月汇总"]);
  });

  it("merges compact track fragments before pairing the current and previous periods", () => {
    const record = marketRecord();
    const columns = [
      "周期", "周期开始", "周期结束", "属性维度", "属性值", "价格带",
      "搜索潜力", "成交潜力", "拉新潜力", "蓝海指数"
    ];
    record.report.tables = [
      {
        name: "细分赛道矩阵-机身材质-0abc123-分片01",
        columns,
        rows: [{ cells: [
          "2026-07-01 至 2026-07-31", "2026-07-01", "2026-07-31", "机身材质", "不锈钢", "0~2300",
          "131", "64", "26", "346"
        ] }]
      },
      {
        name: "细分赛道矩阵-机身材质-0abc123-分片02",
        columns,
        rows: [{ cells: [
          "2026-06-01 至 2026-06-30", "2026-06-01", "2026-06-30", "机身材质", "不锈钢", "0~2300",
          "120", "60", "20", "300"
        ] }]
      },
      {
        name: "自然月汇总",
        columns: ["周期", "成交金额"],
        rows: [{ cells: ["2026-07-01 至 2026-07-31", "1.2亿"] }]
      }
    ];

    const model = projectDmpMarketReport(record);
    expect(model.tables.filter((table) => table.name.startsWith("细分赛道矩阵-"))).toHaveLength(1);
    expect(model.capturedPeriod).toEqual({ start: "2026-06-01", end: "2026-07-31", count: 2 });
    const july = selectDmpMarketPeriod(model, "month", "2026-07");
    const trackTable = july.tables.find((table) => table.name.startsWith("细分赛道矩阵-"));
    const matrix = buildDmpMarketTrackMatrix(trackTable!);
    expect(matrix).toMatchObject({
      propertyName: "机身材质",
      currentLabel: "2026-07-01 至 2026-07-31",
      previousLabel: "2026-06-01 至 2026-06-30"
    });
    expect(matrix?.metrics.find((metric) => metric.label === "蓝海指数")?.rows[0].cells[0])
      .toMatchObject({ current: 346, previous: 300, change: 46 });
  });

  it("merges growth-opportunity archive fragments before filtering the selected period", () => {
    const record = marketRecord();
    const columns = ["周期", "周期开始", "周期结束", "机会类型", "赛道名称", "属性维度", "属性值", "价格带"];
    record.report.tables = [
      {
        name: "货品增长机会-分片01",
        columns,
        rows: [{ cells: [
          "2026-07-01 至 2026-07-31", "2026-07-01", "2026-07-31", "本店优势赛道", "赛道A", "机身材质", "不锈钢", "0~2300"
        ] }]
      },
      {
        name: "货品增长机会-分片02",
        columns,
        rows: [
          { cells: [
            "2026-07-01 至 2026-07-31", "2026-07-01", "2026-07-31", "本店优势赛道", "赛道A", "机身材质", "不锈钢", "0~2300"
          ] },
          { cells: [
            "2026-06-01 至 2026-06-30", "2026-06-01", "2026-06-30", "类目高潜机会", "赛道B", "机身材质", "钢化玻璃", "2300~3900"
          ] }
        ]
      },
      {
        name: "自然月汇总",
        columns: ["周期", "成交金额"],
        rows: [{ cells: ["2026-07-01 至 2026-07-31", "1.2亿"] }]
      }
    ];

    const model = projectDmpMarketReport(record);
    expect(model.tables.filter((table) => table.name === "货品增长机会")).toHaveLength(1);
    expect(model.tables.find((table) => table.name === "货品增长机会")?.rows).toHaveLength(3);
    const july = selectDmpMarketPeriod(model, "month", "2026-07");
    expect(july.tables.find((table) => table.name === "货品增长机会")?.rows).toHaveLength(2);
    expect(july.tables.find((table) => table.name === "货品增长机会")?.rows[0]).toContain("赛道A");
  });

  it("does not pair a non-adjacent older track period as the previous period", () => {
    const record = marketRecord();
    record.report.tables = [
      {
        name: "细分赛道矩阵",
        columns: ["周期", "周期开始", "周期结束", "属性维度", "属性值", "价格带", "指标", "数值"],
        rows: [
          { cells: ["2026-07-01 至 2026-07-31", "2026-07-01", "2026-07-31", "机身材质", "不锈钢", "0~2300", "蓝海指数", "346"] },
          { cells: ["2026-05-01 至 2026-05-31", "2026-05-01", "2026-05-31", "机身材质", "不锈钢", "0~2300", "蓝海指数", "280"] }
        ]
      },
      {
        name: "自然月汇总",
        columns: ["周期", "成交金额"],
        rows: [{ cells: ["2026-07-01 至 2026-07-31", "1.2亿"] }]
      }
    ];

    const july = selectDmpMarketPeriod(projectDmpMarketReport(record), "month", "2026-07");
    const trackTable = july.tables.find((table) => table.name === "细分赛道矩阵-机身材质");
    expect(trackTable?.rows).toHaveLength(2);
    expect(trackTable?.selectedTrackPeriod).toEqual({ start: "2026-07-01", end: "2026-07-31" });
    expect(buildDmpMarketTrackMatrix(trackTable!)).toMatchObject({
      currentLabel: "2026-07-01 至 2026-07-31",
      previousLabel: "—"
    });
  });

  it("falls back to the Chinese category path and drops empty or engineering-only fields", () => {
    const record = marketRecord();
    record.subjectItemId = "50015382";
    record.report.item_id = "50015382";
    record.report.market_scope = {
      category_id: "50015382",
      category_name: "",
      category_path: []
    };
    record.report.tables[0].columns.push("内容运营日消耗", "空字段", "7日参考值", "期间中位", "分析窗口");
    record.report.tables[0].rows.forEach((row) => row.cells.push("0", "", "99", "88", "2026-04-01 至 2026-07-31"));
    const model = projectDmpMarketReport(record);
    expect(model.scope.category_path).toEqual(["大家电", "厨房大电", "油烟机"]);
    expect(dmpMarketCategoryLabel(record.report.market_scope, record.subjectItemId)).toBe("大家电-厨房大电-油烟机");
    expect(model.tables[0].columns).toEqual(["日期", "成交金额", "新客人数", "内容运营日消耗"]);
  });

  it("constructs exactly 54 branded watermark nodes", () => {
    const viewer = readFileSync("src/components/tools/DmpMarketReportViewer.tsx", "utf8");
    const count = Number(viewer.match(/Array\.from\(\{ length:\s*(\d+) \}/)?.[1]);
    expect(count).toBe(54);
    expect(viewer).toContain("WATERMARKS.map((index) => <span");
  });

  it("keeps preview and share on the branded market viewer visual contract", () => {
    const viewer = readFileSync("src/components/tools/DmpMarketReportViewer.tsx", "utf8");
    const css = readFileSync("src/components/tools/DmpMarketReportViewer.module.css", "utf8");
    const dispatch = readFileSync("src/components/tools/DmpReportViewer.tsx", "utf8");
    const workspace = readFileSync("src/components/tools/DmpReportWorkspace.tsx", "utf8");
    const sharedPage = readFileSync("src/app/shared/dmp-reports/[token]/page.tsx", "utf8");
    expect(viewer).toContain("少壮AI自动化 · shaozhuangai.com");
    expect(viewer).toContain("<h1>少壮AI自动化报告</h1>");
    expect(sharedPage).toContain('title: "少壮AI自动化报告"');
    expect(viewer).toContain("自然周");
    expect(viewer).toContain("自然月");
    expect(viewer).toContain("自然日");
    expect(viewer).toContain("细分赛道已采全周期");
    expect(viewer).toContain("data-captured-period");
    expect(viewer).toContain('record.quality === "partial"');
    expect(viewer).toContain('data-report-quality="partial"');
    expect(viewer).toContain("缺失项不会按 0 处理");
    expect(viewer).toContain("data-track-period-selector");
    expect(viewer).toContain("dmp-market-empty-state");
    expect(viewer).toContain("data-track-matrix");
    expect(viewer).toContain('data-track-visualization="heatmap"');
    expect(viewer).toContain("价格带 × {matrix.propertyName}");
    expect(viewer).toContain("环比为本期减上一周期的分值差");
    expect(viewer).not.toMatch(/metric-progress|track-progress|track-bar/i);
    expect(viewer).toContain("Array.from({ length: 54 }");
    expect(viewer).not.toMatch(/类目\s*ID|滚动值中位数|中位数参考|7日参考值|期间中位|分析窗口|数据窗口|对比窗口/);
    expect(workspace).not.toMatch(/类目\s*ID/);
    expect(dispatch).toContain("DmpMarketReportViewer");
    expect(css).toMatch(/\.root\s*\{[^}]*color-scheme:\s*light\s*!important;/s);
    expect(css).toMatch(/\.tableShell thead th[^}]*\{[\s\S]*?color:\s*#fff\s*!important;[\s\S]*?background:\s*var\(--market-green\)\s*!important;/);
    expect(css).toMatch(/\.tableShell th,\s*\.tableShell td[^}]*border-top:\s*0\s*!important;[^}]*color:\s*var\(--market-ink\)\s*!important;[^}]*vertical-align:\s*middle/);
    expect(css).toMatch(/\.tableShell tbody\s*>\s*tr\s*>\s*td\s*\{[^}]*background:\s*#edf5f3\s*!important;/s);
    expect(css).toMatch(/\.numeric\s*\{[^}]*text-align:\s*right\s*!important;/);
    expect(css).toMatch(/\.watermark\s*\{[^}]*z-index:\s*3;[^}]*opacity:\s*\.075;/s);
    expect(css).toMatch(/\.trackHeatmapTable\s*\{[^}]*width:\s*max-content;[^}]*min-width:\s*100%/s);
    expect(css).toMatch(/\.trackHeatmapTable thead th:first-child,\s*\.trackHeatmapTable tbody th\s*\{[^}]*position:\s*sticky;[^}]*left:\s*0/s);
    expect(css).toMatch(/\.trackHeatmapTable tbody\s*>\s*tr\s*>\s*td\.trackHeatCell\s*\{[^}]*rgba\(var\(--market-track-blue\),\s*var\(--market-track-heat[^}]*!important/s);
    expect(css).toMatch(/td\.trackHeatCell\.trackHeatMissing\s*\{[^}]*background:\s*#edf5f3\s*!important/s);
    expect(css).toMatch(/td\.trackHeatCell\.trackHeatZero\s*\{[^}]*background:\s*#f1f5f4\s*!important/s);
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.trackToolbar\s*\{[^}]*grid-template-columns:\s*1fr/s);
    expect(css).toMatch(/@media print[\s\S]*?\.trackHeatmapTable\s*\{[^}]*table-layout:\s*fixed/s);
    expect(`${viewer}\n${css}`).not.toMatch(/Boundary|zssl|ecbis/i);
  });
});
