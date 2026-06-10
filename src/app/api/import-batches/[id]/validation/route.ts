import { NextResponse } from "next/server";
import { getImportBatch } from "@/lib/store/runtime-store";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const batch = await getImportBatch(id);
  if (!batch) {
    return NextResponse.json({ error: "未找到导入批次" }, { status: 404 });
  }
  return NextResponse.json({ data: { validation: batch.validation } });
}
