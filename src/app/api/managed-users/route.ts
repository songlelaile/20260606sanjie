import { NextResponse } from "next/server";
import { getManagedUsers } from "@/lib/store/runtime-store";

export async function GET() {
  return NextResponse.json({
    data: {
      users: getManagedUsers()
    }
  });
}
