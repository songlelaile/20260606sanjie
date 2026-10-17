import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelGatewayConsole } from "./ModelGatewayConsole";

const initialOverview = {
  wallet: { balanceCents: 2000, monthlyQuotaCents: 0, planCode: "starter", planName: "体验版", periodEnd: "2026-10-01" },
  keys: [{ id: "key-1", name: "业务 Key", keyPrefix: "sk-sz-abcd", status: "active", createdAt: "2026-10-01" }],
  orders: [],
  usages: []
};
const plans = [{ code: "starter", name: "体验版", description: "测试套餐", priceCents: 9900, creditCents: 12000, badge: "入门", features: ["120 元模型额度", "1 个 API Key"] }];

describe("模型网关页面展示边界", () => {
  it("已收款待分配购买记录保留原订单查询入口且移除再次付款链接", () => {
    const html = renderToStaticMarkup(React.createElement(ModelGatewayConsole, {
      initialOverview: { ...initialOverview, orders: [{ id: "funded-1", planCode: "starter", planName: "体验版",
        amountCents: 9900, creditCents: 12000, status: "pending", creditAllocationState: "awaiting_capacity",
        paymentProvider: "alipay", paymentUrl: "https://qr.alipay.com/must-not-pay-again", createdAt: "2026-10-01" }] }, plans, models: []
    }));
    expect(html).toContain("已收款，积分待分配"); expect(html).toContain("查看分配状态");
    expect(html).not.toContain("继续付款</button>"); expect(html).not.toContain("去付款</a>");
    expect(html).not.toContain("must-not-pay-again"); expect(html).not.toContain("已到账</em>");
  });

  it("购买积分页只渲染套餐与余额，API 接入内容通过个人菜单单独打开", () => {
    const html = renderToStaticMarkup(React.createElement(ModelGatewayConsole, { initialOverview, plans, models: [] }));
    expect(html).toContain("可用积分");
    expect(html).toContain("200 积分");
    expect(html).toContain("1,200 积分");
    expect(html).toContain("¥99.00");
    expect(html).toContain("GPT 图片创作");
    expect(html).toContain("GPT 创意文案");
    expect(html).toContain("所有套餐均可使用");
    expect(html).toContain('href="/profile?tab=credits"');
    expect(html).not.toContain("API 接入与调用记录");
    expect(html).not.toContain("上游与接入说明");
    expect(html).not.toContain("Lume Flow");
    expect(html).not.toContain("120 元模型额度");
    expect(html).toContain("选择套餐");
    expect(html).not.toContain("业务 Key");
    expect(html).not.toContain("最近流水");
    expect(html).toContain("购买记录");
    expect(html).not.toContain("中转站管理");
    expect(html).not.toContain("relay-settings-heading");
    expect(html).not.toContain("type=\"password\"");
    expect(html).not.toContain("上游 API Key");
    expect(html).toContain("当前未启用视频模型");
  });

  it("API 入口保留当前账户 Key 和调用记录，普通账号不获得平台凭据管理", () => {
    const html = renderToStaticMarkup(React.createElement(ModelGatewayConsole, { initialOverview, plans, models: [], view: "api" }));
    expect(html).toContain("API 接入与调用记录");
    expect(html).toContain("业务 Key");
    expect(html).toContain("最近流水");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("刷新账户");
    expect(html).toContain("管理当前账户的 API Key 与调用记录。");
    expect(html).toContain('href="/profile"');
    expect(html).not.toContain("选择套餐");
    expect(html).not.toContain("购买记录");
    expect(html).not.toContain("relay-settings-heading");
  });

  it("keeps reserved task credits separate from the available balance", () => {
    const html = renderToStaticMarkup(React.createElement(ModelGatewayConsole, {
      initialOverview: { ...initialOverview, wallet: { ...initialOverview.wallet, availableCents: 1500, reservedCents: 500 } }, plans, models: []
    }));
    expect(html).toContain("150 积分");
    expect(html).toContain("冻结 50 积分 · 任务结算后更新");
    expect(html).not.toContain(">200 积分<");
  });

  it("管理员能渲染管理入口，已登记视频目录提供异步任务示例", () => {
    const html = renderToStaticMarkup(React.createElement(ModelGatewayConsole, {
      initialOverview,
      plans,
      canManageRelay: true,
      view: "api",
      models: [{ id: "catalog-video", label: "商品视频", provider: "shaozhuang", kind: "video", endpoint: "videos" }]
    }));
    expect(html).toContain("中转站管理");
    expect(html).toContain("正在读取中转站配置");
    expect(html).toContain("catalog-video");
    expect(html).toContain("复制视频示例");
    expect(html).toContain("任务随后失败暂不自动退款");
    expect(html).toContain("美元费用使用每日参考汇率换算");
    expect(html).not.toContain("当前未启用视频模型");
  });

  it("目录读取失败仍保留账户页面，只显示通用错误", () => {
    const html = renderToStaticMarkup(React.createElement(ModelGatewayConsole, {
      initialOverview,
      plans,
      models: [],
      modelCatalogError: "模型目录暂不可用，请管理员检查中转站配置后刷新。"
    }));
    expect(html).toContain("模型目录暂不可用");
    expect(html).not.toContain("业务 Key");
    expect(html).toContain("200 积分");
    expect(html).not.toContain("chatGPT5.5");
  });
});
