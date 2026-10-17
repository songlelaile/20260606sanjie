import { NextResponse } from "next/server";
import { getCurrentSession, getCurrentUser } from "@/lib/server-session";
import { getCreativeAccessForSession } from "@/lib/creative-entitlements";
import { creativeImageReceiptStore, parseCreativeImageReceiptQuery, CreativeImageReceiptError } from "@/lib/creative-image-receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request, context: { params: Promise<{ receiptId: string; index: string }> }) {
  try {
    const session = await getCurrentSession();
    if (!session || !(await getCreativeAccessForSession(session)).allowed) {
      return NextResponse.json({ error: "请登录当前账号查看原图片。", code: "IMAGE_RECEIPT_AUTH_REQUIRED", stateUncertain: true }, { status: 401, headers: PRIVATE_HEADERS });
    }
    const owner = await getCurrentUser();
    if (!owner || owner.tenantId !== session.tenantId || owner.username !== session.username) {
      return NextResponse.json({ error: "登录账号已变化，请保留原任务并核对账号。", code: "IMAGE_RECEIPT_ACCOUNT_CHANGED", stateUncertain: true }, { status: 401, headers: PRIVATE_HEADERS });
    }
    const { receiptId, index } = await context.params;
    const identity = parseCreativeImageReceiptQuery(request, receiptId, owner);
    if (!/^(?:[0-9]|1[0-9])$/.test(index)) throw new CreativeImageReceiptError("IMAGE_RECEIPT_CONTENT_NOT_FOUND", 404, "原图片内容未找到。");
    const media = await creativeImageReceiptStore.content(owner.id, identity, Number(index));
    // URL-only results stay original remote URLs in the descriptor. This route
    // never fetches or redirects to a provider/resource outside this origin.
    if (media.kind !== "binary") throw new CreativeImageReceiptError("IMAGE_RECEIPT_CONTENT_NOT_FOUND", 404, "原图片内容未找到。");
    return new NextResponse(new Uint8Array(media.bytes), { headers: { ...PRIVATE_HEADERS, "Content-Type": media.mime,
      "Content-Length": String(media.bytes.length), "X-Sanjie-Image-Content-Sha256": media.sha256 } });
  } catch (error) {
    const known = error instanceof CreativeImageReceiptError;
    return NextResponse.json({ error: "原图片内容仍需核对，请保留原任务与已有归档结果。", code: known ? error.code : "IMAGE_RECEIPT_UNAVAILABLE", stateUncertain: true },
      { status: known ? error.status : 503, headers: PRIVATE_HEADERS });
  }
}
