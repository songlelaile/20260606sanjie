import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { deflateSync } from "node:zlib";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const publicRoot = process.env.CREATIVE_PUBLIC_TEST_ROOT
  ? path.resolve(process.env.CREATIVE_PUBLIC_TEST_ROOT)
  : fileURLToPath(new URL("../../public", import.meta.url));
const htmlPath = path.join(publicRoot, "creative/labs/image-prompt-lab/promptlab.html");
const scripts = [...readFileSync(htmlPath, "utf8").matchAll(/<script[^>]+src="([^"]+)"/g)]
  .map(match => match[1].split("?")[0])
  .map(src => src.startsWith("/") ? path.join(publicRoot, src) : path.resolve(path.dirname(htmlPath), src));

function png(color: number) {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, bytes: Buffer) => {
    const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc(Buffer.concat([name, bytes])));
    return Buffer.concat([length, name, bytes, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return "data:image/png;base64," + Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, color, 20, 40, 255]))), chunk("IEND", Buffer.alloc(0))
  ]).toString("base64");
}
const images = [png(20), png(100), png(200)];

function storage() {
  const items = new Map<string, string>();
  return { get length() { return items.size; }, key: (index: number) => [...items.keys()][index],
    getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key) };
}

function element(tag = "div", id = "") {
  const classes = new Set<string>(), listeners = new Map<string, Array<(event: any) => unknown>>();
  const node: any = {
    tagName: tag.toUpperCase(), id, value: "", textContent: "", className: "", hidden: true,
    disabled: false, checked: false, dataset: {}, style: { setProperty: vi.fn() },
    children: [] as any[], options: [] as any[], attributes: new Map<string, string>(),
    focus: vi.fn(), click: vi.fn(), remove: vi.fn(), querySelectorAll: () => [], querySelector: () => null,
    closest: () => null, setAttribute(name: string, value: string) { this.attributes.set(name, value); },
    getAttribute(name: string) { return this.attributes.get(name) ?? null; },
    appendChild(child: any) { this.children.push(child); child.parentNode = this; if (child.tagName === "OPTION") this.options.push(child); return child; },
    addEventListener(type: string, callback: (event: any) => unknown) { listeners.set(type, [...(listeners.get(type) || []), callback]); },
    async dispatch(type: string, event: any = {}) { for (const callback of listeners.get(type) || []) await callback.call(node, { target: node, currentTarget: node, preventDefault: vi.fn(), ...event }); },
    classList: { add: (...names: string[]) => names.forEach(name => classes.add(name)), remove: (...names: string[]) => names.forEach(name => classes.delete(name)),
      contains: (name: string) => classes.has(name), toggle(name: string, force?: boolean) { const next = force ?? !classes.has(name); if (next) classes.add(name); else classes.delete(name); return next; } }
  };
  Object.defineProperty(node, "innerHTML", { get: () => "", set: () => { node.children = []; } });
  return node;
}

function runtime() {
  const elements = new Map<string, any>();
  const document: any = {
    readyState: "loading", body: element("body"), documentElement: element("html"),
    getElementById(id: string) { if (!elements.has(id)) elements.set(id, element("div", id)); return elements.get(id); },
    createElement: element, querySelectorAll: () => [], querySelector: () => null, addEventListener: vi.fn()
  };
  document.body.classList.add("detail-lab-mode");
  const fetch = vi.fn(async (url: string) => {
    if (url === "/api/auth/me") return Response.json({ data: { tenantId: "fixture", username: "fixture", creativeEntitlement: { allowed: true } } });
    throw new Error("Screenshot import must not call upstream services");
  });
  const context = vm.createContext({ console, URL, URLSearchParams, Headers, Request, Response, FormData, Blob,
    ArrayBuffer, Uint8Array, AbortController, TextEncoder, TextDecoder, Promise, fetch, atob, btoa,
    setTimeout: vi.fn(), clearTimeout: vi.fn(), document, localStorage: storage(), sessionStorage: storage(),
    location: { href: "https://site.test/creative/labs/image-prompt-lab/promptlab.html?mode=detail&detailMode=reference&source=detail-reference&layout=1", origin: "https://site.test", search: "?mode=detail&detailMode=reference&source=detail-reference&layout=1" },
    __SZ_PROMPTLAB_BACKGROUND_TEST_MODE__: true, __SZ_PROMPTLAB_TEST_MODE__: true, crypto: webcrypto,
    navigator: { locks: { request(_key: string, _options: unknown, callback: (lock: object) => unknown) { return Promise.resolve(callback({})); } } }
  });
  context.window = context;
  for (const file of scripts) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file, timeout: 2000 });
  const api = context.__SZ_PROMPTLAB_TEST_API__;
  const dispatch = vi.fn(async (_type: string, _payload?: any): Promise<any> => ({ ok: false, error: "Unexpected background dispatch in local screenshot import" }));
  api.setTestSend(dispatch);
  return { api, context, document, fetch, dispatch };
}

