import { describe, expect, it } from "vitest";
import {
  mapDamoProductRows,
  mapProductDailyRows,
  mapProductSourceRows,
  mapPromotionDailyRows,
  mapPromotionRows,
  parseNumericCellOrNull
} from "@/lib/imports/map-rows";

describe("parseNumericCellOrNull", () => {
  it("处理数字、百分比、千分位与货币符号", () => {
    expect(parseNumericCellOrNull(0.45)).toBe(0.45);
    expect(parseNumericCellOrNull("45%")).toBeCloseTo(0.45);
    expect(parseNumericCellOrNull("1,234.5")).toBe(1234.5);
    expect(parseNumericCellOrNull("¥2,000")).toBe(2000);
    expect(parseNumericCellOrNull("")).toBeNull();
    expect(parseNumericCellOrNull("abc")).toBeNull();
  });

  it.each(["-", "--", "—", "–", "－"])("将报表占位符 %s 识别为缺失", (placeholder) => {
    expect(parseNumericCellOrNull(placeholder)).toBeNull();
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
  "搜索引导支付转化率",
  "搜索引导访客数"
];

describe("mapProductSourceRows", () => {
  it("按表头映射并跳过总计行", () => {
    const rows = [
      ["20260501", "111", "刀杆A", 1000, 2000, 30, 0.4, 50, 8000, 0.05, 200, 0.03, 320],
      ["20260501", "总计", "", 9999, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    ];
    const mapped = mapProductSourceRows(PRODUCT_HEADERS, rows);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].productId).toBe("111");
    expect(mapped[0].paymentAmount).toBe(8000);
    expect(mapped[0].refundAmount).toBe(200);
    expect(mapped[0].searchGuidedVisitors).toBe(320);
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

describe("safe structural repair", () => {
  it("isolates a row with a missing product ID instead of generating a fake ID", () => {
    const mapped = mapProductDailyRows(
      PRODUCT_HEADERS,
      [["无法识别", "", "刀杆A", 10, 20, 5, 0.4, 3, 100, 0.05, "无数据", 0.03, 8]],
      "2026-08-04"
    );

    expect(mapped).toHaveLength(0);
  });

  it("uses canonical column positions when required header text is missing", () => {
    const headers = [...PRODUCT_HEADERS];
    headers[1] = "";
    const mapped = mapProductDailyRows(
      headers,
      [["2026-08-04", "P-100", "刀杆A", 10, 20, 5, 0.4, 3, 100, 0.05, 0, 0.03, 8]]
    );

    expect(mapped[0].productId).toBe("P-100");
  });

  it("isolates a promotion row without a stable subject ID", () => {
    const mapped = mapPromotionDailyRows(
      ["日期", "主体ID", "主体类型", "主体名称", "展现量", "点击量", "花费", "平均点击花费", "投入产出比"],
      [["-", "", "商品", "X", 100, 10, 20, 2, "未投放"]],
      "2026-08-04"
    );

    expect(mapped).toHaveLength(0);
  });

  it("uses an unambiguous file date but keeps an unknown metric as null", () => {
    const mapped = mapProductDailyRows(
      PRODUCT_HEADERS,
      [["无法识别", "P-100", "刀杆A", 10, 20, 5, 0.4, 3, 100, 0.05, "无数据", 0.03, 8]],
      "2026-08-04"
    );
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({ productId: "P-100", date: "2026-08-04", refundAmount: null });
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

  it("缺失的率不进入该率的加权分母", () => {
    const [merged] = mapDamoProductRows(DAMO_HEADERS, [
      ["111", "甲", "成长期", "20260501", 5000, 1200, 300, 4.5, "-", 0.12, 0.03, 100, 0.2, 3],
      ["111", "甲", "爆品期", "20260502", 5000, 1200, 300, 4.5, 0.1, 0.12, 0.03, 100, 0.2, 3]
    ]);

    expect(merged.paymentConversionRate).toBeCloseTo(0.1, 6);
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
