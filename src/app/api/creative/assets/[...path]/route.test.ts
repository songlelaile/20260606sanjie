import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn() }));
vi.mock("@/lib/server-session", () => ({ getCurrentSession: mocks.session }));
vi.mock("@/lib/creative-entitlements", () => ({ getCreativeAccessForSession: mocks.access }));
import { GET } from "./route";

let fixture: string;
const entryFolder = "labs/image-prompt-lab/";
const productionStyles = ["studio-workspace-20261009-v1.css", "sku-region-ui.css", "aesthetic-mirror.css", "link-image.css", "workspace-ux.css"];
const productionScripts = [
  "studio-prerequisites-20261009-v1.js", "viral-series-contract.js", "studio-runtime-20261010-credit-v3.js",
  "sku-region-ui.js", "sku-delivery-store.js", "sku-durable-receipt.js", "promptlab.js", "studio-views-20261010-credit-v3.js",
  "aesthetic-mirror-contract.js", "aesthetic-mirror-ui.js", "link-list-import.js", "link-image-contract.js",
  "link-image-result-actions.js", "link-image-ui.js"
];
const bridgeUrl = "/creative/web-chrome.js?v=reviewed-fixture";
const versioned = (name: string) => name + "?v=reviewed-fixture";
// Independent fixture for the reviewed production packaging: a body bridge,
// fourteen ordered tail scripts, five active styles and a noscript fallback.
const productionHtml = `<html><head>
${[bridgeUrl, ...[0, 1, 2, 6, 7].map(index => versioned(productionScripts[index]))].map(url => `<link rel="preload" as="script" href="${url}">`).join("\n")}
<link id="labWorkspaceStyles" rel="stylesheet" href="${versioned(productionStyles[0])}" media="print" fetchpriority="high" onload="window.SZ_LAB_STYLES.loaded(this)" onerror="window.SZ_LAB_STYLES.failed(this)">
<noscript><link rel="stylesheet" href="${versioned(productionStyles[0])}"></noscript>
${productionStyles.slice(1).map(name => `<link rel="stylesheet" href="${versioned(name)}">`).join("\n")}
</head><body><script id="labFirstPaintMeasure">if (window.SZ_LAB_STYLES) window.SZ_LAB_STYLES.bodyReady(); if (window.SZ_LAB_FIRST_PAINT) window.SZ_LAB_FIRST_PAINT.bodyReady();</script>
<script src="${bridgeUrl}"></script><main class="app">production workspace fixture</main>
${productionScripts.map(name => `<script src="${versioned(name)}"></script>`).join("\n")}
</body></html>`;
const session = { username: "customer", role: "tenant", tenantId: "tenant" };
const call = (asset: string, headers?: HeadersInit) => GET(new Request(`https://site.test/api/creative/assets/${asset}`, { headers }), { params: Promise.resolve({ path: asset.split("/") }) });

