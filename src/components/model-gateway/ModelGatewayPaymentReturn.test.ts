import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as scanPaymentContract from "@/lib/model-gateway/scan-payment-contract";

const source = ts.transpileModule(readFileSync(resolve("src/components/model-gateway/ModelGatewayConsole.tsx"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
}).outputText;

type View = { type: string; props: Record<string, unknown> };
type Child = View | string | number | boolean | null | undefined | Child[];
function paymentConsole(search: string, plans: Array<{ code: string; name: string; priceCents: number; creditCents: number; badge: string; recommended?: boolean }> = []) {
  const slots: { value?: unknown; deps?: unknown[] }[] = [];
  let cursor = 0, dirty = false, effects: Array<() => void> = [], tree: Child;
  const overview = { wallet: { balanceCents: 0, availableCents: 0, reservedCents: 0, monthlyQuotaCents: 0,
    planCode: "free", planName: "体验版", periodEnd: "2026-10-03" }, keys: [], orders: [], usages: [] };
  const freshOverview = { ...overview, wallet: { ...overview.wallet, balanceCents: 12000, availableCents: 12000 } };
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: freshOverview }) });
  const history = { state: { retained: true }, replaceState: vi.fn() };
  const local: Record<string, unknown> = {};
  const react = {
    useState(initial: unknown) {
      const slot = slots[cursor++] ||= { value: initial };
      return [slot.value, (next: unknown) => { if (!Object.is(next, slot.value)) { slot.value = next; dirty = true; } }];
    },
    useEffect(callback: () => void, deps: unknown[]) {
      const slot = slots[cursor++] ||= {};
      if (!slot.deps || deps.length !== slot.deps.length || deps.some((value, index) => !Object.is(value, slot.deps![index]))) {
        slot.deps = deps; effects.push(callback);
      }
    }
  };
  const jsx = (type: string, props: Record<string, unknown>) => ({ type, props });
  runInContext(source, createContext({ exports: local, module: { exports: local }, URL, URLSearchParams, Date, Intl, fetch,
    window: { location: { origin: "https://shaozhuangai.com", search, href: "https://shaozhuangai.com/models" + search }, history },
    require(name: string) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "lucide-react") return new Proxy({}, { get: (_, key) => String(key) });
      if (name === "./RelaySettingsPanel") return { RelaySettingsPanel: "RelaySettingsPanel" };
      if (name === "./UserSupplyPanel") return { UserSupplyPanel: "UserSupplyPanel" };
      if (name === "../creative/ScanPaymentDialog") return { ScanPaymentDialog: "ScanPaymentDialog" };
      if (name === "@/lib/model-gateway/scan-payment-contract") return scanPaymentContract;
      throw new Error(name);
    }
  }));
  function render() {
    let attempts = 0;
    do {
      dirty = false; cursor = 0; effects = [];
      tree = (local.ModelGatewayConsole as (props: unknown) => Child)({ initialOverview: overview, plans, models: [] });
      effects.forEach(effect => effect());
      if (++attempts > 12) throw new Error("Unstable parent render");
    } while (dirty);
  }
  function nodes(value: Child = tree): View[] {
    if (Array.isArray(value)) return value.flatMap(item => nodes(item));
    return value && typeof value === "object" ? [value, ...(value.props.children !== undefined ? nodes(value.props.children as Child) : [])] : [];
  }
  function text(value: Child = tree): string {
    if (Array.isArray(value)) return value.map(item => text(item)).join("");
    return value && typeof value === "object" ? value.props.children !== undefined ? text(value.props.children as Child) : "" : value == null || typeof value === "boolean" ? "" : String(value);
  }
  async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); render(); }
  render();
  return { dialog: () => nodes().find(node => node.type === "ScanPaymentDialog")!, planButtons: () => nodes().filter(node => node.type === "button" && node.props.className === "pricing-select"), fetch, history, render, settle, text, freshOverview };
}

