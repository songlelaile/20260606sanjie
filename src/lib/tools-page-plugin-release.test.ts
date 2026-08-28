import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const toolsPageSource = readFileSync(
  resolve(process.cwd(), "src/app/tools/page.tsx"),
  "utf8"
);

describe("tools page collector release contract", () => {
  it("publishes the v1.9.27 collector package metadata", () => {
    expect(toolsPageSource).toContain('version: "1.9.27"');
    expect(toolsPageSource).toContain(
      'zipHref: "/downloads/sycm-keyword-collector-v1.9.27.zip"'
    );
    expect(toolsPageSource).toContain(
      'downloadName: "少壮AI自动化-v1.9.27.zip"'
    );
    expect(toolsPageSource).toContain('sizeLabel: "约 3.6 MB"');
  });

  it("describes the fixed-layout SKU JPG download contract", () => {
    for (const releaseClaim of [
      "模型只创作无字、无商品背景",
      "字体、字号、文字位置、整体布局和商品主体位置由浏览器固定",
      "仅背景色、邻近渐变和轻背景氛围可变",
      "真实 JPG",
      "商品规格.jpg",
      "不含 SKU 编号"
    ]) {
      expect(toolsPageSource).toContain(releaseClaim);
    }
  });

  it("does not advertise removed collector modules", () => {
    for (const removedClaim of [
      "分日商品排行",
      "商品排行分日下载",
      "插件「商品排行」",
      "货盘 / 无界源表",
      "货盘、无界商品、无界人群",
      'title: "商品排行"',
      'title: "货盘"',
      'title: "无界商品"',
      'title: "无界人群"'
    ]) {
      expect(toolsPageSource).not.toContain(removedClaim);
    }
  });

  it("keeps supported market evidence and external-table import wording", () => {
    expect(toolsPageSource).toContain("市场商品榜");
    expect(toolsPageSource).toContain("Top300 商品卡");
    expect(toolsPageSource).toContain("市场排行、商品榜或竞品表");
  });
});
