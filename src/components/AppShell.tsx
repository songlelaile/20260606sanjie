"use client";

import clsx from "clsx";
import {
  Brain,
  Clapperboard,
  Image as ImageIcon,
  LogOut,
  Menu,
  Network,
  Puzzle,
  Workflow,
  X
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import type { Role } from "@/lib/auth";
import type { ShopSummary } from "@/lib/types/domain";
import { ShopSwitcher } from "@/components/ShopSwitcher";
import { SanjieReportWorkspace } from "@/components/reports/SanjieReportWorkspace";
import { isSanjieReportPath } from "@/lib/sanjie-report-navigation";
import { AccountMenu } from "@/components/AccountMenu";
import { BrandIdentity } from "@/components/BrandIdentity";

const TENANT_NAV = [
  { href: "/dashboards/operating-network", label: "图像创作", icon: ImageIcon, exact: true },
  { href: "/dashboards/operating-network/video", label: "视频创作", icon: Clapperboard, exact: true },
  { href: "/reports", label: "三阶报告", icon: Workflow },
  { href: "/tools", label: "AI 工具", icon: Puzzle },
  { href: "/models", label: "购买积分", icon: Network }
];

// Sower Work 网页版先向管理账号开放，置于图像创作之前。
const ADMIN_NAV = [
  { href: "/sower-work", label: "Sower Work", icon: Brain },
  ...TENANT_NAV,
  { href: "/management", label: "管理", icon: Brain }
];

export function AppShell({
  children,
  role,
  userName,
  userEmail,
  shopSwitcher,
  testLabel,
  testExitUrl
}: {
  children: ReactNode;
  role: Role;
  userName: string;
  userEmail?: string;
  testLabel?: string;
  testExitUrl?: string;
  shopSwitcher: {
    shops: ShopSummary[];
    activeShopId: string;
    limit: number | null;
    canCreate: boolean;
    isAdmin: boolean;
  };
}) {
  const pathname = usePathname();
  const navItems = role === "admin" ? ADMIN_NAV : TENANT_NAV;
  const reportPage = isSanjieReportPath(pathname, role);
  const home = "/dashboards/operating-network";
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  useEffect(() => {
    const desktopQuery = window.matchMedia("(min-width: 1025px)");
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setSidebarOpen(false);
    };
    desktopQuery.addEventListener("change", closeOnDesktop);
    return () => desktopQuery.removeEventListener("change", closeOnDesktop);
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [sidebarOpen]);

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST", cache: "no-store" });
    } finally {
      // 即使网络中断也离开当前租户页面；服务端会在下一次鉴权时兜底。
      window.location.replace("/login");
    }
  }

  return (
    <div className="app-shell">
      <button
        type="button"
        className={clsx("sidebar-backdrop", sidebarOpen && "is-visible")}
        aria-label="关闭主导航"
        tabIndex={sidebarOpen ? 0 : -1}
        onClick={() => setSidebarOpen(false)}
      />
      <aside id="primary-sidebar" className={clsx("sidebar", sidebarOpen && "is-open")}>
        <button
          type="button"
          className="sidebar-close-button"
          aria-label="关闭主导航"
          onClick={() => setSidebarOpen(false)}
        >
          <X size={18} />
        </button>
        <Link
          href={home}
          prefetch={false}
          className="brand"
          aria-label="少壮AI自动化 · 智篆联合开发"
          onClick={() => setSidebarOpen(false)}
        >
          <BrandIdentity subtitle={role === "admin" ? "管理版 · 作图视频" : "作图 · 视频"} />
        </Link>
        <ShopSwitcher {...shopSwitcher} />
        {testLabel ? <div style={{ padding: "12px 16px", fontSize: 12, color: "#fbbf24" }}>
          <strong>{testLabel}</strong>
          {testExitUrl ? <p><a href={testExitUrl} style={{ color: "inherit" }}>退出测试版</a></p> : null}
        </div> : null}
        <nav className="nav-list" aria-label="主导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = item.href === "/reports" ? reportPage : item.exact
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                className={clsx("nav-item", active && "active")}
                aria-current={active ? "page" : undefined}
                onClick={() => setSidebarOpen(false)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-user">
          <div className="sidebar-user-meta">
            <strong>{userName}</strong>
            <small>{role === "admin" ? "平台管理员" : "店铺运营"}</small>
          </div>
          <button type="button" className="logout-button" onClick={logout} aria-label="退出登录">
            <LogOut size={16} />
            退出
          </button>
        </div>
      </aside>
      <main className="main">
        <div className="mobile-shell-bar">
          <button
            type="button"
            className="sidebar-open-button"
            aria-label="打开主导航"
            aria-controls="primary-sidebar"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={19} />
            菜单
          </button>
          <BrandIdentity variant="compact" />
        </div>
        <AccountMenu key={userEmail || userName} userName={userName} email={userEmail} onLogout={logout} />
        {reportPage ? <SanjieReportWorkspace role={role}>{children}</SanjieReportWorkspace> : children}
      </main>
    </div>
  );
}