describe("payment return and existing-order recovery", () => {
  it("套餐卡将原套餐编码交给收款弹窗，选择时不创建订单", () => {
    const h = paymentConsole("", [
      { code: "starter", name: "体验版", priceCents: 9900, creditCents: 12000, badge: "入门" },
      { code: "growth", name: "增长版", priceCents: 29900, creditCents: 38000, badge: "推荐", recommended: true }
    ]);
    expect(h.planButtons()).toHaveLength(2);
    expect(h.text()).toContain("¥299.00");
    expect(h.text()).toContain("3,800 积分");
    (h.planButtons()[1].props.onClick as () => void)(); h.render();
    expect(h.dialog().props.open).toBe(true);
    expect(h.dialog().props.initialPlanCode).toBe("growth");
    expect(h.dialog().props.resumeOrderId).toBeUndefined();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("opens only the explicit original order and performs no create request", () => {
    const h = paymentConsole("?recharge=1&orderId=paid-order_123");
    expect(h.dialog().props.open).toBe(true);
    expect(h.dialog().props.resumeOrderId).toBe("paid-order_123");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each(["?orderId=valid", "?recharge=1&orderId=", "?recharge=1&orderId=a%2Fb", "?recharge=1&orderId=" + "a".repeat(81),
    "?recharge=1&orderId=first&orderId=second", "?recharge=1&recharge=1&orderId=valid"])("rejects ambiguous or unsafe restore selector %s", search => {
    const h = paymentConsole(search);
    expect(h.dialog().props.open).toBe(false); expect(h.dialog().props.resumeOrderId).toBeUndefined();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("preserves the ordinary recharge entry with no existing order", () => {
    const h = paymentConsole("?recharge=1");
    expect(h.dialog().props.open).toBe(true); expect(h.dialog().props.resumeOrderId).toBeUndefined();
  });

  it("paid callback fetches current available balance before automatic close consumes only payment URL selectors", async () => {
    const h = paymentConsole("?recharge=1&orderId=paid-order_123&keep=1#tab");
    await (h.dialog().props.onPaid as () => Promise<void>)(); h.render();
    expect(h.fetch).toHaveBeenCalledWith("/api/model-gateway/overview", { cache: "no-store" });
    expect(h.text()).toContain("1,200 积分"); expect(h.text()).toContain("支付成功，套餐与积分已到账。");
    (h.dialog().props.onClose as () => void)(); await h.settle();
    expect(h.dialog().props.open).toBe(false);
    expect(h.history.replaceState).toHaveBeenCalledWith(h.history.state, "", "/models?keep=1#tab");
    expect(h.fetch.mock.calls.every(([url]) => url === "/api/model-gateway/overview")).toBe(true);
  });

  it("balance refresh failure rejects onPaid so the dialog can stay paid and offer a retry", async () => {
    const h = paymentConsole("?recharge=1&orderId=paid-order_123");
    h.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "未登录" }) });
    await expect((h.dialog().props.onPaid as () => Promise<void>)()).rejects.toThrow("未登录");
    expect(h.dialog().props.open).toBe(true); expect(h.history.replaceState).not.toHaveBeenCalled();
  });

  it("an aborted payment refresh cannot overwrite the newer balance after retry", async () => {
    const h = paymentConsole("?recharge=1&orderId=paid-order_123");
    let oldResponse!: (value: unknown) => void;
    h.fetch.mockImplementationOnce(() => new Promise(resolve => { oldResponse = resolve; }));
    const cancelled = new AbortController();
    const onPaid = h.dialog().props.onPaid as (order: unknown, signal?: AbortSignal) => Promise<void>;
    const old = onPaid(undefined, cancelled.signal).catch(error => error);
    cancelled.abort();
    await onPaid(undefined, new AbortController().signal); h.render();
    expect(h.text()).toContain("1,200 积分");
    oldResponse({ ok: true, json: async () => ({ data: { ...h.freshOverview,
      wallet: { ...h.freshOverview.wallet, balanceCents: 0, availableCents: 0 } } }) });
    expect((await old).message).toBe("账户刷新已取消。"); h.render();
    expect(h.text()).toContain("1,200 积分");
  });
});
