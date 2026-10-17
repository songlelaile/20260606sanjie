import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/AppShell";
import type { Role } from "@/lib/auth";

const navigation = vi.hoisted(() => ({ pathname: "/dashboards/management" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));
vi.mock("@/components/ShopSwitcher", () => ({ ShopSwitcher: () => null }));

function renderShell(pathname: string, role: Role = "tenant") {
  navigation.pathname = pathname;
  return renderToStaticMarkup(createElement(AppShell, {
    role,
    userName: "测试运营",
    shopSwitcher: { shops: [], activeShopId: "", limit: null, canCreate: false, isAdmin: role === "admin" }
  } as unknown as Parameters<typeof AppShell>[0], createElement("div", { id: "report-page-content" }, "报表正文")));
}

function region(html: string, tag: "nav" | "section", label: string) {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  expect(match, `${label} should be rendered`).not.toBeNull();
  return match![1];
}

function links(html: string) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((match) => ({
    href: match[1].match(/\bhref="([^"]+)"/)?.[1],
    current: /\baria-current="page"/.test(match[1]),
    text: match[2].replace(/<[^>]+>/g, "")
  }));
}

describe("三阶报告在真实 AppShell 中的导航边界", () => {
  beforeEach(() => {
    navigation.pathname = "/dashboards/management";
  });

  it("三阶报告位于视频创作之后，并保留原报表内容", () => {
    const html = renderShell("/dashboards/management");
    const primary = links(region(html, "nav", "主导航"));
    const videoIndex = primary.findIndex((link) => link.href === "/dashboards/operating-network/video");
    expect(videoIndex).toBeGreaterThanOrEqual(0);
    expect(primary[videoIndex + 1]).toMatchObject({ href: "/reports", text: "三阶报告" });
    const workspace = region(html, "section", "三阶报告工作台");
    expect(workspace).toContain('id="report-page-content"');
    expect(html.match(/id="report-page-content"/g)).toHaveLength(1);
  });

  it.each([
    ["/dashboards/management", "/dashboards/management"],
    ["/dashboards/product-breakthrough", "/dashboards/product-breakthrough"],
    ["/dashboards/audience-plan", "/dashboards/audience-plan"],
    ["/imports", "/imports"],
    ["/imports/history", "/imports"],
    ["/prefill", "/prefill"],
    ["/reports/operating-network", "/reports/operating-network"],
    ["/dashboards/business-diagnosis", "/dashboards/business-diagnosis"]
  ])("旧功能 %s 同时选中报告主入口和对应二级入口", (pathname, selectedHref) => {
    const html = renderShell(pathname);
    expect(links(region(html, "nav", "主导航")).filter((link) => link.current).map((link) => link.href))
      .toEqual(["/reports"]);
    expect(links(region(html, "section", "三阶报告工作台")).filter((link) => link.current).map((link) => link.href))
      .toEqual([selectedHref]);
  });

  it.each([
    ["/dashboards/operating-network", "/dashboards/operating-network"],
    ["/dashboards/operating-network/video", "/dashboards/operating-network/video"]
  ])("创作页面 %s 保留独立工作台和准确主入口", (pathname, selectedHref) => {
    const html = renderShell(pathname);
    expect(html).not.toContain('aria-label="三阶报告工作台"');
    expect(html).toContain('id="report-page-content"');
    expect(links(region(html, "nav", "主导航")).filter((link) => link.current).map((link) => link.href))
      .toEqual([selectedHref]);
  });

  it("相似前缀不会让模型网关或非报表页面误选三阶报告", () => {
    for (const pathname of ["/models", "/imports-archive"]) {
      const html = renderShell(pathname);
      expect(html).not.toContain('aria-label="三阶报告工作台"');
      expect(links(region(html, "nav", "主导航")).find((link) => link.href === "/reports")?.current).toBe(false);
    }
  });

  it("管理留痕只向管理员显示，管理员旧页面仍属于报告工作台", () => {
    const tenant = renderShell("/dashboards/management", "tenant");
    expect(tenant).not.toContain('aria-label="管理留痕"');
    const tenantLinks = links(region(tenant, "section", "三阶报告工作台")).map((link) => link.href);
    expect(tenantLinks).not.toContain("/admin");
    expect(tenantLinks).not.toContain("/versions");

    const admin = renderShell("/versions", "admin");
    const history = links(region(admin, "nav", "管理留痕"));
    expect(history.map((link) => link.href)).toEqual(["/admin", "/versions"]);
    expect(history.filter((link) => link.current).map((link) => link.href)).toEqual(["/versions"]);
    expect(links(region(admin, "nav", "主导航")).filter((link) => link.current).map((link) => link.href))
      .toEqual(["/reports"]);
  });
});
