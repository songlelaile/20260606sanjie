import * as React from "react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Element = React.ReactElement<Record<string, unknown>>;
const state = { cursor: 0, values: new Map<number, unknown>(), refs: new Map<number, { current: unknown }>(), effects: [] as (() => void | (() => void))[], mounted: false };
const requireDependency = createRequire(import.meta.url);
const component = { exports: {} as typeof import("./UserSupplyPanel") };
new Function("require", "exports", ts.transpileModule(readFileSync(new URL("./UserSupplyPanel.tsx", import.meta.url), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText)((id: string) => {
  if (id === "react") return {
    ...React,
    useState: (initial: unknown) => {
      const index = state.cursor++;
      if (!state.values.has(index)) state.values.set(index, initial);
      return [state.values.get(index), (next: unknown) => state.values.set(index, typeof next === "function" ? next(state.values.get(index)) : next)];
    },
    useRef: (initial: unknown) => {
      const index = state.cursor++;
      if (!state.refs.has(index)) state.refs.set(index, { current: initial });
      return state.refs.get(index);
    },
    useEffect: (effect: () => void | (() => void)) => { if (!state.mounted) state.effects.push(effect); }
  };
  if (id.endsWith(".module.css")) return new Proxy({}, { get: (_target, key) => String(key) });
  return requireDependency(id);
}, component.exports);
const { UserSupplyPanel } = component.exports;
const endpoint = "/api/management/user-supply";
const overview = (configured = true) => ({ data: { provisioning: { configured, missing: configured ? [] : ["SUB2API_ADMIN_TOKEN"] }, users: [
  { userId: "user-a", username: "13800000001", name: "客户甲", accountStatus: "active", primary: { id: "credential-a", status: "ready", providerKeyId: "provider-a" }, backup: { id: "credential-b", status: "failed", providerKeyId: null } },
  { userId: "user-b", username: "13800000002", name: "客户乙", accountStatus: "disabled", primary: null, backup: null }
] } });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function render() { state.cursor = 0; return UserSupplyPanel(); }
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  return React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children as React.ReactNode)] : [];
}
function text(node: React.ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (React.isValidElement<Record<string, unknown>>(node)) return text(node.props.children as React.ReactNode);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function button(tree: React.ReactNode, label: string) {
  const found = elements(tree).find((element) => element.type === "button" && text(element).trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function input(tree: React.ReactNode, label: string) { return elements(tree).find((element) => element.props["aria-label"] === label)!; }
function change(tree: React.ReactNode, label: string, value: string) { (input(tree, label).props.onChange as (event: unknown) => void)({ target: { value } }); }
async function click(tree: React.ReactNode, label = "补齐主备 Key") { await (button(tree, label).props.onClick as () => Promise<void>)(); }
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
async function mount() {
  render();
  state.mounted = true;
  const cleanup = state.effects.splice(0).map((effect) => effect());
  await flush();
  return { tree: render(), cleanup: () => cleanup.forEach((callback) => callback?.()) };
}

beforeEach(() => {
  state.cursor = 0; state.values.clear(); state.refs.clear(); state.effects = []; state.mounted = false;
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe("registered user supply management panel", () => {
  it("reads status on mount without issuing keys and displays each user's primary and backup state", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(overview()));
    const { tree } = await mount();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({ cache: "no-store", credentials: "same-origin", signal: expect.any(AbortSignal) }));
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("客户甲"); expect(html).toContain("客户乙");
    expect(html).toContain("已就绪"); expect(html).toContain("发行失败"); expect(html).toContain("待配置");
    expect(html).toContain("已有就绪 Key 原样保留");
    expect(html).not.toContain("credential-a"); expect(html).not.toContain("provider-a");
    expect(button(tree, "补齐主备 Key").props.disabled).toBe(false);
  });

  it("disables issuance and shows missing configuration until the issuer is configured", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(overview(false)));
    const { tree } = await mount();
    expect(text(tree)).toContain("Key 发行服务尚未配置");
    expect(text(tree)).toContain("SUB2API_ADMIN_TOKEN");
    expect(button(tree, "补齐主备 Key").props.disabled).toBe(true);
    await click(tree);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("sends one bounded batch, refreshes status, and requires another click for remaining users", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(overview()));
    const { tree } = await mount();
    vi.mocked(fetch).mockResolvedValueOnce(response({ data: { processed: 10, ready: 9, failed: 1, remaining: 25 } })).mockResolvedValueOnce(response(overview()));
    await click(tree);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetch).mock.calls[1]).toEqual([endpoint, { cache: "no-store", credentials: "same-origin", method: "POST", headers: { "Content-Type": "application/json" }, body: '{"limit":10}' }]);
    expect(vi.mocked(fetch).mock.calls[2]).toEqual([endpoint, { cache: "no-store", credentials: "same-origin" }]);
    const fresh = render();
    expect(text(fresh)).toContain("本批处理 10 个用户，主备就绪 9 个，失败 1 个，剩余 25 个待补齐");
    expect(button(fresh, "补齐主备 Key").props.disabled).toBe(false);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("prevents repeated clicks from starting overlapping batches", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(overview()));
    const { tree } = await mount();
    let complete!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const pending = click(tree);
    await click(tree);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(button(render(), "正在补齐...").props.disabled).toBe(true);
    vi.mocked(fetch).mockResolvedValueOnce(response(overview()));
    complete(response({ data: { processed: 1, ready: 1, failed: 0, remaining: 0 } }));
    await pending;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retains the completed batch receipt when its subsequent status refresh fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(overview()));
    const { tree } = await mount();
    vi.mocked(fetch).mockResolvedValueOnce(response({ data: { processed: 2, ready: 2, failed: 0, remaining: 0 } })).mockRejectedValueOnce(new Error("offline"));
    await click(tree);
    expect(text(render())).toContain("本批处理 2 个用户，主备就绪 2 个");
    expect(text(render())).toContain("状态刷新失败，请点击刷新");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("aborts the initial read on unmount and ignores its later response", async () => {
    let complete!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const { cleanup } = await mount();
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal as AbortSignal;
    cleanup();
    expect(signal.aborted).toBe(true);
    complete(response(overview()));
    await flush();
    expect(text(render())).not.toContain("客户甲");
    expect(button(render(), "补齐主备 Key").props.disabled).toBe(true);
  });

  it("keeps quota blank until explicitly entered and uses a password field with a fixed service address", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(overview(false)));
    const { tree } = await mount();
    expect(input(tree, "配发账号密码").props.type).toBe("password");
    expect(input(tree, "配发服务地址").props.value).toBe("https://sub.shaozhuangai.com");
    expect(input(tree, "配发服务地址").props.readOnly).toBe(true);
    expect(input(tree, "每 Key 上游额度").props.value).toBe("");
    await click(tree, "保存配发账号配置");
    expect(text(render())).toContain("请明确填写上游分组和每 Key 额度");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("saves explicit credentials only on click and clears the password after successful save", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(overview(false)));
    const { tree } = await mount();
    change(tree, "配发账号邮箱", "issuer@example.com");
    change(tree, "配发账号密码", "private-secret");
    change(tree, "上游分组 ID", "3");
    change(tree, "每 Key 上游额度", "0");
    expect(fetch).toHaveBeenCalledOnce();
    vi.mocked(fetch).mockResolvedValueOnce(response({ data: { configured: true, missing: [], emailMasked: "i***@example.com", groupId: "3", quotaUsd: 0 } }));
    await click(render(), "保存配发账号配置");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[1]).toEqual([endpoint, { cache: "no-store", credentials: "same-origin", method: "PUT", headers: { "Content-Type": "application/json" }, body: expect.any(String) }]);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))).toEqual({ config: { email: "issuer@example.com", password: "private-secret", groupId: "3", quotaUsd: 0 } });
    const fresh = render();
    expect(input(fresh, "配发账号密码").props.value).toBe("");
    expect(input(fresh, "配发账号邮箱").props.value).toBe("");
    expect(input(fresh, "每 Key 上游额度").props.value).toBe("0");
    expect(button(fresh, "补齐主备 Key").props.disabled).toBe(false);
    expect(text(fresh)).toContain("配发账号配置已保存");
  });
});
