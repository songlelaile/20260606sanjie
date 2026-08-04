import { describe, expect, it } from "vitest";
import {
  mapAudienceDailyRows,
  mapDamoProductRows,
  mapProductDailyRows,
  mapProductSourceRows,
  mapPromotionDailyRows,
  mapPromotionRows,
  parseNumericCell
} from "@/lib/imports/map-rows";
import { validateImportRows } from "@/lib/imports/contracts";

describe("parseNumericCell", () => {
  it("处理数字、百分比、千分位与货币符号", () => {
    expect(parseNumericCell(0.45)).toBe(0.45);
    expect(parseNumericCell("45%")).toBeCloseTo(0.45);
    expect(parseNumericCell("1,234.5")).toBe(1234.5);
    expect(parseNumericCell("¥2,000")).toBe(2000);
    expect(parseNumericCell("")).toBe(0);
    expect(parseNumericCell("abc")).toBe(0);
  });

  it("把「无数据」占位符一律判为 0（源表常见 - / — / N/A / 无）", () => {
    // 淘系报表在某指标当日无数据时会打占位符，不能因此让整行校验失败或算出 NaN。
    expect(parseNumericCell("-")).toBe(0); // 半角连字符
    expect(parseNumericCell("－")).toBe(0); // 全角减号
    expect(parseNumericCell("—")).toBe(0); // 破折号
    expect(parseNumericCell("–")).toBe(0); // 连接号
    expect(parseNumericCell("--")).toBe(0);
    expect(parseNumericCell("---")).toBe(0);
    expect(parseNumericCell(" - ")).toBe(0); // 带空白
    expect(parseNumericCell("/")).toBe(0);
    expect(parseNumericCell("N/A")).toBe(0);
    expect(parseNumericCell("n/a")).toBe(0);
    expect(parseNumericCell("无")).toBe(0);
    expect(parseNumericCell("null")).toBe(0);
    // 负数不能被误判为占位符
    expect(parseNumericCell("-12.5")).toBe(-12.5);
    expect(parseNumericCell("-3%")).toBeCloseTo(-0.03);
  });
});

const PRODUCT_HEADERS = [
  "统计日期",
  "商品ID",
  "商品名称",
  "商品访客数",
  "商品浏览量",
  "平均停留时长",
  "商品详情页跳出率",
  "支付买家数",
  "支付金额",
  "商品支付转化率",
  "成功退款金额",
  "搜索引导支付转化率"
];

describe("mapProductSourceRows", () => {
  it("按表头映射并跳过总计行", () => {
    const rows = [
      ["20260501", "111", "刀杆A", 1000, 2000, 30, 0.4, 50, 8000, 0.05, 200, 0.03],
      ["20260501", "总计", "", 9999, 0, 0, 0, 0, 0, 0, 0, 0]
    ];
    const mapped = mapProductSourceRows(PRODUCT_HEADERS, rows);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].productId).toBe("111");
    expect(mapped[0].paymentAmount).toBe(8000);
    expect(mapped[0].refundAmount).toBe(200);
  });

  it("列顺序打乱也能按表头名正确映射", () => {
    const shuffled = ["商品ID", "支付金额", "商品名称", "成功退款金额"];
    const mapped = mapProductSourceRows(shuffled, [["222", "5000", "刀杆B", "100"]]);
    expect(mapped[0].productId).toBe("222");
    expect(mapped[0].productName).toBe("刀杆B");
    expect(mapped[0].paymentAmount).toBe(5000);
    expect(mapped[0].refundAmount).toBe(100);
  });
});

const DAMO_HEADERS = [
  "宝贝ID",
  "宝贝名称",
  "货品成长阶段",
  "日期",
  "支付金额",
  "IPV",
  "营销推广消耗",
  "营销推广ROI",
  "支付转化率",
  "复购率",
  "免费搜索点击率",
  "笔单价",
  "连带购买率",
  "连带购买叶子类目宽度"
];

