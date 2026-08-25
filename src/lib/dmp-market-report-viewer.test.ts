import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DMP_MARKET_TIME_ZONE,
  buildDmpMarketGrowthOpportunityGroups,
  buildDmpMarketOpportunityMatrix,
  buildDmpMarketOpportunityWorkspace,
  buildDmpMarketTrackMatrix,
  dmpMarketTrackHeatOpacity,
  dmpMarketCategoryLabel,
  formatDmpMarketTrackScore,
  marketKpiMetrics,
  marketMedianMetrics,
  normalizeDmpMarketPriceBand,
  parseBusinessNumber,
  projectDmpMarketReport,
  isDmpMarketOpportunityWorkspaceSource,
  shanghaiDateKey,
  selectDmpMarketPeriod
} from "@/components/tools/DmpMarketReportViewModel";
import type { DmpBusinessReportRecord } from "@/lib/dmp-report-types";

function cssDeclarationsFor(css: string, selectorSuffix: string) {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const normalizedSuffix = normalize(selectorSuffix);
  const declarations: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map(normalize);
    if (selectors.some((selector) => selector.endsWith(normalizedSuffix))) declarations.push(match[2]);
  }
  return declarations.join("\n");
}

function expectForcedLightTableRule(
  css: string,
  selectorSuffix: string,
  background: RegExp,
  requireColor = true
) {
  const declarations = cssDeclarationsFor(css, selectorSuffix);
  expect(declarations, `missing scoped light-table rule: ${selectorSuffix}`).not.toBe("");
  if (requireColor) {
    expect(declarations).toMatch(/color:\s*(?:var\(--market-ink\)|#[0-9a-f]{3,8})\s*!important\s*;/i);
  }
  expect(declarations).toMatch(background);
}

function expectProtectedTableCells(css: string, shell: string) {
  for (const tag of ["th", "td"]) {
    const declarations = cssDeclarationsFor(css, `${shell} ${tag}`);
    expect(declarations, `missing global-table reset: ${shell} ${tag}`).not.toBe("");
    expect(declarations).toMatch(/border-top:\s*(?:0|none)\s*!important\s*;/i);
    expect(declarations).toMatch(/color:\s*var\(--market-ink\)\s*!important\s*;/i);
  }
}

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
  it("projects only business fields and offers an actual all-collected period beside day/week/month", () => {
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
    expect(model.periods.all).toEqual([{
      key: "actual-collected",
      label: "2026-03-31 至 2026-04-02",
      start: "2026-03-31",
      end: "2026-04-02"
    }]);
    expect(model.allCollected).toMatchObject({ periodCount: 3, start: "2026-03-31", end: "2026-04-02" });
    expect(selectDmpMarketPeriod(model, "all", "actual-collected").tables[0]).toMatchObject({
      name: "全部已采周期",
      columns: ["指标", "2026-03-31", "2026-04-01", "2026-04-02"],
      rows: [
        ["成交金额", "3000万~4000万", "2000万~3000万", "3000万~4000万"],
        ["新客人数", "1500", "1700", "1600"]
      ]
    });
    expect(selectDmpMarketPeriod(model, "day", "2026-04-01").tables[0].rows)
      .toEqual([["2026-04-01", "2000万~3000万", "1700"]]);
    expect(selectDmpMarketPeriod(model, "month", "2026-04").tables[0].rows).toHaveLength(2);
  });

  it("selects one natural day, keeps explicit zero, prunes missing fields and switches back to week/month", () => {
    const record = marketRecord();
    record.period = "2026-07-01 至 2026-07-31";
    record.report.period = record.period;
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

    const all = selectDmpMarketPeriod(model, "all", "actual-collected");
    expect(all.selected).toMatchObject({ start: "2026-07-18", end: "2026-07-19" });
    expect(model.allCollected?.periodCount).toBe(2);
    expect(all.tables[0]).toMatchObject({
      name: "全部已采周期",
      columns: ["指标", "2026-07-18", "2026-07-19"],
      rows: [
        ["成交金额", "2800万", "0"],
        ["新客人数", "520", "—"],
        ["内容运营日消耗", "100", "0"]
      ]
    });
    expect(JSON.stringify(all.tables[0])).not.toMatch(/2026-07-20|2026-07-01|2026-07-31/);
    expect(marketKpiMetrics(all.tables)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "成交金额", value: 0 }),
      expect.objectContaining({ label: "新客人数", value: 520 }),
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
          { cells: ["产品剂型", "口服液", "0~330", "蓝海指数(eScore)", "4", "2", "+2"] },
          { cells: ["产品剂型", "口服液", "0~330", "搜索潜力(aScore)", "82", "70", "+12"] }
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
      "搜索潜力(aScore)",
      "蓝海指数(eScore)",
      "增长潜力得分(dScore)"
    ]);
    const dScore = matrix?.metrics.find((metric) => /dScore/.test(metric.label));
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

  it("keeps growth-opportunity context with a selected period, groups dynamic chance titles and excludes it from KPIs", () => {
    const record = marketRecord();
    record.period = "2026-07-01 至 2026-07-31";
    record.report.period = record.period;
    record.report.tables = [
      {
        name: "货品增长机会-2026-07-01至2026-07-31",
        columns: ["机会类型", "机会标签", "机会说明", "赛道名称", "属性维度", "属性值", "价格带", "综合潜力指数", "本店成交排名", "关注状态"],
        rows: [
          { cells: ["高潜赛道", "市场高潜", "来自接口的动态说明", "冷板喷塑 × 0~2300", "机身材质", "冷板喷塑", "0~2300", "0", "14", "未关注"] },
          { cells: ["高潜赛道", "市场高潜", "来自接口的动态说明", "钢化玻璃 × ≥9800", "机身材质", "钢化玻璃", "9800以上", "116", "—", "已关注"] },
          { cells: ["本店优势赛道", "店铺优势", "同样来自接口", "不锈钢 × 2300~3900", "机身材质", "不锈钢", "2300~3900", "88", "3", "false"] }
        ]
      },
      {
        name: "赛道整体与本店-2026-07-01至2026-07-31",
        columns: ["赛道名称", "指标", "赛道值", "本店值"],
        rows: [{ cells: ["冷板喷塑 × 0~2300", "成交笔数", "346", "14"] }]
      },
      {
        name: "赛道人群-2026-07-01至2026-07-31",
        columns: ["赛道名称", "人群维度", "人群分组", "赛道洞察"],
        rows: [{ cells: ["冷板喷塑 × 0~2300", "年龄", "30~34岁", "120"] }]
      },
      {
        name: "赛道投放结构-2026-07-01至2026-07-31",
        columns: ["赛道名称", "范围", "场景", "消耗占比"],
        rows: [{ cells: ["冷板喷塑 × 0~2300", "赛道", "关键词推广", "30%"] }]
      },
      {
        name: "自然月汇总",
        columns: ["周期", "成交金额", "新客人数"],
        rows: [{ cells: ["2026-07-01 至 2026-07-31", "1.2亿", "2600"] }]
      }
    ];

    const model = projectDmpMarketReport(record);
    const selected = selectDmpMarketPeriod(model, "month", "2026-07");
    expect(selected.tables.map((table) => table.name)).toEqual([
      "货品增长机会-2026-07-01至2026-07-31",
      "赛道整体与本店-2026-07-01至2026-07-31",
      "赛道人群-2026-07-01至2026-07-31",
      "赛道投放结构-2026-07-01至2026-07-31",
      "自然月汇总"
    ]);
    const groups = buildDmpMarketGrowthOpportunityGroups(selected.tables[0]);
    expect(groups).toEqual([
      expect.objectContaining({
        title: "高潜赛道",
        tag: "市场高潜",
        description: "来自接口的动态说明",
        tracks: [
          expect.objectContaining({ trackName: "冷板喷塑 × 0~2300", score: "0", collected: "未关注" }),
          expect.objectContaining({ trackName: "钢化玻璃 × ≥9800", priceBand: "≥9800", collected: "已关注" })
        ]
      }),
      expect.objectContaining({
        title: "本店优势赛道",
        tracks: [expect.objectContaining({ collected: "false" })]
      })
    ]);
    expect(marketKpiMetrics(selected.tables)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "成交金额", value: 120_000_000 }),
      expect.objectContaining({ label: "新客人数", value: 2600 })
    ]));
    expect(marketKpiMetrics(selected.tables).some((metric) => /潜力|排名|消耗占比/.test(metric.label))).toBe(false);
    expect(buildDmpMarketOpportunityWorkspace(selected.tables)).toBeNull();
  });

  it("merges the six fixed long tables by exact period, keeps zero-count groups and never mixes periods", () => {
    const record = marketRecord();
    record.period = "2026-06-01 至 2026-07-31";
    record.report.period = record.period;
    const june = "2026-06-01 至 2026-06-30";
    const july = "2026-07-01 至 2026-07-31";
    const overlap = "2026-07-15 至 2026-08-14";
    record.report.tables = [
      {
        name: "细分赛道矩阵",
        columns: ["周期", "周期开始", "周期结束", "属性维度", "属性值", "价格带", "指标", "数值"],
        rows: [
          { cells: [june, "2026-06-01", "2026-06-30", "机身材质", "不锈钢", "0~2300", "搜索潜力(aScore)", "71"] },
          { cells: [july, "2026-07-01", "2026-07-31", "机身材质", "不锈钢", "0~2300", "搜索潜力(aScore)", "0"] },
          { cells: [july, "2026-07-01", "2026-07-31", "机身材质", "不锈钢", "0~2300", "成交潜力(bScore)", "63"] },
          { cells: [july, "2026-07-01", "2026-07-31", "机身材质", "不锈钢", "0~2300", "拉新潜力(cScore)", "52"] },
          { cells: [july, "2026-07-01", "2026-07-31", "机身材质", "不锈钢", "0~2300", "蓝海指数(eScore)", "40"] },
          { cells: [overlap, "2026-07-15", "2026-08-14", "机身材质", "串期材质", "2300~3900", "搜索潜力(aScore)", "99"] }
        ]
      },
      {
        name: "货品增长机会概览",
        columns: ["周期", "周期开始", "周期结束", "属性维度", "机会类型", "机会标签", "机会说明", "赛道数量"],
        rows: [
          { cells: [june, "2026-06-01", "2026-06-30", "机身材质", "高潜赛道", "市场高潜", "六月说明", "1"] },
          { cells: [july, "2026-07-01", "2026-07-31", "机身材质", "高潜赛道", "市场高潜", "七月暂无赛道", "0"] },
          { cells: [july, "2026-07-01", "2026-07-31", "机身材质", "本店优势赛道", "店铺优势", "七月本店优势", "1"] }
        ]
      },
      {
        name: "货品增长机会",
        columns: ["周期", "周期开始", "周期结束", "机会类型", "机会标签", "机会说明", "赛道名称", "属性维度", "属性值", "价格带", "综合潜力指数", "本店成交排名", "关注状态"],
        rows: [
          { cells: [june, "2026-06-01", "2026-06-30", "高潜赛道", "市场高潜", "六月说明", "六月赛道", "机身材质", "冷板喷塑", "0~2300", "80", "8", "已关注"] },
          { cells: [july, "2026-07-01", "2026-07-31", "本店优势赛道", "店铺优势", "七月本店优势", "七月赛道", "机身材质", "不锈钢", "0~2300", "88", "3", "未关注"] }
        ]
      },
      {
        name: "赛道整体与本店",
        columns: ["周期", "周期开始", "周期结束", "机会类型", "赛道名称", "属性维度", "属性值", "价格带", "指标", "赛道整体", "本店表现"],
        rows: [
          { cells: [june, "2026-06-01", "2026-06-30", "高潜赛道", "六月赛道", "机身材质", "冷板喷塑", "0~2300", "成交金额", "600", "60"] },
          { cells: [july, "2026-07-01", "2026-07-31", "本店优势赛道", "七月赛道", "机身材质", "不锈钢", "0~2300", "成交金额", "800", "120"] }
        ]
      },
      {
        name: "赛道人群",
        columns: ["周期", "周期开始", "周期结束", "机会类型", "赛道名称", "属性维度", "属性值", "价格带", "人群维度", "特征", "数值"],
        rows: [
          { cells: [june, "2026-06-01", "2026-06-30", "高潜赛道", "六月赛道", "机身材质", "冷板喷塑", "0~2300", "年龄", "25~29岁", "70"] },
          { cells: [july, "2026-07-01", "2026-07-31", "本店优势赛道", "七月赛道", "机身材质", "不锈钢", "0~2300", "年龄", "30~34岁", "120"] }
        ]
      },
      {
        name: "赛道投放结构",
        columns: ["周期", "周期开始", "周期结束", "机会类型", "赛道名称", "属性维度", "属性值", "价格带", "口径", "推广场景", "消耗占比", "点击量", "点击量环比", "点击率", "点击率环比", "支付转化率", "支付转化率环比", "ROI", "ROI环比"],
        rows: [
          { cells: [june, "2026-06-01", "2026-06-30", "高潜赛道", "六月赛道", "机身材质", "冷板喷塑", "0~2300", "赛道", "关键词推广", "20%", "600", "1%", "3%", "0%", "2%", "0%", "5", "2%"] },
          { cells: [july, "2026-07-01", "2026-07-31", "本店优势赛道", "七月赛道", "机身材质", "不锈钢", "0~2300", "赛道", "关键词推广", "30%", "900", "5%", "4%", "1%", "3%", "1%", "6", "4%"] }
        ]
      },
      {
        name: "自然月汇总",
        columns: ["周期", "成交金额"],
        rows: [
          { cells: [june, "8000万"] },
          { cells: [july, "1.2亿"] }
        ]
      }
    ];

    const model = projectDmpMarketReport(record);
    expect(model.periods.all[0]).toMatchObject({ start: "2026-06-01", end: "2026-08-14" });
    expect(model.allCollected?.periodCount).toBe(3);
    const selected = selectDmpMarketPeriod(model, "month", "2026-07");
    expect(selected.tables.filter(isDmpMarketOpportunityWorkspaceSource).map((table) => table.name)).toEqual([
      "细分赛道矩阵",
      "货品增长机会概览",
      "货品增长机会",
      "赛道整体与本店",
      "赛道人群",
      "赛道投放结构"
    ]);
    expect(JSON.stringify(selected.tables)).not.toMatch(/六月赛道|串期材质|2026-07-15 至 2026-08-14/);
    const workspace = buildDmpMarketOpportunityWorkspace(selected.tables);
    expect(workspace).toMatchObject({
      propertyNames: ["机身材质"],
      metricLabels: ["搜索潜力(aScore)", "成交潜力(bScore)", "拉新潜力(cScore)", "蓝海指数(eScore)"],
      periods: [{
        key: "2026-07-01\u001f2026-07-31",
        label: july,
        start: "2026-07-01",
        end: "2026-07-31"
      }]
    });
    const matrix = buildDmpMarketOpportunityMatrix(workspace!, workspace!.periods[0].key, "机身材质", "搜索潜力(aScore)");
    expect(matrix?.rows[0].cells[0]).toEqual({ propertyValue: "不锈钢", value: 0 });
    const emptyGroup = workspace?.groups.find((group) => group.title === "高潜赛道");
    expect(emptyGroup).toMatchObject({ declaredTrackCount: 0, tracks: [] });
    const storeGroup = workspace?.groups.find((group) => group.title === "本店优势赛道");
    expect(storeGroup?.tracks[0]).toMatchObject({
      trackName: "七月赛道",
      overall: [{ metric: "成交金额", trackValue: "800", shopValue: "120" }],
      crowds: [{ dimension: "年龄", feature: "30~34岁", value: "120" }],
      promotions: [expect.objectContaining({ scene: "关键词推广", spendShare: "30%", roi: "6" })]
    });

    const all = selectDmpMarketPeriod(model, "all", "actual-collected");
    const allWorkspace = buildDmpMarketOpportunityWorkspace(all.tables);
    expect(allWorkspace?.periods.map((period) => period.label)).toEqual([june, july, overlap]);
    const julyTrack = allWorkspace?.groups
      .find((group) => group.periodKey === "2026-07-01\u001f2026-07-31" && group.title === "本店优势赛道")
      ?.tracks[0];
    expect(JSON.stringify(julyTrack)).not.toMatch(/六月|600|25~29岁/);
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

  it("freezes the approved period-first framework independently from visual styling", () => {
    const viewer = readFileSync("src/components/tools/DmpMarketReportViewer.tsx", "utf8");
    const viewModel = readFileSync("src/components/tools/DmpMarketReportViewModel.ts", "utf8");
    const periodSelect = viewer.match(/<select value=\{mode\}[\s\S]*?<\/select>/)?.[0] ?? "";
    const literalOptions = [...periodSelect.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)]
      .map((match) => [match[1], match[2]]);

    expect(viewModel).toContain('export type DmpMarketPeriodMode = "all" | "day" | "week" | "month";');
    expect(viewer).toMatch(/const defaultMode:[^=]+=[\s\S]*?model\.periods\.all\.length\s*\?\s*"all"/);
    expect(literalOptions).toEqual([
      ["all", "全部已采周期"],
      ["day", "自然日"],
      ["week", "自然周"],
      ["month", "自然月"]
    ]);
    expect(viewer).toContain('disabled={mode === "all"}');
    expect(viewer).toContain('mode === "all" ? "实际获取范围"');
    expect(viewer).toContain('mode === "all" ? "实际已采周期"');
    expect(viewModel).toContain('name: "全部已采周期"');
    expect(viewModel).toContain('columns: ["指标", ...periods.map((period) => period.label)]');
    expect(viewModel).toContain("const rows = metrics.map((metric) => [");

    const workspaceIndex = viewer.indexOf("{opportunityWorkspace ? (");
    const regularTableIndex = viewer.indexOf("{regularTables.map((table, tableIndex) => (");
    expect(workspaceIndex).toBeGreaterThan(-1);
    expect(regularTableIndex).toBeGreaterThan(workspaceIndex);
    expect(viewer).toContain("!isDmpMarketOpportunityWorkspaceSource(table)");
    expect(viewer).toContain('data-opportunity-workspace="true"');
    expect(viewer).toContain("workspace.propertyNames.map");
    expect(viewer).toContain("workspace.metricLabels.map");
    expect(viewer).toContain("periods.map((period) => {");
  });

  it("forces report table bodies onto the light palette instead of inheriting global black rows", () => {
    const css = readFileSync("src/components/tools/DmpMarketReportViewer.module.css", "utf8");
    const white = /background(?:-color)?:\s*#fff(?:fff)?\s*!important\s*;/i;
    const pale = /background(?:-color)?:\s*#[ef][0-9a-f]{5}\s*!important\s*;/i;
    const root = cssDeclarationsFor(css, ".root");

    expect(root).toMatch(/color-scheme:\s*light\s*!important\s*;/i);
    expectForcedLightTableRule(css, ".tableShell tbody > tr > td", white);
    expectForcedLightTableRule(css, ".tableShell tbody tr:nth-child(even) > td", pale, false);
    expectForcedLightTableRule(css, ".tableShell tbody tr:hover > td", pale, false);
    expectForcedLightTableRule(css, ".allPeriodTable tbody th", pale);
    expectForcedLightTableRule(css, ".opportunityTableShell tbody > tr > td", white);
    expectForcedLightTableRule(css, ".opportunityTableShell tbody tr:nth-child(even) > td", pale, false);
    expectForcedLightTableRule(css, ".opportunityDetailTableShell tbody > tr > td", white);
    expectForcedLightTableRule(css, ".opportunityDetailTableShell tbody tr:nth-child(even) > td", pale, false);

    for (const shell of [
      ".tableShell",
      ".opportunityTableShell",
      ".opportunityMatrixShell",
      ".opportunityDetailTableShell",
      ".trackHeatmapTable"
    ]) expectProtectedTableCells(css, shell);

    expectForcedLightTableRule(
      css,
      ".opportunityMatrixShell tbody > tr > td.opportunityMatrixCell",
      /background:\s*rgba\(13,\s*113,\s*107,\s*var\(--market-track-heat,\s*0\)\)\s*!important\s*;/i
    );
    expectForcedLightTableRule(
      css,
      '.opportunityMatrixShell tbody > tr > td.opportunityMatrixCell[data-track-state="missing"]',
      white
    );
    expectForcedLightTableRule(
      css,
      '.opportunityMatrixShell tbody > tr > td.opportunityMatrixCell[data-track-state="zero"]',
      pale
    );
    expectForcedLightTableRule(
      css,
      ".trackHeatmapTable tbody > tr > td.trackHeatCell",
      /background:\s*rgba\(var\(--market-track-blue\),\s*var\(--market-track-heat,\s*0\)\)\s*!important\s*;/i
    );
    expectForcedLightTableRule(css, ".trackHeatmapTable tbody > tr > td.trackHeatMissing", white);
    expectForcedLightTableRule(css, ".trackHeatmapTable tbody > tr > td.trackHeatZero", pale);
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
    expect(viewer).toContain("全部已采周期");
    expect(viewer).toContain("仅展示实际返回值");
    expect(viewer).toContain("dmp-market-empty-state");
    expect(viewer).toContain("data-track-matrix");
    expect(viewer).toContain('data-track-visualization="heatmap"');
    expect(viewer).toContain("data-growth-opportunity-view");
    expect(viewer).toContain("data-growth-opportunity-group");
    expect(viewer).toContain("data-opportunity-workspace");
    expect(viewer).toContain("data-consumed-tables");
    expect(viewer).toContain("!isDmpMarketOpportunityWorkspaceSource(table)");
    expect(viewer).toContain("赛道整体 vs 本店");
    expect(viewer).toContain("赛道投放结构");
    expect(viewer).toContain("0 个赛道");
    expect(viewer).toContain("货品增长机会");
    expect(viewer).toContain("按达摩盘返回的机会类型分组");
    expect(viewer).toContain("价格带 × {matrix.propertyName}");
    expect(viewer).toContain("环比为本期减上一周期的分值差");
    expect(viewer).not.toMatch(/metric-progress|track-progress|track-bar/i);
    expect(viewer).toContain("Array.from({ length: 54 }");
    expect(viewer).not.toMatch(/类目\s*ID|滚动值中位数|中位数参考|7日参考值|期间中位|分析窗口|数据窗口|对比窗口/);
    expect(workspace).not.toMatch(/类目\s*ID/);
    expect(dispatch).toContain("DmpMarketReportViewer");
    expect(css).toMatch(/\.tableShell thead th[^}]*\{[\s\S]*?color:\s*#fff\s*!important;[\s\S]*?background:\s*var\(--market-green\)\s*!important;/);
    expect(css).toMatch(/\.tableShell th,\s*\.tableShell td[^}]*vertical-align:\s*middle/);
    expect(css).toMatch(/\.tableShell tbody\s*>\s*tr\s*>\s*td\s*\{[^}]*background:\s*#fff/);
    expect(css).toMatch(/\.opportunityTableShell tbody\s*>\s*tr\s*>\s*td\s*\{[^}]*background:\s*#fff/);
    expect(css).toMatch(/\.allPeriodTable thead th:first-child,\s*\.allPeriodTable tbody th\s*\{[^}]*position:\s*sticky/);
    expect(css).toMatch(/\.root\s*\{[^}]*color-scheme:\s*light/s);
    expect(css).toMatch(/\.numeric\s*\{[^}]*text-align:\s*right\s*!important;/);
    expect(css).toMatch(/\.watermark\s*\{[^}]*z-index:\s*3;[^}]*opacity:\s*\.075;/s);
    expect(css).toMatch(/\.trackHeatmapTable\s*\{[^}]*width:\s*max-content;[^}]*min-width:\s*100%/s);
    expect(css).toMatch(/\.trackHeatmapTable thead th:first-child,\s*\.trackHeatmapTable tbody th\s*\{[^}]*position:\s*sticky;[^}]*left:\s*0/s);
    expect(css).toMatch(/\.trackHeatCell\s*\{[^}]*rgba\(var\(--market-track-blue\),\s*var\(--market-track-heat/s);
    expect(css).toMatch(/\.opportunityGroups\s*\{[^}]*display:\s*grid/s);
    expect(css).toMatch(/\.opportunityWorkspaceControls\s*\{[^}]*display:\s*grid/s);
    expect(css).toMatch(/\.opportunityMetricTabs\s*>\s*div\s*\{[^}]*grid-template-columns:\s*repeat\(4/s);
    expect(css).toMatch(/\.opportunityMatrixShell thead th[^}]*background:\s*var\(--market-green\)\s*!important/s);
    expect(css).toMatch(/\.opportunityDetailTableShell tbody\s*>\s*tr\s*>\s*td\s*\{[^}]*background:\s*#fff/s);
    expect(css).toMatch(/\.opportunityTableShell table\s*\{[^}]*min-width:\s*940px/s);
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.trackToolbar\s*\{[^}]*grid-template-columns:\s*1fr/s);
    expect(css).toMatch(/@media print[\s\S]*?\.trackHeatmapTable\s*\{[^}]*table-layout:\s*fixed/s);
    expect(`${viewer}\n${css}`).not.toMatch(/Boundary|zssl|ecbis/i);
  });
});
