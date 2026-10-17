import { NextResponse } from "next/server";
import { receiveScanNotification } from "@/lib/model-gateway/scan-payment";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    await receiveScanNotification("wechat", request);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ code: "FAIL", message: "支付通知未通过核验" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