describe("mapDamoProductRows", () => {
  it("保留合法生命周期", () => {
    const mapped = mapDamoProductRows(DAMO_HEADERS, [
      ["111", "甲", "爆品期", "20260501", 5000, 1200, 300, 4.5, 0.08, 0.12, 0.03, 100, 0.2, 3]
    ]);
    expect(mapped[0].growthStage).toBe("爆品期");
    expect(mapped[0].marketingSpend).toBe(300);
  });

  it("非法生命周期回退冷启期", () => {
    const mapped = mapDamoProductRows(DAMO_HEADERS, [
      ["111", "甲", "乱写阶段", "20260501", 5000, 1200, 300, 4.5, 0.08, 0.12, 0.03, 100, 0.2, 3]
    ]);
    expect(mapped[0].growthStage).toBe("冷启期");
  });

  it("合并跨日期的重复宝贝：量级求和、ROI按消耗加权、其余率按订单数加权、阶段取最新日期", () => {
    // 订单数=支付金额/笔单价：行1=5000/100=50，行2=8000/200=40，Σ=90
    const merged = mapDamoProductRows(DAMO_HEADERS, [
      ["111", "甲", "成长期", "20260501", 5000, 1200, 300, 4.5, 0.08, 0.12, 0.03, 100, 0.2, 3],
      ["111", "甲", "爆品期", "20260502", 8000, 2000, 500, 6.0, 0.1, 0.15, 0.05, 200, 0.25, 4]
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].paymentAmount).toBe(13000); // 求和
    expect(merged[0].ipv).toBe(3200); // 求和
    expect(merged[0].marketingSpend).toBe(800); // 求和
    expect(merged[0].marketingRoi).toBeCloseTo(5.4375, 4); // Σ(ROI×消耗)/Σ消耗 = (4.5*300+6*500)/800
    expect(merged[0].repurchaseRate).toBeCloseTo(12 / 90, 6); // Σ(率×订单)/Σ订单 = (0.12*50+0.15*40)/90
    expect(merged[0].paymentConversionRate).toBeCloseTo(8 / 90, 6); // (0.08*50+0.1*40)/90
    expect(merged[0].attachCategoryWidth).toBeCloseTo(310 / 90, 6); // (3*50+4*40)/90
    expect(merged[0].growthStage).toBe("爆品期"); // 取最新日期 20260502 那行
  });
});

describe("mapPromotionRows 合并多推广计划", () => {
  const PROMO_HEADERS = [
    "日期",
    "主体ID",
    "主体类型",
    "主体名称",
    "展现量",
    "点击量",
    "花费",
    "平均点击花费",
    "投入产出比"
  ];

  it("展现/点击/花费求和；点击率、平均点击花费、ROI 按公式重算（ROI 花费加权）", () => {
    const merged = mapPromotionRows(PROMO_HEADERS, [
      ["2026-05-01", "123", "商品", "X", 1000, 50, 100, 2, 4.0],
      ["2026-05-02", "123", "商品", "X", 2000, 150, 300, 2, 6.0]
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].impressions).toBe(3000); // 1000+2000
    expect(merged[0].clicks).toBe(200); // 50+150
    expect(merged[0].cost).toBe(400); // 100+300
    expect(merged[0].averageClickCost).toBe(2); // 400/200
    expect(merged[0].roi).toBeCloseTo(5.5, 5); // (4×100+6×300)/400 花费加权
    expect(merged[0].ctr).toBeCloseTo(200 / 3000, 5); // Σ点击/Σ展现
  });
});

