import { CirclePlay, LayoutGrid } from "lucide-react";
import Link from "next/link";
import { TOOL_TUTORIALS } from "@/lib/tool-tutorials";

const ITEMS = [
  {
    key: "overview",
    href: "/tools",
    label: "工具总览",
    description: "下载、能力与使用说明",
    icon: LayoutGrid
  },
  {
    key: "tutorials",
    href: "/tools/tutorials",
    label: "视频教程",
    description: "按真实任务一步步上手",
    badge: `${TOOL_TUTORIALS.length} 条教程`,
    icon: CirclePlay
  }
] as const;

export type ToolsSubnavKey = (typeof ITEMS)[number]["key"];

export function ToolsSubnav({ active }: { active: ToolsSubnavKey }) {
  return (
    <nav className="tools-subnav" aria-label="AI 工具二级导航">
      <span className="tools-subnav-label">学习与使用</span>
      <div className="tools-subnav-links">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const current = active === item.key;

          return (
            <Link
              key={item.key}
              href={item.href}
              prefetch={false}
              aria-current={current ? "page" : undefined}
              className={`tools-subnav-link${current ? " is-active" : ""}`}
            >
              <span className="tools-subnav-icon" aria-hidden="true">
                <Icon size={19} />
              </span>
              <span className="tools-subnav-copy">
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
              {"badge" in item ? <em>{item.badge}</em> : null}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
