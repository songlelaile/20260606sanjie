import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn() }));
vi.mock("@/lib/server-session", () => ({ getCurrentSession: mocks.session }));
vi.mock("@/lib/creative-entitlements", () => ({ getCreativeAccessForSession: mocks.access }));
import { GET } from "./route";
import { CREATIVE_ENTRY_CSS, CREATIVE_ENTRY_HTML, CREATIVE_ENTRY_JS, CREATIVE_ENTRY_SCRIPTS, CREATIVE_ENTRY_STYLES } from "@/lib/creative-entry-bundle";

let fixture: string;
const originalAssets = path.resolve("public/creative");
const session = { username: "customer", role: "tenant", tenantId: "tenant" };
const call = (asset: string, etag?: string) => GET(new Request(`https://site.test/api/creative/assets/${asset}`, {
  headers: etag === undefined ? {} : { "If-None-Match": etag }
}), { params: Promise.resolve({ path: asset.split("/") }) });

function securityHeaders(response: Response) {
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'self'");
  expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
  expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
}

function privateHeaders(response: Response) {
  securityHeaders(response);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("ETag")).toBeNull();
}

function revalidationHeaders(response: Response) {
  securityHeaders(response);
  expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
  expect(response.headers.get("Vary")).toBe("Cookie");
  expect(response.headers.get("ETag")).toMatch(/^W\/"[a-f0-9]{64}"$/);
}

