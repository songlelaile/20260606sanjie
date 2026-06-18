import { describe, expect, it } from "vitest";
import { buildShengyiMergePlan } from "@/lib/imports/merge-shengyi";
import { normalizeDate } from "@/lib/imports/map-rows";

const H = ["统计日期", "商品ID", "商品名称", "支付金额", "支付买家数"];

function file(name: string, rows: unknown[][], headers = H) {
  return { name, headers, rows };
}

describe("normalizeDate 合法性", () => {
  it("识别常见写法", () => {
    expect(normalizeDate("2026-05-19")).toBe("2026-05-19");
    expect(normalizeDate("2026/5/1")).toBe("2026-05-01");
    expect(normalizeDate("20260519")).toBe("2026-05-19");
    expect(normalizeDate("2026-05-19 下午1.33")).toBe("2026-05-19");
  });
  it("拒绝非法日期", () => {
    expect(normalizeDate("2026-13-01")).toBe("");
    expect(normalizeDate("2026-05-32")).toBe("");
    expect(normalizeDate("2026-02-30")).toBe("");
    expect(normalizeDate("")).toBe("");
    expect(normalizeDate("abc")).toBe("");
  });
});

describe("buildShengyiMergePlan", () => {
  it("正常合并多日表：拼接行、识别区间、无错误", () => {
    const plan = buildShengyiMergePlan([
      file("商品_2026-05-19.xls", [["2026-05-19", "P1", "甲", "100", "5"]]),
      file("商品_2026-05-20.xls", [["2026-05-20", "P1", "甲", "200", "8"]])
    ]);
    expect(plan.report.ok).toBe(true);
    expect(plan.report.fileCount).toBe(2);
    expect(plan.report.dateStart).toBe("2026-05-19");
    expect(plan.report.dateEnd).toBe("2026-05-20");
    expect(plan.report.totalDataRows).toBe(2);
    expect(plan.mergedRows.length).toBe(2);
  });

  it("列顺序不同的文件：按表头名重排，不错列（BLOCKER 修复）", () => {
    const reordered = ["商品ID", "支付金额", "统计日期", "支付买家数", "商品名称"];
    const plan = buildShengyiMergePlan([
      file("商品_2026-05-19.xls", [["2026-05-19", "P1", "甲", "100", "5"]]), // 标准列序
      file("商品_2026-05-20.xls", [["P2", "999", "2026-05-20", "9", "乙"]], reordered) // 打乱列序
    ]);
    // 合并后所有行应与首文件列序 H 对齐
    const row2 = plan.mergedRows[1];
    expect(row2[0]).toBe("2026-05-20"); // 统计日期
    expect(row2[1]).toBe("P2"); // 商品ID
    expect(row2[2]).toBe("乙"); // 商品名称
    expect(row2[3]).toBe("999"); // 支付金额
    expect(row2[4]).toBe("9"); // 支付买家数
  });

  it("重复日期 → error 阻断", () => {
    const plan = buildShengyiMergePlan([
      file("a_2026-05-19.xls", [["2026-05-19", "P1", "甲", "100", "5"]]),
      file("b_2026-05-19.xls", [["2026-05-19", "P2", "乙", "200", "8"]])
    ]);
    expect(plan.report.ok).toBe(false);
    expect(plan.report.errors.some((e) => e.includes("重复") || e.includes("多个文件"))).toBe(true);
  });

  it("日期缺口 → warning（不阻断）", () => {
    const plan = buildShengyiMergePlan([
      file("a_2026-05-19.xls", [["2026-05-19", "P1", "甲", "100", "5"]]),
      file("c_2026-05-21.xls", [["2026-05-21", "P1", "甲", "120", "6"]])
    ]);
    expect(plan.report.ok).toBe(true);
    expect(plan.report.warnings.some((w) => w.includes("缺"))).toBe(true);
  });

  it("缺必要列 → error", () => {
    const plan = buildShengyiMergePlan([
      { name: "bad.xls", headers: ["统计日期", "商品名称"], rows: [["2026-05-19", "甲"]] }
    ]);
    expect(plan.report.ok).toBe(false);
    expect(plan.report.errors.some((e) => e.includes("缺少必要列"))).toBe(true);
  });

  it("文件名日期与内部统计日期不一致 → warning", () => {
    const plan = buildShengyiMergePlan([
      file("商品_2026-05-19.xls", [["2026-05-20", "P1", "甲", "100", "5"]])
    ]);
    expect(plan.report.warnings.some((w) => w.includes("不一致"))).toBe(true);
  });
});
