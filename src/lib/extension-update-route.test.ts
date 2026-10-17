import path from "node:path";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(), getDmpAutomationAccessForSession: vi.fn(),
  readFile: vi.fn(), stat: vi.fn()
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-server", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("@/lib/tool-entitlements", () => ({ getDmpAutomationAccessForSession: mocks.getDmpAutomationAccessForSession }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile, stat: mocks.stat }));

import { GET as latest } from "@/app/api/tools/updates/[product]/latest/route";
import { GET as updatePackage } from "@/app/api/tools/updates/[product]/package/[version]/route";
import { GET as bootstrap } from "@/app/api/tools/updates/[product]/bootstrap/route";

const SESSION = { username: "entitled-user", role: "tenant", tenantId: "tenant-a" };
const request = new Request("https://shaozhuangai.com/api/tools/updates/ai-automation/latest");
const context = (product: string, version = "1.9.63") => ({ params: Promise.resolve({ product, version }) });
function artifact(productId: string, version = "1.9.63", isPackage = false) {
  const payload = { schema: isPackage ? "SZ_EXTENSION_PACKAGE_V1" : "SZ_EXTENSION_CHANNEL_V1",
    productId, version, ...(isPackage ? { updaterProtocol: 1, files: [] } : {}) };
  return Buffer.from(JSON.stringify({ payloadB64: Buffer.from(JSON.stringify(payload)).toString("base64"),
    signatureB64: Buffer.alloc(64, 1).toString("base64"), ...(isPackage ? { files: {} } : {}) }, null, 2) + "\n");
}
function available(bytes: Buffer) {
  mocks.stat.mockResolvedValue({ size: bytes.length, isFile: () => true });
  mocks.readFile.mockResolvedValue(bytes);
}

