import "server-only";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { SowerWorkAccessError } from "@/lib/sower-work-entitlements";
import { SOWER_WORK_PACKAGE_PARTS } from "@/lib/sower-work-product";

export async function readSowerWorkPackage() {
  try {
    const bytes = await readFile(path.join(process.cwd(), ...SOWER_WORK_PACKAGE_PARTS));
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("Invalid ZIP");
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch {
    throw new SowerWorkAccessError(503, "PACKAGE_UNAVAILABLE", "Sower Work 安装包暂未就绪，请稍后重试");
  }
}
