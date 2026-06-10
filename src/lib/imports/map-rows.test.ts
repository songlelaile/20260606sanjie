import { describe, expect, it } from "vitest";
import {
  mapDamoProductRows,
  mapProductSourceRows,
  mapPromotionRows,
  parseNumericCell
} from "@/lib/imports/map-rows";

describe("parseNumericCell", () => {
  it("处理数字、百分比、千分位与货币符号", () => {
    expect(parseNumericCell(0.45)).toBe(0.45);
    expect(parseNumericCell("45%")).toBeCloseTo(0.45);
    expect(parseNumericCell("1,234.5")).toBe(1234.5);
    expect(parseNumericCell("¥2,000")).toBe(2000);
    expect(parseNumericCell("")).toBe(0);
    expect(parseNumericCell("abc")).toBe(0);
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
  "支付金额",
  "IPV",
  "营销推广消耗",
  "营销推广ROI",
  "支付转化率",
  "复购率",
  "免费搜索点击率",
  "连带购买率",
  "连带购买叶子类目宽度"
];

describe("mapDamoProductRows", () => {
  it("保留合法生命周期", () => {
    const mapped = mapDamoProductRows(DAMO_HEADERS, [
      ["111", "甲", "爆品期", 5000, 1200, 300, 4.5, 0.08, 0.12, 0.03, 0.2, 3]
    ]);
    expect(mapped[0].growthStage).toBe("爆品期");
    expect(mapped[0].marketingSpend).toBe(300);
  });

  it("非法生命周期回退冷启期", () => {
    const mapped = mapDamoProductRows(DAMO_HEADERS, [
      ["111", "甲", "乱写阶段", 5000, 1200, 300, 4.5, 0.08, 0.12, 0.03, 0.2, 3]
    ]);
    expect(mapped[0].growthStage).toBe("冷启期");
  });

  it("合并跨成长阶段的重复宝贝：数量求和、比率取最高、阶段取最靠后", () => {
    const merged = mapDamoProductRows(DAMO_HEADERS, [
      ["111", "甲", "成长期", 5000, 1200, 300, 4.5, 0.08, 0.12, 0.03, 0.2, 3],
      ["111", "甲", "爆品期", 8000, 2000, 500, 6.0, 0.1, 0.15, 0.05, 0.25, 4]
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].paymentAmount).toBe(13000); // 5000+8000 求和
    expect(merged[0].ipv).toBe(3200); // 1200+2000 求和
    expect(merged[0].marketingSpend).toBe(800); // 300+500 求和
    expect(merged[0].marketingRoi).toBe(6); // max(4.5,6) 取最高
    expect(merged[0].repurchaseRate).toBe(0.15); // max(0.12,0.15)
    expect(merged[0].attachCategoryWidth).toBe(4); // max(3,4)
    expect(merged[0].growthStage).toBe("爆品期"); // 取最靠后
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
