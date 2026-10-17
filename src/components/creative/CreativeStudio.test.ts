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
const componentSource = readFileSync(resolve("src/components/creative/CreativeStudio.tsx"), "utf8");
const componentJs = ts.transpileModule(componentSource, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX
}, fileName: "CreativeStudio.tsx" }).outputText;
const stylesSource = readFileSync(resolve("src/components/creative/CreativeStudio.module.css"), "utf8");

interface Props { kind: "image" | "video"; initialSurface?: string; initialBatch?: boolean; initialHistory?: boolean; initialApiConfig?: boolean }
interface Permission { allowed: boolean; reason?: string }
interface DeactivationBridge { canDeactivate(): Permission | Promise<Permission> }
interface ToolsBridge extends DeactivationBridge { getState(): { ready: boolean; startupFailed?: boolean; busy: boolean } }
interface Bridge {
  canDeactivate(): Permission | Promise<Permission>;
  activate(): Promise<{ ok: boolean; error?: string }>;
}
interface JsxNode { type: unknown; key?: unknown; props: Record<string, unknown> }
type RenderValue = JsxNode | string | number | boolean | null | undefined | RenderValue[];
type Cleanup = (() => void) | undefined;
interface HookSlot { kind: string; value?: unknown; deps?: unknown[]; cleanup?: Cleanup }
interface Frame {
  identity: string; title: string; src: string; hidden: boolean; inert: boolean;
  tabIndex?: number; draft: string;
  contentWindow: { SanjieViralWorkflowBridge?: Bridge; SanjieStudioGenesisBridge?: DeactivationBridge;
    SZ_CREATIVE_TOOLS_UI?: ToolsBridge;
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

function harness(initial: Props = { kind: "image", initialSurface: "viral-case" }) {
  const slots: HookSlot[] = [];
  const frames = new Map<string, Frame>();
  const frameRefs = new Map<string, (frame: Frame | null) => void>();
  const bridges = new Map<string, Bridge | undefined>();
  const defaults = new Map(CREATIVE_VIRAL_SURFACES.map(item => [item.id, bridge()]));
  const studioDefaults = new Map(["main", "detail", "ad", "batch"].map(id => [id, bridge()]));
  const toolsDefaults = new Map(["clothing", "buyer", "refinement"].map(id => {
    const value = bridge();
    return [id, { ...value, getState: vi.fn(() => ({ ready: true, busy: value.state.busy })) }] as const;
  }));
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
  const context = createContext({ exports, module: { exports }, console, AbortController, setTimeout, clearTimeout,
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
          contentWindow: { SanjieViralWorkflowBridge: bridges.get(id),
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
  async function flush(rounds = 12) {
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
  return { frames, defaults, studioDefaults, toolsDefaults, bridges, router, render, flush, click, button, selected, alert, status, unmount,
    updatesAfterUnmount: () => updatesAfterUnmount };
}


afterEach(() => vi.useRealTimers());

const mainProps: Props = { kind: "image", initialSurface: "main" };
const apiProps: Props = { ...mainProps, initialApiConfig: true };

describe("CreativeStudio API menu notice lifecycle", () => {
  it("ends the opening notice as soon as the child reports a startup error", async () => {
    vi.useFakeTimers();
    const h = harness(mainProps), frame = [...h.frames.values()][0];
    frame.contentDocument.documentElement.dataset.labStartup = "pending";
    h.render(apiProps); await h.flush();
    expect(h.status()).toContain("正在打开自定义配置 API");
    frame.contentDocument.documentElement.dataset.labStartup = "error";
    await vi.advanceTimersByTimeAsync(100); await h.flush();
    expect(h.status()).toBe(""); expect(h.alert()).toContain("创作工作台加载失败");
    expect(frame.contentWindow.SZ_CREATIVE_TOOLS_BRIDGE.openConfig).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.router.replace).toHaveBeenCalledWith("/dashboards/operating-network", { scroll: false });
    h.unmount();
  });

  it("retries API configuration in the restored workbench while preserving its frame and draft", async () => {
    const h = harness(mainProps), frame = [...h.frames.values()][0]; frame.draft = "保留我的商品素材";
    frame.contentDocument.documentElement.dataset.labStartup = "error";
    h.render(apiProps); await h.flush();
    h.render(mainProps); await h.flush();
    expect(h.alert()).toContain("创作工作台加载失败");
    frame.contentDocument.documentElement.dataset.labStartup = "ready";
    h.click("重试打开 API 配置"); await h.flush();
    expect(h.alert()).toBe(""); expect(h.status()).toBe("");
    expect(frame.contentWindow.SZ_CREATIVE_TOOLS_BRIDGE.openConfig).toHaveBeenCalledOnce();
    expect([...h.frames.values()][0]).toBe(frame); expect(frame.draft).toBe("保留我的商品素材");
    h.unmount();
  });

  it("clears the previous workbench's error after switching surfaces", async () => {
    const h = harness(mainProps), frame = [...h.frames.values()][0];
    frame.contentWindow.SZ_CREATIVE_TOOLS_BRIDGE.openConfig.mockReturnValue({ ok: false, error: "请等待当前任务结束后配置 API。" });
    h.render(apiProps); await h.flush(); h.render(mainProps); await h.flush();
    expect(h.alert()).toContain("请等待当前任务");
    h.click("详情"); await h.flush();
    expect(h.selected("详情")).toBe(true); expect(h.alert()).toBe(""); expect(h.status()).toBe("");
    expect(frame.contentWindow.SZ_CREATIVE_TOOLS_BRIDGE.openConfig).toHaveBeenCalledOnce();
    h.unmount();
  });

  it("cancels a pending menu request when its query is consumed without opening it later", async () => {
    vi.useFakeTimers();
    const h = harness(mainProps), frame = [...h.frames.values()][0];
    frame.contentDocument.documentElement.dataset.labStartup = "pending";
    h.render(apiProps); await h.flush(); expect(h.status()).not.toBe("");
    h.render(mainProps); await h.flush(); expect(h.status()).toBe("");
    frame.contentDocument.documentElement.dataset.labStartup = "ready";
    await vi.advanceTimersByTimeAsync(12_000); await h.flush();
    expect(frame.contentWindow.SZ_CREATIVE_TOOLS_BRIDGE.openConfig).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); h.unmount();
  });

  it("turns an unavailable configuration into a bounded error with a retry action", async () => {
    vi.useFakeTimers();
    const h = harness(mainProps), frame = [...h.frames.values()][0];
    frame.contentDocument.documentElement.dataset.labStartup = "pending";
    h.render(apiProps); await h.flush();
    await vi.advanceTimersByTimeAsync(12_000); await h.flush();
    expect(h.status()).toBe(""); expect(h.alert()).toContain("配置暂未就绪");
    expect(h.button("重试打开 API 配置").props.disabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0); h.unmount();
  });

  it("releases pending work on unmount without any later React updates", async () => {
    vi.useFakeTimers();
    const h = harness(mainProps), frame = [...h.frames.values()][0];
    frame.contentDocument.documentElement.dataset.labStartup = "pending";
    h.render(apiProps); await h.flush(); h.unmount();
    await vi.advanceTimersByTimeAsync(12_000); await h.flush();
    expect(h.updatesAfterUnmount()).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(frame.contentWindow.SZ_CREATIVE_TOOLS_BRIDGE.openConfig).not.toHaveBeenCalled();
  });
});
