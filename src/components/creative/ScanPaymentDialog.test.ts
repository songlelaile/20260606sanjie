import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { centsToPoints } from "@/lib/model-gateway/billing-contract";

type Node = { type: string; props: Record<string, unknown> };
type Value = Node | string | number | boolean | null | undefined | Value[];
type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void };
type Request = { url: string; options: { method?: string; body?: string; signal: AbortSignal }; resolve: (value: unknown) => void; reject: (reason: Error) => void };
const source = ts.transpileModule(readFileSync(resolve("src/components/creative/ScanPaymentDialog.tsx"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
}).outputText;
const plans = [{ code: "starter", name: "体验版", priceCents: 9900, creditCents: 12000 }, { code: "growth", name: "成长版", priceCents: 29900, creditCents: 36000 }];
const options = { data: { providers: [{ provider: "alipay", available: true }, { provider: "wechat", available: true }] } };
const pendingOrder = {
  id: "scan-order-1", planCode: "starter", planName: "体验版", amountCents: 9900, creditCents: 12000,
  paymentProvider: "alipay", status: "pending", paymentUrl: "https://qr.alipay.com/example",
  qrCodeDataUrl: "data:image/png;base64,UE5H", expiresAt: "2026-10-02T01:15:00.000Z", paidAt: null, createdAt: "2026-10-02T01:00:00.000Z"
};
const pageOrder = { ...pendingOrder, checkoutMode: "alipay_page", qrCodeDataUrl: null, paymentUrl: "",
  cashierUrl: "https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay&biz_content=mode4&sign=embedded-signature",
  fallbackCashierUrl: "https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay&biz_content=mode2&sign=fallback-signature" };

function harness(extra: Record<string, unknown> = {}) {
  const slots: Slot[] = [], requests: Request[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const windowListeners = new Map<string, (event: unknown) => void>();
  let cursor = 0, tree: Value, pending: Array<() => void> = [], dirty = false;
  const events: unknown[] = [];
  const onPaid = vi.fn();
  const doc = { activeElement: null as Element | null, visibilityState: "visible", body: { style: { overflow: "auto" } },
    addEventListener: (name: string, handler: (event: unknown) => void) => listeners.set(name, handler),
    removeEventListener: (name: string) => listeners.delete(name) };
  class Element {
    isConnected = true;
    children: Element[] = [];
    constructor(public node?: Node) {}
    focus() { doc.activeElement = this; }
    contains(element: Element | null) { return element === this || this.children.includes(element!); }
    querySelectorAll() { return this.children.filter(element => element.node?.type === "button" && !element.node.props.disabled || element.node?.type === "select" && !element.node.props.disabled || element.node?.type === "a"); }
  }
  const trigger = new Element(); trigger.focus();
  const elements = new Map<string, Element>();
  const props = { open: true, plans, onClose: vi.fn(() => { props.open = false; render(); }), onPaid, ...extra };
  const changed = (a: unknown[] | undefined, b: unknown[]) => !a || a.length !== b.length || !b.every((item, index) => Object.is(item, a[index]));
  const react = {
    useState(initial: unknown) {
      const slot = slots[cursor++] ||= { value: typeof initial === "function" ? (initial as () => unknown)() : initial };
      return [slot.value, (value: unknown) => { const next = typeof value === "function" ? (value as (old: unknown) => unknown)(slot.value) : value; if (!Object.is(next, slot.value)) { slot.value = next; dirty = true; } }];
    },
    useRef(initial: unknown) { return (slots[cursor++] ||= { value: { current: initial } }).value; },
    useId() { return (slots[cursor++] ||= { value: "payment-title" }).value; },
    useCallback(callback: unknown, deps: unknown[]) { const slot = slots[cursor++] ||= {}; if (changed(slot.deps, deps)) { slot.value = callback; slot.deps = deps; } return slot.value; },
    useEffect(callback: () => (() => void) | undefined, deps: unknown[]) { const slot = slots[cursor++] ||= {}; if (changed(slot.deps, deps)) { slot.deps = deps; pending.push(() => { slot.cleanup?.(); slot.cleanup = callback(); }); } }
  };
  const jsx = (type: string, nodeProps: Record<string, unknown>) => ({ type, props: nodeProps });
  const exports: Record<string, unknown> = {};
  const context = createContext({ exports, module: { exports }, Date, Intl, URL, AbortController, HTMLElement: Element, document: doc,
    window: { setInterval, clearInterval, setTimeout, clearTimeout, dispatchEvent: (event: unknown) => events.push(event),
      addEventListener: (name: string, handler: (event: unknown) => void) => windowListeners.set(name, handler),
      removeEventListener: (name: string) => windowListeners.delete(name) }, CustomEvent: class { constructor(public type: string, public detail: unknown) {} },
    fetch: vi.fn((url: string, requestOptions: Request["options"]) => new Promise((resolve, reject) => requests.push({ url, options: requestOptions, resolve, reject }))),
    require: (name: string) => {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react-dom") return { createPortal: (value: Value) => value };
      if (name === "@/lib/model-gateway/billing-contract") return { centsToPoints };
      if (name === "lucide-react") return new Proxy({}, { get: (_, key) => String(key) });
      if (name.endsWith(".module.css")) return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
      throw new Error(name);
    }
  });
  runInContext(source, context);
  const component = exports.ScanPaymentDialog as (input: typeof props) => Value;
  function nodes(value: Value = tree): Node[] { if (Array.isArray(value)) return value.flatMap(item => nodes(item)); return value && typeof value === "object" ? [value, ...(value.props.children ? nodes(value.props.children as Value) : [])] : []; }
  function text(value: Value = tree): string { if (Array.isArray(value)) return value.map(item => text(item)).join(""); return value && typeof value === "object" ? value.props.children ? text(value.props.children as Value) : "" : value == null || typeof value === "boolean" ? "" : String(value); }
  function render() {
    let attempts = 0;
    do {
      dirty = false; cursor = 0; pending = []; tree = component(props);
      const all = nodes();
      all.forEach((node, index) => {
        const key = String(node.props["aria-label"] || node.props.role || `${node.type}-${index}`);
        const element = elements.get(key) || new Element(node); element.node = node; elements.set(key, element);
        if (node.props.ref) (node.props.ref as { current: Element }).current = element;
      });
      const dialog = elements.get("dialog"); if (dialog) dialog.children = all.filter(node => node.props.role !== "dialog").map(node => new Element(node));
      // Ref-backed close button is also the first keyboard target, as in the DOM.
      if (dialog) dialog.children = dialog.children.map(item => item.node?.props["aria-label"] === "关闭收款弹窗" ? elements.get("关闭收款弹窗")! : item);
      pending.forEach(effect => effect());
      if (++attempts > 15) throw new Error("Render did not settle");
    } while (dirty);
    return tree;
  }
  function button(label: string) { const node = nodes().find(item => item.type === "button" && (text(item.props.children as Value) === label || item.props["aria-label"] === label)); if (!node) throw new Error(`Missing button: ${label}; got ${text()}`); return node; }
  function click(label: string) { const node = button(label); if (node.props.disabled) throw new Error(`Disabled button: ${label}`); (node.props.onClick as () => void)(); render(); }
  async function settle() { for (let n = 0; n < 40; n++) await Promise.resolve(); render(); }
  async function respond(index: number, body: unknown, ok = true, status = ok ? 200 : 500) { requests[index].resolve({ ok, status, json: async () => body }); await settle(); }
  async function advance(ms: number) { await vi.advanceTimersByTimeAsync(ms); render(); await settle(); }
  render();
  return { render, nodes, text, button, click, requests, respond, settle, advance, props, doc, trigger, listeners, windowListeners, onPaid, events, elements,
    officialCashierUrl: exports.officialAlipayCashierUrl as (value: unknown) => string | null };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-02T01:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); });