describe("extension update artifact delivery", () => {
  beforeEach(() => { Object.values(mocks).forEach((mock) => mock.mockReset()); });

  it.each([
    { isPackage: false, version: "1.9.63" },
    { isPackage: true, version: "1.9.63" },
    { isPackage: true, version: "1.9.62" },
    { isPackage: true, version: "1.9.61" }
  ])("serves the public AI artifact without changing signed bytes ($version, package=$isPackage)", async ({ isPackage, version }) => {
    const bytes = artifact("ai-automation", version, isPackage);
    available(bytes);
    const response = await (isPackage ? updatePackage : latest)(request, context("ai-automation", version));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(mocks.readFile).toHaveBeenCalledWith(path.join(process.cwd(), "private-assets", "extension-updates", "ai-automation", isPackage ? `${version}.json` : "latest.json"));
    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.getDmpAutomationAccessForSession).not.toHaveBeenCalled();
  });

  it("gzip-encodes an AI package while preserving the complete signed envelope after one decode", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload = Buffer.from(JSON.stringify({ schema: "SZ_EXTENSION_PACKAGE_V1", productId: "ai-automation", version: "1.9.72", updaterProtocol: 1, files: [] }));
    const bytes = Buffer.from(JSON.stringify({ payloadB64: payload.toString("base64"), signatureB64: sign(null, payload, privateKey).toString("base64"), files: {}, notes: "transport fixture ".repeat(1000) }, null, 2) + "\n");
    available(bytes);
    const gzipRequest = new Request(request.url, { headers: { "Accept-Encoding": "br, gzip, deflate" } });
    const response = await updatePackage(gzipRequest, context("ai-automation", "1.9.72"));
    const encoded = Buffer.from(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("content-length")).toBe(String(encoded.length));
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(encoded.length).toBeLessThan(bytes.length);
    const decoded = gunzipSync(encoded);
    expect(decoded).toEqual(bytes);
    expect(createHash("sha256").update(decoded).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
    const envelope = JSON.parse(decoded.toString());
    expect(verify(null, Buffer.from(envelope.payloadB64, "base64"), publicKey, Buffer.from(envelope.signatureB64, "base64"))).toBe(true);
    expect(mocks.getServerSession).not.toHaveBeenCalled();
  });

  it.each(["gzip;q=0", "br", "gzip;q=0, *;q=1"])("keeps exact AI package identity bytes when gzip is not accepted: %s", async (encoding) => {
    const bytes = artifact("ai-automation", "1.9.72", true);
    available(bytes);
    const response = await updatePackage(new Request(request.url, { headers: { "Accept-Encoding": encoding } }), context("ai-automation", "1.9.72"));
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it.each([latest, bootstrap])("does not change AI latest or bootstrap for gzip requests", async (handler) => {
    const bytes = handler === latest ? artifact("ai-automation") : Buffer.from("504b0304616263", "hex");
    available(bytes);
    const response = await handler(new Request(request.url, { headers: { "Accept-Encoding": "gzip" } }), context("ai-automation"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it("rechecks the source before serving an already-compressed AI package", async () => {
    const bytes = artifact("ai-automation", "1.9.72", true);
    available(bytes);
    const gzipRequest = new Request(request.url, { headers: { "Accept-Encoding": "gzip" } });
    expect((await updatePackage(gzipRequest, context("ai-automation", "1.9.72"))).status).toBe(200);
    mocks.stat.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
    expect((await updatePackage(gzipRequest, context("ai-automation", "1.9.72"))).status).toBe(404);
    available(artifact("ai-automation", "1.9.71", true));
    expect((await updatePackage(gzipRequest, context("ai-automation", "1.9.72"))).status).toBe(503);
  });

  it("keeps DMP response bytes and entitlement checks unchanged when gzip is requested", async () => {
    const bytes = artifact("dmp-collector", "2.3.61", true);
    available(bytes);
    const gzipRequest = new Request(request.url, { headers: { "Accept-Encoding": "gzip" } });
    mocks.getServerSession.mockResolvedValue(null);
    expect((await updatePackage(gzipRequest, context("dmp-collector", "2.3.61"))).status).toBe(401);
    expect(mocks.readFile).not.toHaveBeenCalled();
    mocks.getServerSession.mockResolvedValue(SESSION);
    mocks.getDmpAutomationAccessForSession.mockResolvedValue({ allowed: true });
    const response = await updatePackage(gzipRequest, context("dmp-collector", "2.3.61"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(mocks.getDmpAutomationAccessForSession).toHaveBeenCalledWith(SESSION);
  });

  it.each([latest, updatePackage, bootstrap])("requires Cookie login before reading any DMP artifact", async (handler) => {
    mocks.getServerSession.mockResolvedValue(null);
    const response = await handler(request, context("dmp-collector", "2.3.61"));
    expect(response.status).toBe(401);
    expect(mocks.getDmpAutomationAccessForSession).not.toHaveBeenCalled();
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it.each(["ungranted", "expired", "account_disabled", "database-error"])("fails closed for DMP %s access before any file read", async (status) => {
    mocks.getServerSession.mockResolvedValue(SESSION);
    if (status === "database-error") mocks.getDmpAutomationAccessForSession.mockRejectedValue(new Error("database unavailable"));
    else mocks.getDmpAutomationAccessForSession.mockResolvedValue({ allowed: false, status });
    for (const handler of [latest, updatePackage, bootstrap]) {
      const response = await handler(request, context("dmp-collector", "2.3.61"));
      expect(response.status).toBe(403);
      if (status === "expired") expect((await response.json()).error).toContain("已到期");
    }
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("serves the DMP package only after a fresh database entitlement check", async () => {
    const bytes = artifact("dmp-collector", "2.3.61", true);
    available(bytes);
    mocks.getServerSession.mockResolvedValue(SESSION);
    mocks.getDmpAutomationAccessForSession.mockResolvedValue({ allowed: true });
    const response = await updatePackage(request, context("dmp-collector", "2.3.61"));
    expect(response.status).toBe(200);
    expect(mocks.getDmpAutomationAccessForSession).toHaveBeenCalledWith(SESSION);
    expect(mocks.readFile).toHaveBeenCalledWith(path.join(process.cwd(), "private-assets", "extension-updates", "dmp-collector", "2.3.61.json"));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it.each(["ai-automation", "dmp-collector"])("labels the %s bootstrap ZIP as migration/verification only", async (product) => {
    const bytes = Buffer.from("504b0304616263", "hex");
    available(bytes);
    mocks.getServerSession.mockResolvedValue(SESSION);
    mocks.getDmpAutomationAccessForSession.mockResolvedValue({ allowed: true });
    const response = await bootstrap(request, context(product));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(decodeURIComponent(response.headers.get("content-disposition")!)).toContain("仅迁移验收包");
    expect(response.headers.get("content-disposition")).toContain(product === "ai-automation" ? "1.9.60.1" : "2.3.60.1");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(mocks.readFile).toHaveBeenCalledWith(path.join(process.cwd(), "private-assets", "extension-updates", product, "bootstrap.zip"));
  });

  it.each(["unknown", "AI-automation", "../dmp-collector", "ai-automation/extra"])("rejects product %s before auth or filesystem access", async (product) => {
    for (const handler of [latest, updatePackage, bootstrap]) {
      expect((await handler(request, context(product))).status).toBe(404);
    }
    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.stat).not.toHaveBeenCalled();
  });

  it.each(["../latest", "1.9.63/extra", "01.9.63", "1.9", "1.9.63.1.1", "65536.0.0", "1.9.63.json"])("rejects version %s before filesystem access", async (version) => {
    expect((await updatePackage(request, context("ai-automation", version))).status).toBe(404);
    expect(mocks.stat).not.toHaveBeenCalled();
  });

  it("returns a cache-safe 404 for missing artifacts", async () => {
    mocks.stat.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
    const response = await latest(request, context("ai-automation"));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it.each([Buffer.from("{}"), Buffer.from("not json"), artifact("dmp-collector"), artifact("ai-automation", "1.9.63", true)])("does not serve malformed or cross-route latest artifacts", async (bytes) => {
    available(bytes);
    expect((await latest(request, context("ai-automation"))).status).toBe(503);
  });

  it("does not serve a package with a version different from the request", async () => {
    available(artifact("ai-automation", "1.9.64", true));
    expect((await updatePackage(request, context("ai-automation", "1.9.63"))).status).toBe(503);
  });

  it("rejects oversized metadata before loading it into memory", async () => {
    mocks.stat.mockResolvedValue({ size: 65 * 1024, isFile: () => true });
    expect((await latest(request, context("ai-automation"))).status).toBe(503);
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("rejects an artifact that changes size between stat and read", async () => {
    available(artifact("ai-automation"));
    mocks.stat.mockResolvedValue({ size: 1, isFile: () => true });
    expect((await latest(request, context("ai-automation"))).status).toBe(503);
  });
});