describe("creative assets use current database authorization", () => {
  beforeAll(async () => {
    fixture = await mkdtemp(path.join(os.tmpdir(), "creative-assets-test-"));
    const root = path.join(fixture, "public/creative");
    await mkdir(path.join(root, "labs"), { recursive: true });
    await writeFile(path.join(root, "labs/workspace.html"), "<html><head></head><body>workspace</body></html>");
    await writeFile(path.join(root, "labs/runtime.js"), "window.workspaceReady = true;");
    await writeFile(path.join(root, "labs/runtime.css"), "body{color:red}");
    await writeFile(path.join(root, "labs/icon.png"), new Uint8Array([137, 80, 78, 71, 0, 255]));
    await writeFile(path.join(root, "labs/manifest.json"), "private manifest details");
    await writeFile(path.join(fixture, "outside.js"), "private outside file");
    await symlink(path.join(fixture, "outside.js"), path.join(root, "labs/escape.js"));
    await symlink(fixture, path.join(root, "escape-directory"));
    await symlink(path.join(root, "labs/manifest.json"), path.join(root, "labs/alias.js"));
    for (const relative of [CREATIVE_ENTRY_HTML, ...CREATIVE_ENTRY_STYLES, ...CREATIVE_ENTRY_SCRIPTS]) {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readFile(path.join(originalAssets, relative)));
    }
  });
  afterAll(async () => { await rm(fixture, { recursive: true, force: true }); });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "cwd").mockReturnValue(fixture);
    vi.stubEnv("SANJIE_TEST_ENVIRONMENT", "");
    mocks.session.mockResolvedValue(session);
    mocks.access.mockResolvedValue({ allowed: true, reason: "paid" });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it.each(["labs/runtime.js", "labs/runtime.css", "labs/icon.png", "labs/workspace.html", CREATIVE_ENTRY_HTML, CREATIVE_ENTRY_CSS, CREATIVE_ENTRY_JS])("denies anonymous access to %s", async asset => {
    mocks.session.mockResolvedValue(null);
    const response = await call(asset);
    expect(response.status).toBe(401);
    expect(mocks.access).not.toHaveBeenCalled();
    privateHeaders(response);
  });

  it("checks database authorization on every asset and fails closed on revocation", async () => {
    expect((await call("labs/runtime.js")).status).toBe(200);
    mocks.access.mockResolvedValueOnce({ allowed: false, reason: "payment_required" });
    const unpaid = await call("labs/runtime.css");
    expect(unpaid.status).toBe(402); privateHeaders(unpaid);
    mocks.access.mockResolvedValueOnce({ allowed: false, reason: "invalid_account" });
    expect((await call("labs/icon.png")).status).toBe(401);
    expect(mocks.access).toHaveBeenCalledTimes(3);
    expect(mocks.access).toHaveBeenCalledWith(session);
  });

  it("returns a safe private error when the authorization database fails", async () => {
    mocks.access.mockRejectedValue(new Error("private connection details"));
    const response = await call("labs/runtime.js");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private connection details");
    privateHeaders(response);
  });

  it("fails closed when the session service fails", async () => {
    mocks.session.mockRejectedValue(new Error("private session details"));
    const response = await call("labs/runtime.js");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private session details");
    expect(mocks.access).not.toHaveBeenCalled();
    privateHeaders(response);
  });

  it("serves JS, CSS and binary images without changing their bytes", async () => {
    const js = await call("labs/runtime.js");
    expect(js.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(await js.text()).toBe("window.workspaceReady = true;"); revalidationHeaders(js);
    const css = await call("labs/runtime.css");
    expect(css.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe("body{color:red}"); revalidationHeaders(css);
    const png = await call("labs/icon.png");
    expect(png.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71, 0, 255])); privateHeaders(png);
  });

  it.each(["labs/runtime.js", "labs/runtime.css", CREATIVE_ENTRY_CSS, CREATIVE_ENTRY_JS])("rechecks session and database authorization before a bodyless %s 304", async asset => {
    const initial = await call(asset);
    expect(initial.status).toBe(200); revalidationHeaders(initial);
    const etag = initial.headers.get("ETag")!;
    const response = await call(asset, etag);
    expect(response.status).toBe(304); expect(response.body).toBeNull();
    expect(await response.text()).toBe(""); revalidationHeaders(response);
    expect(response.headers.get("ETag")).toBe(etag);
    expect(mocks.session).toHaveBeenCalledTimes(2);
    expect(mocks.access).toHaveBeenCalledTimes(2);
    expect(mocks.access).toHaveBeenLastCalledWith(session);
  });

  it.each(["matching", "wildcard"])("denies a now-anonymous %s conditional request", async condition => {
    const etag = (await call("labs/runtime.js")).headers.get("ETag")!;
    mocks.session.mockResolvedValue(null);
    const response = await call("labs/runtime.js", condition === "matching" ? etag : "*");
    expect(response.status).toBe(401); privateHeaders(response);
    expect(mocks.session).toHaveBeenCalledTimes(2);
    expect(mocks.access).toHaveBeenCalledTimes(1);
  });

  it.each(["matching", "wildcard"])("denies a revoked %s conditional request", async condition => {
    const etag = (await call("labs/runtime.js")).headers.get("ETag")!;
    mocks.access.mockResolvedValue({ allowed: false, reason: "payment_required" });
    const response = await call("labs/runtime.js", condition === "matching" ? etag : "*");
    expect(response.status).toBe(402); privateHeaders(response);
    expect(mocks.session).toHaveBeenCalledTimes(2);
    expect(mocks.access).toHaveBeenCalledTimes(2);
  });

  it.each([CREATIVE_ENTRY_CSS, CREATIVE_ENTRY_JS])("checks current authorization before a conditional bundle request: %s", async asset => {
    const etag = (await call(asset)).headers.get("ETag")!;
    mocks.access.mockResolvedValue({ allowed: false, reason: "payment_required" });
    const revoked = await call(asset, etag);
    expect(revoked.status).toBe(402); privateHeaders(revoked);
    mocks.access.mockResolvedValue({ allowed: true, reason: "paid" }); mocks.session.mockResolvedValue(null);
    const anonymous = await call(asset, "*");
    expect(anonymous.status).toBe(401); privateHeaders(anonymous);
    expect(mocks.session).toHaveBeenCalledTimes(3); expect(mocks.access).toHaveBeenCalledTimes(2);
  });

  it.each(["session", "authorization"])("fails closed on %s lookup failure with a matching validator", async service => {
    const etag = (await call("labs/runtime.js")).headers.get("ETag")!;
    (service === "session" ? mocks.session : mocks.access).mockRejectedValue(new Error("private connection details"));
    const response = await call("labs/runtime.js", etag);
    expect(response.status).toBe(503); privateHeaders(response);
    expect(await response.text()).not.toContain("private connection details");
  });

  it.each(["labs/runtime.js", CREATIVE_ENTRY_CSS, CREATIVE_ENTRY_JS])("does not reuse another current account's private validator for %s", async asset => {
    const initial = await call(asset), etag = initial.headers.get("ETag")!;
    const changed = { ...session, username: "another-customer", tenantId: "another-tenant" };
    mocks.session.mockResolvedValue(changed);
    const response = await call(asset, etag);
    expect(response.status).toBe(200); revalidationHeaders(response);
    expect(response.headers.get("ETag")).not.toBe(etag);
    expect(response.headers.get("ETag")).not.toContain(changed.username);
    expect(response.headers.get("ETag")).not.toContain(changed.tenantId);
    expect(mocks.access).toHaveBeenLastCalledWith(changed);
  });

  it.each(["labs/workspace.html", "labs/icon.png"])("retains no-store for %s even with a wildcard validator", async asset => {
    const response = await call(asset, "*");
    expect(response.status).toBe(200); privateHeaders(response);
  });

  it("retains the workspace HTML and environment script only on HTML responses", async () => {
    vi.stubEnv("SANJIE_TEST_ENVIRONMENT", "creative-20261001");
    const html = await call("labs/workspace.html");
    expect(html.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await html.text()).toContain("<head><script>"); privateHeaders(html);
    expect(await (await call("labs/runtime.js")).text()).toBe("window.workspaceReady = true;");
  });

  it("serves a protected four-request studio entry with its test environment marker and original mode handling", async () => {
    vi.stubEnv("SANJIE_TEST_ENVIRONMENT", "creative-bundle-uat");
    const response = await call(CREATIVE_ENTRY_HTML), html = await response.text();
    expect(response.status).toBe(200); privateHeaders(response);
    expect(html).toContain('window.__SANJIE_ENVIRONMENT=marker'); expect(html).toContain('"creative-bundle-uat"');
    expect([...html.matchAll(/<script\b[^>]+src=/g)]).toHaveLength(2);
    expect([...html.matchAll(/<link\b[^>]+rel="stylesheet"/g)]).toHaveLength(1);
    expect(html).toContain('src="/creative/web-chrome.js?v=');
    expect(html).toContain("new URLSearchParams(location.search)");
    expect(await readFile(path.join(fixture, "public/creative", CREATIVE_ENTRY_HTML), "utf8")).not.toContain("studio-entry.js");
    const js = await call(CREATIVE_ENTRY_JS), css = await call(CREATIVE_ENTRY_CSS);
    revalidationHeaders(js); revalidationHeaders(css);
    expect(js.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(css.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    expect(await js.text()).not.toContain('"creative-bundle-uat"');
    expect(mocks.access).toHaveBeenCalledTimes(3);
  });

  it("does not serve a cached bundle after a manifest member becomes an escaping symlink", async () => {
    expect((await call(CREATIVE_ENTRY_JS)).status).toBe(200);
    const target = path.join(fixture, "public/creative", CREATIVE_ENTRY_SCRIPTS[0]);
    const original = await readFile(target);
    try {
      await rm(target); await symlink(path.join(fixture, "outside.js"), target);
      const response = await call(CREATIVE_ENTRY_JS, "*");
      expect(response.status).toBe(404); privateHeaders(response);
      expect(await response.text()).not.toContain("private outside file");
    } finally { await rm(target); await writeFile(target, original); }
  });

  it.each(["labs/runtime.js.map", "labs/README.md", "labs/manifest.json", "fixtures/runtime.js", "../outside.js", "labs/%2e%2e/outside.js", "labs/escape.js", "escape-directory/outside.js", "labs/alias.js", "labs/missing.js", "labs/image-prompt-lab/../studio-entry.js", "labs/image-prompt-lab/%2e%2e/studio-entry.js", "labs/other/studio-entry.js"])("rejects source artifacts and filesystem escapes: %s", async asset => {
    const response = await call(asset);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("private outside file");
    privateHeaders(response);
  });
});
