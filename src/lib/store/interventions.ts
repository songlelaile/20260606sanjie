import "server-only";
import { prisma } from "@/lib/db";
import { normalizeDate } from "@/lib/imports/map-rows";
import { getServerSession, requireTenantId } from "@/lib/session-server";
import type { Intervention } from "@/lib/types/domain";

/** 运营手动标记的"优化动作"（v2 前后对比锚点）的增删改查，全部租户隔离。 */

function toDomain(row: {
  id: string;
  date: string;
  title: string;
  note: string;
  category: string;
  productIds: unknown;
  createdBy: string;
  createdAt: Date;
}): Intervention {
  return {
    id: row.id,
    date: row.date,
    title: row.title,
    note: row.note,
    category: row.category,
    productIds: Array.isArray(row.productIds) ? (row.productIds as string[]) : [],
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString()
  };
}

export async function getInterventions(): Promise<Intervention[]> {
  const tenantId = await requireTenantId();
  const rows = await prisma.intervention.findMany({
    where: { tenantId },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }]
  });
  return rows.map(toDomain);
}

export type InterventionResult =
  | { ok: true; intervention: Intervention }
  | { ok: false; error: string; status: number };

export async function createIntervention(input: {
  date: string;
  title: string;
  note?: string;
  category?: string;
  productIds?: string[];
}): Promise<InterventionResult> {
  const tenantId = await requireTenantId();
  const session = await getServerSession();
  const date = normalizeDate(input.date);
  if (!date) {
    return { ok: false, error: "请填写合法的动作日期", status: 400 };
  }
  const title = input.title.trim();
  if (!title) {
    return { ok: false, error: "请填写动作标题", status: 400 };
  }
  const row = await prisma.intervention.create({
    data: {
      tenantId,
      date,
      title,
      note: input.note?.trim() ?? "",
      category: input.category?.trim() ?? "",
      productIds: Array.isArray(input.productIds) ? input.productIds : [],
      createdBy: session?.name ?? ""
    }
  });
  return { ok: true, intervention: toDomain(row) };
}

async function guardOwn(id: string): Promise<{ tenantId: string } | { error: string; status: number }> {
  const tenantId = await requireTenantId();
  const row = await prisma.intervention.findUnique({ where: { id } });
  if (!row || row.tenantId !== tenantId) {
    return { error: "动作不存在", status: 404 };
  }
  return { tenantId };
}

export async function updateIntervention(
  id: string,
  patch: { date?: string; title?: string; note?: string; category?: string; productIds?: string[] }
): Promise<InterventionResult> {
  const guard = await guardOwn(id);
  if ("error" in guard) {
    return { ok: false, error: guard.error, status: guard.status };
  }
  const data: Record<string, unknown> = {};
  if (patch.date !== undefined) {
    const date = normalizeDate(patch.date);
    if (!date) {
      return { ok: false, error: "请填写合法的动作日期", status: 400 };
    }
    data.date = date;
  }
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) {
      return { ok: false, error: "请填写动作标题", status: 400 };
    }
    data.title = title;
  }
  if (patch.note !== undefined) data.note = patch.note.trim();
  if (patch.category !== undefined) data.category = patch.category.trim();
  if (patch.productIds !== undefined) data.productIds = patch.productIds;

  const row = await prisma.intervention.update({ where: { id }, data });
  return { ok: true, intervention: toDomain(row) };
}

export async function deleteIntervention(
  id: string
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const guard = await guardOwn(id);
  if ("error" in guard) {
    return { ok: false, error: guard.error, status: guard.status };
  }
  await prisma.intervention.delete({ where: { id } });
  return { ok: true };
}
