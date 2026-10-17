import { NextResponse } from "next/server";
import { getCurrentSession, getCurrentUser } from "@/lib/server-session";
import { getCreativeAccessForSession } from "@/lib/creative-entitlements";
import { creativeImageReceiptStore, parseCreativeImageReceiptQuery, CreativeImageReceiptError } from "@/lib/creative-image-receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request, context: { params: Promise<{ receiptId: string }> }) {
  try {
    const session = await getCurrentSession();
    if (!session || !(await getCreativeAccessForSession(session)).allowed) {
      return NextResponse.json({ error: "请登录当前账号查看原图片回执。", code: "IMAGE_RECEIPT_AUTH_REQUIRED", stateUncertain: true }, { status: 401, headers: PRIVATE_HEADERS });
    }
    const owner = await getCurrentUser();
    if (!owner || owner.tenantId !== session.tenantId || owner.username !== session.username) {
      return NextResponse.json({ error: "登录账号已变化，请保留原任务并核对账号。", code: "IMAGE_RECEIPT_ACCOUNT_CHANGED", stateUncertain: true }, { status: 401, headers: PRIVATE_HEADERS });
    }
    const { receiptId } = await context.params;
    const identity = parseCreativeImageReceiptQuery(request, receiptId, owner);
    const descriptor = await creativeImageReceiptStore.descriptor(owner.id, identity);
    return NextResponse.json(descriptor, { headers: PRIVATE_HEADERS });
  } catch (error) {
    const known = error instanceof CreativeImageReceiptError;
    return NextResponse.json({ error: known && error.code === "IMAGE_RECEIPT_EXPIRED" ? "原图片缓存读取期限已到，请保留原任务与已有归档结果，核对回执后再处理。" : "原图片回执仍需核对，请保留原任务，避免重复提交。",
      code: known ? error.code : "IMAGE_RECEIPT_UNAVAILABLE", stateUncertain: true }, { status: known ? error.status : 503, headers: PRIVATE_HEADERS });
  }
}
