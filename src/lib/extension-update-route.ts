import "server-only";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/session-server";
import { getDmpAutomationAccessForSession } from "@/lib/tool-entitlements";
import { DMP_AUTOMATION_NAME } from "@/lib/dmp-product";
import { encodeAiUpdatePackage } from "@/lib/ai-update-package-transport";

export type ExtensionUpdateProduct = "ai-automation" | "dmp-collector";

const VERSION = /^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){2,3}$/;
const MAX_LATEST_BYTES = 64 * 1024;
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const BOOTSTRAP = {
  "ai-automation": { name: "少壮AI自动化", version: "1.9.60.1" },
  "dmp-collector": { name: "达摩盘一体化自动取数", version: "2.3.60.1" }
};
const BASE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff"
};

function isProduct(value: string): value is ExtensionUpdateProduct {
  return value === "ai-automation" || value === "dmp-collector";
}

function isVersion(value: string) {
  return VERSION.test(value) && value.split(".").every((part) => Number(part) <= 65535);
}

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: BASE_HEADERS });
}

function assertSignedEnvelope(bytes: Buffer, product: ExtensionUpdateProduct, version?: string) {
  const envelope = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (!envelope || Array.isArray(envelope) || typeof envelope !== "object"
    || typeof envelope.payloadB64 !== "string" || !envelope.payloadB64
    || typeof envelope.signatureB64 !== "string"
    || Buffer.from(envelope.payloadB64, "base64").toString("base64") !== envelope.payloadB64
    || Buffer.from(envelope.signatureB64, "base64").length !== 64
    || Buffer.from(envelope.signatureB64, "base64").toString("base64") !== envelope.signatureB64) {
    throw new Error("Invalid signed update envelope");
  }
  const payload = JSON.parse(Buffer.from(envelope.payloadB64, "base64").toString("utf8")) as Record<string, unknown>;
  if (!payload || Array.isArray(payload) || typeof payload !== "object"
    || payload.productId !== product || typeof payload.version !== "string" || !isVersion(payload.version)
    || (version !== undefined && payload.version !== version)
    || payload.schema !== (version === undefined ? "SZ_EXTENSION_CHANNEL_V1" : "SZ_EXTENSION_PACKAGE_V1")
    || (version !== undefined && (payload.updaterProtocol !== 1 || !Array.isArray(payload.files)
      || !envelope.files || Array.isArray(envelope.files) || typeof envelope.files !== "object"))) {
    throw new Error("Update artifact does not match its route");
  }
  // The signing/release gate and the installed extension verify Ed25519.
  // Serve original bytes: reserializing would change the package digest.
}

/** Uses the existing website Cookie session and database-backed DMP entitlement. */
export async function serveExtensionUpdate(product: string, version?: string, acceptEncoding?: string | null) {
  if (!isProduct(product) || (version !== undefined && !isVersion(version))) {
    return errorResponse("未找到更新文件", 404);
  }
  return serveArtifact(product, version === undefined ? "latest.json" : `${version}.json`, version, false, acceptEncoding);
}

/** A separately labelled one-time migration/UAT ZIP, never the latest product download. */
export async function serveExtensionBootstrap(product: string) {
  if (!isProduct(product)) return errorResponse("未找到更新文件", 404);
  return serveArtifact(product, "bootstrap.zip", undefined, true);
}

async function serveArtifact(product: ExtensionUpdateProduct, fileName: string, version?: string, bootstrap = false, acceptEncoding?: string | null) {

  if (product === "dmp-collector") {
    const session = await getServerSession().catch(() => null);
    if (!session) return errorResponse("请先在当前浏览器登录官网，再检查更新", 401);
    const access = await getDmpAutomationAccessForSession(session).catch(() => null);
    if (!access?.allowed) {
      return errorResponse(access?.status === "expired"
        ? `${DMP_AUTOMATION_NAME}的 30 天授权已到期，请联系管理员付费续费`
        : `该账号尚未开通${DMP_AUTOMATION_NAME}，请联系管理员付费开通`, 403);
    }
  }

  const assetPath = path.join(process.cwd(), "private-assets", "extension-updates", product, fileName);
  try {
    const maxBytes = !bootstrap && version === undefined ? MAX_LATEST_BYTES : MAX_PACKAGE_BYTES;
    const info = await stat(assetPath);
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes) {
      return errorResponse("更新文件暂不可用，请稍后重试", 503);
    }
    const bytes = await readFile(assetPath);
    if (bytes.length !== info.size || bytes.length > maxBytes) {
      return errorResponse("更新文件暂不可用，请稍后重试", 503);
    }
    if (bootstrap) {
      if (bytes.subarray(0, 4).toString("hex") !== "504b0304") throw new Error("Invalid bootstrap ZIP");
    } else {
      assertSignedEnvelope(bytes, product, version);
    }
    if (product === "ai-automation" && version !== undefined && !bootstrap) {
      const encoded = await encodeAiUpdatePackage(bytes, acceptEncoding ?? null);
      return new NextResponse(new Uint8Array(encoded.body), {
        headers: {
          ...BASE_HEADERS,
          ...encoded.headers,
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": String(encoded.body.length)
        }
      });
    }
    const downloadName = `${BOOTSTRAP[product].name}-仅迁移验收包-v${BOOTSTRAP[product].version}.zip`;
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        ...BASE_HEADERS,
        "Content-Type": bootstrap ? "application/zip" : "application/json; charset=utf-8",
        "Content-Length": String(bytes.length),
        ...(bootstrap ? {
          "Content-Disposition": `attachment; filename="${product}-migration-verification-v${BOOTSTRAP[product].version}.zip"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
        } : {})
      }
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return errorResponse("未找到更新文件", 404);
    }
    return errorResponse("更新文件暂不可用，请稍后重试", 503);
  }
}
