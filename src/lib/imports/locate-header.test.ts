import { describe, expect, it } from "vitest";
import { locateHeaderRow } from "@/lib/imports/contracts";

describe("locateHeaderRow", () => {
  it("跳过标题/统计周期等前导行，定位真正的列表头", () => {
    const matrix = [
      ["万相台推广宝贝报表"],
      ["统计周期：2026-05-01 至 2026-05-31"],
      ["日期", "主体ID", "主体类型", "主体名称", "展现量", "点击量", "花费", "平均点击花费", "投入产出比"],
      ["2026-05-01", "123", "商品", "刀杆X", 1000, 50, 100, 2, 4.5],
      ["2026-05-02", "124", "商品", "刀杆Y", 800, 40, 80, 2, 5.0]
    ];
    const { headerIndex, headers, rows } = locateHeaderRow(matrix, "promotion_product_source");
    expect(headerIndex).toBe(2);
    expect(headers).toContain("主体ID");
    expect(rows).toHaveLength(2);
  });

  it("表头本就在第一行时正常定位", () => {
    const matrix = [
      [
        "日期",
        "场景ID",
        "场景名字",
        "计划ID",
        "计划名字",
        "人群名字",
        "主体ID",
        "主体名称",
        "点击量",
        "投入产出比",
        "引导访问潜客占比",
        "成交新客占比"
      ],
      ["2026-05-01", "s1", "拉新场景", "p1", "计划A", "新客人群", "123", "刀杆X", 50, 3.2, 0.4, 0.3]
    ];
    const { headerIndex, rows } = locateHeaderRow(matrix, "audience_source");
    expect(headerIndex).toBe(0);
    expect(rows).toHaveLength(1);
  });
});
