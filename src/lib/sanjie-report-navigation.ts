import type { Role } from "@/lib/auth";

export const SANJIE_REPORT_HOME = "/dashboards/management";

export const SANJIE_REPORT_GROUPS = [
  {
    label: "三张报表",
    items: [
      { href: SANJIE_REPORT_HOME, label: "综合看板", icon: "overview" },
      { href: "/dashboards/product-breakthrough", label: "单品突破", icon: "product" },
      { href: "/dashboards/audience-plan", label: "人群计划", icon: "audience" }
    ]
  },
  {
    label: "经营分析",
    items: [
      { href: "/reports/operating-network", label: "经营网络", icon: "network" },
      { href: "/dashboards/business-diagnosis", label: "业务诊断", icon: "diagnosis" }
    ]
  },
  {
    label: "数据管理",
    items: [
      { href: "/imports", label: "数据导入", icon: "import" },
      { href: "/prefill", label: "预填写表", icon: "prefill" }
    ]
  },
  {
    label: "管理留痕",
    adminOnly: true,
    items: [
      { href: "/admin", label: "工作区概览", icon: "workspace" },
      { href: "/versions", label: "版本留痕", icon: "history" }
    ]
  }
] as const;

export function getSanjieReportGroups(role: Role) {
  return SANJIE_REPORT_GROUPS.filter((group) => !("adminOnly" in group) || role === "admin");
}

export function getSanjieReportPage(pathname: string, role: Role) {
  for (const group of getSanjieReportGroups(role)) {
    for (const item of group.items) {
      if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
        return { ...item, group: group.label };
      }
    }
  }
  return null;
}

export function isSanjieReportPath(pathname: string, role: Role) {
  return pathname === "/reports" || pathname === "/dashboards/diagnostics" ||
    pathname === "/dashboards/product-opportunity" || Boolean(getSanjieReportPage(pathname, role));
}
