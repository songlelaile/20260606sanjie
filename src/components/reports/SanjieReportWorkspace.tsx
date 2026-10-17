"use client";

import {
  BarChart3, Boxes, ChartNoAxesCombined, ChevronRight, ClipboardPenLine,
  FileClock, LayoutDashboard, Network, UploadCloud, Users, Workflow
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { Role } from "@/lib/auth";
import { getSanjieReportGroups, getSanjieReportPage } from "@/lib/sanjie-report-navigation";
import studioStyles from "@/components/creative/CreativeStudio.module.css";
import styles from "./SanjieReportWorkspace.module.css";

const ICONS = {
  overview: BarChart3,
  product: Boxes,
  audience: Users,
  network: Network,
  diagnosis: ChartNoAxesCombined,
  import: UploadCloud,
  prefill: ClipboardPenLine,
  workspace: LayoutDashboard,
  history: FileClock
};

export function SanjieReportWorkspace({ children, role }: { children: ReactNode; role: Role }) {
  const pathname = usePathname();
  const current = getSanjieReportPage(pathname, role);

  return (
    <section className={`reports-workspace ${styles.reports}`} aria-label="三阶报告工作台">
      <aside className={studioStyles.rail} aria-label="三阶报告功能">
        {getSanjieReportGroups(role).map((group) => (
          <div className={styles.group} key={group.label}>
            <p className={studioStyles.railTitle}>{group.label}</p>
            <nav className={studioStyles.navigation} aria-label={group.label}>
              {group.items.map((item) => {
                const selected = current?.href === item.href;
                const Icon = ICONS[item.icon];
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    prefetch={false}
                    aria-current={selected ? "page" : undefined}
                    className={`${studioStyles.navItem} ${selected ? studioStyles.active : ""}`}
                  >
                    <Icon size={17} aria-hidden="true" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
        ))}
      </aside>
      <div className={studioStyles.workspace}>
        <header className={studioStyles.toolbar}>
          <div className={studioStyles.breadcrumb}>
            <Workflow size={16} aria-hidden="true" />
            <span>三阶报告</span>
            <ChevronRight size={14} aria-hidden="true" />
            <strong>{current?.label ?? "综合看板"}</strong>
          </div>
          <Link
            className={`${studioStyles.batchButton} ${styles.action}`}
            href={current?.href === "/imports" ? "/prefill" : "/imports"}
            prefetch={false}
          >
            {current?.href === "/imports" ? <ClipboardPenLine size={16} aria-hidden="true" /> : <UploadCloud size={16} aria-hidden="true" />}
            {current?.href === "/imports" ? "填写参数" : "导入数据"}
          </Link>
        </header>
        <div className={styles.content} key={pathname}>{children}</div>
      </div>
    </section>
  );
}
