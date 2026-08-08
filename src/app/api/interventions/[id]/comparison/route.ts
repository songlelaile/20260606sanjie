import { NextResponse } from "next/server";
import {
  buildAudienceComparison,
  buildInterventionComparison,
  buildProductComparison
} from "@/lib/store/runtime-store";

function clampDays(value: string | null, fallback: number): number {
  if (value === null || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(90, Math.max(1, Math.round(n)));
}

/**
 * 优化动作前后对比。view 决定视角：
 *  - overview（默认）：三口径（经营复盘/综合看板用）
 *  - product：单品突破——逐商品前后变化
 *  - audience：人群计划——逐(计划·人群)前后变化
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(request.url);
  // 前后窗必须等长；保留 before/after 只为兼容旧链接，并统一取较保守的较短窗口。
  const explicitDays = url.searchParams.get("days");
  const legacyBefore = clampDays(url.searchParams.get("before"), 7);
  const legacyAfter = clampDays(url.searchParams.get("after"), 7);
  const days = explicitDays === null
    ? Math.min(legacyBefore, legacyAfter)
    : clampDays(explicitDays, 7);
  const view = url.searchParams.get("view") ?? "overview";

  if (view === "product") {
    const data = await buildProductComparison(id, days, days);
    if (!data) return NextResponse.json({ error: "动作不存在" }, { status: 404 });
    return NextResponse.json({ data: { product: data } });
  }
  if (view === "audience") {
    const data = await buildAudienceComparison(id, days, days);
    if (!data) return NextResponse.json({ error: "动作不存在" }, { status: 404 });
    return NextResponse.json({ data: { audience: data } });
  }

  const comparison = await buildInterventionComparison(id, days, days);
  if (!comparison) {
    return NextResponse.json({ error: "动作不存在" }, { status: 404 });
  }
  return NextResponse.json({ data: { comparison } });
}
