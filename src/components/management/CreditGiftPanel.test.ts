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
let listeners: Map<string, () => void>;

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
  listeners = new Map();
  vi.stubGlobal("window", { confirm: vi.fn(() => true), addEventListener: (name: string, listener: () => void) => listeners.set(name, listener), removeEventListener: (name: string) => listeners.delete(name), sessionStorage: {
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
  it("accepts the old ready=false response as uninitialized and locks submission", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(overview([], false)));
    const tree = await mount();
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("未配置");
    expect(html).toContain("总积分池尚未初始化，无法确认可赠送余额");
    expect(html).not.toContain("60618.0775600000");
    expect(html).not.toContain("Codex_credit");
    expect(html).not.toContain("客户乙");
    expect(button(tree, "确认赠送积分").props.disabled).toBe(true);
    await click(tree, "确认赠送积分");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["uninitialized", "未配置", "总积分池尚未初始化，无法确认可赠送余额", "总积分池尚未初始化，当前不能赠送。"],
    ["pending", "待核对", "总积分池已建立", "来源余额需重新核对，当前不能赠送。"],
    ["invalid", "异常", "总积分池状态或余额异常", "总积分池状态异常，当前不能赠送。"]
  ])("distinguishes the %s pool state and exposes the actual submission blocker", async (poolState, label, hint, blocker) => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ data: { pool: { state: poolState, ready: false, balanceCents: null, balancePoints: null }, gifts: [] } }));
    let tree = await mount();
    change(tree, "自定义积分", "100.5"); change(tree, "赠送理由", "状态验收"); tree = render();
    const text = textContent(tree);
    expect(text).toContain(label); expect(text).toContain(hint); expect(text).toContain(blocker);
    expect(button(tree, "确认赠送积分").props.disabled).toBe(true);
    expect(button(tree, "确认赠送积分").props["aria-describedby"]).toBe("credit-gift-submit-blocker");
    expect(text).not.toContain("读取失败");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("shows loading separately and never reports a not-yet-loaded pool as uninitialized", async () => {
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const tree = await mount();
    expect(textContent(tree)).toContain("读取中…");
    expect(textContent(tree)).toContain("正在读取总积分池，请等待核对完成");
    expect(textContent(tree)).not.toContain("尚未配置");
    expect(button(tree, "确认赠送积分").props.disabled).toBe(true);
    resolve(response(overview())); await flush();
    expect(textContent(render())).not.toContain("读取中…");
  });
  it.each([401, 403, 503])("shows GET %s failure separately from uninitialized", async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: "读取失败" }, status));
    const tree = await mount();
    expect(textContent(tree)).toContain("总积分池读取失败，请先刷新核对");
    expect(textContent(tree)).toContain("读取失败不能判断是否已配置");
    expect(textContent(tree)).not.toContain("尚未配置总积分池");
    expect(button(tree, "确认赠送积分").props.disabled).toBe(true);
  });
  it.each([
    { state: "ready", ready: false, balanceCents: null, balancePoints: null },
    { state: "pending", ready: true, balanceCents: 5000, balancePoints: 500 },
    { state: "unknown", ready: false, balanceCents: null, balancePoints: null },
    { state: 123, ready: false, balanceCents: null, balancePoints: null },
    { state: { toString: "pending" }, ready: false, balanceCents: null, balancePoints: null },
    { state: "ready", ready: true, balanceCents: 5000, balancePoints: 5000 }
  ])("treats inconsistent or malformed explicit state as a read failure (%j)", async (pool) => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ data: { pool, gifts: [] } }));
    const tree = await mount();
    expect(textContent(tree)).toContain("总积分池读取失败，请先刷新核对");
    expect(textContent(tree)).not.toContain("尚未配置总积分池");
    expect(button(tree, "确认赠送积分").props.disabled).toBe(true);
  });
  it("does not mislabel an invalid JSON response as uninitialized", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("broken", { status: 200 }));
    const tree = await mount();
    expect(textContent(tree)).toContain("读取失败");
    expect(textContent(tree)).not.toContain("尚未配置总积分池");
  });
  it("shows an empty but ready pool as zero and explains insufficient balance", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ data: { pool: { state: "ready", ready: true, balanceCents: 0, balancePoints: 0 }, gifts: [] } }));
    let tree = await mount(); change(tree, "自定义积分", "0.1"); change(tree, "赠送理由", "状态验收"); tree = render();
    expect(renderToStaticMarkup(tree)).toContain("<strong>0<small> 积分</small></strong>");
    expect(textContent(tree)).toContain("总积分池可赠送余额不足，请调整积分数量");
    expect(textContent(tree)).not.toContain("未配置");
    expect(button(tree, "确认赠送积分").props.disabled).toBe(true);
  });
  it("explains missing account, quantity and reason before enabling the ready-state button", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ data: { ...overview().data, pool: { ...overview().data.pool, state: "ready" } } }));
    let tree = await mount({ initialUserId: "" });
    expect(textContent(tree)).toContain("请选择启用中的赠送账号");
    change(tree, "赠送账号", "user-a"); tree = render();
    expect(textContent(tree)).toContain("请填写大于 0、最多 1 位小数的积分数量");
    change(tree, "自定义积分", "100.5"); tree = render();
    expect(textContent(tree)).toContain("请填写 2 至 500 字的赠送理由");
    expect(button(tree, "确认赠送积分").props.disabled).toBe(true);
    for (const value of ["x", "x".repeat(501), "有效\n理由"]) {
      change(tree, "赠送理由", value); tree = render();
      expect(button(tree, "确认赠送积分").props.disabled).toBe(true);
      expect(textContent(tree)).toContain("请填写 2 至 500 字的赠送理由");
    }
    change(tree, "赠送理由", "状态验收"); tree = render();
    expect(button(tree, "确认赠送积分").props.disabled).toBe(false);
    expect(button(tree, "确认赠送积分").props["aria-describedby"]).toBeUndefined();
    expect(textContent(tree)).not.toContain("请填写 2 至 500 字的赠送理由，不能");
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

