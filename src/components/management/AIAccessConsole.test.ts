import * as React from "react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Compile in memory using the repository's existing source-test workflow.
// No browser, real API, business database, or additional test dependency is used.
const requireDependency = createRequire(import.meta.url);
const state = {
  cursor: 0, values: new Map<number, unknown>(), registeredEffect: false,
  effects: [] as (() => (() => void))[], cleanup: [] as (() => void)[]
};
const source = readFileSync(new URL("./AIAccessConsole.tsx", import.meta.url), "utf8");
const stylesheet = readFileSync(new URL("./AIAccessConsole.module.css", import.meta.url), "utf8");
const globalStylesheet = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
const compile = (input: string) => ts.transpileModule(input, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText;
const componentModule = { exports: {} as Pick<typeof import("./AIAccessConsole"), "AIAccessConsole"> };
new Function("require", "exports", compile(source))((id: string) => {
  if (id === "react") return {
    ...React,
    useState: (initial: unknown) => {
      const index = state.cursor++;
      if (!state.values.has(index)) state.values.set(index, initial);
      return [state.values.get(index), (next: unknown) => {
        state.values.set(index, typeof next === "function" ? next(state.values.get(index)) : next);
      }];
    },
    useRef: (initial: unknown) => {
      const index = state.cursor++;
      if (!state.values.has(index)) state.values.set(index, { current: initial });
      return state.values.get(index);
    },
    useEffect: (effect: () => (() => void)) => {
      if (!state.registeredEffect) { state.registeredEffect = true; state.effects.push(effect); }
    }
  };
  if (id.endsWith(".module.css")) return { __esModule: true, default: new Proxy({}, { get: (_target, key) => key }) };
  return requireDependency(id);
}, componentModule.exports);
const { AIAccessConsole } = componentModule.exports;
type Element = React.ReactElement<Record<string, unknown>>;

const pageMocks = { session: vi.fn(), user: vi.fn(), redirect: vi.fn((url: string) => { throw new Error("redirect:" + url); }) };
const pageModule = { exports: {} as { default: typeof import("../../app/management/ai-access/page")["default"] } };
const pageSource = readFileSync(new URL("../../app/management/ai-access/page.tsx", import.meta.url), "utf8");
new Function("require", "exports", compile(pageSource))((id: string) => {
  if (id === "next/navigation") return { redirect: pageMocks.redirect };
  if (id === "@/lib/server-session") return { getCurrentSession: pageMocks.session, getCurrentUser: pageMocks.user };
  if (id === "@/lib/auth") return { ROLE_HOME: { admin: "/dashboards/operating-network", tenant: "/dashboards/operating-network" } };
  if (id === "@/components/management/AIAccessConsole") return { AIAccessConsole };
  return requireDependency(id);
}, pageModule.exports);

const grant = (extra: Record<string, unknown> = {}) => ({
  id: "grant-1", name: "Codex", scope: "read", expiresAt: null, enabled: false, revokedAt: null, ...extra
});
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" }
});
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const render = () => { state.cursor = 0; return AIAccessConsole(); };
const mount = async () => {
  render();
  for (const effect of state.effects.splice(0)) state.cleanup.push(effect());
  await flush();
  return render();
};
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as React.ReactNode)];
}
function text(node: React.ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (React.isValidElement<Record<string, unknown>>(node)) return text(node.props.children as React.ReactNode);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
const button = (tree: React.ReactNode, label: string) => {
  const found = elements(tree).find(item => item.type === "button" && text(item) === label);
  if (!found) throw new Error("Missing button: " + label);
  return found;
};
const click = async (element: Element) => { await (element.props.onClick as () => Promise<void> | void)(); };
const select = (tree: React.ReactNode, id: string) => {
  const found = elements(tree).find(item => item.type === "select" && item.props.id === id);
  if (!found) throw new Error("Missing select: " + id);
  return found;
};
const choose = (element: Element, value: string) => {
  (element.props.onChange as (event: unknown) => void)({ target: { value } });
};
const chooseAction = () => {
  choose(select(render(), "ai-grant-scope"), "action");
};
const listeners = new Map<string, () => void>();

beforeEach(() => {
  vi.clearAllMocks();
  state.cursor = 0; state.values.clear(); state.effects = []; state.cleanup = []; state.registeredEffect = false;
  listeners.clear();
  vi.stubGlobal("window", {
    addEventListener: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    removeEventListener: vi.fn((event: string) => listeners.delete(event))
  });
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(jsonResponse({ data: { grants: [] } }))
    .mockResolvedValueOnce(jsonResponse({ data: { events: [] } })));
  pageMocks.session.mockResolvedValue({ role: "admin", username: "admin", tenantId: "admin-tenant" });
  pageMocks.user.mockResolvedValue({ status: "active", authRole: "admin", username: "private-admin", passwordHash: "private-hash" });
});
afterEach(() => { for (const cleanup of state.cleanup) cleanup(); vi.unstubAllGlobals(); });

