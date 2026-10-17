import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn() }));
vi.mock("@/lib/server-session", () => ({ getCurrentSession: mocks.session }));
vi.mock("@/lib/creative-entitlements", () => ({ getCreativeAccessForSession: mocks.access }));
import { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS } from "./route";

let fixture: string;
let rootAliasFixture: string;
let responses: Response[];
const session = { username: "customer", role: "tenant", tenantId: "tenant", name: "Customer" };
const archive = Buffer.from([80, 75, 3, 4, 0, 255, 10, 20, 30]);
const bigArchive = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
const historical = ["sycm-keyword-collector-v1.8.5.zip", "sycm-keyword-collector-v1.9.23.zip"];
const mainPackage = "sycm-keyword-collector-v9.0.0.zip";
const largePackage = "shaozhuang-ai-v9.0.0-macos-full.zip";
const nestedPackage = "sycm-keyword-collector-v9.0.1.zip";
const nestedAlias = "sycm-keyword-collector-v9.0.2.zip";
const internalAlias = "sycm-keyword-collector-v9.0.3.zip";
const escapePackage = "sycm-keyword-collector-v9.0.4.zip";
const prefixEscape = "sycm-keyword-collector-v9.0.5.zip";
const disguisedPackage = "sycm-keyword-collector-v9.0.6.zip";
const directoryPackage = "sycm-keyword-collector-v9.0.7.zip";
const directoryAlias = "sycm-keyword-collector-v9.0.8.zip";
const pipePackage = "sycm-keyword-collector-v9.0.9.zip";
const fifoSupported = process.platform !== "win32";
const call = async (parts: string | string[], method: "GET" | "HEAD" = "GET") => {
  const value = typeof parts === "string" ? parts.split("/") : parts;
  const response = await (method === "HEAD" ? HEAD : GET)(
    new Request("https://site.test/api/protected-downloads/test.zip", { method }),
    { params: Promise.resolve({ path: value }) }
  );
  responses.push(response);
  return response;
};

function privateHeaders(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
}

