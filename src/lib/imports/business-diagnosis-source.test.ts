import { describe, expect, it } from "vitest";
import {
  mergeBusinessDiagnosisUploads,
  parseBusinessDiagnosisUpload,
  validateBusinessDiagnosisSourcePatch
} from "@/lib/imports/business-diagnosis-source";

describe("business diagnosis source import", () => {
  it("recognizes and parses store category monthly tables", () => {
    const matrix = [
      ["数据说明"],
      [
        "统计日期",
        "一级类目名称",
        "二级类目名称",
        "类目名称",
        "商品访客数",
        "商品浏览量",
        "有访客商品数",
        "有支付商品数",
        "商品加购人数",
        "商品加购件数",
        "商品收藏人数",
        "访问收藏转化率",
        "访问加购转化率",
        "下单买家数",
        "下单件数",
        "下单金额",
        "下单转化率",
        "支付买家数",
        "支付件数",
        "支付金额",
        "支付金额占比",
        "支付转化率",
        "月累计支付金额",
        "年累计支付金额",
        "聚划算支付金额",
        "支付新买家数",
        "支付老买家数",
        "老买家支付金额",
        "客单价",
        "访客平均价值",
        "售中售后成功退款金额"
      ],
      [
        "2025-12-31",
        "大家电",
        "厨房大电",
        "油烟机",
        "65,015",
        "165,141",
        "9",
        "8",
        "2,422",
        "3,588",
        "580",
        "0.89%",
        "3.73%",
        "1,479",
        "2,438",
        "902,446.23",
        "2.27%",
        "1,321",
        "2,148",
        "826,032.10",
        "70.9%",
        "2.03%",
        "826,032.10",
        "9,800,000",
        "0",
        "850",
        "471",
        "210,000",
        "625.31",
        "12.70",
        "31,000"
      ]
    ];
    const parsed = parseBusinessDiagnosisUpload("品类-标准类目-2025-12-31.xls", matrix);

    expect(parsed.kind).toBe("store_category");
    expect(parsed.errors).toEqual([]);
    expect(parsed.storeCategoryRows?.[0]).toMatchObject({
      month: "2025-12",
      categoryName: "油烟机",
      paymentAmount: 826032.1,
      paymentConversionRate: 0.0203
    });
  });

  it("recognizes and parses market overview tables", () => {
    const matrix = [
      ["市场概况", "", "", "", "", "", "", "", "", "", "", "", "价格带分析", "", "", "", "", "卖点分析", "", "", "", "", "", "搜索词分类洞察"],
      [
        "时间",
        "销售额占比",
        "销售额同比",
        "销售量占比",
        "销售量同比",
        "成交人数",
        "同比",
        "件单价",
        "同比",
        "供给指数",
        "同比",
        "",
        "价格带",
        "市场占比",
        "同比",
        "供给指数",
        "",
        "属性",
        "属性值",
        "销售额指数",
        "同比",
        "供给指数",
        "",
        "搜索词分类",
        "搜索UV",
        "搜索uv平均增长率",
        "搜索点击率",
        "搜索成交率"
      ],
      [
        202605,
        0.3659,
        "[-5%-0%)",
        0.1538,
        "[-25%--20%)",
        "[100万-250万)",
        "[-5%-0%)",
        2406.91,
        0.2,
        40591,
        -0.18,
        "",
        "2843-3981",
        0.14129324475032626,
        -0.19,
        12121,
        "",
        "空调冷暖方式",
        "冷暖",
        7533997692.88,
        -0.05,
        "",
        "",
        "品类",
        11889451,
        0.9629924981826208,
        0.623921407304677,
        0.04425544964187161
      ]
    ];
    const parsed = parseBusinessDiagnosisUpload("市场大盘数据.xlsx", matrix);

    expect(parsed.kind).toBe("market_overview");
    expect(parsed.market?.overview[0]).toMatchObject({
      month: "2026-05",
      salesShare: 0.3659,
      salesYoY: -0.025
    });
    expect(parsed.market?.searchSignals[0].category).toBe("品类");
  });

  it("merges duplicate store rows by month and category", () => {
    const first = parseBusinessDiagnosisUpload("a.xls", [
      [...minimumStoreHeaders()],
      ["2025-12-31", "大家电", "厨房大电", "油烟机", 10, 100, "1%", 0, 10, 10, 1, 1]
    ]);
    const second = parseBusinessDiagnosisUpload("b.xls", [
      [...minimumStoreHeaders()],
      ["2025-12-31", "大家电", "厨房大电", "油烟机", 12, 120, "1.2%", 0, 10, 10, 1, 1]
    ]);
    const { patch, report } = mergeBusinessDiagnosisUploads([first, second]);

    expect(report.ok).toBe(true);
    expect(report.storeRowCount).toBe(1);
    expect(patch.storeCategoryRows?.[0].paymentAmount).toBe(120);
  });

  it("imports a partial diagnostic table with missing metrics as null", () => {
    const parsed = parseBusinessDiagnosisUpload("缺核心列.xls", [
      ["统计日期", "一级类目名称", "二级类目名称", "类目名称", "商品访客数"],
      ["2025-12-31", "大家电", "厨房大电", "油烟机", 10]
    ]);

    expect(parsed.kind).toBe("store_category");
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings.join(" ")).toContain("支付金额");
    expect(parsed.warnings.join(" ")).toContain("支付转化率");
    expect(parsed.storeCategoryRows?.[0]).toMatchObject({ visitors: 10, paymentAmount: null });
    expect(mergeBusinessDiagnosisUploads([parsed]).report.ok).toBe(true);
  });

  it.each(["-", "--", "—", "–", "－", "N/A"])(
    "imports placeholder %s as missing evidence rather than zero",
    (placeholder) => {
      const parsed = parseBusinessDiagnosisUpload(`占位符${placeholder}.xls`, [
        [...minimumStoreHeaders()],
        ["2025-12-31", "大家电", "厨房大电", "油烟机", 10, placeholder, "1%", 0, 10, 10, 1, 1]
      ]);

      expect(parsed.errors).toEqual([]);
      expect(parsed.warnings.join(" ")).toContain("支付金额缺失");
      expect(parsed.storeCategoryRows?.[0].paymentAmount).toBeNull();
    }
  );

  it.each([
    { field: "商品访客数", visitors: "", payment: 100, conversion: "1%" },
    { field: "支付金额", visitors: 10, payment: "not-a-number", conversion: "1%" },
    { field: "支付转化率", visitors: 10, payment: 100, conversion: "unknown" }
  ])("isolates an invalid core numeric cell $field as null without rejecting the row", ({ field, visitors, payment, conversion }) => {
    const parsed = parseBusinessDiagnosisUpload(`空${field}.xls`, [
      [...minimumStoreHeaders()],
      ["2025-12-31", "大家电", "厨房大电", "油烟机", visitors, payment, conversion, 0, 10, 10, 1, 1]
    ]);

    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings.join(" ")).toContain(`${field}缺失或不是有效数值`);
    const value = field === "商品访客数"
      ? parsed.storeCategoryRows?.[0].visitors
      : field === "支付金额"
        ? parsed.storeCategoryRows?.[0].paymentAmount
        : parsed.storeCategoryRows?.[0].paymentConversionRate;
    expect(value).toBeNull();
  });

  it("imports a missing refund field as null instead of diagnosing a zero refund rate", () => {
    const headers = minimumStoreHeaders().filter((header) => header !== "售中售后成功退款金额");
    const parsed = parseBusinessDiagnosisUpload("缺退款.xls", [
      headers,
      ["2025-12-31", "大家电", "厨房大电", "油烟机", 10, 100, "1%", 10, 10, 1, 1]
    ]);

    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings.join(" ")).toContain("售中售后成功退款金额");
    expect(parsed.storeCategoryRows?.[0].refundAmount).toBeNull();
  });

  it("rejects malformed API DTOs before they can be persisted", () => {
    expect(validateBusinessDiagnosisSourcePatch({
      market: { overview: [] }
    }).join(" ")).toContain("priceBands");

    const parsed = parseBusinessDiagnosisUpload("valid.xls", [
      [...minimumStoreHeaders()],
      ["2025-12-31", "大家电", "厨房大电", "油烟机", 10, 100, "1%", 0, 10, 10, 1, 1]
    ]);
    const invalidRows = structuredClone(parsed.storeCategoryRows!);
    invalidRows[0].paymentAmount = Number.POSITIVE_INFINITY;
    expect(validateBusinessDiagnosisSourcePatch({ storeCategoryRows: invalidRows }).join(" ")).toContain("paymentAmount");
  });
});

function minimumStoreHeaders() {
  return [
    "统计日期",
    "一级类目名称",
    "二级类目名称",
    "类目名称",
    "商品访客数",
    "支付金额",
    "支付转化率",
    "售中售后成功退款金额",
    "客单价",
    "访客平均价值",
    "有访客商品数",
    "有支付商品数"
  ];
}