describe("explicit gift submission refreshes an adopted shared source", () => {
  const pendingOverview = (available: unknown) => ({ data: { pool: { state: "pending", ready: false,
    balanceCents: null, balancePoints: null, refreshOnSubmitAvailable: available }, gifts: [] } });
  async function pendingForm() {
    vi.mocked(fetch).mockResolvedValueOnce(response(pendingOverview(true)));
    let tree = await mount(); change(tree, "自定义积分", "100.5"); change(tree, "赠送理由", " 内测赠送 "); tree = render();
    expect(button(tree, "核对最新余额并赠送").props.disabled).toBe(false);
    expect(textContent(tree)).toContain("余额足够且校验通过后才赠送");
    expect(textContent(tree)).not.toContain("预计余额");
    return tree;
  }
  it("keeps a pending null balance honest and cancelling confirmation sends no mutation", async () => {
    const tree = await pendingForm(); vi.mocked(window.confirm).mockReturnValueOnce(false);
    await click(tree, "核对最新余额并赠送");
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("先读取最新上游余额并核对账本"));
    expect(vi.mocked(window.confirm).mock.calls[0][0]).not.toContain("预计余额");
    expect(fetch).toHaveBeenCalledTimes(1); expect(storage.size).toBe(0);
  });
  it("sends one original gift POST, never a separate source POST, and rejects insufficient backing without success", async () => {
    const tree = await pendingForm(); let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = click(tree, "核对最新余额并赠送"); await click(tree, "核对最新余额并赠送");
    expect(fetch).toHaveBeenCalledTimes(2); expect(vi.mocked(fetch).mock.calls[1][0]).toBe(ENDPOINT);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))).toEqual(payload);
    expect(JSON.parse(storage.get(STORAGE_KEY)!)).toEqual(payload);
    finish(response({ error: "总积分池可分配积分不足" }, 409)); await first;
    expect(textContent(render())).toContain("本次赠送未成功"); expect(textContent(render())).not.toContain("赠送成功：");
    expect(storage.size).toBe(0);
  });
  it("retains unknown outcomes and retries only the same gift key", async () => {
    const tree = await pendingForm(); vi.mocked(fetch).mockRejectedValueOnce(new Error("fixture offline"));
    await click(tree, "核对最新余额并赠送"); expect(textContent(render())).toContain("赠送结果待核对");
    vi.mocked(fetch).mockResolvedValueOnce(response({ data: gift })).mockResolvedValueOnce(response(overview([gift])));
    await click(render(), "重试同一笔赠送");
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))).toEqual(payload);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[2][1]?.body))).toEqual(payload);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1); expect(storage.size).toBe(0);
    expect(textContent(render())).toContain("赠送成功：");
    expect(vi.mocked(fetch).mock.calls.every(call => call[0] === ENDPOINT)).toBe(true);
  });
  it.each([false, undefined])("a missing or false capability remains blocked (%s)", async available => {
    vi.mocked(fetch).mockResolvedValueOnce(response(pendingOverview(available)));
    let tree = await mount(); change(tree, "自定义积分", "100.5"); change(tree, "赠送理由", "状态验收"); tree = render();
    expect(button(tree, "确认赠送积分").props.disabled).toBe(true);
    await click(tree, "确认赠送积分"); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { state: "pending", ready: false, balanceCents: null, balancePoints: null, refreshOnSubmitAvailable: "true" },
    { state: "uninitialized", ready: false, balanceCents: null, balancePoints: null, refreshOnSubmitAvailable: true },
    { state: "invalid", ready: false, balanceCents: null, balancePoints: null, refreshOnSubmitAvailable: true },
    { state: "ready", ready: true, balanceCents: 5000, balancePoints: 500, refreshOnSubmitAvailable: true }
  ])("malformed or contradictory refresh capability cannot enable submission (%j)", async pool => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ data: { pool, gifts: [] } }));
    const tree = await mount(); expect(textContent(tree)).toContain("总积分池读取失败");
    expect(button(tree, "确认赠送积分").props.disabled).toBe(true);
  });
});

describe("credit gift uncertainty and idempotent recovery", () => {
  it("source adoption event refreshes only GET and preserves an unsent gift draft", async () => { let tree = await readyForm(); expect(listeners.has("sanjie-credit-pool-updated")).toBe(true); vi.mocked(fetch).mockResolvedValueOnce(response(overview())); listeners.get("sanjie-credit-pool-updated")!(); await flush(); tree = render(); expect(field(tree, "自定义积分").props.value).toBe("100.5"); expect(field(tree, "赠送理由").props.value).toBe(" 内测赠送 "); expect(button(tree, "确认赠送积分").props.disabled).toBe(false); expect(fetch).toHaveBeenCalledTimes(2); expect(vi.mocked(fetch).mock.calls[1][1]).not.toHaveProperty("method", "POST"); expect(storage.size).toBe(0); });
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
