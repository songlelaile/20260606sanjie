import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/AppShell";
import { canAccess, type Role } from "@/lib/auth";

const navigation = vi.hoisted(() => ({ pathname: "/sower-work" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));
vi.mock("@/components/ShopSwitcher", () => ({ ShopSwitcher: () => null }));

function primaryLinks(role: Role, pathname = "/sower-work") {
  navigation.pathname = pathname;
  const props = {
    role, userName: "测试账号",
    children: null,
    shopSwitcher: { shops: [], activeShopId: "", limit: null, canCreate: false, isAdmin: role === "admin" }
  };
  const html = renderToStaticMarkup(createElement(AppShell, props, createElement("div", null, "工作台内容")));
  const nav = html.match(/<nav\b[^>]*aria-label="主导航"[^>]*>([\s\S]*?)<\/nav>/)![1];
  return [...nav.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(match => ({
    href: match[1].match(/\bhref="([^"]+)"/)![1],
    current: /\baria-current="page"/.test(match[1]),
    label: match[2].replace(/<[^>]+>/g, "")
  }));
}

describe("Sower Work administrator navigation", () => {
  it("shows Sower Work first and image creation immediately afterwards for administrators", () => {
    const links = primaryLinks("admin");
    expect(links.slice(0, 2)).toEqual([
      { href: "/sower-work", current: true, label: "Sower Work" },
      { href: "/dashboards/operating-network", current: false, label: "图像创作" }
    ]);
    expect(links.at(-1)?.href).toBe("/management");
  });

  it("keeps image creation first and hides Sower Work from tenant navigation", () => {
    const links = primaryLinks("tenant", "/dashboards/operating-network");
    expect(links[0]).toEqual({ href: "/dashboards/operating-network", current: true, label: "图像创作" });
    expect(links.some(link => link.href === "/sower-work")).toBe(false);
  });

  it("selects only Sower Work on nested app paths", () => {
    expect(primaryLinks("admin", "/sower-work/app/").filter(link => link.current).map(link => link.href))
      .toEqual(["/sower-work"]);
  });

  it("does not select Sower Work on a similar unrelated prefix", () => {
    expect(primaryLinks("admin", "/sower-work-archive").some(link => link.current)).toBe(false);
  });

  it.each(["/sower-work", "/sower-work/app/", "/sower-work/assets/main.js"])("denies the tenant page prefix %s", pathname => {
    expect(canAccess("tenant", pathname)).toBe(false);
    expect(canAccess("admin", pathname)).toBe(true);
  });

  it("does not grant administrators unrelated similar prefixes", () => {
    expect(canAccess("admin", "/sower-work-archive")).toBe(false);
  });
});
