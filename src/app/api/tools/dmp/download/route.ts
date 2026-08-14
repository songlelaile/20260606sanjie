import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  DMP_AUTOMATION_DOWNLOAD_NAME,
  DMP_AUTOMATION_PACKAGE_PARTS
} from "@/lib/dmp-product";
import { getServerSession } from "@/lib/session-server";
import { getDmpAutomationAccessForSession } from "@/lib/tool-entitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET() {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: "请先登录" }, { status: 401, headers: PRIVATE_HEADERS });
  }

  const access = await getDmpAutomationAccessForSession(session).catch(() => null);
  if (!access?.allowed) {
    const error = access?.status === "expired"
      ? "达摩盘 AI 自动化的 30 天授权已到期，请联系管理员付费续费"
      : "该账号尚未开通达摩盘 AI 自动化，请联系管理员付费开通";
    return NextResponse.json(
      { error },
      { status: 403, headers: PRIVATE_HEADERS }
    );
  }

  const packagePath = path.join(process.cwd(), ...DMP_AUTOMATION_PACKAGE_PARTS);
  const file = await readFile(packagePath);
  return new NextResponse(new Uint8Array(file), {
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "application/zip",
      "Content-Length": String(file.byteLength),
      "Content-Disposition": `attachment; filename="dmp-automation.zip"; filename*=UTF-8''${encodeURIComponent(DMP_AUTOMATION_DOWNLOAD_NAME)}`,
      "X-Content-Type-Options": "nosniff"
    }
  });
}
