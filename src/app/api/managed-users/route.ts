import { NextResponse } from "next/server";
import { requireAdminResponse } from "@/lib/route-guards";
import { getManagedUsers, UserManagementAccessError } from "@/lib/store/user-store";

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
        users: await getManagedUsers()
      }
    }, { headers });
  } catch (error) {
    if (error instanceof UserManagementAccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers });
    }
    throw error;
  }
}
