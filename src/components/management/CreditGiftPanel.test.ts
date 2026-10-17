import * as React from "react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Element = React.ReactElement<Record<string, unknown>>;
const state = { cursor: 0, values: new Map<number, unknown>(), refs: new Map<number, { current: unknown }>(), effects: [] as (() => void)[], mounted: false };
const requireDependency = createRequire(import.meta.url);
const component = { exports: {} as typeof import("./CreditGiftPanel") };
new Function("require", "exports", ts.transpileModule(readFileSync(new URL("./CreditGiftPanel.tsx", import.meta.url), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText)((id: string) => {
  if (id === "react") return {
    ...React,
    useState: (initial: unknown) => {
      const index = state.cursor++;
      if (!state.values.has(index)) state.values.set(index, typeof initial === "function" ? initial() : initial);
      return [state.values.get(index), (next: unknown) => state.values.set(index, typeof next === "function" ? next(state.values.get(index)) : next)];
    },
    useRef: (initial: unknown) => {
      const index = state.cursor++;
      if (!state.refs.has(index)) state.refs.set(index, { current: initial });
      return state.refs.get(index);
    },
    useEffect: (effect: () => void) => { if (!state.mounted) state.effects.push(effect); }
  };
  if (id.endsWith(".module.css")) return new Proxy({}, { get: (_target, key) => String(key) });
  return requireDependency(id);
}, component.exports);
const { CreditGiftPanel, parseCreditGiftPoints } = component.exports;
const REQUEST_KEY = "f10fe7c7-c0fd-4203-9cd6-e38fb4ff42a3";
const ENDPOINT = "/api/management/credit-gifts";
const STORAGE_KEY = "sanjie-credit-gift-v1:admin-a";
const users = [
  { id: "user-a", name: "客户甲", username: "13800000001", status: "active", shopName: "店铺甲" },
  { id: "user-b", name: "客户乙", username: "13800000002", status: "disabled", shopName: "店铺乙" }
];
const payload = { userId: "user-a", points: "100.5", reason: "内测赠送", requestKey: REQUEST_KEY };
const gift = {
  id: "gift-a", billingEventId: `gift:${REQUEST_KEY}`, ...payload, adminId: "admin-a", adminName: "管理员", adminUsername: "admin",
  username: "13800000001", userName: "客户甲", amountCents: 1005, poolBeforeCents: 5000, poolAfterCents: 3995,
  walletBeforeCents: 300, walletAfterCents: 1305, createdAt: "2026-10-03T04:00:00.000Z"
};
const overview = (gifts: unknown[] = [], ready = true) => ({ data: { pool: { ready, balanceCents: ready ? 5000 : null, balancePoints: ready ? 500 : null }, gifts } });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let storage: Map<string, string>;

function resetHooks() { state.cursor = 0; state.values.clear(); state.refs.clear(); state.effects = []; state.mounted = false; }
function render(props: Partial<Parameters<typeof CreditGiftPanel>[0]> = {}) {
  state.cursor = 0;
  return CreditGiftPanel({ users, adminId: "admin-a", initialUserId: "user-a", ...props });
}
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as React.ReactNode)];
}
function textContent(node: React.ReactNode): string {
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (React.isValidElement<Record<string, unknown>>(node)) return textContent(node.props.children as React.ReactNode);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function button(tree: React.ReactNode, label: string) {
  const element = elements(tree).find((row) => row.type === "button" && textContent(row) === label);
  if (!element) throw new Error(`缺少按钮 ${label}`);
  return element;
}
function field(tree: React.ReactNode, label: string) { return elements(tree).find((row) => row.props["aria-label"] === label)!; }
function change(tree: React.ReactNode, label: string, value: string) { (field(tree, label).props.onChange as (event: unknown) => void)({ target: { value } }); }
async function click(tree: React.ReactNode, label: string) { await (button(tree, label).props.onClick as () => Promise<void>)(); }
async function flush() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
async function mount(props: Partial<Parameters<typeof CreditGiftPanel>[0]> = {}) {
  render(props);
  const effects = state.effects.splice(0);
  state.mounted = true;
  effects.forEach((effect) => effect());
  await flush();
  return render(props);
}
async function readyForm() {
  vi.mocked(fetch).mockResolvedValueOnce(response(overview()));
  let tree = await mount();
  change(tree, "自定义积分", "100.5");
  change(tree, "赠送理由", " 内测赠送 ");
  tree = render();
  expect(button(tree, "确认赠送积分").props.disabled).toBe(false);
  return tree;
}

beforeEach(() => {
  resetHooks();
  storage = new Map();
  vi.stubGlobal("window", { confirm: vi.fn(() => true), sessionStorage: {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { storage.set(key, value); }),
    removeItem: vi.fn((key: string) => { storage.delete(key); })
  } });
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => REQUEST_KEY) });
  vi.stubGlobal("fetch", vi.fn());
});

