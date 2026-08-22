"use client";

import clsx from "clsx";
import {
  Activity,
  BarChart3,
  Brain,
  DatabaseZap,
  LineChart,
  LogOut,
  Menu,
  Network,
  Puzzle,
  Settings2,
  Target,
  X
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import type { Role } from "@/lib/auth";
import type { ShopSummary } from "@/lib/types/domain";
import { ShopSwitcher } from "@/components/ShopSwitcher";

const TENANT_NAV = [
  { href: "/dashboards/operating-network", label: "经营网络", icon: Network },
  { href: "/dashboards/management", label: "综合看板", icon: BarChart3 },
  { href: "/dashboards/product-breakthrough", label: "单品突破", icon: Target },
  { href: "/dashboards/audience-plan", label: "人群计划", icon: LineChart },
  { href: "/dashboards/business-diagnosis", label: "业务诊断", icon: Activity },
  { href: "/imports", label: "数据导入", icon: DatabaseZap },
  { href: "/prefill", label: "预填写表", icon: Settings2 },
  { href: "/tools", label: "AI 工具", icon: Puzzle },
  { href: "/models", label: "模型网关", icon: Network }
];

// 管理版 = 租户版全部功能 + 多一个「管理」入口
const ADMIN_NAV = [...TENANT_NAV, { href: "/management", label: "管理", icon: Brain }];

export function AppShell({
  children,
  role,
  userName,
  shopSwitcher
}: {
  children: ReactNode;
  role: Role;
  userName: string;
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
          aria-label="三阶引擎"
          onClick={() => setSidebarOpen(false)}
        >
          <span className="brand-mark">
            <BarChart3 size={23} />
          </span>
          <span>
            <strong>三阶引擎</strong>
            <small>{role === "admin" ? "管理版" : "租户版"}</small>
          </span>
        </Link>
        <ShopSwitcher {...shopSwitcher} />
        <nav className="nav-list" aria-label="主导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                className={clsx("nav-item", active && "active")}
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
          <span>三阶引擎</span>
        </div>
        {children}
      </main>
    </div>
  );
}
