import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { applyGatewayBillingCost, centsToPoints } from "@/lib/model-gateway/billing-contract";

type Node = { type: unknown; props: Record<string, unknown> };
type Value = Node | string | number | boolean | null | undefined | Value[];
const source = ts.transpileModule(readFileSync(resolve("src/components/creative/CreativeCredits.tsx"), "utf8"), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX
} }).outputText;
const data = { wallet: { balanceCents: 12000, balancePoints: 1200 }, plan: { code: "starter", name: "体验版", multiplierBps: 8000, ruleVersion: 3 },
  models: [{ id: "image2", label: "演示图片模型", kind: "image", imageCents: 50 }, { id: "video", label: "演示视频模型", kind: "video", videoCents: 90 }], catalogError: null };

function harness() {
  const slots: Array<{ value?: unknown; deps?: unknown[]; cleanup?: () => void }> = [];
  let cursor = 0, tree: Value, pending: Array<() => void> = [];
  const requests: Array<{ url: string; resolve: (response: { ok: boolean; json: () => Promise<unknown> }) => void; signal: AbortSignal }> = [];
  const messages: Array<{ message: { data: unknown }; origin: string }> = [];
  const events = new Map<string, () => void>();
  const react = {
    useState(initial: unknown) { const slot = slots[cursor++] ||= { value: initial }; return [slot.value, (next: unknown) => { slot.value = typeof next === "function" ? (next as (v: unknown) => unknown)(slot.value) : next; }]; },
    useEffect(callback: () => (() => void) | undefined, deps: unknown[]) { const slot = slots[cursor++] ||= {}; if (!slot.deps || !deps.every((d, i) => Object.is(d, slot.deps![i]))) { slot.deps = deps; pending.push(() => { slot.cleanup?.(); slot.cleanup = callback(); }); } }
  };
  const exports: Record<string, unknown> = {};
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  let sequence = 0;
  const context = createContext({ exports, module: { exports }, AbortController, Date, Intl, console,
    crypto: { randomUUID: () => `demo-${++sequence}` }, document: { querySelectorAll: () => [{ contentWindow: { postMessage: (message: { data: unknown }, origin: string) => messages.push({ message, origin }) } }] }, window: { location: { origin: "http://localhost" }, addEventListener: (name: string, handler: () => void) => events.set(name, handler), removeEventListener: (name: string) => events.delete(name) },
    fetch: vi.fn((url: string, options: { signal: AbortSignal }) => new Promise(resolve => requests.push({ url, resolve, signal: options.signal }))),
    require: (name: string) => {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "@/lib/model-gateway/billing-contract") return { applyGatewayBillingCost, centsToPoints };
      if (name.endsWith(".module.css")) return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
      throw new Error(name);
    }
  });
  runInContext(source, context);
  const component = exports.CreativeCredits as () => Value;
  const quote = exports.creativeDemoQuote as (model: typeof data.models[number], count: number, multiplier: number, grouping?: string) => { costCents: number; requests: number[] } | null;
  function render() { cursor = 0; pending = []; tree = component(); pending.forEach(effect => effect()); return tree; }
  function nodes(value?: Value): Node[] { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(v => nodes(v)); return value && typeof value === "object" ? [value, ...nodes(value.props.children as Value)] : []; }
  function text(value?: Value): string { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.map(v => text(v)).join(""); return value && typeof value === "object" ? text(value.props.children as Value) : value == null || typeof value === "boolean" ? "" : String(value); }
  function button(label: string) { const node = nodes().find(node => node.type === "button" && text(node.props.children as Value) === label); if (!node) throw new Error(`Missing ${label}`); return node; }
  function click(label: string) { const node = button(label); (node.props.onClick as () => void)(); render(); }
  async function respond(index: number, body: unknown, ok = true) { requests[index].resolve({ ok, json: async () => body }); await new Promise(resolve => setImmediate(resolve)); render(); }
  render();
  return { render, nodes, text, button, click, respond, requests, messages, quote, context, events };
}