describe("扫码充值交互与到账边界", () => {
  it.each(["alipay", "wechat"])("保留 %s 原生二维码路径，不嵌入收银台", async paymentProvider => {
    const h = harness({ resumeOrderId: pendingOrder.id });
    await h.respond(0, options);
    await h.respond(1, { data: { order: { ...pendingOrder, paymentProvider, checkoutMode: "qr" } } });
    expect(h.nodes().find(node => node.type === "img")?.props.src).toBe(pendingOrder.qrCodeDataUrl);
    expect(h.nodes().some(node => node.type === "iframe")).toBe(false);
    expect(h.text()).not.toContain("在新窗口打开支付宝收银台");
  });

  it("电脑网站支付嵌入官方托管二维码并提供独立签名的新窗口收银台，加载不代表付款", async () => {
    const h = harness({ resumeOrderId: pendingOrder.id });
    await h.respond(0, options);
    await h.respond(1, { data: { order: { ...pageOrder, qrCodeDataUrl: pendingOrder.qrCodeDataUrl } } });
    const frame = h.nodes().find(node => node.type === "iframe")!;
    expect(frame.props.src).toBe(pageOrder.cashierUrl);
    expect(frame.props.title).toBe("支付宝官方收银台二维码");
    expect(frame.props.width).toBe(240); expect(frame.props.height).toBe(280);
    expect(frame.props.sandbox).toContain("allow-scripts"); expect(frame.props.sandbox).toContain("allow-forms");
    expect(frame.props.sandbox).not.toContain("allow-top-navigation"); expect(frame.props.sandbox).not.toContain("allow-popups");
    expect(h.nodes().some(node => node.type === "img")).toBe(false);
    const fallback = h.nodes().find(node => node.type === "a")!;
    expect(fallback.props.href).toBe(pageOrder.fallbackCashierUrl);
    expect(fallback.props.target).toBe("_blank"); expect(fallback.props.rel).toBe("noopener noreferrer");
    expect(h.text()).toContain("99.00"); expect(h.text()).toContain("15:00");
    (frame.props.onLoad as () => void)(); h.render();
    expect(h.onPaid).not.toHaveBeenCalled(); expect(h.text()).not.toContain("支付成功");
    await h.advance(5000);
    expect(h.requests[2].url).toBe("/api/model-gateway/checkout/scan-order-1");
    await h.respond(2, { data: { order: { ...pageOrder, status: "paid" } } });
    expect(h.onPaid).toHaveBeenCalledOnce(); expect(h.text()).toContain("支付成功");
    expect(h.nodes().some(node => node.type === "iframe")).toBe(false);
  });

  it("官方收银台加载失败展示提示和新窗口入口，过期后移除两种付款入口", async () => {
    const h = harness({ resumeOrderId: pendingOrder.id });
    await h.respond(0, options);
    await h.respond(1, { data: { order: { ...pageOrder, expiresAt: "2026-10-02T01:00:02.000Z" } } });
    (h.nodes().find(node => node.type === "iframe")!.props.onError as () => void)(); h.render();
    expect(h.text()).toContain("支付宝收银台加载失败");
    expect(h.text()).toContain("在新窗口打开支付宝收银台");
    expect(h.onPaid).not.toHaveBeenCalled();
    await h.advance(2000);
    expect(h.text()).toContain("二维码已过期");
    expect(h.nodes().some(node => node.type === "iframe" || node.type === "a")).toBe(false);
  });

  it("收银台长时间未加载可见回退提示，跨域页面内容不作为到账依据", async () => {
    const h = harness({ resumeOrderId: pendingOrder.id });
    await h.respond(0, options); await h.respond(1, { data: { order: pageOrder } });
    await h.advance(12000);
    expect(h.text()).toContain("收银台加载较慢");
    expect(h.text()).toContain("在新窗口打开支付宝收银台");
    expect(h.onPaid).not.toHaveBeenCalled();
  });

  it("仅接受官方 HTTPS 网关，拒绝凭据、片段、非443端口和伪装域名", () => {
    const h = harness();
    expect(h.officialCashierUrl(pageOrder.cashierUrl)).toBe(pageOrder.cashierUrl);
    expect(h.officialCashierUrl("https://openapi.alipay.com:443/gateway.do?a=1")).toBe("https://openapi.alipay.com/gateway.do?a=1");
    for (const value of [null, undefined, "", "//openapi.alipay.com/gateway.do", "http://openapi.alipay.com/gateway.do",
      "javascript:alert(1)", "https://openapi.alipay.com.evil.example/gateway.do", "https://evil.example/gateway.do",
      "https://user@openapi.alipay.com/gateway.do", "https://:password@openapi.alipay.com/gateway.do", "https://@openapi.alipay.com/gateway.do",
      "https://openapi.alipay.com:444/gateway.do", "https://openapi.alipay.com/gateway.do#checkout", "https://openapi.alipay.com/gateway.do#",
      "https://openapi.alipay.com/other", "https://openapi.alipay.com/gateway.do/", " https://openapi.alipay.com/gateway.do",
      "https://openapi.alipay.com/gateway.do?x=\n", "https://openapi.alipay.com\\@evil.example/gateway.do"]) {
      expect(h.officialCashierUrl(value), String(value)).toBeNull();
    }
  });

  it("恶意收银台地址不进入iframe或链接，page模式不会降级成图片二维码", async () => {
    const h = harness({ resumeOrderId: pendingOrder.id });
    await h.respond(0, options);
    await h.respond(1, { data: { order: { ...pageOrder, qrCodeDataUrl: pendingOrder.qrCodeDataUrl,
      cashierUrl: "https://user:password@openapi.alipay.com/gateway.do", fallbackCashierUrl: "https://openapi.alipay.com/gateway.do#redirect" } } });
    expect(h.text()).toContain("支付宝收银台暂不可用");
    expect(h.nodes().some(node => ["iframe", "img", "a"].includes(node.type))).toBe(false);
    expect(h.onPaid).not.toHaveBeenCalled();
  });

  it("先显示当前套餐和可用渠道，选择支付方式前不创建订单", async () => {
    const h = harness();
    expect(h.requests).toHaveLength(1);
    await h.respond(0, options);
    expect(h.text()).toContain("99.00");
    expect(h.text()).toContain("到账 1,200 积分");
    expect(h.button("请选择支付方式").props.disabled).toBe(true);
    h.click("支付宝扫码支付");
    expect(h.requests).toHaveLength(1);
    h.click("生成支付宝收款码");
    expect(h.requests[1].url).toBe("/api/model-gateway/checkout");
    expect(JSON.parse(h.requests[1].options.body!)).toEqual({ planCode: "starter", provider: "alipay" });
    await h.respond(1, { data: { order: pendingOrder } });
    expect(h.nodes().find(node => node.type === "img")?.props.src).toBe(pendingOrder.qrCodeDataUrl);
    expect(h.text()).toContain("请使用支付宝扫一扫");
    expect(h.text()).toContain("15:00");
  });

  it("未开通时禁用扫码渠道，仍可创建人工订单而不制造二维码", async () => {
    const h = harness();
    await h.respond(0, { data: { providers: [{ provider: "alipay", available: false }, { provider: "wechat", available: false }] } });
    expect(h.button("支付宝暂未开通").props.disabled).toBe(true);
    expect(h.button("微信支付暂未开通").props.disabled).toBe(true);
    expect(h.nodes().some(node => node.type === "img")).toBe(false);
    h.click("联系管理员 · 创建人工充值订单");
    expect(h.requests[1].url).toBe("/api/model-gateway/orders");
    expect(JSON.parse(h.requests[1].options.body!)).toEqual({ planCode: "starter" });
    await h.respond(1, { data: { order: { ...pendingOrder, paymentProvider: "manual", paymentUrl: "", qrCodeDataUrl: null, expiresAt: null } } });
    expect(h.text()).toContain("人工充值 · 等待确认");
    expect(h.text()).toContain("scan-order-1");
    await h.advance(5000);
    expect(h.requests).toHaveLength(2);
    h.click("我已完成支付");
    expect(h.requests[2].url).toBe("/api/model-gateway/orders/scan-order-1");
  });

  it("每 5 秒查询且不并发重复查询，只有服务端 paid 才刷新余额", async () => {
    const h = harness(); await h.respond(0, options);
    h.click("支付宝扫码支付"); h.click("生成支付宝收款码");
    await h.respond(1, { data: { order: pendingOrder } });
    await h.advance(4999); expect(h.requests).toHaveLength(2);
    await h.advance(1); expect(h.requests).toHaveLength(3);
    await h.advance(5000); expect(h.requests).toHaveLength(3);
    expect(h.onPaid).not.toHaveBeenCalled();
    await h.respond(2, { data: { order: { ...pendingOrder, status: "paid", paidAt: new Date().toISOString() } } });
    expect(h.text()).toContain("支付成功");
    expect(h.nodes().some(node => node.type === "img")).toBe(false);
    expect(h.onPaid).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveLength(1);
    await h.advance(10000); expect(h.requests).toHaveLength(3);
  });

  it("过期移除二维码但低频继续查询同一订单，迟到到账自动转成功", async () => {
    const h = harness(); await h.respond(0, options);
    h.click("支付宝扫码支付"); h.click("生成支付宝收款码");
    await h.respond(1, { data: { order: { ...pendingOrder, expiresAt: "2026-10-02T01:00:02.000Z" } } });
    await h.advance(2000);
    expect(h.text()).toContain("二维码已过期");
    expect(h.nodes().some(node => node.type === "img")).toBe(false);
    await h.advance(15000); expect(h.requests).toHaveLength(3);
    expect(h.requests[2].url).toBe("/api/model-gateway/checkout/scan-order-1");
    await h.respond(2, { data: { order: { ...pendingOrder, status: "paid" } } });
    expect(h.text()).toContain("支付成功");
    expect(h.onPaid).toHaveBeenCalledOnce();
  });

  it("付款页返回前台立即补查，focus与visibility及手动查询不会并发", async () => {
    const h = harness({ resumeOrderId: pendingOrder.id });
    await h.respond(0, options); await h.respond(1, { data: { order: pageOrder } });
    h.doc.visibilityState = "hidden"; h.listeners.get("visibilitychange")?.({});
    await h.advance(6000); expect(h.requests).toHaveLength(2);
    h.doc.visibilityState = "visible"; h.listeners.get("visibilitychange")?.({});
    h.windowListeners.get("focus")?.({}); h.render();
    expect(h.requests).toHaveLength(3);
    expect(h.button("查询中…").props.disabled).toBe(true);
    await h.respond(2, { data: { order: { ...pageOrder, status: "paid" } } });
    expect(h.text()).toContain("支付成功"); expect(h.nodes().some(node => node.type === "iframe")).toBe(false);
    expect(h.onPaid).toHaveBeenCalledOnce(); expect(h.events).toHaveLength(1);
  });

  it.each(["fetch", "body"])("%s悬挂有超时，释放查询状态后可再次核验到账", async phase => {
    const h = harness({ resumeOrderId: pendingOrder.id });
    await h.respond(0, options); await h.respond(1, { data: { order: pageOrder } });
    h.click("我已完成支付");
    if (phase === "body") {
      h.requests[2].resolve({ ok: true, status: 200, json: () => new Promise(() => {}) }); await h.settle();
    }
    await h.advance(15000);
    expect(h.requests[2].options.signal.aborted).toBe(true);
    expect(h.text()).toContain("查询超时");
    h.click("我已完成支付");
    await h.respond(3, { data: { order: { ...pageOrder, status: "paid" } } });
    expect(h.onPaid).toHaveBeenCalledOnce(); expect(h.text()).toContain("支付成功");
    await h.respond(2, { data: { order: pageOrder } });
    expect(h.text()).toContain("支付成功");
  });

  it("401保留原订单并隐藏付款入口，重新登录返回后只查单且不假报成功", async () => {
    const h = harness({ resumeOrderId: pendingOrder.id });
    await h.respond(0, options); await h.respond(1, { data: { order: pageOrder } });
    await h.advance(5000); await h.respond(2, { error: "未登录" }, false, 401);
    expect(h.text()).toContain("登录已失效"); expect(h.text()).toContain("请勿重复付款");
    expect(h.text()).toContain(pageOrder.id);
    expect(h.nodes().some(node => node.type === "iframe" || node.type === "img")).toBe(false);
    const login = h.nodes().find(node => node.type === "a" && node.props.href === "/login")!;
    expect(login.props.target).toBe("_blank"); expect(login.props.rel).toBe("noopener noreferrer");
    await h.advance(15000); expect(h.requests).toHaveLength(3); expect(h.onPaid).not.toHaveBeenCalled();
    h.windowListeners.get("focus")?.({}); h.render();
    expect(h.requests[3].url).toBe("/api/model-gateway/checkout/scan-order-1");
    await h.respond(3, { data: { order: { ...pageOrder, status: "paid" } } });
    expect(h.text()).toContain("支付成功"); expect(h.onPaid).toHaveBeenCalledOnce();
    expect(h.requests.every(request => !request.options.method)).toBe(true);
  });

  it("余额刷新失败不退回二维码或重复发到账事件", async () => {
    const onPaid = vi.fn().mockRejectedValue(new Error("账户刷新失败"));
    const h = harness({ resumeOrderId: pendingOrder.id, onPaid });
    await h.respond(0, options); await h.respond(1, { data: { order: pageOrder } });
    await h.advance(5000); await h.respond(2, { data: { order: { ...pageOrder, status: "paid" } } });
    expect(h.text()).toContain("支付成功"); expect(h.text()).toContain("余额刷新失败");
    expect(h.nodes().some(node => node.type === "iframe")).toBe(false);
    h.windowListeners.get("focus")?.({}); await h.advance(10000);
    expect(onPaid).toHaveBeenCalledOnce(); expect(h.events).toHaveLength(1);
  });

  it("服务端已付后等待余额刷新成功再自动关闭，无需再点完成", async () => {
    let finish!: () => void;
    const onPaid = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const h = harness({ resumeOrderId: pendingOrder.id, onPaid });
    await h.respond(0, options); await h.respond(1, { data: { order: { ...pageOrder, status: "paid" } } });
    expect(h.text()).toContain("支付成功"); expect(h.nodes().some(node => node.type === "iframe")).toBe(false);
    await h.advance(2000); expect(h.props.onClose).not.toHaveBeenCalled();
    finish(); await h.settle();
    await h.advance(1499); expect(h.props.onClose).not.toHaveBeenCalled();
    await h.advance(1); expect(h.props.onClose).toHaveBeenCalledOnce(); expect(h.text()).toBe("");
    expect(onPaid).toHaveBeenCalledOnce(); expect(h.events).toHaveLength(1);
  });

  it("无需onPaid回调也会自动关闭；同一已付订单再次打开重新刷新和自动返回", async () => {
    const h = harness({ resumeOrderId: pendingOrder.id, onPaid: undefined });
    await h.respond(0, options); await h.respond(1, { data: { order: { ...pageOrder, status: "paid" } } });
    await h.advance(1500); expect(h.props.onClose).toHaveBeenCalledOnce();
    h.props.open = true; h.render();
    await h.respond(2, options); await h.respond(3, { data: { order: { ...pageOrder, status: "paid" } } });
    expect(h.text()).toContain("支付成功");
    await h.advance(1500); expect(h.props.onClose).toHaveBeenCalledTimes(2);
    expect(h.events).toHaveLength(2); // Once per modal session, never per duplicate response.
  });

  it.each(["fetch", "body"])("恢复原订单的初次%s悬挂也会超时，随后自动重试同一订单", async phase => {
    const h = harness({ resumeOrderId: pendingOrder.id }); await h.respond(0, options);
    if (phase === "body") { h.requests[1].resolve({ ok: true, status: 200, json: () => new Promise(() => {}) }); await h.settle(); }
    await h.advance(15000); expect(h.requests[1].options.signal.aborted).toBe(true);
    await h.advance(5000); expect(h.requests[2].url).toBe("/api/model-gateway/checkout/scan-order-1");
    await h.respond(2, { data: { order: { ...pageOrder, status: "paid" } } });
    expect(h.onPaid).toHaveBeenCalledOnce(); expect(h.text()).toContain("支付成功");
    expect(h.requests.every(request => !request.options.method)).toBe(true);
  });

  it("付款后余额刷新悬挂也会超时，重试仅刷新账户且不重复到账事件", async () => {
    const onPaid = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(undefined);
    const h = harness({ resumeOrderId: pendingOrder.id, onPaid });
    await h.respond(0, options); await h.respond(1, { data: { order: { ...pageOrder, status: "paid" } } });
    await h.advance(15000); expect(h.text()).toContain("余额刷新失败");
    expect((onPaid.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    expect(h.props.onClose).not.toHaveBeenCalled(); expect(h.text()).toContain("支付成功");
    h.click("重试刷新账户"); await h.settle(); await h.advance(1500);
    expect(h.props.onClose).toHaveBeenCalledOnce(); expect(onPaid).toHaveBeenCalledTimes(2); expect(h.events).toHaveLength(1);
    expect(h.requests).toHaveLength(2);
  });

  it.each([401, 404, 503])("恢复原订单HTTP %i失败时保留原单，不退回创建订单", async status => {
    const h = harness({ resumeOrderId: pendingOrder.id }); await h.respond(0, options);
    await h.respond(1, { error: status === 401 ? "未登录" : "订单暂不可用" }, false, status);
    expect(h.text()).toContain(pendingOrder.id); expect(h.text()).toContain("请勿重复付款");
    expect(h.text()).not.toContain("生成支付宝收款码"); expect(h.text()).not.toContain("请选择支付方式");
    expect(h.requests.every(request => !request.options.method)).toBe(true);
    expect(h.onPaid).not.toHaveBeenCalled();
  });

  it("明确退出恢复后不再重查旧订单，旧响应不会覆盖新订单", async () => {
    const h = harness({ resumeOrderId: pendingOrder.id }); await h.respond(0, options);
    await h.respond(1, { data: { order: { ...pageOrder, status: "expired", expiresAt: "2026-10-02T00:59:00.000Z" } } });
    h.click("我已完成支付");
    await h.advance(15000); // Old query times out; its eventual network result is still deliberately released below.
    h.click("重新选择支付方式");
    await h.advance(16000); expect(h.requests).toHaveLength(3);
    h.click("支付宝扫码支付"); h.click("生成支付宝收款码");
    expect(h.requests[3].options.method).toBe("POST");
    await h.respond(3, { data: { order: { ...pageOrder, id: "new-order-2" } } });
    await h.respond(2, { data: { order: { ...pageOrder, status: "paid" } } });
    expect(h.text()).not.toContain("支付成功"); expect(h.onPaid).not.toHaveBeenCalled();
    await h.advance(5000); expect(h.requests[4].url).toBe("/api/model-gateway/checkout/new-order-2");
  });

  it("关闭后旧余额回调不会关闭新会话，旧paid查询不会覆盖新订单", async () => {
    let finish!: () => void;
    const onPaid = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const h = harness({ resumeOrderId: pendingOrder.id, onPaid });
    await h.respond(0, options); await h.respond(1, { data: { order: { ...pageOrder, status: "paid" } } });
    h.click("关闭收款弹窗"); h.props.open = true; Object.assign(h.props, { resumeOrderId: "scan-order-2" }); h.render();
    await h.respond(2, options); await h.respond(3, { data: { order: { ...pageOrder, id: "scan-order-2" } } });
    finish(); await h.settle(); await h.advance(1500);
    expect(h.props.onClose).toHaveBeenCalledOnce(); expect(h.text()).not.toContain("支付成功");
    expect(h.nodes().some(node => node.type === "iframe")).toBe(true);
  });

  it("手动查询 pending 不假报成功，网络错误可重试", async () => {
    const h = harness(); await h.respond(0, options);
    h.click("微信支付扫码支付"); h.click("生成微信支付收款码");
    await h.respond(1, { data: { order: { ...pendingOrder, paymentProvider: "wechat" } } });
    h.click("我已完成支付"); await h.respond(2, { data: { order: { ...pendingOrder, paymentProvider: "wechat" } } });
    expect(h.text()).toContain("尚未收到支付确认"); expect(h.onPaid).not.toHaveBeenCalled();
    h.click("我已完成支付"); await h.respond(3, { error: "支付结果查询失败，请重试。" }, false);
    expect(h.text()).toContain("支付结果查询失败");
    expect(h.button("我已完成支付").props.disabled).toBe(false);
  });

  it("关闭中止请求、恢复滚动及入口焦点，Escape 与 Tab 工作", async () => {
    const h = harness();
    expect(h.doc.body.style.overflow).toBe("hidden");
    expect(h.doc.activeElement).toBe(h.elements.get("关闭收款弹窗"));
    const tab = { key: "Tab", shiftKey: true, preventDefault: vi.fn() };
    h.listeners.get("keydown")?.(tab); expect(tab.preventDefault).toHaveBeenCalled();
    h.listeners.get("keydown")?.({ key: "Escape", preventDefault: vi.fn() });
    expect(h.props.onClose).toHaveBeenCalledOnce();
    expect(h.requests[0].options.signal.aborted).toBe(true);
    expect(h.doc.activeElement).toBe(h.trigger);
    expect(h.doc.body.style.overflow).toBe("auto");
    await h.respond(0, options); expect(h.text()).toBe("");
  });

  it("继续付款读取已有订单，不生成新订单；损坏二维码不给外部图片地址", async () => {
    const h = harness({ resumeOrderId: pendingOrder.id });
    expect(h.requests.map(request => request.url)).toEqual(["/api/model-gateway/checkout", "/api/model-gateway/checkout/scan-order-1"]);
    await h.respond(0, options);
    await h.respond(1, { data: { order: { ...pendingOrder, qrCodeDataUrl: "https://untrusted.example/qr.png" } } });
    expect(h.text()).toContain("收款码暂不可用");
    expect(h.nodes().some(node => node.type === "img")).toBe(false);
    expect(h.requests.every(request => !request.options.method)).toBe(true);
  });
});
