import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { CREATIVE_VIRAL_SURFACES } from "./creative-viral-surfaces";
import { openCreativeHistory } from "./creative-history-entry";
import { openCreativeApiConfig } from "./creative-api-entry";
import { ACCOUNT as TOOLS_ACCOUNT, tools as creativeTools, bootCreativeToolsFixture, createCreativeToolsFixture, flushCreativeToolsFixture, type StoredToolDraft } from "./creative-tools-navigation-fixture";

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
  const context = createContext({ exports, module: { exports }, console, AbortController,
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

async function visitCachedStyle(h: ReturnType<typeof harness>) {
  h.click("风格焕新"); await h.flush();
  h.render({ kind: "image", initialSurface: "viral-style" }); await h.flush();
  h.click("案例裂变"); await h.flush();
  h.render({ kind: "image", initialSurface: "viral-case" }); await h.flush();
  h.router.replace.mockClear(); h.router.push.mockClear();
}

describe("actual CreativeStudio async navigation and cached iframe lifetime", () => {
  it("loads a dedicated iframe only on its first visit and retains all three live instances", async () => {
    const h = harness({ kind: "image", initialSurface: "main" });
    expect([...h.frames.keys()].filter(key => key.startsWith("viral-"))).toEqual([]);
    h.click("案例裂变"); await h.flush();
    const caseFrame = h.frames.get("viral-case")!; caseFrame.draft = "案例草稿甲";
    expect(h.frames.has("viral-style")).toBe(false); expect(h.frames.has("viral-scene")).toBe(false);
    h.click("风格焕新"); await h.flush();
    const styleFrame = h.frames.get("viral-style")!; styleFrame.draft = "自由共创描述乙";
    h.click("场景延展"); await h.flush();
    const sceneFrame = h.frames.get("viral-scene")!; sceneFrame.draft = "场景多角度素材丙";
    h.click("案例裂变"); await h.flush();
    expect(h.frames.get("viral-case")).toBe(caseFrame); expect(caseFrame.draft).toBe("案例草稿甲");
    expect(h.frames.get("viral-style")).toBe(styleFrame); expect(styleFrame.draft).toBe("自由共创描述乙");
    expect(h.frames.get("viral-scene")).toBe(sceneFrame); expect(sceneFrame.draft).toBe("场景多角度素材丙");
    expect(h.frames.size).toBe(3);
    for (const surface of CREATIVE_VIRAL_SURFACES) expect(h.frames.get(surface.id)?.src).toBe(surface.src);
    expect(caseFrame.hidden).toBe(false); expect(styleFrame.hidden).toBe(true); expect(sceneFrame.hidden).toBe(true);
    expect(styleFrame.tabIndex).toBe(-1); expect(sceneFrame.tabIndex).toBe(-1);
    expect(stylesSource).toMatch(/\.cachedFrame\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  it("retains cached drafts when opening and returning from the batch workbench", async () => {
    const h = harness(), frame = h.frames.get("viral-case")!; frame.draft = "未提交计划";
    h.click("批量任务"); await h.flush();
    expect(h.frames.get("viral-case")).toBe(frame); expect(frame.hidden).toBe(true);
    h.click("返回单个创作"); await h.flush();
    h.click("案例裂变"); await h.flush();
    expect(h.frames.get("viral-case")).toBe(frame); expect(frame.hidden).toBe(false); expect(frame.draft).toBe("未提交计划");
  });

  it("keeps the original page visible if it becomes busy during target activation", async () => {
    const h = harness(); await visitCachedStyle(h);
    const wait = deferred<{ ok: boolean }>(); h.defaults.get("viral-style")!.activate.mockImplementation(() => wait.promise);
    h.click("风格焕新"); await h.flush(2);
    expect(h.frames.get("viral-case")?.inert).toBe(true); expect(h.frames.get("viral-case")?.hidden).toBe(false);
    h.defaults.get("viral-case")!.state.busy = true;
    wait.resolve({ ok: true }); await h.flush();
    expect(h.selected("案例裂变")).toBe(true); expect(h.frames.get("viral-case")?.hidden).toBe(false);
    expect(h.router.replace).not.toHaveBeenCalled(); expect(h.router.push).not.toHaveBeenCalled();
    expect(h.alert()).toContain("任务仍在执行"); expect(h.frames.get("viral-case")?.inert).toBe(false);
  });

  it.each(["deny", "reject"])("does not switch when the cached target API activation fails: %s", async failure => {
    const h = harness(); await visitCachedStyle(h);
    if (failure === "deny") h.defaults.get("viral-style")!.activate.mockResolvedValue({ ok: false });
    else h.defaults.get("viral-style")!.activate.mockRejectedValue(new Error("API不可用"));
    h.click("风格焕新"); await h.flush();
    expect(h.selected("案例裂变")).toBe(true); expect(h.frames.get("viral-style")?.hidden).toBe(true);
    expect(h.router.replace).not.toHaveBeenCalled(); expect(h.alert()).not.toBe("");
    expect(h.button("风格焕新").props.disabled).toBe(false);
  });

  it("does not run a second activation after rapid clicks before React renders disabled buttons", async () => {
    const h = harness(); await visitCachedStyle(h);
    const wait = deferred<{ ok: boolean }>(); h.defaults.get("viral-style")!.activate.mockImplementation(() => wait.promise);
    const styleClick = h.button("风格焕新").props.onClick as () => void;
    const sceneClick = h.button("场景延展").props.onClick as () => void;
    styleClick(); sceneClick(); await h.flush(2);
    expect(h.frames.has("viral-scene")).toBe(false); expect(h.defaults.get("viral-style")!.activate).toHaveBeenCalledOnce();
    wait.resolve({ ok: true }); await h.flush();
    expect(h.selected("风格焕新")).toBe(true); expect(h.router.replace).toHaveBeenCalledTimes(1);
  });

  it("does not change state or router after unmount while activation is awaiting", async () => {
    const h = harness(); await visitCachedStyle(h);
    const wait = deferred<{ ok: boolean }>(); h.defaults.get("viral-style")!.activate.mockImplementation(() => wait.promise);
    h.click("风格焕新"); await h.flush(2); h.unmount();
    wait.resolve({ ok: true }); await h.flush();
    expect(h.router.replace).not.toHaveBeenCalled(); expect(h.router.push).not.toHaveBeenCalled();
    expect(h.updatesAfterUnmount()).toBe(0);
  });

  it("invalidates the first pending click when a back/forward URL revision requests another workflow", async () => {
    const h = harness(); await visitCachedStyle(h);
    const wait = deferred<{ ok: boolean }>(); h.defaults.get("viral-style")!.activate.mockImplementation(() => wait.promise);
    h.click("风格焕新"); await h.flush(2);
    h.render({ kind: "image", initialSurface: "viral-scene" }); await h.flush();
    expect(h.selected("场景延展")).toBe(true);
    wait.resolve({ ok: true }); await h.flush();
    expect(h.selected("场景延展")).toBe(true); expect(h.frames.get("viral-style")?.hidden).toBe(true);
    expect(h.router.replace).not.toHaveBeenCalled(); expect(h.router.push).not.toHaveBeenCalled();
  });

  it("keeps the active busy workflow on URL navigation and restores its URL", async () => {
    const h = harness(); h.defaults.get("viral-case")!.state.busy = true;
    h.render({ kind: "image", initialSurface: "viral-scene" }); await h.flush();
    expect(h.selected("案例裂变")).toBe(true); expect(h.frames.has("viral-scene")).toBe(false);
    expect(h.router.replace).toHaveBeenCalledWith("/dashboards/operating-network?surface=viral-case", { scroll: false });
    expect(h.alert()).toContain("任务仍在执行");
  });

  it("does not let an older URL activation overwrite a newer URL revision", async () => {
    const h = harness(); await visitCachedStyle(h);
    const wait = deferred<{ ok: boolean }>(); h.defaults.get("viral-style")!.activate.mockImplementation(() => wait.promise);
    h.render({ kind: "image", initialSurface: "viral-style" }); await h.flush(2);
    h.render({ kind: "image", initialSurface: "viral-scene" }); await h.flush();
    wait.resolve({ ok: true }); await h.flush();
    expect(h.selected("场景延展")).toBe(true); expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("blocks leaving an unready dedicated iframe but permits leaving a startup error", async () => {
    const h = harness(), frame = h.frames.get("viral-case")!;
    delete frame.contentWindow.SanjieViralWorkflowBridge;
    frame.contentDocument.documentElement.dataset.labStartup = "pending";
    h.click("场景延展"); await h.flush();
    expect(h.selected("案例裂变")).toBe(true); expect(h.frames.has("viral-scene")).toBe(false);
    expect(h.alert()).toContain("正在打开");
    frame.contentDocument.documentElement.dataset.labStartup = "error";
    h.click("场景延展"); await h.flush();
    expect(h.selected("场景延展")).toBe(true);
  });

  it.each(["生成视频", "批量任务", "主图"])("blocks %s while the current dedicated workflow is busy", async label => {
    const h = harness(); h.defaults.get("viral-case")!.state.busy = true;
    h.click(label); await h.flush();
    expect(h.selected("案例裂变")).toBe(true); expect(h.frames.get("viral-case")?.hidden).toBe(false);
    expect(h.router.push).not.toHaveBeenCalled(); expect(h.router.replace).not.toHaveBeenCalled();
  });
});

describe("actual CreativeStudio history deep links", () => {
  it("opens the existing visible history again after the URL request has been consumed", async () => {
    const h = harness({ kind: "image", initialSurface: "main", initialHistory: true });
    const frame = [...h.frames.values()][0], history = frame.contentWindow.SZ_CREATIVE_TOOLS_BRIDGE;
    await h.flush();
    expect(history.openHistory).toHaveBeenCalledOnce();
    expect(h.router.replace).toHaveBeenCalledWith("/dashboards/operating-network", { scroll: false });
    h.render({ kind: "image", initialSurface: "main" }); await h.flush();
    h.render({ kind: "image", initialSurface: "main", initialHistory: true }); await h.flush();
    expect(history.openHistory).toHaveBeenCalledTimes(2);
    expect([...h.frames.values()][0]).toBe(frame);
    h.unmount();
  });

  it.each([
    { id: "detail", props: { kind: "image", initialSurface: "detail" }, url: "?surface=detail" },
    { id: "batch", props: { kind: "image", initialSurface: "main", initialBatch: true }, url: "?surface=main&batch=1" }
  ] satisfies Array<{ id: string; props: Props; url: string }>)("keeps a busy $id task and its draft when a menu history link omits its surface", async ({ id, props, url }) => {
    const h = harness(props), frame = [...h.frames.values()][0];
    frame.draft = "未完成商品方案"; h.studioDefaults.get(id)!.state.busy = true;
    h.render({ kind: "image", initialHistory: true }); await h.flush();
    expect([...h.frames.values()][0]).toBe(frame); expect(frame.draft).toBe("未完成商品方案");
    expect(frame.contentWindow.SZ_CREATIVE_TOOLS_BRIDGE.openHistory).toHaveBeenCalledOnce();
    expect(h.studioDefaults.get(id)!.canDeactivate).not.toHaveBeenCalled();
    expect(h.router.replace).toHaveBeenCalledWith(`/dashboards/operating-network${url}`, { scroll: false });
    h.unmount();
  });

  it("opens only the current cached iframe and reports an account change visibly", async () => {
    const h = harness(); await visitCachedStyle(h);
    const visible = h.frames.get("viral-case")!, hidden = h.frames.get("viral-style")!;
    visible.contentWindow.SZ_CREATIVE_TOOLS_BRIDGE.getAccountKey.mockResolvedValue("tenant:bob");
    h.render({ kind: "image", initialHistory: true }); await h.flush();
    expect(h.alert()).toContain("登录账号已变化");
    expect(visible.contentWindow.SZ_CREATIVE_TOOLS_BRIDGE.openHistory).not.toHaveBeenCalled();
    expect(hidden.contentWindow.SZ_CREATIVE_TOOLS_BRIDGE.getAccountKey).not.toHaveBeenCalled();
    expect(h.selected("案例裂变")).toBe(true);
    expect(h.router.replace).toHaveBeenCalledWith("/dashboards/operating-network?surface=viral-case", { scroll: false });
    h.unmount();
  });

  it("does not reopen a history dialog or redirect after leaving during identity validation", async () => {
    const h = harness({ kind: "image", initialSurface: "main" });
    const history = [...h.frames.values()][0].contentWindow.SZ_CREATIVE_TOOLS_BRIDGE;
    const identity = deferred<string>(); history.getAccountKey.mockImplementation(() => identity.promise);
    h.render({ kind: "image", initialHistory: true }); await h.flush(2);
    h.unmount(); identity.resolve("tenant:alice"); await h.flush();
    expect(history.openHistory).not.toHaveBeenCalled();
    expect(h.router.replace).not.toHaveBeenCalled();
    expect(h.updatesAfterUnmount()).toBe(0);
  });

  it("clears a cancelled opening status when the user switches workspaces", async () => {
    const h = harness({ kind: "image", initialSurface: "main" });
    const history = [...h.frames.values()][0].contentWindow.SZ_CREATIVE_TOOLS_BRIDGE;
    const identity = deferred<string>(); history.getAccountKey.mockImplementation(() => identity.promise);
    h.render({ kind: "image", initialHistory: true }); await h.flush();
    expect(h.status()).toContain("正在打开生图历史");
    h.render({ kind: "image", initialSurface: "detail" }); await h.flush();
    identity.resolve("tenant:alice"); await h.flush();
    expect(h.status()).toBe(""); expect(h.selected("详情")).toBe(true);
    expect(history.openHistory).not.toHaveBeenCalled();
    h.unmount();
  });
});

describe("actual CreativeStudio main/detail/ad and batch request protection", () => {
  const cases = [
    { id: "main", label: "主图", props: { kind: "image", initialSurface: "main" } },
    { id: "detail", label: "详情", props: { kind: "image", initialSurface: "detail" } },
    { id: "ad", label: "广告图", props: { kind: "image", initialSurface: "ad" } },
    { id: "batch", label: "批量任务", props: { kind: "image", initialSurface: "main", initialBatch: true } }
  ] satisfies Array<{ id: string; label: string; props: Props }>;

  it.each(cases)("preserves the $id frame while a request is executing", async ({ id, label, props }) => {
    const h = harness(props), frame = [...h.frames.values()].find(item => item.src.includes("studio=1"))!;
    frame.draft = "当前商品与未完成方案"; h.studioDefaults.get(id)!.state.busy = true;
    for (const target of ["案例裂变", "详情", "生成视频", id === "batch" ? "返回单个创作" : "批量任务"]) {
      h.click(target); await h.flush();
      expect(h.frames.get(frame.identity)).toBe(frame); expect(frame.draft).toBe("当前商品与未完成方案");
      expect(h.selected(label)).toBe(true); expect(h.router.push).not.toHaveBeenCalled(); expect(h.router.replace).not.toHaveBeenCalled();
      expect(h.alert()).toContain("任务仍在执行");
    }
  });

  it("keeps an uncertain receipt visible and presents its required next action", async () => {
    const h = harness({ kind: "image", initialSurface: "ad" });
    h.studioDefaults.get("ad")!.canDeactivate.mockReturnValue({ allowed: false, reason: "上一请求回执尚未确认，请先核对服务商任务记录。" });
    h.click("主图"); await h.flush();
    expect(h.selected("广告图")).toBe(true); expect(h.alert()).toContain("先核对服务商任务记录");
    expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("awaits the latest idle draft save before changing the iframe", async () => {
    const h = harness({ kind: "image", initialSurface: "main" }), frame = [...h.frames.values()][0];
    const waiting = deferred<Permission>(); h.studioDefaults.get("main")!.canDeactivate.mockImplementationOnce(() => waiting.promise);
    h.click("详情"); await h.flush(3);
    expect(h.frames.get(frame.identity)).toBe(frame); expect(frame.inert).toBe(true); expect(h.selected("主图")).toBe(true);
    expect(h.router.replace).not.toHaveBeenCalled();
    waiting.resolve({ allowed: true }); await h.flush(20);
    expect(h.selected("详情")).toBe(true); expect(h.frames.has(frame.identity)).toBe(false);
    expect(h.router.replace).toHaveBeenCalledWith("/dashboards/operating-network?surface=detail", { scroll: false });
    expect(h.studioDefaults.get("main")!.canDeactivate).toHaveBeenCalledTimes(2);
  });

  it("keeps the current draft when the asynchronous save cannot complete", async () => {
    const h = harness({ kind: "image", initialSurface: "main" }), frame = [...h.frames.values()][0];
    h.studioDefaults.get("main")!.canDeactivate.mockResolvedValue({ allowed: false, reason: "保存草稿失败，请检查本机存储空间后重试。" });
    h.click("批量任务"); await h.flush();
    expect(h.frames.get(frame.identity)).toBe(frame); expect(frame.inert).toBe(false); expect(h.selected("主图")).toBe(true);
    expect(h.alert()).toContain("保存草稿失败"); expect(h.router.replace).not.toHaveBeenCalled();
  });

  it.each(cases)("requires the $id guard while opening and allows leaving a startup error", async ({ label, props }) => {
    const h = harness(props), frame = [...h.frames.values()].find(item => item.src.includes("studio=1"))!;
    delete frame.contentWindow.SanjieStudioGenesisBridge; frame.contentDocument.documentElement.dataset.labStartup = "pending";
    h.click("案例裂变"); await h.flush();
    expect(h.selected(label)).toBe(true); expect(h.frames.has("viral-case")).toBe(false); expect(h.alert()).toContain("正在打开");
    frame.contentDocument.documentElement.dataset.labStartup = "error";
    h.click("案例裂变"); await h.flush();
    expect(h.selected("案例裂变")).toBe(true);
  });

  it("does not apply an asynchronous guard answer after component unmount", async () => {
    const h = harness({ kind: "image", initialSurface: "main" }), waiting = deferred<Permission>();
    h.studioDefaults.get("main")!.canDeactivate.mockImplementation(() => waiting.promise);
    h.click("详情"); await h.flush(3); h.unmount(); waiting.resolve({ allowed: true }); await h.flush();
    expect(h.router.replace).not.toHaveBeenCalled(); expect(h.router.push).not.toHaveBeenCalled(); expect(h.updatesAfterUnmount()).toBe(0);
  });

  it("restores the active studio URL when back/forward tries to leave a request", async () => {
    const h = harness({ kind: "image", initialSurface: "main" }); h.studioDefaults.get("main")!.state.busy = true;
    h.render({ kind: "image", initialSurface: "ad" }); await h.flush();
    expect(h.selected("主图")).toBe(true); expect(h.selected("广告图")).toBe(false);
    expect(h.router.replace).toHaveBeenCalledWith("/dashboards/operating-network?surface=main", { scroll: false });
  });
});

describe("actual CreativeStudio creative-tool request protection", () => {
  const cases = [
    { id: "refinement", label: "产品精修" }, { id: "clothing", label: "DIY成图" }, { id: "buyer", label: "买家秀" }
  ];

  it.each(cases)("reads the $id UI bridge and keeps its busy iframe", async ({ id, label }) => {
    const h = harness({ kind: "image", initialSurface: id }), frame = [...h.frames.values()][0];
    frame.draft = "商品素材与已完成成果"; h.toolsDefaults.get(id)!.state.busy = true;
    for (const target of ["广告图", "生成视频", "批量任务"]) {
      h.click(target); await h.flush();
      expect([...h.frames.values()][0]).toBe(frame); expect(frame.draft).toBe("商品素材与已完成成果");
      expect(h.selected(label)).toBe(true); expect(h.router.replace).not.toHaveBeenCalled(); expect(h.router.push).not.toHaveBeenCalled();
      expect(h.alert()).toContain("正在处理");
    }
    expect(h.toolsDefaults.get(id)!.getState).toHaveBeenCalled();
  });

  it.each(cases)("awaits $id persistence before changing its iframe", async ({ id, label }) => {
    const h = harness({ kind: "image", initialSurface: id }), frame = [...h.frames.values()][0];
    const pending = deferred<Permission>(); h.toolsDefaults.get(id)!.canDeactivate.mockImplementationOnce(() => pending.promise);
    h.click("广告图"); await h.flush(3);
    expect([...h.frames.values()][0]).toBe(frame); expect(frame.inert).toBe(true); expect(h.selected(label)).toBe(true);
    pending.resolve({ allowed: true }); await h.flush();
    expect(h.selected("广告图")).toBe(true); expect([...h.frames.values()]).not.toContain(frame);
    expect(h.toolsDefaults.get(id)!.canDeactivate).toHaveBeenCalledTimes(2);
  });

  it.each(["草稿保存失败", "登录账号已变化"])("keeps the creative tool on %s", async reason => {
    const h = harness({ kind: "image", initialSurface: "buyer" }), frame = [...h.frames.values()][0];
    h.toolsDefaults.get("buyer")!.canDeactivate.mockResolvedValue({ allowed: false, reason });
    h.click("广告图"); await h.flush();
    expect([...h.frames.values()][0]).toBe(frame); expect(h.selected("买家秀")).toBe(true);
    expect(h.alert()).toContain(reason); expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("blocks missing and initializing tool bridges while retaining the startup failure exit", async () => {
    const h = harness({ kind: "image", initialSurface: "refinement" }), frame = [...h.frames.values()][0];
    const readyBridge = frame.contentWindow.SZ_CREATIVE_TOOLS_UI;
    delete frame.contentWindow.SZ_CREATIVE_TOOLS_UI; frame.contentDocument.documentElement.dataset.labStartup = "pending";
    h.click("广告图"); await h.flush(); expect(h.selected("产品精修")).toBe(true); expect(h.alert()).toContain("正在打开");
    frame.contentWindow.SZ_CREATIVE_TOOLS_UI = readyBridge;
    h.toolsDefaults.get("refinement")!.getState.mockReturnValue({ ready: false, busy: false });
    h.click("广告图"); await h.flush(); expect(h.selected("产品精修")).toBe(true);
    delete frame.contentWindow.SZ_CREATIVE_TOOLS_UI; frame.contentDocument.documentElement.dataset.labStartup = "error";
    h.click("广告图"); await h.flush(); expect(h.selected("广告图")).toBe(true);
  });

  it("rechecks tool activity after an awaited permission and ignores rapid clicks", async () => {
    const h = harness({ kind: "image", initialSurface: "buyer" }), frame = [...h.frames.values()][0], pending = deferred<Permission>();
    h.toolsDefaults.get("buyer")!.canDeactivate.mockImplementationOnce(() => pending.promise);
    const adClick = h.button("广告图").props.onClick as () => void, detailClick = h.button("详情").props.onClick as () => void;
    adClick(); detailClick(); await h.flush(3); h.toolsDefaults.get("buyer")!.state.busy = true;
    pending.resolve({ allowed: true }); await h.flush();
    expect(h.selected("买家秀")).toBe(true); expect([...h.frames.values()][0]).toBe(frame); expect(h.router.replace).not.toHaveBeenCalled();
    expect(h.toolsDefaults.get("buyer")!.canDeactivate).toHaveBeenCalledTimes(2);
  });

  it.each(cases)("restores the busy $id URL on back/forward", async ({ id, label }) => {
    const h = harness({ kind: "image", initialSurface: id }), frame = [...h.frames.values()][0];
    h.toolsDefaults.get(id)!.state.busy = true;
    h.render({ kind: "image", initialSurface: "ad" }); await h.flush();
    expect(h.selected(label)).toBe(true); expect([...h.frames.values()][0]).toBe(frame);
    expect(h.router.replace).toHaveBeenCalledWith(`/dashboards/operating-network?surface=${id}`, { scroll: false });
  });
});

describe("actual CreativeStudio with the real creative tools UI bridge", () => {
  const labels = { refinement: "产品精修", clothing: "DIY成图", buyer: "买家秀" };
  async function combined(tool: typeof creativeTools[number], uncertain = false) {
    const ui = await bootCreativeToolsFixture(tool, { uncertain });
    const h = harness({ kind: "image", initialSurface: tool }), frame = [...h.frames.values()][0];
    frame.contentWindow.SZ_CREATIVE_TOOLS_UI = ui.ui();
    return { h, ui, frame };
  }

  it.each(creativeTools)("keeps %s mounted while its real controller request is pending", async tool => {
    const { h, ui, frame } = await combined(tool);
    ui.click('[data-action="generate"]'); await flushCreativeToolsFixture();
    expect(ui.ui().getState().controller.busy).toBe(true); expect(ui.sends).toHaveLength(1);
    for (const target of ["广告图", "批量任务", "生成视频"]) {
      h.click(target); await h.flush(); expect(h.selected(labels[tool])).toBe(true);
      expect([...h.frames.values()][0]).toBe(frame); expect(h.router.replace).not.toHaveBeenCalled(); expect(h.router.push).not.toHaveBeenCalled();
    }
    expect(ui.context.localStorage.removeItem).not.toHaveBeenCalled(); expect(ui.forbidden).not.toHaveBeenCalled();
    await ui.finishGeneration();
  });

  it.each(creativeTools)("keeps timed-out %s mounted while the original UI transport is unresolved", async tool => {
    const { h, ui, frame } = await combined(tool);
    ui.click('[data-action="generate"]'); await flushCreativeToolsFixture(); await ui.fireGenerationTimeout();
    expect(ui.ui().getState().controller.busy).toBe(false); expect(ui.ui().getState().controller.uncertain).not.toBeNull();
    h.click("广告图"); await h.flush(); expect(h.selected(labels[tool])).toBe(true); expect([...h.frames.values()][0]).toBe(frame);
    await ui.finishGeneration(); h.click("广告图"); await h.flush(100);
    expect(h.selected("广告图")).toBe(true); expect(ui.journals.get(ui.receiptKey)).not.toBeUndefined();
    expect(ui.context.localStorage.removeItem).not.toHaveBeenCalled(); expect(ui.sends).toHaveLength(1); expect(ui.forbidden).not.toHaveBeenCalled();
  });

  it.each(creativeTools)("switches away from idle %s only after actual IndexedDB commits", async tool => {
    const { h, ui, frame } = await combined(tool); ui.holdWrites();
    h.click("广告图"); await h.flush(30);
    expect(h.selected(labels[tool])).toBe(true); expect([...h.frames.values()][0]).toBe(frame); expect(frame.inert).toBe(true);
    await ui.releaseWrites(); await h.flush(100);
    expect(h.selected("广告图")).toBe(true); expect([...h.frames.values()]).not.toContain(frame);
    const stored = ui.records.get(`${TOOLS_ACCOUNT}:tool:${tool}`) as StoredToolDraft;
    expect(stored.config.requirements).toBe("保留要求"); expect(stored.snapshot.previousResults[0].item.resultId).toBe("completed-fixture");
    expect(ui.sends).toEqual([]); expect(ui.forbidden).not.toHaveBeenCalled();
  });

  it.each(creativeTools)("permits browsing from idle uncertain %s and restores its saved receipt lock on return", async tool => {
    const { h, ui } = await combined(tool, true), receipt = ui.journals.get(ui.receiptKey);
    h.click("广告图"); await h.flush(100);
    expect(h.selected("广告图")).toBe(true); expect(ui.journals.get(ui.receiptKey)).toBe(receipt);
    const stored = ui.records.get(`${TOOLS_ACCOUNT}:tool:${tool}`) as StoredToolDraft;
    expect(stored.snapshot.uncertain).toEqual(ui.receipt); expect(stored.snapshot.previousResults[0].item.resultId).toBe("completed-fixture");
    h.click(labels[tool]); await h.flush(100); expect(h.selected(labels[tool])).toBe(true);
    // Simulate a newly mounted iframe using exactly the same account-scoped data.
    const restored = await bootCreativeToolsFixture(tool, { seedRecords: ui.records, seedJournals: ui.journals });
    expect(restored.ui().getState().controller.uncertain).toEqual(ui.receipt);
    expect(restored.document.control('[data-action="generate"]').disabled).toBe(true);
    expect(ui.sends).toEqual([]); expect(ui.context.localStorage.removeItem).not.toHaveBeenCalled();
  });

  it.each(creativeTools)("keeps %s on actual save failure and account change", async tool => {
    const failed = await combined(tool, true); failed.ui.failWrites();
    failed.h.click("广告图"); await failed.h.flush(100);
    expect(failed.h.selected(labels[tool])).toBe(true); expect([...failed.h.frames.values()][0]).toBe(failed.frame);
    expect(failed.h.alert()).toContain("quota"); expect(failed.h.router.replace).not.toHaveBeenCalled();
    const changed = await combined(tool); changed.ui.holdWrites(); changed.h.click("广告图"); await changed.h.flush(30);
    changed.ui.setAccount("changed-account"); await changed.ui.releaseWrites(); await changed.h.flush(100);
    expect(changed.h.selected(labels[tool])).toBe(true); expect([...changed.h.frames.values()][0]).toBe(changed.frame);
    expect(changed.h.alert()).toContain("账号"); expect(changed.h.router.replace).not.toHaveBeenCalled();
  });

  it("keeps the real material modal request mounted and protects URL back navigation", async () => {
    const { h, ui, frame } = await combined("buyer");
    ui.click('[data-action="material-open"]'); await flushCreativeToolsFixture();
    ui.click('[data-action="material-generate"]'); await flushCreativeToolsFixture();
    expect(ui.ui().getState().materialController.busy).toBe(true);
    h.render({ kind: "image", initialSurface: "ad" }); await h.flush();
    expect(h.selected("买家秀")).toBe(true); expect([...h.frames.values()][0]).toBe(frame);
    expect(h.router.replace).toHaveBeenCalledWith("/dashboards/operating-network?surface=buyer", { scroll: false });
    await ui.finishGeneration();
  });

  it("ignores the old real save answer after a newer URL asks to leave an importing tool", async () => {
    const { h, ui, frame } = await combined("clothing"); ui.holdWrites();
    h.click("广告图"); await h.flush(30); ui.setImporting(true);
    h.render({ kind: "image", initialSurface: "detail" }); await h.flush(30);
    await ui.releaseWrites(); await h.flush(100);
    expect(h.selected("DIY成图")).toBe(true); expect([...h.frames.values()][0]).toBe(frame);
    expect(h.selected("广告图")).toBe(false); expect(h.selected("详情")).toBe(false);
    expect(h.router.replace).toHaveBeenCalledOnce();
    expect(h.router.replace).toHaveBeenCalledWith("/dashboards/operating-network?surface=clothing", { scroll: false });
  });

  it("blocks real initialization and lets the real startup failure with no draft leave", async () => {
    const ui = createCreativeToolsFixture("refinement", { pendingReady: true }); await flushCreativeToolsFixture();
    const h = harness({ kind: "image", initialSurface: "refinement" }), frame = [...h.frames.values()][0];
    frame.contentWindow.SZ_CREATIVE_TOOLS_UI = ui.ui();
    h.click("广告图"); await h.flush(); expect(h.selected("产品精修")).toBe(true); expect([...h.frames.values()][0]).toBe(frame);
    ui.ready.complete({ ok: false }); await flushCreativeToolsFixture();
    expect(ui.ui().getState().startupFailed).toBe(true);
    h.click("广告图"); await h.flush(30); expect(h.selected("广告图")).toBe(true);
    expect(ui.sends).toEqual([]); expect(ui.forbidden).not.toHaveBeenCalled();
  });
});

describe("account menu API configuration entry", () => {
  it.each([
    { props: { kind: "image", initialSurface: "detail" }, url: "?surface=detail" },
    { props: { kind: "image", initialSurface: "ad" }, url: "?surface=ad" },
    { props: { kind: "image", initialSurface: "main", initialBatch: true }, url: "?surface=main&batch=1" }
  ] satisfies Array<{ props: Props; url: string }>)('keeps the current $url iframe and draft while opening and reopening API settings', async ({ props, url }) => {
    const h = harness(props), frame = [...h.frames.values()][0]; frame.draft = "保留当前商品草稿";
    h.render({ kind: "image", initialApiConfig: true }); await h.flush();
    expect([...h.frames.values()][0]).toBe(frame); expect(frame.draft).toBe("保留当前商品草稿");
    expect(frame.contentWindow.SZ_CREATIVE_TOOLS_BRIDGE.openConfig).toHaveBeenCalledOnce();
    expect(h.router.replace).toHaveBeenCalledWith(`/dashboards/operating-network${url}`, { scroll: false });
    h.render(props); await h.flush(); h.render({ kind: "image", initialApiConfig: true }); await h.flush();
    expect(frame.contentWindow.SZ_CREATIVE_TOOLS_BRIDGE.openConfig).toHaveBeenCalledTimes(2); h.unmount();
  });
  it("opens only the active cached workflow configuration", async () => {
    const h = harness(); await visitCachedStyle(h);
    const visible = h.frames.get("viral-case")!, hidden = h.frames.get("viral-style")!;
    h.render({ kind: "image", initialApiConfig: true }); await h.flush();
    expect(visible.contentWindow.SZ_CREATIVE_TOOLS_BRIDGE.openConfig).toHaveBeenCalledOnce();
    expect(hidden.contentWindow.SZ_CREATIVE_TOOLS_BRIDGE.getAccountKey).not.toHaveBeenCalled();
    expect(h.selected("案例裂变")).toBe(true); h.unmount();
  });
  it("shows a locked-task error without replacing the current draft", async () => {
    const h = harness({ kind: "image", initialSurface: "detail" }), frame = [...h.frames.values()][0];
    frame.contentWindow.SZ_CREATIVE_TOOLS_BRIDGE.openConfig.mockReturnValue({ ok: false, error: "请等待当前任务结束后配置 API。" });
    h.render({ kind: "image", initialApiConfig: true }); await h.flush();
    expect(h.alert()).toContain("请等待当前任务"); expect([...h.frames.values()][0]).toBe(frame); h.unmount();
  });
});