describe("historical downloads require current workspace authorization", () => {
  beforeAll(async () => {
    fixture = await mkdtemp(path.join(os.tmpdir(), "protected-downloads-test-"));
    const root = path.join(fixture, "public/downloads");
    await mkdir(path.join(root, "nested"), { recursive: true });
    await mkdir(path.join(root, directoryPackage));
    await mkdir(path.join(fixture, "public/downloads-sibling"));
    await writeFile(path.join(root, mainPackage), archive);
    await writeFile(path.join(root, largePackage), bigArchive);
    await writeFile(path.join(root, "nested", nestedPackage), archive);
    await writeFile(path.join(root, "unknown.zip"), "unrelated product archive");
    await writeFile(path.join(root, ".env"), "private provider secret");
    await writeFile(path.join(fixture, escapePackage), "private outside archive");
    await writeFile(path.join(fixture, "public/downloads-sibling", prefixEscape), "private sibling archive");
    for (const name of historical) await writeFile(path.join(root, name), archive);
    await symlink(path.join(fixture, escapePackage), path.join(root, escapePackage));
    await symlink(path.join(fixture, "public/downloads-sibling", prefixEscape), path.join(root, prefixEscape));
    await symlink(path.join(root, ".env"), path.join(root, disguisedPackage));
    await symlink(path.join(root, mainPackage), path.join(root, internalAlias));
    await symlink(path.join(root, "nested", nestedPackage), path.join(root, nestedAlias));
    await symlink(path.join(root, directoryPackage), path.join(root, directoryAlias));
    rootAliasFixture = path.join(fixture, "root-alias-workspace");
    await mkdir(path.join(rootAliasFixture, "public"), { recursive: true });
    await symlink(root, path.join(rootAliasFixture, "public/downloads"));
    if (fifoSupported) {
      const created = spawnSync("mkfifo", [path.join(root, pipePackage)], { encoding: "utf8" });
      if (created.status !== 0) throw new Error(created.error?.message || created.stderr);
    }
  });
  afterAll(async () => { await rm(fixture, { recursive: true, force: true }); });
  beforeEach(() => {
    responses = [];
    vi.clearAllMocks();
    vi.spyOn(process, "cwd").mockReturnValue(fixture);
    mocks.session.mockResolvedValue(session);
    mocks.access.mockResolvedValue({ allowed: true, reason: "paid" });
  });
  afterEach(async () => {
    for (const response of responses) await response.body?.cancel().catch(() => {});
    vi.restoreAllMocks();
  });

  it.each([mainPackage, largePackage, ...historical, "unknown.zip"])("denies anonymous access to %s without checking files", async name => {
    mocks.session.mockResolvedValue(null);
    const response = await call(name);
    expect(response.status).toBe(401);
    expect(mocks.access).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("PK");
    privateHeaders(response);
  });

  it("uses the same authentication failure for an anonymous unknown archive", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await call("missing.zip")).status).toBe(401);
    expect((await call("../outside.zip")).status).toBe(401);
  });

  it("checks current entitlement on every request, including HEAD and old versions", async () => {
    const downloaded = await call(historical[0]);
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(archive);
    mocks.access.mockResolvedValueOnce({ allowed: false, reason: "payment_required" });
    const unpaid = await call(historical[1]);
    expect(unpaid.status).toBe(402); privateHeaders(unpaid);
    mocks.access.mockResolvedValueOnce({ allowed: false, reason: "invalid_account" });
    const revoked = await call(mainPackage, "HEAD");
    expect(revoked.status).toBe(401);
    expect(revoked.body).toBeNull(); privateHeaders(revoked);
    expect(mocks.access).toHaveBeenCalledTimes(3);
    expect(mocks.access).toHaveBeenCalledWith(session);
  });

  it.each(["payment_required", "expired"])("denies downloads when entitlement is %s", async reason => {
    mocks.access.mockResolvedValue({ allowed: false, reason });
    const response = await call(mainPackage);
    expect(response.status).toBe(402); privateHeaders(response);
  });

  it("fails closed with 503 when the authorization database rejects", async () => {
    mocks.access.mockRejectedValue(new Error("private database details"));
    const response = await call(mainPackage);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private database details");
    privateHeaders(response);
  });

  it("fails closed with 503 when access is explicitly unavailable", async () => {
    mocks.access.mockResolvedValue({ allowed: false, reason: "unavailable" });
    const response = await call(mainPackage, "HEAD");
    expect(response.status).toBe(503); expect(response.body).toBeNull(); privateHeaders(response);
  });

  it("fails closed when the session service rejects", async () => {
    mocks.session.mockRejectedValue(new Error("private session details"));
    const response = await call(mainPackage);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private session details");
    expect(mocks.access).not.toHaveBeenCalled(); privateHeaders(response);
  });

  it("serves the original bytes with attachment and exact size metadata", async () => {
    const response = await call(mainPackage);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(archive);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Length")).toBe(String(archive.byteLength));
    expect(response.headers.get("Content-Disposition")).toBe(`attachment; filename="${mainPackage}"; filename*=UTF-8''${mainPackage}`);
    privateHeaders(response);
  });

  it("HEAD returns size and attachment metadata without an archive body", async () => {
    const response = await call(largePackage, "HEAD");
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
    expect(response.headers.get("Content-Length")).toBe(String(bigArchive.byteLength));
    expect(response.headers.get("Content-Disposition")).toContain(`filename="${largePackage}"`);
    privateHeaders(response);
  });

  it("streams a large archive in bounded chunks while retaining its checksum", async () => {
    const response = await call(largePackage);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const digest = createHash("sha256");
    let chunks = 0, total = 0, largest = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks += 1; total += value.byteLength; largest = Math.max(largest, value.byteLength);
        digest.update(value);
      }
    } finally { reader.releaseLock(); }
    expect(chunks).toBeGreaterThan(1);
    expect(largest).toBeLessThan(bigArchive.byteLength);
    expect(total).toBe(bigArchive.byteLength);
    expect(digest.digest("hex")).toBe(createHash("sha256").update(bigArchive).digest("hex"));
  });

  it.each([internalAlias, nestedAlias])("rejects a contained ZIP symlink alias even with an authorized product name: %s", async name => {
    const response = await call(name);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "资源不存在" });
    expect((await call(name, "HEAD")).status).toBe(404); privateHeaders(response);
  });

  it("retains an existing symlink to the public download root while rejecting file aliases", async () => {
    vi.mocked(process.cwd).mockReturnValue(rootAliasFixture);
    const response = await call(mainPackage);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(archive);
    expect((await call(internalAlias)).status).toBe(404);
  });

  it.each(["unknown.zip", "main.zip", "other-tool-v1.0.0.zip", "shaozhuang-ai-v1.0.0.zip",
    "sycm-keyword-collector-v1.0.0-macos-full.zip", "sycm-keyword-collector-v1.0.zip",
    "sycm-keyword-collector-v01.0.0.zip", "sycm-keyword-collector-v1.0.0-beta.zip"
  ])("does not grant unrelated or unreviewed ZIP products through creative authorization: %s", async name => {
    const response = await call(name);
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: "资源不存在" }); privateHeaders(response);
  });

  it.each([
    [], ["nested", nestedPackage], ["..", escapePackage], [`../${escapePackage}`],
    ["%2e%2e%2Foutside.zip"], ["main.zip.map"], [".env"], ["main.zip\r\nX-Leak: yes"],
    ["hello zip.zip"], ["商品.zip"], ["/tmp/outside.zip"], ["...zip"], ["empty..zip"],
    ["main.ZIP"], [".hidden.zip"], ["main.zip/"], ["a".repeat(201) + ".zip"],
    [escapePackage], [prefixEscape], [disguisedPackage], [directoryPackage],
    [directoryAlias], ["sycm-keyword-collector-v9.9.9.zip"]
  ])("returns the same safe 404 for a disallowed archive path: %j", async (...parts) => {
    // it.each spreads each row; reconstruct the path array passed to Next.
    const response = await call(parts as string[]);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "资源不存在" });
    privateHeaders(response);
  });

  it("HEAD missing-file errors contain no body", async () => {
    const response = await call("sycm-keyword-collector-v9.9.9.zip", "HEAD");
    expect(response.status).toBe(404); expect(response.body).toBeNull(); privateHeaders(response);
  });

  it.skipIf(!fifoSupported)("rejects a named pipe without blocking the request", async () => {
    const response = await call(pipePackage);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "资源不存在" });
    privateHeaders(response);
  }, 1000);

  it.each([POST, PUT, PATCH, DELETE, OPTIONS])("rejects every exported write/options method", handler => {
    const response = handler();
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
    privateHeaders(response);
    expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.access).not.toHaveBeenCalled();
  });
});
