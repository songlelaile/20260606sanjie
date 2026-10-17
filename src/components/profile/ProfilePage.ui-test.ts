import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), credits: vi.fn(), redirect: vi.fn((path: string) => { throw new Error(`REDIRECT:${path}`); }) }));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/creative-credit", () => ({ getCreativeCredits: mocks.credits }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
import ProfilePage from "@/app/profile/page";
import { ProfileCenter } from "./ProfileCenter";

const account = { username: "shop-login", name: "店铺用户", email: "shop@example.com", shopName: "示例店铺", createdAt: "2026-10-01T00:00:00.000Z" };
const credits = {
  wallet: { balanceCents: 246, balancePoints: 24.6, exists: true },
  plan: { code: "starter", name: "当前真实套餐", multiplierBps: 10000, ruleVersion: 1 },
  models: [], catalogError: null, observedAt: "2026-10-01T00:00:00.000Z", centsPerPoint: 10
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ ...account, id: "user-a", status: "active", password: "private-password-hash", apiKey: "private-provider-key", tenantId: "private-tenant-id", authRole: "tenant", tenant: { name: "内部空间名称" }, createdAt: new Date(account.createdAt) });
  mocks.credits.mockResolvedValue(credits);
});

describe("profile account view", () => {
  it("reads credits for the authenticated user and sends only display identity fields to the client", async () => {
    const page = await ProfilePage({ searchParams: Promise.resolve({}) });
    expect(mocks.credits).toHaveBeenCalledWith("user-a");
    expect(page.props.account).toEqual(account);
    expect(JSON.stringify(page.props)).not.toContain("private-provider-key");
    expect(JSON.stringify(page.props)).not.toContain("private-tenant-id");
    const html = renderToStaticMarkup(page);
    expect(html).toContain("24.6");
    expect(html).toContain("当前真实套餐");
    expect(html).toContain("shop@example.com");
    expect(html).toContain("昵称");
    expect(html).toContain("店铺用户"); // The saved display name is left intact.
    expect(html).not.toContain("用户名称");
    expect(html).not.toContain("所属租户");
    expect(html).not.toContain("内部空间名称");
    expect(html).toContain("/dashboards/operating-network?history=1");
    expect(html).not.toContain("private-password-hash");
    expect(html).not.toContain("租户管理");
    expect(html).not.toContain("更改密码");
  });

  it.each([{ available: 146, held: 100, points: "14.6", frozen: "10" }, { available: 0, held: 246, points: "0", frozen: "24.6" }])("shows spendable credits and labels reserved task credits separately: $available", ({ available, held, points, frozen }) => {
    const html = renderToStaticMarkup(React.createElement(ProfileCenter, {
      account, initialCredits: { ...credits, wallet: { ...credits.wallet, availableCents: available, reservedCents: held } }
    }));
    expect(html).toContain(`${points}<small>积分`);
    expect(html).toContain(`冻结 ${frozen} 积分 · 任务结算后更新`);
    expect(html).not.toContain("24.6<small>积分");
  });

  it("keeps failures unknown instead of inventing a zero balance", async () => {
    mocks.credits.mockRejectedValue(new Error("private credential"));
    const html = renderToStaticMarkup(await ProfilePage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("积分信息暂不可用");
    expect(html).toContain("暂不可用");
    expect(html).not.toContain("0<small>积分");
    expect(html).not.toContain("private credential");
  });

  it("labels a nonexistent wallet rather than claiming a known balance", () => {
    const html = renderToStaticMarkup(React.createElement(ProfileCenter, { account, initialCredits: { ...credits, wallet: { balanceCents: 0, balancePoints: 0, exists: false } } }));
    expect(html).toContain("尚未开通积分钱包");
    expect(html).not.toContain("0<small>积分");
  });

  it.each([null, { status: "disabled" }])("redirects inactive or absent users before reading their credits", async user => {
    mocks.user.mockResolvedValue(user);
    await expect(ProfilePage({ searchParams: Promise.resolve({}) })).rejects.toThrow("REDIRECT:/login");
    expect(mocks.credits).not.toHaveBeenCalled();
  });

  it("supports tutorial deep links and explains where generation history is saved", async () => {
    const html = renderToStaticMarkup(await ProfilePage({ searchParams: Promise.resolve({ tab: "tutorials" }) }));
    expect(html).toContain("三个步骤");
    expect(html).toContain("记录保存在当前浏览器");
    expect(html).toContain("/models");
    expect(html).not.toContain("云记录");
  });

  it.each(["credits", "orders"])("opens the requested history view without declaring empty history before fetching: %s", async tab => {
    const html = renderToStaticMarkup(await ProfilePage({ searchParams: Promise.resolve({ tab }) }));
    expect(html).toContain("正在读取");
    expect(html).not.toContain("暂无充值订单");
    expect(html).not.toContain("暂无积分明细");
  });
});
