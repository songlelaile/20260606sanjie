import { NextResponse } from "next/server";
import { requireAdminResponse } from "@/lib/route-guards";
import { createInviteCode, getInviteCodes } from "@/lib/store/runtime-store";

export async function GET() {
  const forbidden = await requireAdminResponse();
  if (forbidden) return forbidden;
  return NextResponse.json({
    data: {
      invites: await getInviteCodes()
    }
  });
}

export async function POST(request: Request) {
  const forbidden = await requireAdminResponse();
  if (forbidden) return forbidden;
  const body = (await request.json().catch(() => null)) as
    | {
        note?: string;
        maxUses?: number;
      }
    | null;

  const maxUses = Number(body?.maxUses ?? 1);
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 99) {
    return NextResponse.json({ error: "可用次数必须是 1 到 99 的整数" }, { status: 400 });
  }

  const invite = await createInviteCode({
    note: body?.note ?? "",
    maxUses
  });

  return NextResponse.json({ data: { invite } }, { status: 201 });
}