describe("administrator AI grant page", () => {
  it("rechecks the current active administrator without passing private user data", async () => {
    const tree = await pageModule.exports.default();
    expect(tree.type).toBe(AIAccessConsole);
    expect(tree.props).toEqual({});
    expect(pageMocks.session).toHaveBeenCalledOnce();
    expect(pageMocks.user).toHaveBeenCalledOnce();
  });
  it("redirects anonymous visitors to login before querying the current user", async () => {
    pageMocks.session.mockResolvedValue(null);
    await expect(pageModule.exports.default()).rejects.toThrow("redirect:/login");
    expect(pageMocks.user).not.toHaveBeenCalled();
  });
  it.each([null, { status: "disabled", authRole: "admin" }])("rejects a revoked or disabled administrator: %j", async user => {
    pageMocks.user.mockResolvedValue(user);
    await expect(pageModule.exports.default()).rejects.toThrow("redirect:/login");
  });
  it("returns ordinary tenants to their role homepage", async () => {
    pageMocks.session.mockResolvedValue({ role: "tenant" });
    pageMocks.user.mockResolvedValue({ status: "active", authRole: "tenant" });
    await expect(pageModule.exports.default()).rejects.toThrow("redirect:/dashboards/operating-network");
  });
  it("fails closed when the current-user database fails", async () => {
    pageMocks.user.mockRejectedValue(new Error("database unavailable"));
    await expect(pageModule.exports.default()).rejects.toThrow("database unavailable");
  });
});

