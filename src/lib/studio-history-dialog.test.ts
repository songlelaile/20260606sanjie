import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const asset = (name: string) => readFileSync(resolve(assetRoot, "labs/image-prompt-lab", name), "utf8");
const sharedAsset = (name: string) => readFileSync(resolve("public/creative/labs/image-prompt-lab", name), "utf8");
const html = asset("promptlab.html"), runtime = asset("promptlab.js");

type TestEvent = {
  key?: string; shiftKey?: boolean; target?: TestNode; currentTarget?: TestNode; defaultPrevented?: boolean;
  preventDefault: ReturnType<typeof vi.fn>; stopPropagation: ReturnType<typeof vi.fn>;
  stopImmediatePropagation: ReturnType<typeof vi.fn>;
};
type Listener = (event: TestEvent) => void;

class TestStyle {
  private values = new Map<string, { value: string; priority: string }>();
  getPropertyValue(name: string) { return this.values.get(name)?.value || ""; }
  getPropertyPriority(name: string) { return this.values.get(name)?.priority || ""; }
  setProperty(name: string, value: string, priority = "") { this.values.set(name, { value, priority }); }
  removeProperty(name: string) { const old = this.getPropertyValue(name); this.values.delete(name); return old; }
  get overflow() { return this.getPropertyValue("overflow"); }
  set overflow(value: string) { this.setProperty("overflow", value); }
}

class TestNode {
  readonly attributes = new Map<string, string>();
  readonly children: TestNode[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly dataset: Record<string, string> = {};
  readonly style = new TestStyle();
  parentNode: TestNode | null = null;
  hidden = false; disabled = false; checked = false; inert = false; value = ""; type = ""; scrollTop = 0;
  private text = "";
  constructor(readonly tagName: string, readonly owner: { activeElement: TestNode | null }) {}
  get id() { return this.getAttribute("id") || ""; }
  set id(value: string) { this.setAttribute("id", value); }
  get className() { return this.getAttribute("class") || ""; }
  set className(value: string) { this.setAttribute("class", value); }
  get classList() {
    const contains = (name: string) => this.className.split(/\s+/).includes(name);
    const toggle = (name: string, force = !contains(name)) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      if (force) names.add(name); else names.delete(name);
      this.className = [...names].join(" "); return force;
    };
    return { contains, toggle, add: (...names: string[]) => names.forEach(name => toggle(name, true)), remove: (...names: string[]) => names.forEach(name => toggle(name, false)) };
  }
  get isConnected(): boolean { return this.tagName === "BODY" || !!this.parentNode?.isConnected; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.replaceChildren(); this.text = value; }
  appendText(value: string) { this.text += value; }
  set innerHTML(value: string) { this.replaceChildren(); parseMarkup(value, this); }
  get parentElement() { return this.parentNode; }
  get tabIndex() { const value = this.getAttribute("tabindex"); return value === null ? (["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A"].includes(this.tagName) ? 0 : -1) : Number(value); }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name === "hidden") this.hidden = true;
    if (name === "disabled") this.disabled = true;
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = String(value);
  }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  removeAttribute(name: string) { this.attributes.delete(name); if (name === "hidden") this.hidden = false; }
  appendChild(child: TestNode) { child.parentNode = this; this.children.push(child); return child; }
  append(...children: TestNode[]) { children.forEach(child => this.appendChild(child)); }
  replaceChildren() { this.children.forEach(child => { child.parentNode = null; }); this.children.splice(0); this.text = ""; }
  descendants(): TestNode[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  contains(node: TestNode | null) { return node === this || !!node && this.descendants().includes(node); }
  matches(selector: string): boolean {
    return selector.split(",").some(part => {
      let simple = part.trim();
      const excluded = [...simple.matchAll(/:not\(([^)]+)\)/g)].map(match => match[1]);
      if (excluded.some(exclusion => this.matches(exclusion))) return false;
      simple = simple.replace(/:not\([^)]+\)/g, "");
      const tag = /^[a-z][a-z0-9-]*/i.exec(simple)?.[0];
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      const id = /#([\w-]+)/.exec(simple)?.[1]; if (id && id !== this.id) return false;
      if ([...simple.matchAll(/\.([\w-]+)/g)].some(match => !this.classList.contains(match[1]))) return false;
      return [...simple.matchAll(/\[([^=\]\s]+)(?:\s*=\s*["']?([^"'\]]+)["']?)?\]/g)].every(match => {
        if (match[1] === "disabled") return this.disabled;
        if (match[1] === "hidden") return this.hidden;
        return this.hasAttribute(match[1]) && (match[2] === undefined || this.getAttribute(match[1]) === match[2]);
      });
    });
  }
  querySelectorAll(selector: string) { return this.descendants().filter(child => child.matches(selector)); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector: string): TestNode | null { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  getClientRects(): object[] {
    const ancestry: TestNode[] = [this]; for (let p = this.parentNode; p; p = p.parentNode) ancestry.push(p);
    return ancestry.some(node => node.hidden || node.style.getPropertyValue("display") === "none") || this.tagName === "INPUT" && this.type === "hidden" ? [] : [{}];
  }
  focus = vi.fn(() => { this.owner.activeElement = this; });
  scrollIntoView = vi.fn();
  addEventListener(name: string, listener: Listener) { this.listeners.set(name, [...this.listeners.get(name) || [], listener]); }
  dispatch(name: string, event = testEvent(undefined, this)) { event.currentTarget = this; this.listeners.get(name)?.forEach(listener => listener(event)); return event; }
}

