import { NextResponse } from "next/server";
import {
  clearManagementHistory,
  deleteManagementHistoryBefore,
  deleteManagementHistoryRange,
  getManagementHistory,
  saveManagementHistoryReport,
  updateManagementHistoryRetention
} from "@/lib/store/runtime-store";
import type { HistoryDataKey } from "@/lib/types/domain";

const allowedKeys: HistoryDataKey[] = ["product", "promotionProduct", "promotionContent", "keyword", "audience"];

export async function GET() {
  return NextResponse.json({
    data: getManagementHistory()
  });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | {
        months?: number;
      }
    | null;

  const months = Number(body?.months);
  if (!Number.isInteger(months) || months < 0 || months > 120) {
    return NextResponse.json({ error: "历史保留月数必须是 0 到 120 的整数" }, { status: 400 });
  }

  return NextResponse.json({
    data: updateManagementHistoryRetention(months)
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | {
        name?: string;
        startDate?: string;
        endDate?: string;
        categories?: HistoryDataKey[];
      }
    | null;

  const name = body?.name?.trim();
  const startDate = parseDate(body?.startDate);
  const endDate = parseDate(body?.endDate);
  if (!name) {
    return NextResponse.json({ error: "报表名称不能为空" }, { status: 400 });
  }
  if (!startDate || !endDate || startDate.getTime() > endDate.getTime()) {
    return NextResponse.json({ error: "日期区间不合法" }, { status: 400 });
  }

  const categories = normalizeCategories(body?.categories);
  const report = saveManagementHistoryReport({
    name,
    startDate: toDateInput(startDate),
    endDate: toDateInput(endDate),
    categories
  });

  return NextResponse.json({
    data: {
      report,
      history: getManagementHistory()
    }
  });
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | {
        action?: "all" | "before" | "range";
        beforeDate?: string;
        startDate?: string;
        endDate?: string;
      }
    | null;

  const action = body?.action ?? "all";
  if (action === "before") {
    const beforeDate = parseDate(body?.beforeDate);
    if (!beforeDate) {
      return NextResponse.json({ error: "请选择要删除的开始日期" }, { status: 400 });
    }
    return NextResponse.json({
      data: deleteManagementHistoryBefore(toDateInput(beforeDate))
    });
  }

  if (action === "range") {
    const startDate = parseDate(body?.startDate);
    const endDate = parseDate(body?.endDate);
    if (!startDate || !endDate || startDate.getTime() > endDate.getTime()) {
      return NextResponse.json({ error: "请选择合法的日期区间" }, { status: 400 });
    }
    return NextResponse.json({
      data: deleteManagementHistoryRange(toDateInput(startDate), toDateInput(endDate))
    });
  }

  return NextResponse.json({
    data: clearManagementHistory()
  });
}

function normalizeCategories(categories: HistoryDataKey[] | undefined) {
  if (!Array.isArray(categories) || categories.length === 0) {
    return [...allowedKeys];
  }
  return allowedKeys.filter((key) => categories.includes(key));
}

function parseDate(value: string | undefined) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}
