import { NextResponse } from "next/server";
import { requireAdminResponse } from "@/lib/route-guards";
import { getManagedUsers } from "@/lib/store/runtime-store";

export async function GET() {
  const forbidden = await requireAdminResponse();
  if (forbidden) return forbidden;
  return NextResponse.json({
    data: {
      users: await getManagedUsers()
    }
  });
}