describe("manual AI authorization console", () => {
  it("loads only grant metadata on mount, defaults to read, and never initiates execution", async () => {
    const tree = await mount();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith("/api/ai-access/grants", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
    expect(fetch).toHaveBeenCalledWith("/api/ai-access/events", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
    expect(select(tree, "ai-grant-scope").props.value).toBe("read");
    expect(select(tree, "ai-grant-tool").props.value).toBe("Codex");
    const markup = renderToStaticMarkup(tree);
    for (const content of ["AI 授权通道", "Codex", "Cursor", "Claude Code", "通用 AI", "不限时间", "付费生图", "付款", "删除", "/api/ai-access/execute", "未声明身份的 AI 视觉点击", "返回管理"])
      expect(markup).toContain(content);
    expect(markup).toContain("新建通道默认关闭");
    expect(markup).toContain("管理员手动开启 / 关闭");
    expect(markup).not.toContain("30 分钟");
    expect(markup).not.toContain("短期授权");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("creates only after a button click and reveals the token for manual review", async () => {
    await mount();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { grant: grant(), token: "first-review-token" } }, 201));
    await click(button(render(), "创建通道"));
    expect(fetch).toHaveBeenNthCalledWith(3, "/api/ai-access/grants", expect.objectContaining({
      method: "POST", body: '{"name":"Codex","scope":"read"}', credentials: "same-origin"
    }));
    const issued = render();
    expect(elements(issued).find(item => item.type === "textarea")?.props.value).toBe("first-review-token");
    expect(button(issued, "创建通道").props.disabled).toBe(true);
    expect(select(issued, "ai-grant-tool").props.disabled).toBe(true);
    expect(select(issued, "ai-grant-scope").props.disabled).toBe(true);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.every(([url]) => url !== "/api/ai-access/execute")).toBe(true);
    expect(text(issued)).toContain("当前关闭；请保存本次令牌后手动开启");
    expect(text(issued)).toContain("已关闭");
    expect(button(issued, "开启").props.disabled).toBe(false);
  });

  it("labels the tool selector and offers exactly the four supported tool names", async () => {
    const tree = await mount();
    const tool = select(tree, "ai-grant-tool");
    expect(elements(tree).find(item => item.type === "label" && item.props.htmlFor === tool.props.id)).toBeDefined();
    expect(elements(tool).filter(item => item.type === "option").map(item => item.props.value))
      .toEqual(["Codex", "Cursor", "Claude Code", "通用 AI"]);
    expect(text(tree)).toContain("选择不同工具不会扩大权限");
  });

  it.each(["Codex", "Cursor", "Claude Code", "通用 AI"])("creates the selected %s tool grant with unchanged read permissions and no time limit", async name => {
    await mount();
    choose(select(render(), "ai-grant-tool"), name);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(select(render(), "ai-grant-scope").props.value).toBe("read");
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { grant: grant({ name }), token: "selected-tool-token" } }, 201));
    await click(button(render(), "创建通道"));
    const [, options] = vi.mocked(fetch).mock.calls[2];
    expect(JSON.parse(options!.body as string)).toEqual({ name, scope: "read" });
    expect(elements(render()).filter(item => item.type === "td").map(text)).toContain(name);
    expect(vi.mocked(fetch).mock.calls.every(([url]) => url !== "/api/ai-access/execute")).toBe(true);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("preserves explicit action scope when choosing a different tool", async () => {
    await mount(); chooseAction();
    choose(select(render(), "ai-grant-tool"), "Claude Code");
    expect(select(render(), "ai-grant-scope").props.value).toBe("action");
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { grant: grant({ name: "Claude Code", scope: "action" }), token: "action-tool-token" } }, 201));
    await click(button(render(), "创建通道"));
    expect(fetch).toHaveBeenLastCalledWith("/api/ai-access/grants", expect.objectContaining({
      body: '{"name":"Claude Code","scope":"action"}'
    }));
  });

  it("rejects unrecognized tool names without changing the selected tool or requesting a grant", async () => {
    await mount();
    choose(select(render(), "ai-grant-tool"), "Unrecognized AI");
    expect(select(render(), "ai-grant-tool").props.value).toBe("Codex");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("locks the selected tool during creation and while its one-time token is visible", async () => {
    await mount();
    choose(select(render(), "ai-grant-tool"), "Cursor");
    const beforePending = select(render(), "ai-grant-tool");
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = click(button(render(), "创建通道"));
    expect(select(render(), "ai-grant-tool").props.disabled).toBe(true);
    choose(beforePending, "Claude Code");
    expect(select(render(), "ai-grant-tool").props.value).toBe("Cursor");
    finish(jsonResponse({ data: { grant: grant({ name: "Cursor" }), token: "cursor-review-token" } }, 201));
    await pending;
    const issued = select(render(), "ai-grant-tool");
    expect(issued.props.disabled).toBe(true);
    choose(issued, "Claude Code");
    expect(select(render(), "ai-grant-tool").props.value).toBe("Cursor");
    await click(button(render(), "收起并清除令牌"));
    expect(select(render(), "ai-grant-tool").props.disabled).toBe(false);
    choose(select(render(), "ai-grant-tool"), "Claude Code");
    expect(select(render(), "ai-grant-tool").props.value).toBe("Claude Code");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("uses the shared three-stage dark surfaces and gold controls without independent white or blue styling", async () => {
    const markup = renderToStaticMarkup(await mount());
    for (const className of ["console", "card", "primary", "field", "back"])
      expect(markup).toContain(`class="${className}"`);
    for (const token of stylesheet.matchAll(/var\((--[\w-]+)\)/g))
      expect(globalStylesheet).toContain(`${token[1]}:`);
    expect(stylesheet).toMatch(/\.card\s*\{[^}]*background:\s*var\(--surface\)/);
    expect(stylesheet).toMatch(/\.primary\s*\{[^}]*background:\s*var\(--brand\)/);
    expect(stylesheet).toMatch(/\.field select, \.field textarea\s*\{[^}]*background:\s*var\(--bg\)[^}]*color:\s*var\(--ink\)/);
    expect(stylesheet).toMatch(/focus-visible[^}]*outline:\s*2px solid var\(--brand\)/);
    expect(stylesheet).toContain("font: inherit");
    expect(stylesheet).toContain("color-scheme: dark");
    expect(stylesheet).not.toMatch(/#fff\b|#ffffff\b|#2563eb|#1d4ed8|#93c5fd|#eff6ff/i);
  });

  it("lets the administrator explicitly choose action scope", async () => {
    await mount(); chooseAction();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { grant: grant({ scope: "action" }), token: "action-token" } }, 201));
    await click(button(render(), "创建通道"));
    expect(fetch).toHaveBeenLastCalledWith("/api/ai-access/grants", expect.objectContaining({ body: '{"name":"Codex","scope":"action"}' }));
    expect(text(render())).toContain("允许操作目前仅支持切换 AI 使用的店铺");
  });

  it("copies only on explicit request and clears the one-time token on close", async () => {
    await mount();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { grant: grant(), token: "copy-once-token" } }, 201));
    await click(button(render(), "创建通道"));
    await click(button(render(), "复制令牌"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("copy-once-token");
    await click(button(render(), "收起并清除令牌"));
    expect(elements(render()).some(item => item.type === "textarea")).toBe(false);
    expect(renderToStaticMarkup(render())).not.toContain("copy-once-token");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("clears the token when the browser leaves the page", async () => {
    await mount();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { grant: grant(), token: "leave-page-token" } }, 201));
    await click(button(render(), "创建通道"));
    listeners.get("pagehide")!();
    expect(renderToStaticMarkup(render())).not.toContain("leave-page-token");
  });

  it("guards duplicate clicks while a create request is pending", async () => {
    await mount();
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const create = button(render(), "创建通道");
    const pending = click(create);
    await click(create);
    expect(fetch).toHaveBeenCalledTimes(3);
    finish(jsonResponse({ data: { grant: grant(), token: "one-grant-token" } }, 201));
    await pending;
    expect(elements(render()).find(item => item.type === "textarea")?.props.value).toBe("one-grant-token");
  });

  it("requires manual revoke, clears its visible token, and renders revoked state", async () => {
    await mount();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { grant: grant(), token: "revoke-token" } }, 201));
    await click(button(render(), "创建通道"));
    expect(fetch).toHaveBeenCalledTimes(3);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { revoked: true } }));
    await click(button(render(), "永久撤销"));
    expect(fetch).toHaveBeenLastCalledWith("/api/ai-access/grants/grant-1", expect.objectContaining({ method: "DELETE" }));
    expect(text(render())).toContain("已撤销");
    expect(renderToStaticMarkup(render())).not.toContain("revoke-token");
    expect(button(render(), "永久撤销").props.disabled).toBe(true);
    expect(button(render(), "开启").props.disabled).toBe(true);
  });

  it("enables, disables, and re-enables the same unlimited channel only after administrator clicks", async () => {
    await mount();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { grant: grant(), token: "reusable-review-token" } }, 201));
    await click(button(render(), "创建通道"));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(text(render())).toContain("已关闭");

    for (const enabled of [true, false, true]) {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { grant: grant({ enabled }) } }));
      await click(button(render(), enabled ? "开启" : "关闭"));
      expect(fetch).toHaveBeenLastCalledWith("/api/ai-access/grants/grant-1", expect.objectContaining({
        method: "PATCH", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled })
      }));
      expect(text(render())).toContain(enabled ? "已开启" : "已关闭");
      expect(elements(render()).find(item => item.type === "textarea")?.props.value).toBe("reusable-review-token");
      expect(elements(render()).filter(item => item.type === "td").map(text).filter(value => value === "Codex")).toHaveLength(1);
    }
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.every(([url]) => url !== "/api/ai-access/execute")).toBe(true);
  });

  it.each([true, false])("keeps enabled=%s unchanged until the server confirms the toggle and guards duplicate clicks", async enabled => {
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(jsonResponse({ data: { grants: [grant({ enabled })] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { events: [] } }));
    await mount();
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const toggle = button(render(), enabled ? "关闭" : "开启");
    const pending = click(toggle);
    expect(text(render())).toContain(enabled ? "已开启" : "已关闭");
    expect(button(render(), enabled ? "关闭" : "开启").props.disabled).toBe(true);
    await click(toggle);
    expect(fetch).toHaveBeenCalledTimes(3);
    finish(jsonResponse({ data: { grant: grant({ enabled: !enabled }) } }));
    await pending;
    expect(text(render())).toContain(enabled ? "已关闭" : "已开启");
    expect(button(render(), enabled ? "开启" : "关闭").props.disabled).toBe(false);
  });

  it.each([true, false])("keeps enabled=%s and hides server details when the manual toggle fails", async enabled => {
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(jsonResponse({ data: { grants: [grant({ enabled })] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { events: [] } }));
    await mount();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "private-toggle-error", data: { grant: grant({ enabled: !enabled }) } }, 403));
    await click(button(render(), enabled ? "关闭" : "开启"));
    const markup = renderToStaticMarkup(render());
    expect(markup).toContain(enabled ? "已开启" : "已关闭");
    expect(markup).toContain(`${enabled ? "关闭" : "开启"}失败`);
    expect(markup).not.toContain("private-toggle-error");
    expect(button(render(), enabled ? "关闭" : "开启").props.disabled).toBe(false);
  });

  it("keeps the current state and shows a safe error on a toggle network failure", async () => {
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(jsonResponse({ data: { grants: [grant()] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { events: [] } }));
    await mount();
    vi.mocked(fetch).mockRejectedValueOnce(new Error("private-network-details"));
    await click(button(render(), "开启"));
    const markup = renderToStaticMarkup(render());
    expect(markup).toContain("已关闭");
    expect(markup).toContain("网络连接失败，请检查网络后重试");
    expect(markup).not.toContain("private-network-details");
    expect(button(render(), "开启").props.disabled).toBe(false);
  });

  it.each([
    { enabled: false }, { enabled: undefined }, { id: "different-channel" }, { expiresAt: "2099-10-02T01:30:00.000Z" },
    { revokedAt: "2026-10-02T01:00:00.000Z" }, { scope: "action" }, { name: "Different AI" }
  ])("rejects an unexpected toggle response without changing the current channel: %j", async extra => {
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(jsonResponse({ data: { grants: [grant()] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { events: [] } }));
    await mount();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { grant: grant({ enabled: true, ...extra }) } }));
    await click(button(render(), "开启"));
    expect(text(render())).toContain("已关闭");
    expect(text(render())).toContain("开启失败");
    expect(button(render(), "开启").props.disabled).toBe(false);
  });

  it.each([
    { enabled: true }, { enabled: undefined }, { expiresAt: "2099-10-02T01:30:00.000Z" },
    { revokedAt: "2026-10-02T01:00:00.000Z" }, { scope: "action" }, { name: "Unexpected AI" }
  ])("rejects a creation response that does not match a new disabled unlimited channel: %j", async extra => {
    await mount();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { grant: grant(extra), token: "invalid-contract-token" } }, 201));
    await click(button(render(), "创建通道"));
    const markup = renderToStaticMarkup(render());
    expect(markup).toContain("创建授权通道失败");
    expect(markup).not.toContain("invalid-contract-token");
    expect(elements(render()).some(item => item.type === "textarea")).toBe(false);
    expect(button(render(), "创建通道").props.disabled).toBe(false);
  });

  it.each([
    { expiresAt: "2099-10-02T01:30:00.000Z", enabled: true, expected: "已开启" },
    { expiresAt: "2000-10-02T01:30:00.000Z", enabled: true, expected: "已到期" },
    { expiresAt: "2099-10-02T01:30:00.000Z", enabled: false, expected: "已关闭" },
    { expiresAt: "invalid-date", enabled: true, expected: "待刷新" }
  ])("retains legacy finite grant state and forbids reopening or extending it: %j", async ({ expected, ...extra }) => {
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(jsonResponse({ data: { grants: [grant(extra)] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { events: [] } }));
    const tree = await mount();
    expect(text(tree)).toContain(expected);
    expect(text(tree)).toContain("旧版限时");
    expect(text(tree)).toContain("请新建通道使用手动开启 / 关闭");
    expect(elements(tree).filter(item => item.type === "button").map(text)).not.toContain("开启");
    expect(elements(tree).filter(item => item.type === "button").map(text)).not.toContain("关闭");
    expect(button(tree, "永久撤销").props.disabled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { revoked: true } }));
    await click(button(tree, "永久撤销"));
    expect(text(render())).toContain("已撤销");
    expect(fetch).toHaveBeenLastCalledWith("/api/ai-access/grants/grant-1", expect.objectContaining({ method: "DELETE" }));
  });

  it("rejects direct stale handlers for a permanently revoked channel without sending PATCH or DELETE", async () => {
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(jsonResponse({ data: { grants: [grant({ revokedAt: "2026-10-02T01:00:00.000Z" })] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { events: [] } }));
    const tree = await mount();
    expect(text(tree)).toContain("已撤销");
    expect(button(tree, "开启").props.disabled).toBe(true);
    expect(button(tree, "永久撤销").props.disabled).toBe(true);
    await click(button(tree, "开启"));
    await click(button(tree, "永久撤销"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("keeps visible manual token and enabled=%s state when permanent revocation fails", async enabled => {
    await mount();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { grant: grant(), token: "review-before-revoke-token" } }, 201));
    await click(button(render(), "创建通道"));
    if (enabled) {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { grant: grant({ enabled: true }) } }));
      await click(button(render(), "开启"));
    }
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "private-revoke-error" }, 503));
    await click(button(render(), "永久撤销"));
    const markup = renderToStaticMarkup(render());
    expect(markup).toContain("撤销失败");
    expect(markup).toContain(enabled ? "已开启" : "已关闭");
    expect(markup).not.toContain("private-revoke-error");
    expect(elements(render()).find(item => item.type === "textarea")?.props.value).toBe("review-before-revoke-token");
  });

  it.each([{ data: { revoked: false } }, { data: {} }, {}])("waits for explicit server revocation confirmation: %j", async response => {
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(jsonResponse({ data: { grants: [grant({ enabled: true })] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { events: [] } }));
    await mount();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(response));
    await click(button(render(), "永久撤销"));
    expect(text(render())).toContain("已开启");
    expect(text(render())).toContain("撤销失败");
    expect(button(render(), "永久撤销").props.disabled).toBe(false);
  });

  it("guards duplicate permanent revocation while the server request is pending", async () => {
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(jsonResponse({ data: { grants: [grant()] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { events: [] } }));
    await mount();
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const revoke = button(render(), "永久撤销");
    const pending = click(revoke);
    expect(text(render())).toContain("已关闭");
    expect(button(render(), "永久撤销").props.disabled).toBe(true);
    await click(revoke);
    expect(fetch).toHaveBeenCalledTimes(3);
    finish(jsonResponse({ data: { revoked: true } }));
    await pending;
    expect(text(render())).toContain("已撤销");
  });

  it("renders metadata without extra account fields or tokens from the list response", async () => {
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(jsonResponse({ data: { grants: [grant({ username: "private-user", passwordHash: "private-hash", token: "private-list-token" })] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { events: [] } }));
    const markup = renderToStaticMarkup(await mount());
    expect(markup).toContain("已关闭");
    for (const secret of ["private-user", "private-hash", "private-list-token"]) expect(markup).not.toContain(secret);
  });

  it("does not expose failed API details or a token on creation failure", async () => {
    await mount();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "private-user-db-error", data: { token: "failed-token" } }, 503));
    await click(button(render(), "创建通道"));
    const markup = renderToStaticMarkup(render());
    expect(markup).toContain("创建授权通道失败");
    expect(markup).not.toContain("private-user-db-error");
    expect(markup).not.toContain("failed-token");
    expect(button(render(), "创建通道").props.disabled).toBe(false);
  });

  it("shows list unavailability instead of claiming an empty successful list", async () => {
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(jsonResponse({ error: "private-list-error" }, 403))
      .mockResolvedValueOnce(jsonResponse({ data: { events: [] } }));
    const markup = renderToStaticMarkup(await mount());
    expect(markup).toContain("列表暂不可用");
    expect(markup).not.toContain("暂无授权通道");
    expect(markup).not.toContain("private-list-error");
  });

  it("uses safe manual fallback text when clipboard access fails", async () => {
    await mount();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { grant: grant(), token: "clipboard-token" } }, 201));
    await click(button(render(), "创建通道"));
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("clipboard unavailable"));
    await click(button(render(), "复制令牌"));
    expect(text(render())).toContain("复制失败，请手动选中令牌复制");
  });

  it("cancels the list request when unmounted and stores no persistent token", async () => {
    await mount();
    const options = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    for (const cleanup of state.cleanup.splice(0)) cleanup();
    expect(options.signal?.aborted).toBe(true);
    expect(listeners.has("pagehide")).toBe(false);
    expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie|window\.open/);
    expect(source).not.toContain('fetch("/api/ai-access/execute"');
  });

  it("shows at most twenty recent operations without secrets, with a manual refresh", async () => {
    const events = Array.from({ length: 23 }, (_, index) => ({
      id: `event-${index}`, type: "request", grantName: "Codex", method: "GET",
      path: `/api/reports/${index}`, status: index === 1 ? 403 : 200,
      createdAt: "2026-10-02T01:00:00.000Z", token: "hidden-audit-token", username: "hidden-audit-user"
    }));
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(jsonResponse({ data: { grants: [] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { events } }));
    const markup = renderToStaticMarkup(await mount());
    expect(markup).toContain("最近操作"); expect(markup).toContain("接口调用");
    expect(markup).toContain("失败（403）"); expect(markup).toContain("成功（200）");
    expect(markup).toContain("/api/reports/19"); expect(markup).not.toContain("/api/reports/20");
    expect(markup).not.toContain("hidden-audit-token"); expect(markup).not.toContain("hidden-audit-user");
    expect(markup).toContain("只读授权绑定创建时所选店铺");
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { events: [] } }));
    await click(button(render(), "刷新最近操作")); await flush();
    expect(fetch).toHaveBeenLastCalledWith("/api/ai-access/events", expect.objectContaining({ cache: "no-store" }));
    expect(text(render())).toContain("暂无最近操作");
  });

  it("shows safe recent-operation errors without exposing backend details", async () => {
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(jsonResponse({ data: { grants: [] } }))
      .mockResolvedValueOnce(jsonResponse({ error: "private-audit-error", data: { events: [] } }, 503));
    const markup = renderToStaticMarkup(await mount());
    expect(markup).toContain("最近操作暂不可用"); expect(markup).not.toContain("private-audit-error");
  });
});
