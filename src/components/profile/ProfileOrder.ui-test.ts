import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProfileRechargeOrder } from "./ProfileCenter";

const order = { id: "original-funded-order", planName: "体验版", amountCents: 9900, creditCents: 12000,
  status: "pending", paymentProvider: "alipay", createdAt: "2026-10-01T00:00:00Z", paidAt: null };
describe("profile recharge order payment/allocation boundary", () => {
  it("an old unpaid response retains the original payment entry", () => {
    const html = renderToStaticMarkup(React.createElement(ProfileRechargeOrder, { order }));
    expect(html).toContain("待支付确认"); expect(html).toContain("继续付款");
  });
  it.each(["pending", "awaiting_capacity", "paid"])("awaiting allocation %s exposes only original-order status recovery and never a paid badge", status => {
    const html = renderToStaticMarkup(React.createElement(ProfileRechargeOrder, {
      order: { ...order, status, creditAllocationState: "awaiting_capacity", paidAt: "2026-10-01T00:00:00Z" }
    }));
    expect(html).toContain("已收款，积分待分配"); expect(html).toContain("查看分配状态");
    expect(html).toContain("orderId=original-funded-order");
    expect(html).not.toContain("继续付款"); expect(html).not.toContain("已支付 · 已到账");
    expect(html).not.toContain("到账时间");
  });
  it("a manually funded waiting order has no payment link", () => {
    const html = renderToStaticMarkup(React.createElement(ProfileRechargeOrder, {
      order: { ...order, paymentProvider: "manual", creditAllocationState: "awaiting_capacity" }
    }));
    expect(html).toContain("已收款，积分待分配"); expect(html).not.toContain("<a ");
  });
});
