import { NextResponse } from "next/server";
import { gradeRows, lifecycleColumns } from "@/lib/algorithm/three-stage";
import {
  getGrowthProfitConfig,
  getWorkspaceContext,
  updateGrowthProfitConfig
} from "@/lib/store/runtime-store";
import type { GrowthProfitConfigRow } from "@/lib/types/domain";

export async function GET() {
  return NextResponse.json({
    data: {
      config: await getGrowthProfitConfig()
    }
  });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { cycleId?: string; config?: GrowthProfitConfigRow[] }
    | null;
  const validation = validateGrowthProfitConfig(body?.config);

  if (!validation.ok) {
    return NextResponse.json({ error: validation.errors.join("；") }, { status: 400 });
  }

  const { cycle } = await getWorkspaceContext();
  const config = await updateGrowthProfitConfig(body?.cycleId ?? cycle.id, validation.config);
  return NextResponse.json({ data: { config } });
}

function validateGrowthProfitConfig(config: unknown) {
  if (!Array.isArray(config)) {
    return { ok: false as const, errors: ["config 必须是数组"], config: [] };
  }

  const errors: string[] = [];
  const rows = config as GrowthProfitConfigRow[];
  for (const grade of gradeRows) {
    const row = rows.find((item) => item.grade === grade);
    if (!row) {
      errors.push(`缺少 ${grade} 级配置`);
      continue;
    }

    for (const lifecycle of lifecycleColumns) {
      const value = Number(row.values?.[lifecycle]);
      if (!Number.isFinite(value)) {
        errors.push(`${grade} 级 ${lifecycle} 不是有效数字`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false as const, errors, config: [] };
  }

  return {
    ok: true as const,
    errors: [],
    config: gradeRows.map((grade) => {
      const row = rows.find((item) => item.grade === grade);
      return {
        grade,
        values: Object.fromEntries(
          lifecycleColumns.map((lifecycle) => [lifecycle, Number(row?.values[lifecycle])])
        ) as GrowthProfitConfigRow["values"]
      };
    })
  };
}