function parseMarkup(markup: string, root: TestNode) {
  const stack = [root], voidTags = new Set(["input", "img", "link", "meta", "br", "hr"]);
  for (const match of markup.matchAll(/<!--[\s\S]*?-->|<\/?([a-z][a-z0-9-]*)([^>]*?)>|([^<]+)/gi)) {
    if (match[3]) { stack[stack.length - 1].appendText(match[3]); continue; }
    if (!match[1]) continue;
    const tag = match[1].toLowerCase();
    if (match[0].startsWith("</")) { while (stack.length > 1) if (stack.pop()?.tagName === tag.toUpperCase()) break; continue; }
    const node = new TestNode(tag.toUpperCase(), root.owner);
    for (const attribute of match[2].matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) node.setAttribute(attribute[1], attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    node.value = node.getAttribute("value") || ""; node.type = node.getAttribute("type") || "";
    stack[stack.length - 1].appendChild(node);
    if (!voidTags.has(tag)) stack.push(node);
  }
}

function testEvent(key?: string, target?: TestNode, shiftKey = false): TestEvent {
  const event: TestEvent = { key, target, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn() };
  event.preventDefault.mockImplementation(() => { event.defaultPrevented = true; });
  return event;
}

function deferred<T>() { let complete!: (value: T) => void; const promise = new Promise<T>(resolve => { complete = resolve; }); return { promise, complete }; }

function harness() {
  const owner: { activeElement: TestNode | null } = { activeElement: null };
  const body = new TestNode("BODY", owner), documentElement = new TestNode("HTML", owner);
  const bodyMarkup = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1];
  if (!bodyMarkup) throw new Error("Missing shipped body");
  parseMarkup(bodyMarkup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""), body);
  const documentListeners = new Map<string, Listener[]>();
  const document = {
    body, documentElement, readyState: "loading", get activeElement() { return owner.activeElement; },
    getElementById: (id: string) => body.querySelector(`#${id}`), querySelector: (selector: string) => body.querySelector(selector),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector), createElement: (tag: string) => new TestNode(tag.toUpperCase(), owner),
    addEventListener: (name: string, listener: Listener) => documentListeners.set(name, [...documentListeners.get(name) || [], listener])
  };
  const archive = { saveResult: vi.fn(), purgeExpired: vi.fn<(key: string) => Promise<number>>(async () => 0), list: vi.fn<(key: string, options: object) => Promise<object[]>>(async () => []), normalizeAccountKey: (key: string) => key.trim() || "local", moveToTrash: vi.fn(), restore: vi.fn(), permanentlyRemove: vi.fn() };
  const localStorage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
  const context = createContext({ document, console, URL, URLSearchParams, Blob, TextEncoder, TextDecoder, Promise,
    setTimeout: vi.fn(), clearTimeout: vi.fn(), localStorage, sessionStorage: localStorage,
    location: { search: "?studio=1&source=web", href: "https://site.test/promptlab.html?studio=1", origin: "https://site.test" },
    navigator: {}, addEventListener: vi.fn(), getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    SZ_IMAGE_ARCHIVE: archive, __SZ_PROMPTLAB_TEST_MODE__: true
  });
  context.window = context;
  runInContext(sharedAsset("viral-series-contract.js"), context);
  runInContext(sharedAsset("style-refresh-contract.js"), context);
  runInContext(runtime, context, { filename: "promptlab.js", timeout: 2000 });
  const node = (id: string) => { const found = document.getElementById(id); if (!found) throw new Error(`Missing ${id}`); return found; };
  context.state.archiveAccountKey = "tenant:alice";
  return { context, document, documentListeners, body, archive, localStorage, node, owner };
}