describe("credit gift form and pool readiness", () => {
  it("parses positive tenths exactly and rejects malformed, overprecise and overflowing quantities", () => {
    expect(parseCreditGiftPoints("100.5")).toBe(1005);
    expect(parseCreditGiftPoints(" 0.1 ")).toBe(1);
    expect(parseCreditGiftPoints("214748364.7")).toBe(2147483647);
    for (const value of ["", "0", "0.0", "-1", "1e2", "Infinity", "NaN", "1.01", "1.", ".5", "214748364.8", "123456789012345678901"]) expect(parseCreditGiftPoints(value)).toBeNull();
  });
  it("shows unknown pool balance and locks submission until the accounting pool is ready", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(overview([], false)));
    const tree = await mount();
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("未知");
    expect(html).toContain("积分记账系统完成并接通总积分池后可赠送");
    expect(html).not.toContain("客户乙");
    expect(button(tree, "确认赠送积分").props.disabled).toBe(true);
    await click(tree, "确认赠送积分");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("shows the target and pool deduction before confirmation and honors cancellation", async () => {
    const tree = await readyForm();
    expect(textContent(tree)).toContain("确认向 客户甲（13800000001）赠送 100.5 积分；总积分池预计扣减 100.5 积分，预计余额 399.5 积分");
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await click(tree, "确认赠送积分");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(storage.has(STORAGE_KEY)).toBe(false);
  });
});

