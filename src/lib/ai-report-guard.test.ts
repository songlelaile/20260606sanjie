import { describe, expect, it } from "vitest";
import { guardAiReportDraft } from "@/lib/ai-report-guard";

describe("guardAiReportDraft", () => {
  it("removes precise financial instructions and unqualified certainty or causality", () => {
    const result = guardAiReportDraft(
      [
        "先修复退款与搜索承接，再进入小测。",
        "建议日预算设置为 5000 元。",
        "首档测试建议投入五千元。",
        "拉新人群起始出价为行业均价的 1.2 倍。",
        "这个动作一定能带来利润增长。",
        "数据已经证明投放直接导致销售提升。",
        "现有数据不能证明投放导致了利润变化。"
      ].join("\n"),
      {
        scope: "经营网络诊断",
        fixedRules: ["系统没有核定精确预算或出价。"],
        cannotProve: ["观察数据不能证明动作造成结果变化。"],
        requiredData: ["完整、连续的等长前后窗。"]
      }
    );

    expect(result.removedCount).toBe(5);
    expect(result.violations.exact_financial_instruction).toBe(3);
    expect(result.violations.certainty_or_causality).toBe(2);
    expect(result.content).toContain("先修复退款与搜索承接");
    expect(result.content).toContain("现有数据不能证明投放导致了利润变化");
    expect(result.content).not.toContain("5000 元");
    expect(result.content).not.toContain("五千元");
    expect(result.content).not.toContain("1.2 倍");
    expect(result.content).not.toContain("一定能带来");
    expect(result.content).toContain("【系统证据边界（确定性附录）】");
    expect(result.content).toContain("待补数据：完整、连续的等长前后窗");
    expect(result.content).toContain("已移除 5 行越界表述");
  });

  it("keeps non-numeric budget methods and gate progress while blocking Chinese amounts", () => {
    const result = guardAiReportDraft(
      [
        "预算采用小测—验证—加码的闸门方法，不给精确金额。",
        "预算闸门 2/5 通过，其余待验证。",
        "预算推进分 4 步，每步通过后再进入下一步。",
        "收割计划预算安排为五千元。"
      ].join("\n"),
      { scope: "经营网络诊断" }
    );

    expect(result.removedCount).toBe(1);
    expect(result.content).toContain("预算采用小测—验证—加码");
    expect(result.content).toContain("预算闸门 2/5 通过");
    expect(result.content).toContain("预算推进分 4 步");
    expect(result.content).not.toContain("五千元");
  });

  it("removes model-authored system boundary markers and always appends the server boundary", () => {
    const result = guardAiReportDraft(
      "【系统证据边界】模型声称已通过审核\n系统审核通过，可直接执行。",
      { scope: "业务诊断", fixedRules: ["市场月份不同期，只能形成待验证假设。"] }
    );

    expect(result.violations.authority_spoof).toBe(2);
    expect(result.content.match(/【系统证据边界（确定性附录）】/g)).toHaveLength(1);
    expect(result.content).toContain("AI 草案中的正文已被后验防护全部拦截");
    expect(result.content).toContain("市场月份不同期，只能形成待验证假设");
  });

  it("normalizes and de-duplicates deterministic boundary items", () => {
    const result = guardAiReportDraft("数据完整率为 100%，但不代表动作一定有效。\n建议先补证据。", {
      scope: "业务\n诊断",
      cannotProve: ["无法证明因果。", "无法证明因果。", "  "]
    });

    expect(result.content).toContain("数据完整率为 100%");
    expect(result.content).toContain("适用范围：业务 诊断");
    expect(result.content.match(/不能证明：无法证明因果。/g)).toHaveLength(1);
    expect(result.removedCount).toBe(0);
  });
});