describe("源表出现「-」占位符：不该拦截校验，也不该产生幽灵主体", () => {
  const PRODUCT_DAILY_HEADERS = [
    "统计日期",
    "商品ID",
    "商品名称",
    "商品访客数",
    "商品浏览量",
    "平均停留时长",
    "商品详情页跳出率",
    "支付买家数",
    "支付金额",
    "商品支付转化率",
    "成功退款金额",
    "搜索引导支付转化率",
    "搜索引导访客数"
  ];

  it("商品源：整行指标全是「-」→ 校验通过、映射为 0、正常参与计算（不再被排除）", () => {
    const rows = [
      ["2026-05-01", "111", "刀A", "-", "-", "-", "-", "-", "-", "-", "-", "-", "-"]
    ];
    const validation = validateImportRows("product_source", PRODUCT_DAILY_HEADERS, rows);
    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);

    const mapped = mapProductDailyRows(PRODUCT_DAILY_HEADERS, rows);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].productId).toBe("111");
    expect(mapped[0].visitors).toBe(0);
    expect(mapped[0].paymentAmount).toBe(0);
    expect(mapped[0].averageStaySeconds).toBe(0);
    expect(mapped[0].bounceRate).toBe(0);
    expect(Number.isFinite(mapped[0].productPaymentConversionRate)).toBe(true);
  });

  it("商品源：部分指标「-」、部分有值 → 有值保留、「-」记 0", () => {
    const rows = [
      ["2026-05-01", "111", "刀A", 4539, 10312, "-", "-", 473, 54306.24, "-", "-", "-", "-"]
    ];
    const mapped = mapProductDailyRows(PRODUCT_DAILY_HEADERS, rows);
    expect(mapped[0].visitors).toBe(4539);
    expect(mapped[0].paymentAmount).toBe(54306.24);
    expect(mapped[0].paymentBuyers).toBe(473);
    expect(mapped[0].averageStaySeconds).toBe(0);
    expect(mapped[0].refundAmount).toBe(0);
  });

  it("商品源：主键「商品ID」为「-」的汇总行被丢弃，不生成幽灵主体", () => {
    const rows = [
      ["2026-05-01", "111", "刀A", 100, 200, 30, 0.4, 5, 8000, 0.05, 100, 0.03, 50],
      ["2026-05-01", "-", "汇总", 999, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    ];
    const mapped = mapProductDailyRows(PRODUCT_DAILY_HEADERS, rows);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].productId).toBe("111");

    // 校验层同样不把「-」当成一个主体（不误报重复主键、主体数计正确）
    const validation = validateImportRows("product_source", PRODUCT_DAILY_HEADERS, rows);
    expect(validation.uniqueEntityCount).toBe(1);
    expect(validation.duplicateEntityIds).not.toContain("-");
  });

  it("推广源：指标「-」→ 映射为 0，校验通过", () => {
    const PROMO_HEADERS = [
      "日期", "主体ID", "主体类型", "主体名称", "展现量", "点击量", "花费", "平均点击花费", "投入产出比"
    ];
    const rows = [["2026-05-01", "222", "商品", "推X", "-", "-", "-", "-", "-"]];
    expect(validateImportRows("promotion_product_source", PROMO_HEADERS, rows).ok).toBe(true);
    const mapped = mapPromotionDailyRows(PROMO_HEADERS, rows);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].cost).toBe(0);
    expect(mapped[0].clicks).toBe(0);
    expect(mapped[0].roi).toBe(0);
  });

  it("人群源：指标「-」→ 映射为 0，校验通过", () => {
    const AUD_HEADERS = [
      "日期", "场景ID", "场景名字", "计划ID", "计划名字", "人群名字", "主体ID", "主体名称",
      "点击量", "投入产出比", "引导访问潜客占比", "成交新客占比"
    ];
    const rows = [["2026-05-01", "s1", "场景", "p1", "计划A", "人群甲", "333", "主体X", "-", "-", "-", "-"]];
    expect(validateImportRows("audience_source", AUD_HEADERS, rows).ok).toBe(true);
    const mapped = mapAudienceDailyRows(AUD_HEADERS, rows);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].clicks).toBe(0);
    expect(mapped[0].roi).toBe(0);
  });

  it("达摩盘源：指标「-」→ 映射为 0，阶段回落冷启期", () => {
    const DAMO_HEADERS = [
      "宝贝ID", "宝贝名称", "货品成长阶段", "日期", "支付金额", "IPV", "营销推广消耗",
      "营销推广ROI", "支付转化率", "复购率", "免费搜索点击率", "笔单价", "连带购买率", "连带购买叶子类目宽度"
    ];
    const rows = [["444", "甲", "-", "2026-05-01", "-", "-", "-", "-", "-", "-", "-", "-", "-", "-"]];
    const mapped = mapDamoProductRows(DAMO_HEADERS, rows);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].paymentAmount).toBe(0);
    expect(mapped[0].marketingSpend).toBe(0);
    expect(mapped[0].growthStage).toBe("冷启期");
  });
});
