import { describe, expect, it } from "vitest";
import {
  deriveShopView,
  detectShopLayout,
  formatShopAmount,
  formatShopAmountCompact,
  parseShopDisplay,
  shopBadgeForPrecision,
  type DmpViewerTable
} from "@/components/tools/DmpGrowthReportViewModel";

// v2.3.103 (R14) 店铺视角七区块：派生契约的单元测试。
// 夹具数值取自真实记录 cmu50lqal00g7fzpqwha44irr（design/report-record-B-2301.json）的
// canonical 单元格；测试本身不读取该文件，保证在应用内可独立运行。

const COMPARE_COLUMNS = ["模块", "归因范围", "渠道 / 客群", "指标", "本店本期", "本店上期", "本店变化", "竞店1本期", "竞店1上期", "竞店1变化", "本店精度", "竞店1精度", "本店相对竞店1"];

function row(module: string, attribution: string, channel: string, metric: string, values: string[]): string[] {
  return [module, attribution, channel, metric, ...values];
}

function table(name: string, columns: string[], rows: string[][]): DmpViewerTable {
  return { name, columns, rows };
}

function fixtures(): DmpViewerTable[] {
  const overview = table("报告总览", ["对象", "店铺 ID", "店铺名称", "本期开始", "本期结束", "上期开始", "上期结束", "归因范围"], [
    ["本店", "473356596", "惠厨好太太旗舰店", "2026-08-18", "2026-09-16", "2026-07-19", "2026-08-17", ""],
    ["竞店1", "489118152", "志高厨卫旗舰店", "2026-08-18", "2026-09-16", "2026-07-19", "2026-08-17", ""],
    ["数据说明", "", "本店样本费比推算消耗 70,806.52 与平台广告消耗 约29,893.99 不闭合。", "", "", "", "", ""]
  ]);
  const summary = table("周期汇总", COMPARE_COLUMNS, [
    row("推广表现", "平台推广口径", "", "广告消耗（元）", ["约29,893.99", "约45,718.26", "约-34.61%", "约902,359.66～1,804,719.34", "", "样本加权约值", "公式", "样本加权约值", "约-98.35%～-96.68%"]),
    row("推广表现", "平台推广口径", "", "样本费比", ["14.64%", "", "1 个消耗精确样本", "6.69%", "", "10 个消耗精确样本", "公式", "公式", "+118.83%"]),
    row("经营表现", "整体经营", "", "整体成交笔数", ["1005", "956", "5%", "约44,720", "约40,418", "约10.64%", "平台精确", "公式", "约-97.75%"]),
    row("经营表现", "整体经营", "", "成交金额（元）", ["483,812.28", "", "样本加权约值", "约13,489,235.83～26,978,471.68", "", "样本加权约值", "样本加权约值", "样本加权约值", "约-98.21%～-96.41%"]),
    row("经营表现", "整体经营", "", "样本加权笔单价（元）", ["481.41", "", "2 个精确样本订单加权", "539.57", "", "10 个精确样本订单加权", "公式", "公式", "-10.78%"]),
    row("经营表现", "整体经营", "", "样本覆盖率", ["71.94%", "", "样本笔数 723 / 店铺成交笔数 1005", "75.62%～100.00%", "", "样本笔数 37814", "公式", "公式", "约-28.07%～-4.86%"])
  ]);
  const promotion = table("店铺竞争态势·推广表现", COMPARE_COLUMNS, [
    row("推广表现", "平台推广口径", "", "付费点击量", ["16683", "18626", "-10%", "75万~100万", "50万~75万", "+10%~20%", "平台精确", "平台区间", "约-98.34%～-97.77%"]),
    row("推广表现", "平台推广口径", "", "当天引导ROI", ["4.2511555", "2.7873983", "约52.51%", "比本店高", "比本店高", "-10%~-5%", "平台精确", "方向值", ""])
  ]);
  const operation = table("店铺竞争态势·经营表现", COMPARE_COLUMNS, [
    row("经营表现", "整体经营", "", "整体成交转化率", ["1.109737%", "1.031618%", "8%", "1%~2.5%", "1%~2.5%", "+0%~10%", "平台精确", "平台区间", "约-55.62%～+10.98%"]),
    row("经营表现", "整体经营", "", "新客成交金额占比", ["68%", "66%", "3%", "85%~90%", "80%~85%", "+0%~10%", "平台精确", "平台区间", "约-24.45%～-19.99%"]),
    row("经营表现", "整体经营", "", "整体IPV", ["90562", "92670", "-2%", "约3,517,429", "约3,215,427", "约9.39%", "平台精确", "公式", "约-97.43%"])
  ]);
  const structure = table("店铺竞争态势·投放结构", COMPARE_COLUMNS, [
    row("投放结构", "投放结构", "全站推广", "投放成本占比", ["100%", "100%", "", "70.3883%", "56.0976%", "", "平台精确", "平台精确", "+42.07%"]),
    row("投放结构", "投放结构", "关键词推广", "投放成本占比", ["", "", "", "21.8447%", "31.7073%", "", "—", "平台精确", ""])
  ]);
  const paidFree = table("店铺竞争态势·付费与免费流量", COMPARE_COLUMNS, [
    row("付费与免费流量", "付费与免费流量", "付费", "流量占比", ["", "", "", "8.5366%", "8.5366%", "", "—", "平台精确", ""]),
    row("付费与免费流量", "付费与免费流量", "免费搜索", "流量占比", ["27.2237438%", "27.15829342%", "", "26.8293%", "26.8293%", "", "平台精确", "平台精确", "+1.47%"])
  ]);
  const customers = table("店铺竞争态势·购买新老客结构", COMPARE_COLUMNS, [
    row("购买新老客结构", "购买客群", "购买新客", "成交笔数", ["728", "661", "10%", "2.5万~5万", "2.5万~5万", "", "平台精确", "平台区间", "约-98.55%～-97.08%"]),
    row("购买新老客结构", "购买客群", "购买老客", "支付转化率", ["3.835503%", "4.553172%", "-16%", "1%~2.5%", "1%~2.5%", "+0%~10%", "平台精确", "平台区间", "约+53.42%～+283.56%"])
  ]);
  const channels = table("店铺竞争态势·渠道表现", COMPARE_COLUMNS, [
    row("渠道表现", "广告域归因", "全站推广", "成交笔数", ["377", "412", "-9%", "2万~3万", "2万~3万", "", "平台精确", "平台区间", "约-98.12%～-97.43%"]),
    row("渠道表现", "广告域归因", "全站推广 / 货品全站推广", "成交笔数", ["377", "412", "-9%", "2万~3万", "2万~3万", "", "平台精确", "平台区间", "约-98.12%～-97.43%"]),
    row("渠道表现", "全域归因", "淘宝搜索", "成交笔数", ["353", "312", "13%", "1万~2万", "1万~2万", "16%", "平台精确", "平台区间", "约-98.24%～-96.47%"]),
    row("渠道表现", "全域归因", "淘宝其他", "成交笔数", ["295", "242", "22%", "8千~9千", "8千~9千", "8%", "平台精确", "平台区间", "约-96.73%～-96.31%"]),
    row("渠道表现", "全域归因", "淘宝私域", "成交笔数", ["216", "262", "-18%", "4千~5千", "3千~4千", "4%", "平台精确", "平台区间", "约-95.68%～-94.60%"]),
    row("渠道表现", "全域归因", "淘宝推荐", "成交笔数", ["86", "86", "0%", "2千~3千", "1千~2千", "16%", "平台精确", "平台区间", "约-97.14%～-95.70%"]),
    row("渠道表现", "全域归因", "淘宝直播", "成交笔数", ["27", "20", "35%", "2千~3千", "1千~2千", "17%", "平台精确", "平台区间", "约-99.10%～-98.65%"]),
    row("渠道表现", "全域归因", "关键词推广", "成交笔数", ["", "", "", "4千~5千", "3千~4千", "7%", "—", "平台区间", ""])
  ]);
  const samples = table("店铺竞争态势·单品样本", ["对象", "店铺 ID", "商品ID", "商品标题", "周期", "成交笔数", "笔单价", "总GMV", "30日消耗", "单品费比", "来源", "精度"], [
    ["本店", "473356596", "969443619597", "抽油烟机", "2026-08-18~2026-09-16", "691", "476.232995658466", "329077", "", "", "本店Top清单", "精确（消耗缺失）"],
    ["本店", "473356596", "944372485307", "消毒柜", "2026-08-18~2026-09-16", "32", "593.09375", "18979", "2,777.6", "14.64%", "本店Top清单", "精确"],
    ["本店", "473356596", "合计", "2 个精确样本（2 个样本）", "2026-08-18~2026-09-16", "723", "481.41", "348,056", "2,777.6", "14.64%", "样本合计", "精确（部分消耗缺失）"],
    ["竞店1", "489118152", "903880619785", "侧吸变频", "2026-08-18~2026-09-16", "6865", "640.1413896576844", "4394570.64", "198,158.94", "4.51%", "货清单Top10", "精确"],
    ["竞店1", "489118152", "674424029373", "顶吸 T 型", "2026-08-18~2026-09-16", "7014", "623.0491859138865", "4370066.99", "217,614.62", "4.98%", "货清单Top10", "精确"],
    ["竞店1", "489118152", "908486110811", "7 字型", "2026-08-18~2026-09-16", "4695", "800.9805835995738", "3760603.84", "485,696.05", "12.92%", "货清单Top10", "精确"],
    ["竞店1", "489118152", "834351865736", "双灶燃气灶", "2026-08-18~2026-09-16", "9720", "348.57651646090517", "3388163.74", "132,661.78", "3.92%", "货清单Top10", "精确"],
    ["竞店1", "489118152", "1055425514021", "热水器 A", "2026-08-18~2026-09-16", "2359", "627.5899830436625", "1480484.77", "116,544.92", "7.87%", "货清单Top10", "精确"],
    ["竞店1", "489118152", "合计", "5 个精确样本（5 个样本）", "2026-08-18~2026-09-16", "30653", "568.13", "17416889.98", "1150676.31", "6.61%", "样本合计", "精确"]
  ]);
  const benchmark = table("对标总表", COMPARE_COLUMNS, [row("推广表现", "平台推广口径", "", "广告消耗（元）", ["约29,893.99", "约45,718.26", "", "约902,359.66～1,804,719.34", "", "", "公式", "样本加权约值", ""])]);
  const tables = [overview, benchmark, summary, promotion, operation, structure, paidFree, customers, channels, samples];
  return tables.map((entry) => {
    const layout = detectShopLayout(entry.columns);
    return layout ? { ...entry, shopLayout: layout } : entry;
  });
}