function bindHistory(h: ReturnType<typeof harness>) {
  // Preserve the shipped bind() and its handlers, while isolating unrelated
  // workbench initialization that does not participate in history navigation.
  for (const name of ["bindReferenceDetailWorkbench", "bindReferenceDetailBatch", "bindGuideRegenerationUi", "skuRenderSizeValidation", "skuOutputSizeValidation", "syncShareCardControls", "syncLinkCategoryUi", "renderPromptErrors", "renderImageEvidenceWarning"]) h.context[name] = vi.fn();
  h.context.bind();
}

describe("studio generation history dialog", () => {
  it("keeps the original archive controls inside one hidden body-level dialog", () => {
    const h = harness(), modal = h.node("archiveHistoryModal"), panel = h.node("archivePanel");
    expect(modal.parentNode).toBe(h.body);
    expect(modal.hidden).toBe(true);
    expect(modal.getAttribute("role")).toBe("dialog");
    expect(modal.getAttribute("aria-modal")).toBe("true");
    expect(modal.contains(panel)).toBe(true);
    for (const id of ["archiveBatchList", "archiveSearchInput", "archiveRouteFilter", "archiveRefreshBtn", "archiveTrashToggleBtn", "archiveEmpty"]) expect(panel.contains(h.node(id))).toBe(true);
    expect(h.body.descendants().filter(node => node.id === "archivePanel")).toHaveLength(1);
  });

  it("opens immediately while the real archive refresh is still pending", async () => {
    const h = harness(), waiting = deferred<number>(), trigger = h.node("openArchiveBtn");
    h.archive.purgeExpired.mockReturnValueOnce(waiting.promise); trigger.focus();
    const opened = h.context.openArchiveHistory(trigger);
    expect(h.node("archiveHistoryModal").hidden).toBe(false);
    expect(h.body.style.overflow).toBe("hidden");
    expect(h.node("archivePanel").scrollIntoView).not.toHaveBeenCalled();
    expect(h.archive.purgeExpired).toHaveBeenCalledWith("tenant:alice");
    expect(h.archive.list).not.toHaveBeenCalled();
    waiting.complete(0); await opened;
    expect(h.archive.list.mock.calls.map(call => call[0])).toEqual(["tenant:alice", "tenant:alice"]);
    expect(h.node("archiveHistoryModal").hidden).toBe(false);
  });

  it.each([false, true])("restores the exact scroll style, app inert state and opening focus (inert=%s)", async inert => {
    const h = harness(), app = h.document.querySelector(".app")!, trigger = h.node("openArchiveBtn");
    app.inert = inert; h.body.style.setProperty("overflow", "clip", "important"); trigger.focus();
    await h.context.openArchiveHistory(trigger); h.context.closeArchiveHistory();
    expect(h.node("archiveHistoryModal").hidden).toBe(true);
    expect(h.body.style.getPropertyValue("overflow")).toBe("clip");
    expect(h.body.style.getPropertyPriority("overflow")).toBe("important");
    expect(app.inert).toBe(inert); expect(h.document.activeElement).toBe(trigger);
  });

  it("does not replace the original return focus or saved scroll state on repeated open", async () => {
    const h = harness(), trigger = h.node("openArchiveBtn"), inside = h.node("archiveSearchInput");
    trigger.focus(); await h.context.openArchiveHistory(trigger); inside.focus();
    await h.context.openArchiveHistory(inside); h.context.closeArchiveHistory();
    expect(h.document.activeElement).toBe(trigger); expect(h.body.style.overflow).toBe("");
  });

  it("starts a newly opened panel at its top without scrolling the page or resetting an already open panel", async () => {
    const h = harness(), panel = h.node("archivePanel"); panel.scrollTop = 240;
    await h.context.openArchiveHistory(h.node("openArchiveBtn")); expect(panel.scrollTop).toBe(0);
    panel.scrollTop = 80; await h.context.openArchiveHistory(h.node("archiveSearchInput"));
    expect(panel.scrollTop).toBe(80); expect(panel.scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not reopen or steal focus when a delayed refresh finishes after closing", async () => {
    const h = harness(), waiting = deferred<number>(), trigger = h.node("openArchiveBtn");
    h.archive.purgeExpired.mockReturnValueOnce(waiting.promise); trigger.focus();
    const opened = h.context.openArchiveHistory(trigger); h.context.closeArchiveHistory();
    waiting.complete(0); await opened;
    expect(h.node("archiveHistoryModal").hidden).toBe(true); expect(h.document.activeElement).toBe(trigger);
    expect(h.body.style.overflow).toBe("");
  });

  it("uses the bound close button and only the empty backdrop to dismiss history", async () => {
    const h = harness(); bindHistory(h); h.node("openArchiveBtn").focus(); h.node("openArchiveBtn").dispatch("click");
    expect(h.node("archiveHistoryModal").hidden).toBe(false);
    h.node("archiveHistoryModal").dispatch("click", testEvent(undefined, h.node("archivePanel")));
    expect(h.node("archiveHistoryModal").hidden).toBe(false);
    h.node("archiveHistoryCloseBtn").dispatch("click"); expect(h.node("archiveHistoryModal").hidden).toBe(true);
    await h.context.openArchiveHistory(h.node("openArchiveBtn")); h.node("archiveHistoryModal").dispatch("click");
    expect(h.node("archiveHistoryModal").hidden).toBe(true);
  });

  it("closes safely when its original opening button has been detached", async () => {
    const h = harness(), trigger = h.node("openArchiveBtn"); trigger.focus();
    await h.context.openArchiveHistory(trigger); trigger.parentNode = null;
    expect(() => h.context.closeArchiveHistory()).not.toThrow();
    expect(h.node("archiveHistoryModal").hidden).toBe(true); expect(h.body.style.overflow).toBe("");
  });

  it("closes the history on Escape and restores the opener", async () => {
    const h = harness(), trigger = h.node("openArchiveBtn"); trigger.focus(); await h.context.openArchiveHistory(trigger);
    const event = testEvent("Escape", h.node("archiveSearchInput")); h.context.handleArchiveHistoryKeydown(event);
    expect(h.node("archiveHistoryModal").hidden).toBe(true); expect(h.document.activeElement).toBe(trigger);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it.each(["generatedImagePreviewModal", "archiveDeleteModal", "guideActionModal"])("Escape closes only the upper %s", async id => {
    const h = harness(); await h.context.openArchiveHistory(h.node("openArchiveBtn"));
    const inside = h.node("archiveSearchInput"); inside.focus(); h.node(id).hidden = false;
    h.context.handleArchiveHistoryKeydown(testEvent("Escape", inside));
    expect(h.node(id).hidden).toBe(true); expect(h.node("archiveHistoryModal").hidden).toBe(false);
    expect(h.node("archiveHistoryModal").contains(h.document.activeElement)).toBe(true);
    expect(h.body.style.overflow).toBe("hidden");
  });

  it.each(["preview", "delete"])("restores the exact history control after closing an actually opened %s child", async kind => {
    const h = harness(); await h.context.openArchiveHistory(h.node("openArchiveBtn"));
    const control = h.node("archiveSearchInput"); control.focus();
    if (kind === "preview") h.context.openGeneratedImagePreview({ url: "blob:existing-original", variantName: "原件" });
    else h.context.openArchiveDeleteModal(["existing-image"]);
    h.context.handleArchiveHistoryKeydown(testEvent("Escape", h.document.activeElement || undefined));
    expect(h.document.activeElement).toBe(control); expect(h.node("archiveHistoryModal").hidden).toBe(false);
    expect(h.body.style.overflow).toBe("hidden");
  });

  it.each(["sgPreview", "ctPreviewModal", "ctMaterialModal"])("does not close history on Escape owned by %s", async id => {
    const h = harness(); await h.context.openArchiveHistory(h.node("openArchiveBtn"));
    const upper = new TestNode("DIV", h.owner); upper.id = id; upper.setAttribute("role", "dialog"); upper.setAttribute("aria-modal", "true"); h.body.appendChild(upper);
    h.context.handleArchiveHistoryKeydown(testEvent("Escape", upper));
    expect(h.node("archiveHistoryModal").hidden).toBe(false);
  });

  it("wraps Tab and Shift+Tab inside the visible history controls", async () => {
    const h = harness(); await h.context.openArchiveHistory(h.node("openArchiveBtn"));
    const controls: TestNode[] = h.context.archiveHistoryFocusable(h.node("archiveHistoryModal"));
    expect(controls.length).toBeGreaterThan(2);
    const first = controls[0], last = controls[controls.length - 1];
    last.focus(); const forward = testEvent("Tab", last); h.context.handleArchiveHistoryKeydown(forward);
    expect(forward.preventDefault).toHaveBeenCalled(); expect(h.document.activeElement).toBe(first);
    first.focus(); const backward = testEvent("Tab", first, true); h.context.handleArchiveHistoryKeydown(backward);
    expect(backward.preventDefault).toHaveBeenCalled(); expect(h.document.activeElement).toBe(last);
  });

  it("traps Tab in the upper preview, with hidden and disabled controls excluded", async () => {
    const h = harness(); await h.context.openArchiveHistory(h.node("openArchiveBtn"));
    const modal = h.node("generatedImagePreviewModal"); modal.hidden = false;
    const extra = new TestNode("BUTTON", h.owner); modal.appendChild(extra);
    const disabled = new TestNode("BUTTON", h.owner); disabled.disabled = true; modal.appendChild(disabled);
    const hidden = new TestNode("BUTTON", h.owner); hidden.hidden = true; modal.appendChild(hidden);
    const skipped = new TestNode("BUTTON", h.owner); skipped.setAttribute("tabindex", "-1"); modal.appendChild(skipped);
    const first = h.node("generatedImagePreviewClose"), controls: TestNode[] = h.context.archiveHistoryFocusable(modal);
    expect(controls).toEqual([first, extra]); extra.focus(); h.context.handleArchiveHistoryKeydown(testEvent("Tab", extra));
    expect(h.document.activeElement).toBe(first); expect(h.node("archiveHistoryModal").hidden).toBe(false);
  });

  it("uses the existing account-scoped archive store without writing or migrating storage", async () => {
    const h = harness(); await h.context.openArchiveHistory(h.node("openArchiveBtn"));
    expect(h.archive.saveResult).not.toHaveBeenCalled(); expect(h.archive.moveToTrash).not.toHaveBeenCalled();
    expect(h.archive.restore).not.toHaveBeenCalled(); expect(h.archive.permanentlyRemove).not.toHaveBeenCalled();
    expect(h.localStorage.setItem).not.toHaveBeenCalled(); expect(h.localStorage.removeItem).not.toHaveBeenCalled();
    h.context.closeArchiveHistory(); await h.context.setArchiveAccountKey("tenant:bob", { refresh: false });
    h.archive.list.mockClear(); await h.context.openArchiveHistory(h.node("openArchiveBtn"));
    expect(h.archive.list.mock.calls.map(call => call[0])).toEqual(["tenant:bob", "tenant:bob"]);
  });

  it("discards an old account refresh that completes after another account takes over", async () => {
    const h = harness(), waiting = deferred<object[]>();
    h.archive.list.mockReturnValueOnce(waiting.promise); h.archive.list.mockReturnValueOnce(waiting.promise);
    const old = h.context.openArchiveHistory(h.node("openArchiveBtn"));
    await vi.waitFor(() => expect(h.archive.list).toHaveBeenCalledTimes(2));
    await h.context.setArchiveAccountKey("tenant:bob", { silent: true });
    waiting.complete([{ archiveBatchId: "alice-private", assets: [] }]);
    expect(await old).toMatchObject({ stale: true });
    expect(h.context.state.archiveAccountKey).toBe("tenant:bob"); expect(h.context.state.archiveBatches).toEqual([]);
    expect(h.node("archiveBatchList").textContent).not.toContain("alice-private");
  });

  it("keeps the existing database identity and version without opening an upgrade during dialog setup", () => {
    const indexedDB = { open: vi.fn() }, context = createContext({ indexedDB });
    runInContext(sharedAsset("image-archive-store.js"), context);
    expect(context.SZ_IMAGE_ARCHIVE.DB_NAME).toBe("sz_image_archive_v1");
    expect(sharedAsset("image-archive-store.js")).toMatch(/DB_VERSION\s*=\s*2\s*;/);
    expect(indexedDB.open).not.toHaveBeenCalled();
  });

  it.each(["search", "module"])("distinguishes a %s filter miss from an actually empty archive", kind => {
    const h = harness(), batch = { archiveBatchId: "batch-one", surfaceMode: "main", businessBatchTitle: "已有成果", assets: [] };
    h.context.state.archiveBatches = [batch];
    h.node("archiveSearchInput").value = kind === "search" ? "missing" : "";
    h.node("archiveRouteFilter").value = kind === "module" ? "buyer" : "all";
    h.context.renderArchiveHistory(); expect(h.node("archiveEmpty").textContent).toContain("没有匹配的生成记录");
    h.context.state.archiveBatches = []; h.context.renderArchiveHistory();
    expect(h.node("archiveEmpty").textContent).toContain("这台电脑上还没有生成记录");
    h.context.state.archiveTrashMode = true; h.context.state.archiveTrashBatches = [batch];
    h.context.renderArchiveHistory(); expect(h.node("archiveEmpty").textContent).toContain("没有匹配的回收站记录");
    h.context.state.archiveTrashBatches = []; h.context.renderArchiveHistory();
    expect(h.node("archiveEmpty").textContent).toContain("回收站目前为空");
  });

  it("retains search, module filtering and selected downloads from the existing archive functions", async () => {
    const h = harness();
    const batch = { archiveBatchId: "batch-one", surfaceMode: "main", businessBatchTitle: "示例产品", assetCount: 2, totalBytes: 12, assets: [
      { archiveAssetId: "first", surfaceMode: "main", businessRoleName: "正面", imageIndex: 1, mimeType: "image/png", blob: new Blob(["first"]) },
      { archiveAssetId: "second", surfaceMode: "main", businessRoleName: "侧面", imageIndex: 2, mimeType: "image/png", blob: new Blob(["second"]) }
    ] };
    expect(h.context.archiveBatchMatches(batch, "示例", "main")).toBe(true);
    expect(h.context.archiveBatchMatches(batch, "侧面", "all")).toBe(true);
    expect(h.context.archiveBatchMatches(batch, "missing", "all")).toBe(false);
    expect(h.context.archiveBatchMatches(batch, "", "buyer")).toBe(false);
    h.context.state.archiveBatches = [batch]; h.node("archiveSearchInput").value = "示例";
    h.context.renderArchiveHistory(); expect(h.node("archiveBatchList").children).toHaveLength(1);
    const selected = h.context.archiveDownloadItems(batch, ["second"]);
    expect(selected).toHaveLength(1); expect(selected[0].filename).toContain("侧面"); expect(selected[0].url).toMatch(/^blob:/);
    const send = vi.fn(async () => ({ ok: true })); h.context.__SZ_PROMPTLAB_TEST_API__.setTestSend(send);
    expect(await h.context.dispatchArchiveDownloads(selected)).toMatchObject({ ok: true, count: 1 });
    expect(send).toHaveBeenCalledWith("DOWNLOAD_ALL", { items: selected });
    h.node("archiveSearchInput").value = "missing"; h.context.renderArchiveHistory(); expect(h.node("archiveBatchList").children).toHaveLength(0);
  });

  it("routes both studio history buttons and the legacy history entry through the same opener", () => {
    const h = harness(); expect(h.context.SZ_CREATIVE_TOOLS_BRIDGE.openHistory).toBe(h.context.openArchiveHistory);
    expect(runtime).toMatch(/openArchiveBtn[\s\S]{0,180}openArchiveHistory/);
    const studio = asset("studio-genesis-ui.js");
    const helper = (name: string) => {
      const start = studio.indexOf(`  function ${name}(`), end = studio.indexOf("\n  function ", start + 1);
      expect(start, name).toBeGreaterThanOrEqual(0); expect(end, name).toBeGreaterThan(start);
      return studio.slice(start, end);
    };
    // Exactly two openers exist: the common toolbar and the retained legacy-task
    // recovery dialog. A third (duplicate) opener anywhere still fails here.
    expect(studio.match(/data-action="history"/g)).toHaveLength(2);
    expect(helper("commonActions").match(/data-action="history"/g)).toHaveLength(1);
    expect(helper("showLegacyTasks").match(/data-action="history"/g)).toHaveLength(1);
    expect(helper("showLegacyTasks")).toContain("openDialog('保留的旧任务',content)");
    // Single and batch workspaces reuse the one common action toolbar.
    expect(helper("renderSingle")).toContain("${commonActions()}");
    expect(helper("renderBatch")).toContain("${commonActions()}");
    expect(studio.match(/\$\{commonActions\(\)\}/g)).toHaveLength(2);
    // The recovery dialog delegates its buttons to the same action handler,
    // so both openers share the account check and bridge.openHistory below.
    expect(helper("openDialog")).toMatch(/closest\('\[data-action\]'\);if\(button\)action\(button\)/);
    const action = studio.match(/if\(name==='history'\)[^\n]*/)?.[0] || "";
    expect(studio.match(/if\(name==='history'\)/g)).toHaveLength(1);
    expect(action).toMatch(/await ensureAccount\(\);await bridge\.openHistory\(button\);/);
    expect(action).toContain("bridge.openHistory"); expect(action).not.toMatch(/scrollIntoView|studio-visible|creative-visible/);
  });
});
