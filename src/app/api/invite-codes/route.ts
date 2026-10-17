import { NextResponse } from "next/server";
import { requireAdminResponse } from "@/lib/route-guards";
import {
  createInviteCode,
  getInviteCodes,
  UserManagementAccessError,
  UserManagementInputError
} from "@/lib/store/user-store";

const headers = { "Cache-Control": "private, no-store" };

export async function GET() {
  const forbidden = await requireAdminResponse();
  if (forbidden) {
    forbidden.headers.set("Cache-Control", headers["Cache-Control"]);
    return forbidden;
  }
  try {
    return NextResponse.json({
      data: {
        invites: await getInviteCodes()
      }
    }, { headers });
  } catch (error) {
    if (error instanceof UserManagementAccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers });
    }
    throw error;
  }
}

export async function POST(request: Request) {
  const forbidden = await requireAdminResponse();
  if (forbidden) {
    forbidden.headers.set("Cache-Control", headers["Cache-Control"]);
    return forbidden;
  }
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "note" && key !== "maxUses")) {
    return NextResponse.json({ error: "请提交有效的邀请码对象" }, { status: 400, headers });
  }
  const input = body as Record<string, unknown>;
  const note = input.note === undefined ? "" : input.note;
  if (typeof note !== "string" || note.length > 200) {
    return NextResponse.json({ error: "备注必须是 200 字以内的文本" }, { status: 400, headers });
  }
  const maxUses = input.maxUses === undefined ? 1 : input.maxUses;
  if (typeof maxUses !== "number" || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 99) {
    return NextResponse.json({ error: "可用次数必须是 1 到 99 的整数" }, { status: 400, headers });
  }

  try {
    const invite = await createInviteCode({ note, maxUses });
    return NextResponse.json({ data: { invite } }, { status: 201, headers });
  } catch (error) {
    if (error instanceof UserManagementInputError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers });
    }
    if (error instanceof UserManagementAccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers });
    }
    throw error;
  }
}
