import { describe, expect, it } from "vitest";
import { parseWorkbookUpload } from "@/lib/imports/parse-workbook";

function csvFile(name: string, content: string) {
  return new File([content], name, { type: "text/csv" });
}

describe("parseWorkbookUpload", () => {
  it("拒绝非白名单文件类型", async () => {
    await expect(parseWorkbookUpload(new File(["x"], "data.txt"))).rejects.toThrow(
      "不支持的文件类型"
    );
  });

  it("解析 CSV 为完整 matrix（保留表头行供下游定位）", async () => {
    const parsed = await parseWorkbookUpload(csvFile("ok.csv", "宝贝ID,名称\n111,甲\n222,乙\n"));
    expect(parsed.matrix[0]).toEqual(["宝贝ID", "名称"]);
    expect(parsed.matrix).toHaveLength(3);
    expect(parsed.warnings).toEqual([]);
  });

  it("正确处理引号内逗号与双引号转义", async () => {
    const parsed = await parseWorkbookUpload(csvFile("q.csv", 'a,b\n"x,y","z""z"\n'));
    expect(parsed.matrix[1]).toEqual(["x,y", 'z"z']);
    expect(parsed.warnings).toEqual([]);
  });

  it("检测未闭合引号并给出警告（修复静默丢数据）", async () => {
    const parsed = await parseWorkbookUpload(csvFile("bad.csv", "a,b\n\"未闭合,2\n"));
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.warnings[0]).toContain("未闭合");
  });

  it("解析网页表格伪装的 .xls（淘系导出常见格式）", async () => {
    const html =
      "<table><tr><td>宝贝ID</td><td>名称</td></tr><tr><td>683675345916</td><td>刀杆甲</td></tr></table>";
    const file = new File([html], "damo.xls", { type: "application/vnd.ms-excel" });
    const parsed = await parseWorkbookUpload(file);
    expect(parsed.matrix[0]).toEqual(["宝贝ID", "名称"]);
    expect(String(parsed.matrix[1][0])).toBe("683675345916");
    expect(parsed.matrix[1][1]).toBe("刀杆甲");
  });

  it("自动识别并解码 GBK 编码的 CSV（万相台/生意参谋导出常见）", async () => {
    // GBK 字节流："宝贝ID\n111\n"（宝=B1A6 贝=B1B4）
    const gbkBytes = new Uint8Array([
      0xb1, 0xa6, 0xb1, 0xb4, 0x49, 0x44, 0x0a, 0x31, 0x31, 0x31, 0x0a
    ]);
    const file = new File([gbkBytes], "gbk.csv", { type: "text/csv" });
    const parsed = await parseWorkbookUpload(file);
    expect(parsed.matrix[0]).toEqual(["宝贝ID"]);
    expect(parsed.matrix[1]).toEqual(["111"]);
  });
});
