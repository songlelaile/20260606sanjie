import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CREATIVE_VIRAL_SURFACES } from "@/lib/creative-viral-surfaces";
import { openCreativeHistory } from "@/lib/creative-history-entry";
import { openCreativeApiConfig } from "@/lib/creative-api-entry";

// Execute the real TSX and its rendered handlers. The small host supplies only
// React hook lifetimes, iframe identity and router calls; it has no navigation
// algorithm of its own and makes no network or provider requests.
const componentSource = readFileSync(resolve(process.env.CREATIVE_STUDIO_TEST_PATH || "src/components/creative/CreativeStudio.tsx"), "utf8");
const componentJs = ts.transpileModule(componentSource, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX
}, fileName: "CreativeStudio.tsx" }).outputText;

interface Props { kind: "image" | "video"; initialSurface?: string; initialBatch?: boolean; initialHistory?: boolean; initialApiConfig?: boolean }
interface Permission { allowed: boolean; reason?: string }
interface DeactivationBridge { canDeactivate(): Permission | Promise<Permission> }
interface ToolsBridge extends DeactivationBridge { getState(): { ready: boolean; startupFailed?: boolean; busy: boolean } }
interface Bridge {
  canDeactivate(): Permission | Promise<Permission>;
  activate(): Promise<{ ok: boolean; error?: string }>;
}
interface PromptBridge extends Bridge {
  getTaskState(): { ready: boolean; busy: boolean; activeCount: number; pendingReceiptCount: number; summary: string };
}
interface JsxNode { type: unknown; key?: unknown; props: Record<string, unknown> }
type RenderValue = JsxNode | string | number | boolean | null | undefined | RenderValue[];
type Cleanup = (() => void) | undefined;
interface HookSlot { kind: string; value?: unknown; deps?: unknown[]; cleanup?: Cleanup }
interface Frame {
  identity: string; title: string; src: string; hidden: boolean; inert: boolean;
  tabIndex?: number; draft: string;
  contentWindow: { SanjieViralWorkflowBridge?: Bridge; SanjieStudioGenesisBridge?: PromptBridge;
    SZ_CREATIVE_TOOLS_UI?: ToolsBridge; SanjiePromptLabTaskBridge?: PromptBridge; SanjieAestheticMirrorBridge?: PromptBridge; SanjieLinkImageBridge?: PromptBridge;
    SZ_CREATIVE_TOOLS_BRIDGE: { archiveContext(): { accountKey: string }; getAccountKey: ReturnType<typeof vi.fn<() => Promise<string>>>; openHistory: ReturnType<typeof vi.fn<() => Promise<{ ok: boolean }>>>; openConfig: ReturnType<typeof vi.fn<() => { ok: boolean; error?: string }>> } };
  contentDocument: { documentElement: { dataset: { labStartup: string }; classList: { contains(value: string): boolean } }; getElementById(id: string): object; querySelector(): { disabled: boolean } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function bridge() {
  const state = { busy: false };
  return { state, canDeactivate: vi.fn<DeactivationBridge["canDeactivate"]>(() => ({ allowed: !state.busy, reason: state.busy ? "任务仍在执行" : undefined })),
    activate: vi.fn(async () => ({ ok: true })) };
}

function taskBridge() {
  const value = bridge();
  const state = { busy: false, pendingReceiptCount: 0 };
  return { ...value, state,
    canDeactivate: vi.fn<DeactivationBridge["canDeactivate"]>(() => ({ allowed: !state.busy, reason: state.busy ? "任务仍在执行" : undefined })),
    getTaskState: vi.fn(() => ({ ready: true, busy: state.busy, activeCount: state.busy ? 1 : 0,
      pendingReceiptCount: state.pendingReceiptCount, summary: state.busy ? "1 个任务进行中" : "请求回执待确认" })) };
}

function harness(initial: Props = { kind: "image", initialSurface: "mirror" }) {
  const slots: HookSlot[] = [];
  const frames = new Map<string, Frame>();
  const frameRefs = new Map<string, (frame: Frame | null) => void>();
  const bridges = new Map<string, Bridge | undefined>();
  const defaults = new Map(CREATIVE_VIRAL_SURFACES.map(item => [item.id, bridge()]));
  const studioDefaults = new Map(["main", "detail", "ad", "batch"].map(id => [id, taskBridge()]));
  const toolsDefaults = new Map(["clothing", "buyer", "refinement"].map(id => {
    const value = bridge();
    return [id, { ...value, getState: vi.fn(() => ({ ready: true, busy: value.state.busy })) }] as const;
  }));
  const promptDefaults = new Map(["mirror", "list-main", "list-legacy", "reference", "sku"].map(id => [id, taskBridge()]));
  const intervals = new Map<number, () => void>();
  const windowEvents = new Map<string, (event: unknown) => void>();
  const documentEvents = new Map<string, (event: unknown) => void>();
  let nextTimer = 1;
  const browserWindow = {
    location: { href: "https://offline.test/dashboards/operating-network", origin: "https://offline.test" },
    setInterval: (callback: () => void) => { const id = nextTimer++; intervals.set(id, callback); return id; },
    clearInterval: (id: number) => intervals.delete(id),
    addEventListener: (name: string, callback: (event: unknown) => void) => windowEvents.set(name, callback),
    removeEventListener: (name: string) => windowEvents.delete(name)
  };
  const browserDocument = {
    addEventListener: (name: string, callback: (event: unknown) => void) => documentEvents.set(name, callback),
    removeEventListener: (name: string) => documentEvents.delete(name)
  };
  for (const [id, value] of defaults) bridges.set(id, value);
  let props = initial, cursor = 0, dirty = false, unmounted = false, updatesAfterUnmount = 0;
  let tree: RenderValue;
  let pending: Array<{ slot: HookSlot; callback: () => Cleanup }> = [];
  const router = { push: vi.fn(), replace: vi.fn() };
  const sameDeps = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const hook = (kind: string) => {
    const index = cursor++;
    if (!slots[index]) slots[index] = { kind };
    if (slots[index].kind !== kind) throw new Error("Hook order changed");
    return slots[index];
  };
  const react = {
    useState(initialValue: unknown) {
      const slot = hook("state");
      if (!Object.hasOwn(slot, "value")) slot.value = typeof initialValue === "function" ? (initialValue as () => unknown)() : initialValue;
      return [slot.value, (next: unknown) => {
        if (unmounted) { updatesAfterUnmount++; return; }
        const value = typeof next === "function" ? (next as (previous: unknown) => unknown)(slot.value) : next;
        if (!Object.is(slot.value, value)) { slot.value = value; dirty = true; }
      }];
    },
    useRef(initialValue: unknown) {
      const slot = hook("ref");
      if (!Object.hasOwn(slot, "value")) slot.value = { current: initialValue };
      return slot.value;
    },
    useMemo(factory: () => unknown, deps: unknown[]) {
      const slot = hook("memo");
      if (!sameDeps(slot.deps, deps)) { slot.value = factory(); slot.deps = deps; }
      return slot.value;
    },
    useEffect(callback: () => Cleanup, deps?: unknown[]) {
      const slot = hook("effect");
      if (!sameDeps(slot.deps, deps)) { slot.deps = deps; pending.push({ slot, callback }); }
    }
  };
  const jsx = (type: unknown, nodeProps: Record<string, unknown>, key?: unknown): JsxNode => ({ type, props: nodeProps, key });
  const exports: Record<string, unknown> = {};
  const mockStyles = new Proxy({}, { get: (_target, name) => String(name) });
  const context = createContext({ exports, module: { exports }, console, AbortController, URL, setTimeout, clearTimeout, window: browserWindow, document: browserDocument,
    require(name: string) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "next/navigation") return { useRouter: () => router };
      if (name === "lucide-react") return new Proxy({}, { get: (_target, label) => () => String(label) });
      if (name === "./CreativeStudio.module.css") return { __esModule: true, default: mockStyles };
      if (name === "./CreativeCredits") return { CreativeCredits: () => null };
      if (name === "@/lib/creative-history-entry") return { openCreativeHistory };
      if (name === "@/lib/creative-api-entry") return { openCreativeApiConfig };
      if (name === "@/lib/creative-viral-surfaces") return { CREATIVE_VIRAL_SURFACES,
        isDedicatedViralSurface: (value: string) => CREATIVE_VIRAL_SURFACES.some(item => item.id === value) };
      throw new Error("Unexpected component dependency: " + name);
    }
  });
  runInContext(componentJs, context, { filename: "CreativeStudio.tsx" });
  const Component = exports.CreativeStudio as (value: Props) => RenderValue;
  function children(value: RenderValue): RenderValue[] {
    return Array.isArray(value) ? value.flatMap(children) : value == null || typeof value === "boolean" ? [] : [value];
  }
  function walk(value: RenderValue, visit: (node: JsxNode, cached?: JsxNode) => void, cached?: JsxNode) {
    for (const child of children(value)) {
      if (typeof child !== "object" || !child || Array.isArray(child)) continue;
      const parent = child.type === "div" && child.props.className === "cachedFrame" ? child : cached;
      visit(child, parent); walk(child.props.children as RenderValue, visit, parent);
    }
  }
  function reconcile() {
    const seen = new Set<string>();
    walk(tree, (node, parent) => {
      if (node.type !== "iframe") return;
      const id = parent ? String(parent.key) : String(node.key || node.props.src);
      seen.add(id);
      let frame = frames.get(id);
      if (!frame) {
        const src = String(node.props.src), studioId = src.includes("batch=1") ? "batch"
          : src.includes("type=ad") ? "ad" : src.includes("mode=detail") ? "detail" : "main";
        const toolId = new URL(src, "https://offline.test").searchParams.get("tool") || "";
        frame = { identity: id, title: String(node.props.title), src: String(node.props.src), hidden: false, inert: false, draft: "",
          contentWindow: { SanjieViralWorkflowBridge: bridges.get(id), SanjiePromptLabTaskBridge: ["mirror", "list-main"].includes(id) ? undefined : promptDefaults.get(id),
            SanjieAestheticMirrorBridge: id === "mirror" ? promptDefaults.get(id) : undefined,
            SanjieLinkImageBridge: id === "list-main" ? promptDefaults.get(id) : undefined,
            SanjieStudioGenesisBridge: src.includes("studio=1") ? studioDefaults.get(studioId) : undefined,
            SZ_CREATIVE_TOOLS_UI: src.includes("mode=creative") ? toolsDefaults.get(toolId) : undefined,
            SZ_CREATIVE_TOOLS_BRIDGE: { archiveContext: () => ({ accountKey: "tenant:alice" }),
              getAccountKey: vi.fn(async () => "tenant:alice"), openHistory: vi.fn(async () => ({ ok: true })), openConfig: vi.fn(() => ({ ok: true })) } },
          contentDocument: { documentElement: { dataset: { labStartup: "ready" }, classList: { contains: () => false } }, getElementById: () => ({}), querySelector: () => ({ disabled: false }) } };
        frames.set(id, frame);
      }
      frame.hidden = !!parent?.props.hidden;
      frame.inert = !!parent?.props.inert || !!node.props.inert;
      frame.tabIndex = node.props.tabIndex as number | undefined;
      expect(frame.src).toBe(node.props.src);
      const ref = node.props.ref as ((frame: Frame | null) => void) | undefined;
      if (ref) { ref(frame); frameRefs.set(id, ref); }
    });
    for (const [id, ref] of frameRefs) if (!seen.has(id)) { ref(null); frameRefs.delete(id); }
    for (const id of frames.keys()) if (!seen.has(id)) frames.delete(id);
  }
  function render(next = props) {
    if (unmounted) throw new Error("Cannot render unmounted component");
    props = next; cursor = 0; dirty = false; pending = [];
    tree = Component(props); reconcile();
    for (const entry of pending) { entry.slot.cleanup?.(); entry.slot.cleanup = entry.callback(); }
  }
  async function flush(rounds = 32) {
    for (let count = 0; count < rounds; count++) { await Promise.resolve(); if (dirty && !unmounted) render(); }
  }
  const text = (value: RenderValue): string => children(value).map(child => typeof child === "object" && child ? text((child as JsxNode).props.children as RenderValue) : String(child)).join("");
  function nodes(type: string) { const entries: JsxNode[] = []; walk(tree, node => { if (node.type === type) entries.push(node); }); return entries; }
  function button(label: string) {
    const result = nodes("button").find(node => (node.props["aria-label"] || text(node.props.children as RenderValue)) === label);
    if (!result) throw new Error("Missing button: " + label);
    return result;
  }
  function click(label: string) {
    const node = button(label);
    if (node.props.disabled) throw new Error("User cannot click disabled button: " + label);
    (node.props.onClick as () => void)();
  }
  function unmount() {
    for (const slot of slots) slot.cleanup?.();
    for (const ref of frameRefs.values()) ref(null);
    frames.clear(); unmounted = true;
  }
  function selected(label: string) { return button(label).props["aria-current"] === "page"; }
  const alert = () => nodes("p").filter(node => node.props.role === "alert").map(node => text(node.props.children as RenderValue)).join("");
  const status = () => nodes("p").filter(node => node.props.role === "status").map(node => text(node.props.children as RenderValue)).join("");
  render();
  return { frames, defaults, studioDefaults, toolsDefaults, promptDefaults, bridges, router, render, flush, click, button, selected, alert, status, unmount,
    text: () => text(tree),
    tick: () => { for (const callback of intervals.values()) callback(); }, intervals, windowEvents, documentEvents,
    updatesAfterUnmount: () => updatesAfterUnmount };
}