describe("R14 店铺视角七区块派生", () => {
  it("parseShopDisplay 与插件语义一致：exact / interval / text / missing / 约 前缀 / 千·万 单位", () => {
    expect(parseShopDisplay("483,812.28")).toMatchObject({ kind: "exact", min: 483812.28, max: 483812.28, percent: false });
    expect(parseShopDisplay("约29,893.99")).toMatchObject({ kind: "exact", min: 29893.99, approximate: true });
    expect(parseShopDisplay("约902,359.66～1,804,719.34")).toMatchObject({ kind: "interval", min: 902359.66, max: 1804719.34 });
    expect(parseShopDisplay("8千~9千")).toMatchObject({ kind: "interval", min: 8000, max: 9000 });
    expect(parseShopDisplay("68%")).toMatchObject({ kind: "exact", min: 68, percent: true });
    expect(parseShopDisplay("比本店高")).toMatchObject({ kind: "text" });
    expect(parseShopDisplay("—")).toMatchObject({ kind: "missing" });
    expect(parseShopDisplay("样本加权约值")).toMatchObject({ kind: "invalid" });
  });

  it("金额展示：两位小数千分位；概览位置可用「万」缩写", () => {
    expect(formatShopAmount(635155.62455978)).toBe("635,155.62");
    expect(formatShopAmount(29893.99)).toBe("29,893.99");
    expect(formatShopAmountCompact(13489235.83)).toBe("1,348.92万");
    expect(formatShopAmountCompact(483812.28)).toBe("483,812.28");
  });

  it("deriveShopView 输出 01–08 区块与基础 KPI 卡（推广五项缺行仍强制建空卡）", () => {
    const view = deriveShopView(fixtures());
    expect(view).not.toBeNull();
    expect(view!.blocks.map((block) => block.code)).toEqual(["01", "02", "03", "04", "05", "06", "07", "08"]);
    expect(view!.kpis.map((card) => card.metric)).toEqual([
      "成交金额（元）", "广告消耗（元）", "全店费比", "当天引导ROI",
      "点击单价（元）", "推广转化率",
      "整体成交笔数", "样本加权笔单价（元）", "整体成交转化率", "新客成交金额占比"
    ]);
    expect(view!.kpis.some((card) => card.metric === "付费成交笔数" || card.metric === "推广加购率")).toBe(false);
  });

  it("01 全店费比为派生公式值：本店 6.18%，精度标「公式」", () => {
    const view = deriveShopView(fixtures())!;
    const card = view.kpis.find((entry) => entry.metric === "全店费比")!;
    expect(card.derived).toBe(true);
    const subject = card.values.find((entry) => entry.role === "subject")!;
    expect(subject.current).toBe("6.18%");
    expect(subject.precision).toBe("公式");
    expect(card.derivedNote).toContain("29,893.99");
    const competitor = card.values.find((entry) => entry.role === "competitor-1")!;
    expect(competitor.current).toBe("6.69%");
    expect(competitor.precision).toBe("公式");
  });

  it("02 桥：签名样本合计、覆盖率与 Top1 占比（本店 68.0%）", () => {
    const view = deriveShopView(fixtures())!;
    const subject = view.bridges.find((bridge) => bridge.role === "subject")!;
    expect(subject.cells[0].value).toBe("Σ 348,056.00");
    expect(subject.cells[1].value).toBe("1,005 笔");
    expect(subject.cells[1].note).toBe("样本覆盖率 71.9%");
    expect(subject.cells[2].note).toBe("Top1 单品占 68.0%");
    const competitor = view.bridges.find((bridge) => bridge.role === "competitor-1")!;
    expect(competitor.cells[2].value).toBe("约2,412.96万");
    expect(competitor.cells[2].note).toBe("Top1 单品占 18.2%");
    expect(competitor.notes.some((note) => note.includes("44,720") && note.includes("539.57"))).toBe(true);
  });

  it("03 全店渠道花费：竞店全站推广消耗为端点外扩区间，pp 变化为 +14.3pp", () => {
    const view = deriveShopView(fixtures())!;
    const fullsite = view.spend.rows.find((entry) => entry.channel === "全站推广")!;
    const competitor = fullsite.values.find((entry) => entry.role === "competitor-1")!;
    expect(competitor.spend).toBe("约1,136,255.99");
    expect(competitor.share).toBe("70.39%");
    expect(competitor.pp).toBe("+14.3pp");
    expect(competitor.trend).toBe("up");
    const subject = fullsite.values.find((entry) => entry.role === "subject")!;
    expect(subject.spend).toBe("29,893.99");
    expect(view.spend.totals.find((entry) => entry.role === "competitor-1")!.spend).toBe("约1,614,268.26");
  });

  it("04 渠道表现：一级展开、二级折叠，全域本店成交结构 = 淘宝搜索 36.1%", () => {
    const view = deriveShopView(fixtures())!;
    expect(view.channelGroups.map((group) => group.attribution)).toEqual(["广告域归因", "全域归因"]);
    const advertising = view.channelGroups[0];
    expect(advertising.rows.map((row) => row.channel)).toEqual(["全站推广"]);
    expect(advertising.rows[0].subs).toHaveLength(1);
    expect(advertising.rows[0].subs[0].channel).toBe("全站推广 / 货品全站推广");
    const whole = view.channelGroups[1];
    const search = whole.structure.find((bar) => bar.channel === "淘宝搜索")!;
    expect(search.share).toBe("36.1%");
    expect(search.detail).toContain("353 笔");
    expect(whole.structure.find((bar) => bar.channel === "淘宝其他")!.share).toBe("30.2%");
    expect(whole.structure.map((bar) => bar.channel)).toEqual(["淘宝搜索", "淘宝其他", "淘宝私域", "淘宝推荐", "淘宝直播", "关键词推广"]);
  });

  it("05 流量结构：本店付费占比缺失时用 付费点击量 ÷ 整体IPV 派生（18.4%，标公式）", () => {
    const view = deriveShopView(fixtures())!;
    expect(view.traffic.paidDerived).toBe("18.4%");
    expect(view.traffic.paidNote).toContain("公式");
    const subject = view.traffic.stacks.find((stack) => stack.role === "subject")!;
    expect(subject.note).toContain("付费占比 缺失");
    expect(view.traffic.customers.some((entry) => entry.metric === "新客成交金额占比")).toBe(true);
    expect(view.traffic.customers.some((entry) => entry.metric === "新客成交笔数占比" && entry.values.some((value) => String(value.current).startsWith("约")))).toBe(true);
    const newOrders = view.traffic.customers.find((entry) => entry.group.includes("新客") && entry.metric === "成交笔数");
    expect(newOrders?.values.find((value) => value.role === "subject")?.current).toMatch(/^约/);
  });

  it("01 推广五项进入总览；缺行仍强制建空卡", () => {
    const promo = table("店铺竞争态势·推广表现", COMPARE_COLUMNS, [
      row("推广表现", "平台推广口径", "", "当天引导ROI", ["3.00", "", "", "约3.00", "", "", "单品推广加总", "单品推广加总（约值）", ""]),
      row("推广表现", "平台推广口径", "", "付费成交笔数", ["20", "", "", "约10", "", "", "单品推广加总", "单品推广加总（约值）", ""]),
      row("推广表现", "平台推广口径", "", "推广客单价（元）", ["120.00", "", "", "约120.00", "", "", "单品推广加总", "单品推广加总（约值）", ""]),
      row("推广表现", "平台推广口径", "", "点击单价（元）", ["4.00", "", "", "约4.00", "", "", "单品推广加总", "单品推广加总（约值）", ""]),
      row("推广表现", "平台推广口径", "", "推广转化率", ["10.00%", "", "", "约10.00%", "", "", "单品推广加总", "单品推广加总（约值）", ""]),
      row("推广表现", "平台推广口径", "", "推广加购率", ["20.00%", "", "", "约20.00%", "", "", "单品推广加总", "单品推广加总（约值）", ""])
    ]);
    const view = deriveShopView([...fixtures().filter((entry) => entry.name !== "店铺竞争态势·推广表现"), promo])!;
    expect(view.kpis.map((card) => card.title)).toEqual(expect.arrayContaining(["当天引导ROI", "点击单价（元）", "转化率"]));
    expect(view.kpis.map((card) => card.title)).not.toEqual(expect.arrayContaining(["单量", "客单价（元）", "加购率"]));
    expect(view.kpis.find((card) => card.metric === "当天引导ROI")!.values[0].current).toBe("3.00");
  });

  it("方向文字改为公式：点击单价=花费÷点击，转化率=笔数÷点击，ROI=付费成交金额÷消耗", () => {
    const promo = table("店铺竞争态势·推广表现", COMPARE_COLUMNS, [
      row("推广表现", "平台推广口径", "", "广告消耗（元）", ["1000.00", "", "", "2000.00", "", "", "平台精确", "平台精确", ""]),
      row("推广表现", "平台推广口径", "", "付费点击量", ["500", "", "", "1000", "", "", "平台精确", "平台精确", ""]),
      row("推广表现", "平台推广口径", "", "付费成交笔数", ["25", "", "", "40", "", "", "平台精确", "平台精确", ""]),
      row("推广表现", "平台推广口径", "", "广告引导成交金额（元）", ["4300.00", "", "", "9000.00", "", "", "平台精确", "平台精确", ""]),
      row("推广表现", "平台推广口径", "", "当天引导ROI", ["4.30", "", "", "比本店高", "", "", "平台精确", "方向值", ""]),
      row("推广表现", "平台推广口径", "", "点击单价（元）", ["2.00", "", "", "比本店低", "", "", "平台精确", "方向值", ""]),
      row("推广表现", "平台推广口径", "", "推广转化率", ["5.00%", "", "", "比本店低", "", "", "平台精确", "方向值", ""])
    ]);
    const base = fixtures()
      .filter((entry) => entry.name !== "店铺竞争态势·推广表现")
      .map((entry) => ({ ...entry, rows: entry.rows.filter((cells) => !["整体成交笔数", "样本加权笔单价（元）", "广告消耗（元）"].includes(String(cells[3] ?? ""))) }));
    const view = deriveShopView([...base, promo])!;
    const roi = view.kpis.find((card) => card.metric === "当天引导ROI")!;
    expect(roi.values[0].current).toBe("4.30");
    expect(roi.values[1].current).toBe("");
    expect(roi.values[1].precision).toBe("—");
    expect(roi.values[1].current).not.toContain("比本店");
    const cpc = view.kpis.find((card) => card.metric === "点击单价（元）")!;
    expect(cpc.values[0].current).toBe("2.00");
    expect(cpc.values[1].current).toBe("2.00");
    expect(cpc.values[1].precision).toBe("公式");
    const cvr = view.kpis.find((card) => card.metric === "推广转化率")!;
    expect(cvr.values[0].current).toBe("5.00%");
    expect(cvr.values[1].current).toBe("4.00%");
    expect(cvr.values[1].precision).toBe("公式");
  });

  it("06 重点单品：追加「占全店GMV」，全部商品展开，不含其余聚合", () => {
    const view = deriveShopView(fixtures())!;
    expect(view.samples.shareAfterColumn).toBe("总GMV");
    const subjectTotal = view.samples.rows.find((row) => row.role === "subject" && row.total)!;
    expect(subjectTotal.share).toBe("71.9%");
    const subjectTop = view.samples.rows.find((row) => row.role === "subject" && !row.total)!;
    expect(subjectTop.share).toBe("68.0%");
    const competitorRows = view.samples.rows.filter((row) => row.role === "competitor-1");
    expect(competitorRows.filter((row) => row.aggregate)).toHaveLength(0);
    expect(competitorRows.filter((row) => !row.total)).toHaveLength(5);
    expect(competitorRows[0].cells[2]).toBe("903880619785");
    expect(competitorRows.some((row) => String(row.cells[2]).includes("其余"))).toBe(false);
    expect(view.samples.concentration).toContain("68.0%");
    expect(view.samples.concentration).toContain("18.2%");
    expect(view.samples.concentration).not.toContain("样本");
  });

  it("08 数据说明：付费占比不再列为缺；无逐日表时才提示日趋势", () => {
    const view = deriveShopView(fixtures())!;
    expect(view.daily.dates).toEqual([]);
    expect(view.notes.filter((note) => note.kind === "说明").length).toBeGreaterThanOrEqual(1);
    expect(view.notes.some((note) => note.kind === "说明" && note.text.includes("本店单品费比"))).toBe(true);
    const pending = view.notes.filter((note) => note.kind === "缺").map((note) => note.text).join(" ");
    expect(pending).toContain("全店日趋势");
    expect(pending).not.toContain("付费流量占比");
    expect(pending).toContain("上期广告消耗");
  });

  it("07 全店日趋势：同店铺同日期原生行进入展示模型，不取中点", () => {
    const daily = table("店铺竞争态势·逐日趋势", ["对象", "店铺 ID", "归因范围", "日期", "指标", "本期", "上期", "变化"], [
      ["本店", "473356596", "", "2026-09-15", "成交金额（元）", "12,000.00", "", ""],
      ["本店", "473356596", "", "2026-09-15", "广告消耗（元）", "800.00", "", ""],
      ["本店", "473356596", "", "2026-09-15", "费比", "6.67%", "", ""],
      ["本店", "473356596", "", "2026-09-15", "当天引导ROI", "2.00", "", ""],
      ["本店", "473356596", "", "2026-09-15", "付费成交笔数", "10", "", ""],
      ["本店", "473356596", "", "2026-09-15", "推广客单价（元）", "40.00", "", ""],
      ["本店", "473356596", "", "2026-09-15", "点击单价（元）", "2.00", "", ""],
      ["本店", "473356596", "", "2026-09-15", "推广转化率", "10.00%", "", ""],
      ["本店", "473356596", "", "2026-09-15", "推广加购率", "20.00%", "", ""],
      ["本店", "473356596", "", "2026-09-16", "成交金额（元）", "13,000.00", "", ""],
      ["本店", "473356596", "", "2026-09-16", "广告消耗（元）", "900.00", "", ""],
      ["本店", "473356596", "", "2026-09-16", "费比", "6.92%", "", ""],
      ["竞店1", "489118152", "", "2026-09-15", "成交金额（元）", "20,000.00", "", ""],
      ["竞店1", "489118152", "", "2026-09-16", "成交金额（元）", "21,000.00", "", ""]
    ]);
    const view = deriveShopView([...fixtures(), daily])!;
    expect(view.daily.dates).toEqual(["2026-09-15", "2026-09-16"]);
    expect(view.daily.byDate["2026-09-15"][0]).toMatchObject({ gmv: "12,000.00", spend: "800.00", fee: "6.67%", roi: "2.00", orders: "10", aov: "40.00", ppc: "2.00", cvr: "10.00%", cart: "20.00%" });
    expect(view.daily.series.find((item) => item.title === "本店日消耗")?.hover).toBe(true);
    expect(view.daily.series.find((item) => item.title === "本店日销售额")!.values).toEqual(["12,000.00", "13,000.00"]);
    expect(view.notes.filter((note) => note.kind === "缺").map((note) => note.text).join(" ")).not.toContain("全店日趋势");
  });

  it("精度徽标映射与缺失安全：任一输入缺失 → 留空，不取中点", () => {
    expect(shopBadgeForPrecision("平台精确")).toBe("exact");
    expect(shopBadgeForPrecision("平台区间")).toBe("interval");
    expect(shopBadgeForPrecision("方向值")).toBe("text");
    expect(shopBadgeForPrecision("样本加权约值")).toBe("sample");
    expect(shopBadgeForPrecision("公式")).toBe("formula");
    expect(shopBadgeForPrecision("—")).toBe("missing");
    const tables = fixtures().map((entry) => entry.name === "店铺竞争态势·投放结构"
      ? { ...entry, rows: entry.rows.map((cells) => cells.map((value, index) => index === 4 || index === 7 ? "" : value)) }
      : entry);
    const view = deriveShopView(tables)!;
    expect(view.spend.rows.every((entry) => entry.values.every((value) => value.spend === "—"))).toBe(true);
    expect(view.spend.totals.find((entry) => entry.role === "subject")!.spend).toBe("29,893.99");
  });

  it("非店铺版式（无对象分组）返回 null，不影响商品报告", () => {
    expect(deriveShopView([table("周期汇总", ["指标", "主体", "对手"], [["总GMV", "1", "2"]])])).toBeNull();
  });
});