function privateHeaders(response: Response, cacheControl: "private, no-store" | "private, no-cache" = "private, no-store") {
  expect(response.headers.get("Cache-Control")).toBe(cacheControl);
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'self'");
  expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  if (cacheControl === "private, no-cache") {
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(response.headers.get("ETag")).toMatch(/^W\/"[a-f0-9]{64}"$/);
  }
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
    await mkdir(path.join(root, entryFolder), { recursive: true });
    await writeFile(path.join(root, entryFolder, "promptlab.html"), productionHtml);
    await writeFile(path.join(root, "web-chrome.js"), "window.productionBridgeFixture = true;");
    for (const name of productionScripts) await writeFile(path.join(root, entryFolder, name), "window.productionAssetFixture = true;");
    for (const name of productionStyles) await writeFile(path.join(root, entryFolder, name), "body{color:green}");
    // A stale disk file cannot make a synthetic endpoint exist for production.
    await writeFile(path.join(root, entryFolder, "studio-entry.js"), "window.staleSyntheticBundle = true;");
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

  it.each(["labs/runtime.js", "labs/runtime.css", "labs/icon.png", "labs/workspace.html", entryFolder + "promptlab.html", entryFolder + "studio-entry.js"])("denies anonymous access to %s", async asset => {
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
    expect(js.status).toBe(200);
    expect(js.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(await js.text()).toBe("window.workspaceReady = true;"); privateHeaders(js, "private, no-cache");
    const css = await call("labs/runtime.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe("body{color:red}"); privateHeaders(css, "private, no-cache");
    const png = await call("labs/icon.png");
    expect(png.status).toBe(200);
    expect(png.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71, 0, 255]));
    privateHeaders(png);
  });

  it.each(["labs/runtime.js", "labs/runtime.css"])("rechecks the current session and database authorization before an authorized conditional 304 for %s", async asset => {
    const first = await call(asset);
    const etag = first.headers.get("ETag");
    expect(first.status).toBe(200); expect(etag).toBeTruthy();
    mocks.session.mockClear(); mocks.access.mockClear();
    const response = await call(asset, { "If-None-Match": etag! });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("ETag")).toBe(etag);
    expect(mocks.session).toHaveBeenCalledTimes(1);
    expect(mocks.access).toHaveBeenCalledTimes(1);
    expect(mocks.access).toHaveBeenCalledWith(session);
    privateHeaders(response, "private, no-cache");
  });

  it.each([{ reason: "payment_required", status: 402 }, { reason: "invalid_account", status: 401 }])(
    "rejects a matching cache validator after current database authorization is revoked: $reason",
    async ({ reason, status }) => {
      const first = await call("labs/runtime.js"), etag = first.headers.get("ETag");
      expect(first.status).toBe(200); expect(etag).toBeTruthy();
      mocks.access.mockClear(); mocks.access.mockResolvedValueOnce({ allowed: false, reason });
      const response = await call("labs/runtime.js", { "If-None-Match": etag! });
      expect(response.status).toBe(status);
      expect(mocks.access).toHaveBeenCalledTimes(1);
      expect(mocks.access).toHaveBeenCalledWith(session);
      expect(response.headers.get("ETag")).toBeNull();
      privateHeaders(response);
    }
  );

  it("fails closed on an authorization database error even when the cache validator matches", async () => {
    const first = await call("labs/runtime.js"), etag = first.headers.get("ETag");
    expect(first.status).toBe(200); expect(etag).toBeTruthy();
    mocks.access.mockClear(); mocks.access.mockRejectedValueOnce(new Error("private connection details"));
    const response = await call("labs/runtime.js", { "If-None-Match": etag! });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private connection details");
    expect(mocks.access).toHaveBeenCalledTimes(1);
    expect(response.headers.get("ETag")).toBeNull();
    privateHeaders(response);
  });

  it("denies an anonymous matching cache validator without querying database authorization", async () => {
    const first = await call("labs/runtime.js"), etag = first.headers.get("ETag");
    expect(first.status).toBe(200); expect(etag).toBeTruthy();
    mocks.access.mockClear(); mocks.session.mockResolvedValueOnce(null);
    const response = await call("labs/runtime.js", { "If-None-Match": etag! });
    expect(response.status).toBe(401);
    expect(mocks.access).not.toHaveBeenCalled();
    expect(response.headers.get("ETag")).toBeNull();
    privateHeaders(response);
  });

  it("retains the workspace HTML and environment script only on HTML responses", async () => {
    vi.stubEnv("SANJIE_TEST_ENVIRONMENT", "creative-20261001");
    const html = await call("labs/workspace.html");
    expect(html.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await html.text()).toContain("<head><script>"); privateHeaders(html);
    expect(await (await call("labs/runtime.js")).text()).toBe("window.workspaceReady = true;");
  });

  it("serves the complete reviewed production HTML unchanged after authorization", async () => {
    const response = await call(entryFolder + "promptlab.html");
    expect(response.status).toBe(200); privateHeaders(response);
    expect(await response.text()).toBe(productionHtml);
    expect(mocks.session).toHaveBeenCalledOnce(); expect(mocks.access).toHaveBeenCalledExactlyOnceWith(session);
  });

  it("injects the environment marker while retaining production resource order and body bridge", async () => {
    vi.stubEnv("SANJIE_TEST_ENVIRONMENT", "creative-production-fixture");
    const response = await call(entryFolder + "promptlab.html"), html = await response.text();
    expect(response.status).toBe(200); privateHeaders(response);
    expect(html).toContain('<head><script>'); expect(html).toContain('"creative-production-fixture"');
    expect([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1])).toEqual([bridgeUrl, ...productionScripts.map(versioned)]);
    expect(html).toContain("<noscript>"); expect(html).not.toContain('src="studio-entry.js');
  });

  it.each(["studio-entry.js", "studio-entry.css"])("does not expose a synthetic %s endpoint for production, including stale disk files", async name => {
    const response = await call(entryFolder + name, { "If-None-Match": "*" });
    expect(response.status).toBe(404); privateHeaders(response);
    expect(response.headers.get("ETag")).toBeNull();
    expect(await response.text()).not.toContain("staleSyntheticBundle");
    expect(mocks.access).toHaveBeenCalledExactlyOnceWith(session);
  });

  it.each(["labs/runtime.js.map", "labs/README.md", "labs/manifest.json", "fixtures/runtime.js", "../outside.js", "labs/%2e%2e/outside.js", "labs/escape.js", "escape-directory/outside.js", "labs/alias.js", "labs/missing.js"])("rejects source artifacts and filesystem escapes: %s", async asset => {
    const response = await call(asset);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("private outside file");
    privateHeaders(response);
  });
});
