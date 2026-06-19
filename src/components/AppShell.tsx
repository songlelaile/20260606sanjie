"use client";

import clsx from "clsx";
import {
  BarChart3,
  Brain,
  DatabaseZap,
  LineChart,
  LogOut,
  Puzzle,
  Settings2,
  Target
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import type { Role } from "@/lib/auth";

const TENANT_NAV = [
  { href: "/dashboards/management", label: "综合看板", icon: BarChart3 },
  { href: "/dashboards/product-breakthrough", label: "单品突破", icon: Target },
  { href: "/dashboards/audience-plan", label: "人群计划", icon: LineChart },
  { href: "/imports", label: "数据导入", icon: DatabaseZap },
  { href: "/prefill", label: "预填写表", icon: Settings2 },
  { href: "/tools", label: "采集工具", icon: Puzzle }
];

// 管理版 = 租户版全部功能 + 多一个「管理」入口
const ADMIN_NAV = [...TENANT_NAV, { href: "/management", label: "管理", icon: Brain }];

export function AppShell({
  children,
  role,
  userName
}: {
  children: ReactNode;
  role: Role;
  userName: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const navItems = role === "admin" ? ADMIN_NAV : TENANT_NAV;
  const home = "/dashboards/management";

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href={home} className="brand" aria-label="三阶引擎">
          <span className="brand-mark">
            <BarChart3 size={23} />
          </span>
          <span>
            <strong>三阶引擎</strong>
            <small>{role === "admin" ? "管理版" : "租户版"}</small>
          </span>
        </Link>
        <nav className="nav-list" aria-label="主导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link key={item.href} href={item.href} className={clsx("nav-item", active && "active")}>
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
      <main className="main">{children}</main>
    </div>
  );
}