afterEach(() => vi.useRealTimers());

describe("CreativeStudio cached legacy task navigation", () => {
  it.each(["history", "apiConfig"] as const)("opens the existing %s bridge in the replica frame without replacing its draft", async (menu) => {
    const h = harness();
    const frame = h.frames.get("mirror")!;
    frame.draft = "参考图和自家商品";
    h.render({ kind: "image", initialSurface: "mirror", initialHistory: menu === "history", initialApiConfig: menu === "apiConfig" });
    await h.flush();
    expect(frame.contentWindow.SZ_CREATIVE_TOOLS_BRIDGE[menu === "history" ? "openHistory" : "openConfig"]).toHaveBeenCalledOnce();
    expect(h.frames.get("mirror")).toBe(frame);
    expect(frame.draft).toBe("参考图和自家商品");
    expect(h.alert()).toBe("");
    expect(h.router.replace).toHaveBeenCalledWith("/dashboards/operating-network?surface=mirror", { scroll: false });
    h.unmount();
  });

  it("retains every studio frame, draft and receipt callback while concurrent workspaces remain navigable", async () => {
    const h = harness({ kind: "image", initialSurface: "main" });
    const main = h.frames.get("main")!; main.draft = "主图商品与回执";
    h.studioDefaults.get("main")!.state.busy = true;
    h.click("详情"); await h.flush();
    const detail = h.frames.get("detail")!; detail.draft = "详情规划";
    h.studioDefaults.get("detail")!.state.busy = true;
    h.click("广告图"); await h.flush();
    const ad = h.frames.get("ad")!; ad.draft = "广告画面";
    h.studioDefaults.get("ad")!.state.pendingReceiptCount = 3;
    h.click("创建批量任务"); await h.flush();
    const batch = h.frames.get("__studio_batch__")!; batch.draft = "批量商品任务";
    h.studioDefaults.get("batch")!.state.busy = true;
    h.click("买家秀"); await h.flush(); h.tick(); await h.flush();
    expect(h.selected("买家秀")).toBe(true);
    for (const [id, frame] of [["main", main], ["detail", detail], ["ad", ad], ["__studio_batch__", batch]] as const) {
      expect(h.frames.get(id)).toBe(frame); expect(frame.hidden).toBe(true); expect(frame.tabIndex).toBe(-1);
    }
    expect(main.draft).toBe("主图商品与回执"); expect(detail.draft).toBe("详情规划");
    expect(ad.draft).toBe("广告画面"); expect(batch.draft).toBe("批量商品任务");
    expect(h.text()).toContain("执行中 3 · 回执待确认 3");
    expect(h.status()).toContain("主图 · 1 个任务进行中"); expect(h.status()).toContain("详情 · 1 个任务进行中");
    expect(h.status()).toContain("广告图 · 请求回执待确认"); expect(h.status()).toContain("批量任务 · 1 个任务进行中");
    for (const task of h.studioDefaults.values()) expect(task.canDeactivate).not.toHaveBeenCalled();
    h.click("批量任务：返回原任务"); await h.flush();
    expect(h.selected("批量任务")).toBe(true); expect(batch.hidden).toBe(false);
    expect(h.studioDefaults.get("batch")!.activate).toHaveBeenCalledOnce();
    h.click("主图：返回原任务"); await h.flush();
    expect(h.selected("主图")).toBe(true); expect(main.hidden).toBe(false);
    expect(h.studioDefaults.get("main")!.activate).toHaveBeenCalledOnce();
    h.unmount();
  });

  it.each([["main", "主图"], ["detail", "详情"], ["ad", "广告图"], ["batch", "批量任务"]])(
    "allows internal navigation from %s with pending receipts and keeps its original state", async (id, label) => {
      const h = harness({ kind: "image", initialSurface: id === "batch" ? "main" : id, initialBatch: id === "batch" });
      const frameId = id === "batch" ? "__studio_batch__" : id;
      const original = h.frames.get(frameId)!; original.draft = "原任务素材";
      const task = h.studioDefaults.get(id)!; task.state.pendingReceiptCount = 2;
      h.click("爆款复刻"); await h.flush(); h.tick(); await h.flush();
      expect(h.selected("爆款复刻")).toBe(true); expect(h.frames.get(frameId)).toBe(original);
      expect(original.hidden).toBe(true); expect(original.draft).toBe("原任务素材");
      expect(h.text()).toContain("2 个回执待确认"); expect(h.status()).toContain(label + " · 请求回执待确认");
      expect(task.canDeactivate).not.toHaveBeenCalled();
      h.click(label + "：返回原任务"); await h.flush();
      expect(h.selected(label)).toBe(true); expect(original.hidden).toBe(false); expect(task.activate).toHaveBeenCalledOnce();
      h.unmount();
    }
  );

  it("holds a cached studio behind its account activation guard without blocking a newer URL selection", async () => {
    const h = harness({ kind: "image", initialSurface: "detail" });
    const detail = h.frames.get("detail")!; detail.draft = "旧账号商品";
    h.click("主图"); await h.flush();
    h.studioDefaults.get("detail")!.activate.mockResolvedValueOnce({ ok: false, error: "当前账号已变更，请重新打开工作台。" } as { ok: boolean });
    h.click("详情"); await h.flush();
    expect(h.selected("主图")).toBe(true); expect(detail.hidden).toBe(true);
    expect(h.alert()).toContain("当前账号已变更"); expect(detail.draft).toBe("旧账号商品");
    const pending = deferred<{ ok: boolean }>();
    h.studioDefaults.get("detail")!.activate.mockImplementationOnce(() => pending.promise);
    h.click("详情"); await h.flush(2);
    h.render({ kind: "image", initialSurface: "ad" }); await h.flush();
    expect(h.selected("广告图")).toBe(true);
    pending.resolve({ ok: true }); await h.flush();
    expect(h.selected("广告图")).toBe(true); expect(detail.hidden).toBe(true);
    h.unmount();
  });

  it("can leave a loading studio without destroying it and restores a busy batch on URL navigation", async () => {
    const h = harness({ kind: "image", initialBatch: true });
    const original = h.frames.get("__studio_batch__")!;
    original.contentWindow.SanjieStudioGenesisBridge = undefined;
    original.contentDocument.documentElement.dataset.labStartup = "pending";
    h.click("主图"); await h.flush();
    expect(h.selected("主图")).toBe(true); expect(h.frames.get("__studio_batch__")).toBe(original);
    h.render({ kind: "image", initialSurface: "main", initialBatch: false }); await h.flush();
    original.contentWindow.SanjieStudioGenesisBridge = h.studioDefaults.get("batch");
    original.contentDocument.documentElement.dataset.labStartup = "ready";
    h.studioDefaults.get("batch")!.state.busy = true;
    h.render({ kind: "image", initialSurface: "main", initialBatch: true }); await h.flush();
    expect(h.selected("批量任务")).toBe(true);
    expect(original.hidden).toBe(false);
    expect(h.studioDefaults.get("batch")!.activate).toHaveBeenCalledOnce();
    h.unmount();
  });

  it("shows the current studio task state and stops its notice after settlement", async () => {
    const h = harness({ kind: "image", initialSurface: "main" });
    const task = h.studioDefaults.get("main")!; task.state.busy = true;
    h.tick(); await h.flush();
    expect(h.status()).toContain("主图 · 1 个任务进行中"); expect(h.text()).toContain("当前工作台");
    task.state.busy = false; task.state.pendingReceiptCount = 2;
    h.tick(); await h.flush(); expect(h.text()).toContain("执行中 0 · 回执待确认 2");
    task.state.pendingReceiptCount = 0;
    h.tick(); await h.flush(); expect(h.status()).toBe("");
    h.unmount();
  });

  it("protects actual unloading of hidden studio callbacks but allows leaving once local execution ends", async () => {
    const h = harness({ kind: "image", initialSurface: "main" });
    const task = h.studioDefaults.get("main")!; task.state.busy = true;
    h.click("详情"); await h.flush();
    h.click("生成视频"); await h.flush();
    expect(h.router.push).not.toHaveBeenCalled(); expect(h.alert()).toContain("主图：任务仍在执行");
    const event = { preventDefault: vi.fn(), returnValue: undefined }; h.windowEvents.get("beforeunload")!(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    task.state.busy = false; task.state.pendingReceiptCount = 1;
    h.click("生成视频"); await h.flush();
    expect(h.router.push).toHaveBeenCalledWith("/dashboards/operating-network/video");
    h.unmount();
  });

  it("normalizes an unknown surface into the retained main frame", async () => {
    const h = harness({ kind: "image", initialSurface: "unknown" });
    await h.flush(); expect(h.selected("主图")).toBe(true); expect(h.frames.get("main")?.hidden).toBe(false);
    h.unmount();
  });

  it("bounds a lost target activation response and enables retry without unmounting it", async () => {
    vi.useFakeTimers();
    const h = harness(); h.click("主图"); await h.flush();
    const original = h.frames.get("mirror");
    const pending = deferred<{ ok: boolean }>();
    h.promptDefaults.get("mirror")!.activate.mockImplementationOnce(() => pending.promise);
    h.click("爆款复刻"); await h.flush();
    expect(h.button("爆款复刻").props.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000); await h.flush();
    expect(h.alert()).toContain("工作台状态确认超时");
    expect(h.button("爆款复刻").props.disabled).toBe(false);
    expect(h.frames.get("mirror")).toBe(original); expect(original?.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    h.click("爆款复刻"); await h.flush();
    expect(h.selected("爆款复刻")).toBe(true);
    pending.resolve({ ok: true }); await h.flush();
    expect(h.selected("爆款复刻")).toBe(true);
    h.unmount();
  });

  it("bounds a lost hidden-task deactivation response and retains the whole workbench", async () => {
    vi.useFakeTimers();
    const h = harness(); h.click("主图"); await h.flush();
    const pending = deferred<Permission>();
    h.promptDefaults.get("mirror")!.canDeactivate.mockImplementationOnce(() => pending.promise);
    h.click("生成视频"); await h.flush();
    expect(h.button("生成视频").props.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000); await h.flush();
    expect(h.alert()).toContain("工作台状态确认超时");
    expect(h.button("生成视频").props.disabled).toBe(false);
    expect(h.router.push).not.toHaveBeenCalled(); expect(h.frames.has("mirror")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    h.click("生成视频"); await h.flush();
    expect(h.router.push).toHaveBeenCalledWith("/dashboards/operating-network/video");
    h.unmount();
  });
  it.each([["mirror", "爆款复刻"], ["list-main", "链接成图"], ["list-legacy", "旧链接任务"], ["reference", "清单成详"], ["sku", "批量 SKU"]])(
    "preserves the busy %s iframe and receipt callbacks while another image entry opens", async (id, label) => {
      const h = harness({ kind: "image", initialSurface: id });
      const original = h.frames.get(id)!;
      original.draft = "商品与待确认回执";
      const task = h.promptDefaults.get(id)!;
      task.state.busy = true;
      h.click("主图"); await h.flush();
      expect(h.selected("主图")).toBe(true);
      expect(h.frames.get(id)).toBe(original);
      expect(original.hidden).toBe(true);
      expect(original.tabIndex).toBe(-1);
      expect(original.draft).toBe("商品与待确认回执");
      expect(task.canDeactivate).not.toHaveBeenCalled();
      h.tick(); await h.flush();
      expect(h.status()).toContain(label + " · 1 个任务进行中");
      h.click(label + "：返回原任务"); await h.flush();
      expect(original.hidden).toBe(false);
      expect(task.activate).toHaveBeenCalledOnce();
      expect(h.status()).toContain(label + " · 1 个任务进行中");
      h.unmount();
    }
  );

  it("keeps legacy bookmarked frames and the unified entry while concurrent tasks are running", async () => {
    const h = harness({ kind: "image", initialSurface: "list-legacy" });
    h.promptDefaults.get("list-legacy")!.state.busy = true;
    h.render({ kind: "image", initialSurface: "reference" }); await h.flush();
    h.promptDefaults.get("reference")!.state.busy = true;
    h.render({ kind: "image", initialSurface: "sku" }); await h.flush();
    h.promptDefaults.get("sku")!.state.busy = true;
    h.click("爆款复刻"); await h.flush();
    h.promptDefaults.get("mirror")!.state.busy = true;
    h.tick(); await h.flush();
    expect(new Set(h.frames.keys())).toEqual(new Set(["mirror", "list-legacy", "reference", "sku"]));
    expect(h.status()).toContain("旧链接任务"); expect(h.status()).toContain("清单成详");
    expect(h.status()).toContain("批量 SKU"); expect(h.status()).toContain("爆款复刻");
    h.click("清单成详：返回原任务"); await h.flush();
    expect(h.frames.get("reference")!.hidden).toBe(false);
    expect(h.frames.get("mirror")!.hidden).toBe(true);
    h.unmount();
  });

  it("opens the dedicated link workspace beside mirror and keeps the old engine at its explicit recovery URL", async () => {
    const h = harness();
    h.click("链接成图"); await h.flush();
    expect(h.frames.get("list-main")?.src).toBe("/creative/labs/image-prompt-lab/promptlab.html?mode=link-image&source=web");
    expect(h.selected("链接成图")).toBe(true);
    expect(h.frames.get("mirror")?.hidden).toBe(true);
    h.render({ kind: "image", initialSurface: "list-legacy" }); await h.flush();
    expect(h.frames.get("list-legacy")?.src).toBe("/creative/labs/image-prompt-lab/promptlab.html?mode=main&source=web&layout=1");
    expect(h.frames.get("list-main")?.hidden).toBe(true);
    h.unmount();
  });

  it("permits batch creation without destroying a cached task", async () => {
    const h = harness(), frame = h.frames.get("mirror");
    h.promptDefaults.get("mirror")!.state.busy = true;
    h.click("创建批量任务"); await h.flush();
    expect(h.selected("批量任务")).toBe(true);
    expect(h.frames.get("mirror")).toBe(frame);
    expect(frame?.hidden).toBe(true);
    h.unmount();
  });

  it("preserves an active studio while still protecting creative tools that would be unmounted", async () => {
    const h = harness(); h.click("主图"); await h.flush();
    h.studioDefaults.get("main")!.state.busy = true;
    h.click("爆款复刻"); await h.flush();
    expect(h.selected("爆款复刻")).toBe(true); expect(h.alert()).toBe("");
    expect(h.frames.get("main")?.hidden).toBe(true);
    h.studioDefaults.get("main")!.state.busy = false;
    h.click("买家秀"); await h.flush();
    h.toolsDefaults.get("buyer")!.state.busy = true;
    h.click("爆款复刻"); await h.flush();
    expect(h.selected("买家秀")).toBe(true); expect(h.alert()).toContain("当前创作工具正在处理");
    h.unmount();
  });

  it("does not reveal a cached target when its account/config activation fails", async () => {
    const h = harness(), frame = h.frames.get("mirror")!;
    frame.draft = "原账号商品";
    h.click("主图"); await h.flush();
    h.promptDefaults.get("mirror")!.activate.mockResolvedValue({ ok: false, error: "当前账号已变更，请重新打开工作台。" } as { ok: boolean });
    h.click("爆款复刻"); await h.flush();
    expect(h.selected("主图")).toBe(true); expect(frame.hidden).toBe(true);
    expect(frame.draft).toBe("原账号商品"); expect(h.alert()).toContain("当前账号已变更");
    h.unmount();
  });

  it("keeps an activating target hidden and discards an obsolete activation result", async () => {
    const h = harness(); h.click("主图"); await h.flush();
    const pending = deferred<{ ok: boolean }>();
    h.promptDefaults.get("mirror")!.activate.mockImplementation(() => pending.promise);
    h.click("爆款复刻"); await h.flush(2);
    expect(h.frames.get("mirror")!.hidden).toBe(true);
    h.render({ kind: "image", initialSurface: "reference" }); await h.flush();
    expect(h.frames.get("reference")!.hidden).toBe(false);
    pending.resolve({ ok: true }); await h.flush();
    expect(h.frames.get("reference")!.hidden).toBe(false);
    expect(h.frames.get("mirror")!.hidden).toBe(true);
    h.unmount();
  });

  it("blocks video navigation for a hidden task then permits it after local work ends", async () => {
    const h = harness(), task = h.promptDefaults.get("mirror")!;
    task.state.busy = true;
    h.click("主图"); await h.flush();
    h.click("生成视频"); await h.flush();
    expect(h.router.push).not.toHaveBeenCalled();
    expect(h.alert()).toContain("爆款复刻：任务仍在执行");
    task.state.busy = false; task.state.pendingReceiptCount = 1;
    h.click("生成视频"); await h.flush();
    expect(h.router.push).toHaveBeenCalledWith("/dashboards/operating-network/video");
    h.unmount();
  });

  it("updates reminders on task settlement without a new navigation", async () => {
    const h = harness(), task = h.promptDefaults.get("mirror")!;
    task.state.busy = true; h.click("主图"); await h.flush(); h.tick(); await h.flush();
    expect(h.status()).toContain("任务进行中");
    task.state.busy = false; task.state.pendingReceiptCount = 1;
    h.tick(); await h.flush(); expect(h.status()).toContain("请求回执待确认");
    task.state.pendingReceiptCount = 0;
    h.tick(); await h.flush(); expect(h.status()).toBe("");
    h.unmount();
  });

  it("protects browser unload only while cached local work is active and cleans up listeners", async () => {
    const h = harness(), task = h.promptDefaults.get("mirror")!;
    await h.flush(); task.state.busy = true;
    const event = { preventDefault: vi.fn(), returnValue: undefined };
    h.windowEvents.get("beforeunload")!(event);
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.returnValue).toBe("");
    task.state.busy = false; task.state.pendingReceiptCount = 1;
    const ended = { preventDefault: vi.fn() }; h.windowEvents.get("beforeunload")!(ended);
    expect(ended.preventDefault).not.toHaveBeenCalled();
    h.unmount();
    expect(h.intervals.size).toBe(0); expect(h.windowEvents.size).toBe(0); expect(h.documentEvents.size).toBe(0);
  });

  it.each([
    ["https://offline.test/dashboards/operating-network/video", 0, false, "", true],
    ["https://offline.test/profile", 0, false, "", true],
    ["https://offline.test/dashboards/operating-network", 0, false, "", false],
    ["https://offline.test/profile", 0, true, "", false],
    ["https://offline.test/profile", 1, false, "", false],
    ["https://offline.test/profile", 0, false, "_blank", false]
  ])("guards outer navigation %s / button %s / modified %s / target %s", async (href, button, metaKey, target, blocked) => {
    const h = harness(); await h.flush(); h.promptDefaults.get("mirror")!.state.busy = true;
    const event = { button, metaKey, target: { closest: () => ({ href, target, hasAttribute: () => false }) },
      preventDefault: vi.fn(), stopPropagation: vi.fn() };
    h.documentEvents.get("click")!(event); await h.flush();
    expect(event.preventDefault).toHaveBeenCalledTimes(blocked ? 1 : 0);
    expect(event.stopPropagation).toHaveBeenCalledTimes(blocked ? 1 : 0);
    if (blocked) expect(h.alert()).toContain("爆款复刻有任务正在后台进行");
    h.unmount();
  });
});