describe("creative credit display and safe demonstration", () => {
  it("hides multiplier rules while retaining the same balance and quote calculation", async () => {
    const h = harness(); await h.respond(0, { data });
    expect(h.text()).toContain("1,200"); expect(h.text()).not.toContain("倍率"); expect(h.text()).not.toContain("体验版");
    const balanceButton = h.nodes().find(node => node.type === "button" && h.text(node.props.children as Value).includes("可用积分"))!;
    (balanceButton.props.onClick as () => void)(); h.render();
    await h.respond(1, { data: { items: [{ id: "debit", kind: "debit", model: "模型", createdAt: new Date().toISOString(), status: "ok", deltaCents: -40, balanceBeforeCents: 12000, balanceAfterCents: 11960, chargedCostCents: 40, planName: "体验版", multiplierBps: 8000, ruleVersion: 3, billingEventId: "fixture" }], total: 1, pageSize: 20 } });
    expect(h.text()).toContain("实际扣分4 积分"); expect(h.text()).not.toContain("套餐规则"); expect(h.text()).not.toContain("0.8×");
    h.click("积分演示"); h.click("模拟扣分并查看记录");
    expect(h.text()).toContain("1,200 → 1,196"); expect(h.text()).not.toContain("倍率"); expect(h.text()).not.toContain("规则快照");
  });
  it("提供积分充值入口，支付成功事件重新读取账户余额", async () => {
    const h = harness(); await h.respond(0, { data });
    expect(h.nodes().find(node => node.type === "a" && h.text(node.props.children as Value) === "购买积分")?.props.href).toBe("/models?recharge=1");
    h.events.get("sanjie:payment-paid")?.(); h.render();
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].url).toBe("/api/creative/credits");
    await h.respond(1, { data: { ...data, wallet: { balanceCents: 24000, balancePoints: 2400 } } });
    expect(h.text()).toContain("2,400");
  });
  it("rounds each actual request and distinguishes four-image grouping", () => {
    const h = harness();
    expect(h.quote(data.models[0], 2, 10001)?.costCents).toBe(102);
    expect(h.quote(data.models[0], 2, 10001, "four")?.costCents).toBe(101);
    expect(h.quote(data.models[1], 2, 8000)?.costCents).toBe(144);
    expect(h.quote(data.models[1], 15, 8000)?.requests).toHaveLength(15);
  });
  it("does not guess a missing model price or accept invalid quantities", () => {
    const h = harness();
    expect(h.quote({ ...data.models[0], imageCents: undefined } as unknown as typeof data.models[0], 2, 10000)).toBeNull();
    for (const n of [0, 1.5, 101, NaN, Infinity]) expect(h.quote(data.models[0], n, 10000)).toBeNull();
    expect(h.quote(data.models[0], 100, 1000001)).toBeNull();
  });
  it("shows true balance, simulates with the current plan, and never posts or invokes a model", async () => {
    const h = harness(); await h.respond(0, { data });
    const balanceButton = h.nodes().find(node => node.type === "button" && h.text(node.props.children as Value).includes("可用积分"))!;
    (balanceButton.props.onClick as () => void)(); h.render(); h.click("积分演示");
    expect(h.text()).toContain("本次预计 4 积分");
    h.click("模拟扣分并查看记录");
    expect(h.text()).toContain("演示记录"); expect(h.text()).toContain("1,200 → 1,196");
    expect(h.text()).toContain("仅演示，未发起 API 请求");
    expect(h.text()).not.toContain("真实扣分0 积分");
    expect(h.requests.every(request => request.url.startsWith("/api/creative/credits"))).toBe(true);
    expect(h.requests).toHaveLength(2); // account + actual ledger GET on initial open
    h.click("重置演示"); expect(h.text()).not.toContain("演示记录");
  });
  it("shows API failures instead of presenting an empty ledger as verified", async () => {
    const h = harness(); await h.respond(0, {}, false);
    expect(h.text()).toContain("积分信息暂不可用");
  });
  it("clears an old quote when refreshing current pricing fails", async () => {
    const h = harness(); await h.respond(0, { data });
    const balanceButton = h.nodes().find(node => node.type === "button" && h.text(node.props.children as Value).includes("可用积分"))!;
    (balanceButton.props.onClick as () => void)(); h.render(); h.click("积分演示");
    expect(h.text()).toContain("本次预计 4 积分");
    h.click("刷新积分"); await h.respond(2, {}, false);
    expect(h.text()).toContain("积分信息暂不可用");
    expect(h.text()).not.toContain("本次预计 4 积分");
    expect(h.button("模拟扣分并查看记录").props.disabled).toBe(true);
    expect(h.messages.at(-1)).toMatchObject({ message: { data: null }, origin: "http://localhost" });
  });
});