describe("credit gift uncertainty and idempotent recovery", () => {
  it("sends only the documented payload and prevents duplicate clicks while pending", async () => {
    const tree = await readyForm();
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = click(tree, "确认赠送积分");
    await click(tree, "确认赠送积分");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))).toEqual(payload);
    expect(JSON.parse(storage.get(STORAGE_KEY)!)).toEqual(payload);
    finish(response({ error: "服务忙" }, 503));
    await first;
    expect(field(render(), "自定义积分").props.disabled).toBe(true);
    expect(textContent(render())).toContain("赠送结果待核对");
  });
  it("retains the same payload and key after network failure, then preserves confirmed success if overview refresh fails", async () => {
    const tree = await readyForm();
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    await click(tree, "确认赠送积分");
    expect(storage.has(STORAGE_KEY)).toBe(true);
    vi.mocked(fetch).mockResolvedValueOnce(response({ data: gift })).mockRejectedValueOnce(new Error("refresh offline"));
    await click(render(), "重试同一笔赠送");
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[2][1]?.body))).toEqual(payload);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
    const html = renderToStaticMarkup(render());
    expect(html).toContain("赠送成功");
    expect(html).toContain("已确认的赠送成功记录保留");
    expect(html).toContain("30 → 130.5");
    expect(html).toContain("500 → 399.5");
    expect(storage.has(STORAGE_KEY)).toBe(false);
    expect(button(render(), "确认赠送积分").props.disabled).toBe(true);
  });
  it("treats a success status with invalid JSON or mismatched receipt as uncertain", async () => {
    const tree = await readyForm();
    vi.mocked(fetch).mockResolvedValueOnce(new Response("broken json", { status: 200 }));
    await click(tree, "确认赠送积分");
    expect(textContent(render())).toContain("赠送结果待核对");
    vi.mocked(fetch).mockResolvedValueOnce(response({ data: { ...gift, userId: "foreign-user" } }));
    await click(render(), "重试同一笔赠送");
    expect(storage.has(STORAGE_KEY)).toBe(true);
    expect(textContent(render())).not.toContain("赠送成功");
    vi.mocked(fetch).mockResolvedValueOnce(response({ data: { ...gift, id: "", billingEventId: "" } }));
    await click(render(), "重试同一笔赠送");
    expect(storage.has(STORAGE_KEY)).toBe(true);
    expect(textContent(render())).not.toContain("赠送成功");
  });
  it("releases a definite first 4xx rejection but keeps an uncertain operation after a later 4xx", async () => {
    const tree = await readyForm();
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: "总积分池余额不足" }, 409));
    await click(tree, "确认赠送积分");
    expect(storage.has(STORAGE_KEY)).toBe(false);
    expect(field(render(), "自定义积分").props.disabled).toBe(false);
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    await click(render(), "确认赠送积分");
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: "账号状态已变更" }, 403));
    await click(render(), "重试同一笔赠送");
    expect(storage.has(STORAGE_KEY)).toBe(true);
    expect(field(render(), "赠送账号").props.disabled).toBe(true);
    expect(textContent(render())).toContain("原赠送结果仍待核对");
  });
  it("restores pending drafts after unmount or refresh; absence from the recent list never clears them", async () => {
    const tree = await readyForm();
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    await click(tree, "确认赠送积分");
    resetHooks();
    vi.mocked(fetch).mockResolvedValueOnce(response(overview()));
    const restored = await mount({ initialUserId: "different-user" });
    expect(field(restored, "赠送账号").props.value).toBe("user-a");
    expect(field(restored, "自定义积分").props.value).toBe("100.5");
    expect(field(restored, "自定义积分").props.disabled).toBe(true);
    expect(storage.has(STORAGE_KEY)).toBe(true);
    vi.mocked(fetch).mockResolvedValueOnce(response(overview([gift])));
    await click(render(), "刷新核对");
    expect(storage.has(STORAGE_KEY)).toBe(false);
    expect(textContent(render())).toContain("赠送成功");
  });
  it("isolates each administrator's saved draft and blocks sending when persistence fails", async () => {
    storage.set(STORAGE_KEY, JSON.stringify(payload));
    vi.mocked(fetch).mockResolvedValueOnce(response(overview()));
    const otherAdmin = await mount({ adminId: "admin-b" });
    expect(textContent(otherAdmin)).not.toContain("待核对：");
    resetHooks();
    storage.clear();
    const tree = await readyForm();
    vi.mocked(window.sessionStorage.setItem).mockImplementationOnce(() => { throw new Error("storage denied"); });
    await click(tree, "确认赠送积分");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(textContent(render())).toContain("本次未提交");
  });
  it("unlocks after a successful gift's saved record can finally be cleared during a later refresh", async () => {
    const tree = await readyForm();
    vi.mocked(window.sessionStorage.removeItem).mockImplementationOnce(() => { throw new Error("temporarily denied"); });
    vi.mocked(fetch).mockResolvedValueOnce(response({ data: gift })).mockResolvedValueOnce(response(overview()));
    await click(tree, "确认赠送积分");
    expect(textContent(render())).toContain("赠送已成功，但浏览器未能清除待核对记录");
    expect(field(render(), "自定义积分").props.disabled).toBe(true);
    vi.mocked(fetch).mockResolvedValueOnce(response(overview([gift])));
    await click(render(), "刷新核对");
    expect(storage.has(STORAGE_KEY)).toBe(false);
    expect(field(render(), "自定义积分").props.disabled).toBe(false);
    expect(textContent(render())).not.toContain("浏览器未能清除");
    expect(textContent(render())).toContain("赠送成功");
  });
});
