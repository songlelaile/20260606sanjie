"use client";

import clsx from "clsx";
import {
  BarChart3,
  Brain,
  DatabaseZap,
  Download,
  History,
  LineChart,
  Settings2,
  Target
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const navItems = [
  { href: "/dashboards/management", label: "综合看板", icon: BarChart3 },
  { href: "/dashboards/product-breakthrough", label: "单品突破", icon: Target },
  { href: "/dashboards/audience-plan", label: "人群计划", icon: LineChart },
  { href: "/imports", label: "数据导入", icon: DatabaseZap },
  { href: "/prefill", label: "预填写表", icon: Settings2 },
  { href: "/versions", label: "版本留痕", icon: History },
  { href: "/management", label: "管理", icon: Brain },
  { href: "/tools/keyword-collector", label: "关键词采集工具", icon: Download }
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/admin" className="brand" aria-label="三阶引擎管理后台">
          <span className="brand-mark">
            <BarChart3 size={23} />
          </span>
          <span>
            <strong>三阶引擎</strong>
            <small>经营决策 / 投放增长</small>
          </span>
        </Link>
        <nav className="nav-list" aria-label="主导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active =
              pathname === item.href || (item.href !== "/admin" && pathname.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href} className={clsx("nav-item", active && "active")}>
                <Icon size={18} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