function sourceImages(source: any) {
  return [...source.orderedBlocks].sort((a, b) => a.originalIndex - b.originalIndex)
    .map(block => source.assets.find((asset: any) => asset.assetId === block.assetIds[0])?.url);
}

describe("reference detail screenshot learning UI", () => {
  it("imports several screenshots as a distinct local learning source and enables structure analysis", () => {
    const h = runtime();
    h.api.setRefImages(images, "");
    const source = h.api.state.referenceDetail.source;
    expect(source.schema).toBe("REFERENCE_DETAIL_SCREENSHOT_SOURCE_V1");
    expect(h.api.referenceDetailStrictSource()).toBe(true);
    expect(sourceImages(source)).toEqual(images);
    expect(h.api.state.refImages).toEqual(images);
    expect(source.source.platform).not.toBe("taobao");
    expect(source.source.platform).not.toBe("tmall");
    expect(source.source.itemId || "").toBe("");
    expect(source.facts || []).toEqual([]);
    expect(source.assets.every((asset: any) => asset.rightsStatus === "reference_only")).toBe(true);
    expect(h.document.getElementById("referenceDetailSourceKind").textContent).toMatch(/截图/);
    expect(h.document.getElementById("referenceDetailBuildBtn").disabled).toBe(false);
    expect(h.document.getElementById("referenceSourcePanel").hidden).toBe(false);
    expect(h.document.getElementById("referenceSourcePanel").getAttribute("aria-hidden")).toBe("false");
    expect(h.document.getElementById("referenceSourcePanel").classList.contains("route-inactive")).toBe(false);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.fetch.mock.calls.every(([url]) => url === "/api/auth/me")).toBe(true);
  });

  it("updates screenshot order through the source contract while keeping original image bytes", () => {
    const h = runtime();
    h.api.setRefImages(images, "");
    const previousId = h.api.state.referenceDetail.source.snapshotId;
    h.api.moveReferenceDetailScreenshot(2, -1);
    expect(h.api.state.refImages).toEqual([images[0], images[2], images[1]]);
    expect(sourceImages(h.api.state.referenceDetail.source)).toEqual([images[0], images[2], images[1]]);
    expect(h.api.state.referenceDetail.source.snapshotId).not.toBe(previousId);
    h.api.setRefImages([images[0], images[1]], "");
    expect(sourceImages(h.api.state.referenceDetail.source)).toEqual([images[0], images[1]]);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("preserves repeated screenshot positions when a middle screenshot is removed", () => {
    const h = runtime();
    h.api.setRefImages([images[0], images[1], images[0]], "");
    expect(h.api.state.refImages).toEqual([images[0], images[1], images[0]]);
    expect(sourceImages(h.api.state.referenceDetail.source)).toEqual([images[0], images[1], images[0]]);
    h.api.setRefImages([images[0], images[0]], "");
    expect(h.api.state.refImages).toEqual([images[0], images[0]]);
    expect(sourceImages(h.api.state.referenceDetail.source)).toEqual([images[0], images[0]]);
  });

  it("invalidates the approved structure, generated prompt and batch when screenshots change or clear", () => {
    const h = runtime();
    h.api.setRefImages(images, "");
    const detail = h.api.state.referenceDetail;
    detail.currentBlueprint = { ...detail.currentBlueprint, approvalStatus: "approved" };
    h.api.state.referencePrompts.detail = { mode: "detail", source: "reference", referenceDetailFormal: true, prompt: "stale" };
    h.api.state.activePromptRecord = h.api.state.referencePrompts.detail;
    h.api.state.referenceDetailBatch.bundle = { bundleId: "old-approved-bundle" };
    h.api.state.referenceDetailBatch.rows = [{ rowId: "old-target" }];
    h.api.setRefImages([images[1]], "");
    expect(detail.currentBlueprint?.approvalStatus).not.toBe("approved");
    expect(h.api.state.referencePrompts.detail).toBeNull();
    expect(h.api.state.activePromptRecord).toBeNull();
    expect(h.api.state.referenceDetailBatch.bundle).toBeNull();
    expect(h.api.state.referenceDetailBatch.rows).toEqual([]);
    h.api.setRefImages([], "");
    expect(detail.source).toBeNull();
    expect(detail.editor).toBeNull();
    expect(h.api.state.refImages).toEqual([]);
    expect(h.document.getElementById("referenceDetailBuildBtn").disabled).toBe(true);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("keeps current source and originals unchanged when replacing during structure confirmation", () => {
    const h = runtime();
    h.api.setRefImages(images, "");
    const source = h.api.state.referenceDetail.source;
    h.api.state.referenceDetail.confirmationContext = { token: "confirmation-in-progress" };
    try { h.api.setRefImages([images[1]], ""); } catch (error: any) { expect(error.code).toBe("CONFIRMATION_IN_PROGRESS"); }
    expect(h.api.state.referenceDetail.source).toBe(source);
    expect(h.api.state.refImages).toEqual(images);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("keeps current source and originals unchanged while a reference detail batch is active", () => {
    const h = runtime();
    h.api.setRefImages(images, "");
    const source = h.api.state.referenceDetail.source;
    h.api.state.referenceDetailBatch.activeJobs = { "still-running": { taskId: "target-a" } };
    try { h.api.setRefImages([images[1]], ""); } catch (error: any) { expect(error.code).toBe("REFERENCE_DETAIL_BATCH_ACTIVE"); }
    expect(h.api.state.referenceDetail.source).toBe(source);
    expect(h.api.state.refImages).toEqual(images);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("reads URL images through FETCH_IMAGE and keeps their requested order despite completion order", async () => {
    const h = runtime();
    let completeFirst!: (value: any) => void;
    const first = new Promise(resolve => { completeFirst = resolve; });
    h.dispatch.mockImplementation(async (type: any, payload: any) => {
      expect(type).toBe("FETCH_IMAGE");
      if (payload.url.endsWith("first.png")) return first;
      return { ok: true, dataUrl: images[1] };
    });
    const loading = h.api.importReferenceDetailScreenshotUrls(["https://image.test/first.png", "https://image.test/second.png"]);
    completeFirst({ ok: true, dataUrl: images[0] });
    await loading;
    expect(sourceImages(h.api.state.referenceDetail.source)).toEqual([images[0], images[1]]);
    expect(h.dispatch.mock.calls.map(([type]: any) => type)).toEqual(["FETCH_IMAGE", "FETCH_IMAGE"]);
    expect(h.fetch.mock.calls.every(([url]) => url === "/api/auth/me")).toBe(true);
  });

  it("retains a usable screenshot source when another URL is unreadable", async () => {
    const h = runtime();
    h.api.setRefImages(images, "");
    const source = h.api.state.referenceDetail.source;
    h.dispatch.mockImplementation(async () => ({ ok: false, error: "Image cannot be read" }));
    try { await h.api.importReferenceDetailScreenshotUrls(["https://image.test/missing.png"]); } catch { /* Expected local read failure. */ }
    expect(h.api.state.referenceDetail.source).toBe(source);
    expect(h.api.state.refImages).toEqual(images);
    expect(h.api.referenceDetailStrictSource()).toBe(true);
  });

  it("ignores a late URL read after the user replaces the screenshot source", async () => {
    const h = runtime();
    h.api.setRefImages([images[0]], "");
    let complete!: (value: any) => void;
    h.dispatch.mockImplementation(async () => new Promise(resolve => { complete = resolve; }));
    const pending = h.api.importReferenceDetailScreenshotUrls(["https://image.test/late.png"]);
    h.api.setRefImages([images[2]], "");
    const replacement = h.api.state.referenceDetail.source;
    complete({ ok: true, dataUrl: images[1] });
    await expect(pending).rejects.toThrow(/来源或确认状态已变化/);
    expect(h.api.state.referenceDetail.source).toBe(replacement);
    expect(h.api.state.refImages).toEqual([images[2]]);
  });

  it("ignores a late URL read when a new structure confirmation has begun", async () => {
    const h = runtime();
    h.api.setRefImages([images[0]], "");
    const source = h.api.state.referenceDetail.source;
    let complete!: (value: any) => void;
    h.dispatch.mockImplementation(async () => new Promise(resolve => { complete = resolve; }));
    const pending = h.api.importReferenceDetailScreenshotUrls(["https://image.test/late.png"]);
    h.api.state.referenceDetail.confirmationSequence += 1;
    complete({ ok: true, dataUrl: images[1] });
    await expect(pending).rejects.toThrow(/来源或确认状态已变化/);
    expect(h.api.state.referenceDetail.source).toBe(source);
    expect(h.api.state.refImages).toEqual([images[0]]);
  });

  it("ignores a late URL read after the user switches away from screenshot learning", async () => {
    const h = runtime();
    h.api.setRefImages([images[0]], "");
    const source = h.api.state.referenceDetail.source;
    let complete!: (value: any) => void;
    h.dispatch.mockImplementation(async () => new Promise(resolve => { complete = resolve; }));
    const pending = h.api.importReferenceDetailScreenshotUrls(["https://image.test/late.png"]);
    h.document.body.classList.remove("detail-lab-mode");
    h.document.body.classList.add("main-lab-mode");
    complete({ ok: true, dataUrl: images[1] });
    await expect(pending).rejects.toThrow(/来源或确认状态已变化|路线/);
    expect(h.api.state.referenceDetail.source).toBe(source);
    expect(h.api.state.refImages).toEqual([images[0]]);
  });

  it("preserves generic reference-image handling on the main-image route", () => {
    const h = runtime();
    h.document.body.classList.remove("detail-lab-mode");
    h.document.body.classList.add("main-lab-mode");
    h.api.setRefImages(images, "");
    expect(h.api.state.refImages).toEqual(images);
    expect(h.api.state.referenceDetail.source).toBeNull();
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});
