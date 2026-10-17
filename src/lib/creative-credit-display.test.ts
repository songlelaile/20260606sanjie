import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { estimateCreativeCreditRequests, type CreativeCreditsData } from "@/lib/creative-credit-contract";

const script = (name: string) => readFileSync(resolve("public/creative", name), "utf8");
function fixture(multiplierBps = 10001): CreativeCreditsData {
  return {
    wallet: { balanceCents: 12000, balancePoints: 1200, exists: true },
    plan: { code: "starter", name: "入门", multiplierBps, ruleVersion: 3 }, centsPerPoint: 10,
    catalogError: null, observedAt: "2026-10-02T10:00:00.000Z", models: [
      { id: "image-public", upstreamModel: "image-provider", label: "图片", provider: "test", kind: "image", endpoint: "images.generations", imageCents: 50,
        unit: "image", unitCents: 51, unitPoints: 5.1, promptPointsPer1K: null, completionPointsPer1K: null, pricingStatus: "priced" },
      { id: "video-public", upstreamModel: "video-provider", label: "视频", provider: "test", kind: "video", endpoint: "videos", videoCents: 100,
        unit: "accepted_task", unitCents: 101, unitPoints: 10.1, promptPointsPer1K: null, completionPointsPer1K: null, pricingStatus: "priced" },
      { id: "chat-public", upstreamModel: "chat-provider", label: "聊天", provider: "test", kind: "chat", endpoint: "chat.completions", promptCentsPer1K: 1, completionCentsPer1K: 2,
        unit: "tokens", unitCents: null, unitPoints: null, promptPointsPer1K: .2, completionPointsPer1K: .3, pricingStatus: "priced" }
    ]
  };
}

class Node {
  children: Node[] = [];
  parentNode: Node | null = null;
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  textContent = "";
  title = "";
  className = "";
  hidden = false;
  isConnected = true;
  constructor(readonly tag = "button") {}
  appendChild(node: Node) {
    if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((item) => item !== node);
    this.children.push(node); node.parentNode = this;
  }
  insertBefore(node: Node, next: Node) {
    if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((item) => item !== node);
    this.children.splice(this.children.indexOf(next), 0, node); node.parentNode = this;
  }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((item) => item !== this); this.parentNode = null; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
}
type Spec = { kind: string; model?: string; count?: number; requests?: number[]; channel?: string; extraAnalysis?: boolean; detail?: string; reservationPoints?: number; perRequestReservation?: boolean; billingMode?: string };
type Quote = { text: string; detail: string; estimatedPoints?: number; platformPoints?: number };
function harness(response: () => Promise<Response> = async () => Response.json({ data: fixture() })) {
  let now = 1000;
  const messages = new Map<string, (event: Record<string, unknown>) => void>();
  const created: Node[] = [];
  const parent = {};
  const fetch = vi.fn(response);
  const observers: Array<{ target?: Node; options?: unknown; callback: () => void; disconnected: boolean }> = [];
  const getComputedStyle = vi.fn((node: Node) => ({
    display: node.className === 'route-css-hidden' ? 'none' : node.style.display || 'inline-block',
    visibility: node.style.visibility || 'visible'
  }));
  const context = createContext({
    console, Promise, Map, Set, Number, BigInt, Response, setTimeout, clearTimeout, fetch, getComputedStyle,
    Date: class extends Date { static now() { return now; } },
    location: { origin: "https://fixture.test" }, parent,
    document: { readyState: "loading", addEventListener: vi.fn(), createElement: (tag: string) => { const node = new Node(tag); created.push(node); return node; } },
    addEventListener: (name: string, listener: (event: Record<string, unknown>) => void) => messages.set(name, listener),
    MutationObserver: class {
      record: typeof observers[number];
      constructor(callback: () => void) { this.record = { callback, disconnected: false }; observers.push(this.record); }
      observe(target: Node, options: unknown) { Object.assign(this.record, { target, options }); }
      disconnect() { this.record.disconnected = true; }
    }
  });
  context.window = context;
  runInContext(script("credit-display.js"), context);
  const api = context.SZCreativeCredits as {
    ready: () => Promise<unknown>; describe: (spec: Spec) => Quote; annotate: (button: Node, spec: Spec) => Node;
    update: (data: unknown) => boolean; subscribe: (callback: () => void) => () => void;
  };
  const button = () => { const host = new Node("div"), node = new Node(); host.appendChild(node); return { host, node }; };
  return { api, context, parent, messages, fetch, created, observers, button, getComputedStyle, advance: (ms: number) => { now += ms; } };
}

describe("creative credit display uses live prices without executing or charging a model", () => {
  it("loads only one same-origin, no-store read for concurrent ready calls", async () => {
    const h = harness();
    expect(h.api.describe({ kind: "image", model: "image-public", channel: "external_key" }).platformPoints).toBe(0);
    expect(h.fetch).not.toHaveBeenCalled();
    await Promise.all([h.api.ready(), h.api.ready(), h.api.ready()]);
    expect(h.fetch).toHaveBeenCalledExactlyOnceWith("/api/creative/credits", { credentials: "same-origin", cache: "no-store" });
  });

  it.each(["http", "network", "json"])("retries a failed %s read after five seconds and refreshes already registered annotations", async (failure) => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      if (calls > 1) return Response.json({ data: fixture(20000) });
      if (failure === "network") throw new Error("fixture unavailable");
      if (failure === "json") return new Response("invalid JSON", { status: 200 });
      return new Response(null, { status: 503 });
    });
    const { node } = h.button();
    const note = h.api.annotate(node, { kind: "image", model: "image-public", channel: "platform_wallet" });
    expect(await h.api.ready()).toBeNull();
    expect(note.textContent).not.toContain("平台演示预计");
    for (let i = 0; i < 10; i += 1) h.api.annotate(node, { kind: "image", model: "image-public", channel: "platform_wallet" });
    await h.api.ready(); expect(h.fetch).toHaveBeenCalledTimes(1);
    h.advance(4999); await h.api.ready(); expect(h.fetch).toHaveBeenCalledTimes(1);
    h.advance(1); await Promise.all([h.api.ready(), h.api.ready()]);
    expect(h.fetch).toHaveBeenCalledTimes(2); expect(note.textContent).toContain("提交扣 10 积分");
    h.advance(10000); await h.api.ready(); expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("clears stale prices on a parent refresh failure, ignores an older fetch, and allows later recovery", async () => {
    let finish!: (response: Response) => void, calls = 0;
    const h = harness(async () => {
      calls += 1;
      if (calls > 1) return Response.json({ data: fixture(20000) });
      return new Promise((resolveResponse) => { finish = resolveResponse; });
    });
    const ready = h.api.ready(); await Promise.resolve();
    h.api.update(fixture());
    expect(h.api.describe({ kind: "image", model: "image-public", channel: "preview" }).estimatedPoints).toBe(5.1);
    h.api.update(null);
    finish(Response.json({ data: fixture() })); await ready;
    expect(h.api.describe({ kind: "image", model: "image-public", channel: "preview" }).estimatedPoints).toBeUndefined();
    await h.api.ready(); expect(h.fetch).toHaveBeenCalledTimes(1);
    h.advance(5000); await h.api.ready();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.api.describe({ kind: "image", model: "image-public", channel: "preview" }).estimatedPoints).toBe(10);
  });

  it.each([[1, 1], [2], [4, 4, 2]])("rounds each real image request %j before summing", async (...counts) => {
    const requests = counts as number[];
    const h = harness(); await h.api.ready();
    const dto = fixture();
    const quote = h.api.describe({ kind: "image", model: "image-public", requests, channel: "preview" });
    const expected = estimateCreativeCreditRequests("preview", dto.models[0], requests.map((imageCount) => ({ imageCount })), dto.plan);
    expect(quote.estimatedPoints).toBe(expected.points);
    expect(quote.platformPoints).toBe(0);
    expect(quote.text).toContain("不扣积分");
  });

  it("distinguishes two singles from one two-image request, and never double applies DTO unitPoints", async () => {
    const h = harness(); await h.api.ready();
    const spec = { kind: "image", model: "image-provider", channel: "preview" };
    expect(h.api.describe({ ...spec, requests: [1, 1] })).toMatchObject({ estimatedPoints: 10.2, platformPoints: 0 });
    expect(h.api.describe({ ...spec, requests: [2] })).toMatchObject({ estimatedPoints: 10.1, platformPoints: 0 });
    expect(h.api.describe({ ...spec, count: 1 }).text).toContain("平台演示预计 5.1 积分");
  });

  it("quotes platform submissions and shows personal API billing without an unrelated platform estimate", async () => {
    const h = harness(); await h.api.ready();
    expect(h.api.describe({ kind: "image", model: "image-public", channel: "platform_wallet" })).toMatchObject({ estimatedPoints: 5.1, platformPoints: 5.1 });
    expect(h.api.describe({ kind: "image", model: "image-public", channel: "external_key" })).toMatchObject({ text: "自有 API 计费", platformPoints: 0 });
    expect(h.api.describe({ kind: "image", model: "image-public", channel: "external_key" }).estimatedPoints).toBeUndefined();
    expect(h.api.describe({ kind: "local", detail: "本地拼接" })).toMatchObject({ estimatedPoints: 0, platformPoints: 0 });
  });

  it("never substitutes the first configured model, an ambiguous alias, wrong kind, or missing price", async () => {
    const h = harness(); await h.api.ready();
    for (const model of ["", "unknown", "video-public"]) {
      const quote = h.api.describe({ kind: "image", model, channel: "platform_wallet" });
      expect(quote.estimatedPoints).toBeUndefined(); expect(quote.detail).toContain("价格待配置");
    }
    const dto = fixture(); dto.models.push({ ...dto.models[0], id: "image-second" });
    h.api.update(dto);
    expect(h.api.describe({ kind: "image", model: "image-provider", channel: "preview" }).estimatedPoints).toBeUndefined();
    expect(h.api.describe({ kind: "image", model: "image-public", channel: "preview" }).estimatedPoints).toBe(5.1);
    dto.models[0].pricingStatus = "unpriced";
    h.api.update(dto);
    expect(h.api.describe({ kind: "image", model: "image-public", channel: "preview" }).estimatedPoints).toBeUndefined();
  });

  it("matches the gateway's image minimum one cent even for an explicit zero image base", () => {
    const h = harness(), dto = fixture(10000); dto.models[0].imageCents = 0; h.api.update(dto);
    expect(h.api.describe({ kind: "image", model: "image-public", requests: [1, 4], channel: "preview" }).estimatedPoints).toBe(.2);
    dto.models[1].videoCents = 0; h.api.update(dto);
    expect(h.api.describe({ kind: "video", model: "video-public", channel: "preview" }).estimatedPoints).toBeUndefined();
  });

  it("rejects impossible, inconsistent, or overflowing image batches without inventing zero", async () => {
    const h = harness(); await h.api.ready();
    for (const input of [{ count: 20 }, { count: -1 }, { requests: [0] }, { requests: [11] }, { count: 3, requests: [1, 1] }, { requests: Array(1001).fill(1) }]) {
      expect(h.api.describe({ kind: "image", model: "image-public", channel: "preview", ...input }).estimatedPoints).toBeUndefined();
    }
    const dto = fixture(1000000); dto.models[0].imageCents = 2147483647; h.api.update(dto);
    expect(h.api.describe({ kind: "image", model: "image-public", channel: "preview" }).estimatedPoints).toBeUndefined();
  });

  it("does not invent a fixed chat/analysis total and keeps separately billed analysis explicit", async () => {
    const h = harness(); await h.api.ready();
    const chat = h.api.describe({ kind: "chat", model: "chat-public", channel: "platform_wallet" });
    expect(chat.estimatedPoints).toBeUndefined(); expect(chat.platformPoints).toBeUndefined();
    expect(chat.text).toContain("输入 0.2 / 输出 0.3 积分/千 Token");
    expect(chat.detail).toContain("按输入与输出上限报价"); expect(chat.detail).toContain("输入 0.2、输出 0.3");
    const image = h.api.describe({ kind: "image", model: "image-public", count: 1, extraAnalysis: true, channel: "preview" });
    expect(image.estimatedPoints).toBe(5.1); expect(image.detail).toContain("未计入图片或视频报价");
  });

  it("updates one annotation in place after ready and plan changes, with safe plain text and hidden tracking", async () => {
    const h = harness(), { node, host } = h.button();
    node.hidden = true;
    const small = h.api.annotate(node, { kind: "image", model: "image-public", channel: "platform_wallet", detail: "<b>分片说明</b>" });
    expect(small.textContent).toContain("本次积分待确认"); expect(node.parentNode?.style.display).toBe("none");
    expect(h.observers[0].options).toEqual({ attributes: true, attributeFilter: ["hidden", "style", "class", "aria-hidden"] });
    await h.api.ready(); expect(small.textContent).toContain("提交扣 5.1 积分");
    node.hidden = false; h.observers[0].callback(); expect(node.parentNode?.style.display).toBe("inline-flex");
    h.api.annotate(node, { kind: "image", model: "image-public", requests: [1, 1], channel: "preview", detail: "<b>分片说明</b>" });
    expect(host.children).toHaveLength(1); expect(node.parentNode?.children).toEqual([node, small]); expect(h.created).toHaveLength(2);
    expect(small.textContent).toContain("<b>分片说明</b>");
    h.api.update(fixture(20000)); expect(small.textContent).toContain("20 积分");
    node.isConnected = false; h.api.update(fixture()); expect(h.observers[0].disconnected).toBe(true);
  });

  it("accepts only same-origin parent messages and lets a fresh parent DTO win over an older fetch", async () => {
    let finish!: (response: Response) => void;
    const h = harness(() => new Promise((resolveResponse) => { finish = resolveResponse; }));
    const ready = h.api.ready(); await Promise.resolve();
    const listener = h.messages.get("message")!;
    const data = { type: "SZ_CREATIVE_CREDITS_UPDATE", v: 1, data: fixture(20000) };
    listener({ source: {}, origin: "https://fixture.test", data });
    listener({ source: h.parent, origin: "https://other.test", data });
    expect(h.api.describe({ kind: "image", model: "image-public", channel: "preview" }).estimatedPoints).toBeUndefined();
    listener({ source: h.parent, origin: "https://fixture.test", data });
    finish(Response.json({ data: fixture(10000) })); await ready;
    expect(h.api.describe({ kind: "image", model: "image-public", channel: "preview" }).estimatedPoints).toBe(10);
    expect(h.api.update({ ...fixture(), centsPerPoint: 100 })).toBe(false);
    expect(h.api.describe({ kind: "image", model: "image-public", channel: "preview" }).estimatedPoints).toBeUndefined();
  });

  it("does not write real or simulated ledgers or attach model-generation clicks", async () => {
    const h = harness(); const { node } = h.button();
    h.api.annotate(node, { kind: "video", model: "video-public", channel: "external_key" }); await h.api.ready();
    expect([...h.messages.keys()]).toEqual(["message"]);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(script("credit-display.js")).not.toMatch(/localStorage|sessionStorage|postMessage|addEventListener\(['"]click/);
  });

  it("removes captions and wrappers when a submit changes to navigation or an unknown action", async () => {
    const h = harness(); const { node, host } = h.button(), next = new Node("section");
    const small = h.api.annotate(node, { kind: "image", model: "image-public", channel: "platform_wallet" }); await h.api.ready();
    next.appendChild(node);
    h.api.annotate(node, { kind: "image", model: "image-public", channel: "platform_wallet" });
    expect(host.children).toHaveLength(0); expect(next.children).toHaveLength(1);
    expect(node.parentNode?.children).toEqual([node, small]); expect(h.created).toHaveLength(2);
    expect(h.api.annotate(node, { kind: "local" })).toBeNull();
    expect(next.children).toEqual([node]); expect(h.observers[0].disconnected).toBe(true);
    expect(h.api.annotate(node, { kind: "unknown" })).toBeNull();
    expect(h.api.describe({ kind: "unknown" }).text).toBe("");
  });

  it("never wraps local, unknown or empty generation actions or reads their pricing", async () => {
    const h = harness(), { node, host } = h.button();
    for (const spec of [{ kind: "local" }, { kind: "unknown" }, { kind: "image", requests: [] }, { kind: "video", count: 0 }]) {
      expect(h.api.annotate(node, spec)).toBeNull();
      expect(h.api.describe(spec).text).toBe("");
    }
    await Promise.resolve();
    expect(host.children).toEqual([node]); expect(h.created).toHaveLength(0); expect(h.fetch).not.toHaveBeenCalled();
  });

  it("keeps analysis visible when a combined action has no images left without quoting zero", async () => {
    const h = harness(); await h.api.ready();
    const quote = h.api.describe({ kind: "image", model: "image-public", requests: [], extraAnalysis: true, channel: "platform_wallet" });
    expect(quote.text).toBe("分析按报价提交扣积分"); expect(quote.estimatedPoints).toBeUndefined();
  });

  it("shows verified native reservations without presenting them as the final charge", async () => {
    const h = harness(); await h.api.ready();
    expect(h.api.describe({ kind: "video", channel: "platform_wallet", billingMode: "reservation", reservationPoints: 30 } as Spec)).toMatchObject({ text: "提交预占 30 积分" });
    const quote = h.api.describe({ kind: "video", count: 3, channel: "platform_wallet", billingMode: "reservation", reservationPoints: 30, perRequestReservation: true } as Spec);
    expect(quote.text).toBe("每镜最多预占 30 积分"); expect(quote.detail).toContain("预占不代表最终费用");
    for (const reservationPoints of [0, .01, -1, Infinity, 214748365]) expect(h.api.describe({ kind: "video", channel: "platform_wallet", reservationPoints } as Spec).text).toBe("本次积分待确认");
  });

  it("hides annotations with CSS-hidden buttons and restores them after class/style adaptation without checking ancestors", async () => {
    const h = harness(), { node, host } = h.button(), spec = { kind: "image", model: "image-public", channel: "platform_wallet" };
    node.className = "route-css-hidden";
    h.api.annotate(node, spec); await h.api.ready();
    expect(node.parentNode?.style.display).toBe("none");
    expect(node.hidden).toBe(false);
    node.className = ""; h.api.annotate(node, spec);
    expect(node.parentNode?.style.display).toBe("inline-flex");
    host.style.display = "none"; h.api.annotate(node, spec);
    expect(node.parentNode?.style.display).toBe("inline-flex");
    host.style.display = "block"; h.api.annotate(node, spec);
    expect(node.parentNode?.style.display).toBe("inline-flex");
    node.style.visibility = "hidden"; h.observers[0].callback();
    expect(node.parentNode?.style.display).toBe("none");
    node.style.visibility = "visible"; h.observers[0].callback();
    expect(node.parentNode?.style.display).toBe("inline-flex");
    node.setAttribute("aria-hidden", "true"); h.observers[0].callback();
    expect(node.parentNode?.style.display).toBe("none");
    node.setAttribute("aria-hidden", "false"); h.observers[0].callback();
    expect(node.parentNode?.style.display).toBe("inline-flex");
    expect(h.getComputedStyle.mock.calls.every(([button]) => button === node)).toBe(true);
  });

  it("cleans disconnected annotations and observers on later renders even while the quote cache remains valid", async () => {
    const h = harness(), first = h.button();
    h.api.annotate(first.node, { kind: "image", model: "image-public", channel: "platform_wallet" }); await h.api.ready();
    first.node.isConnected = false;
    const next = h.button(); h.api.annotate(next.node, { kind: "image", model: "image-public", channel: "platform_wallet" });
    expect(h.observers[0].disconnected).toBe(true);
    expect(first.host.children).toEqual([first.node]);
    expect(h.observers[1].disconnected).toBe(false);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("video studio credit annotations follow the actual action", () => {
  async function video() {
    const h = harness(); await h.api.ready();
    h.context.SZEcommerceVideoStore = {};
    runInContext(script("labs/ecommerce-video-studio/video-studio-contract.js"), h.context);
    const source = script("labs/ecommerce-video-studio/video-studio.js");
    const marker = "  if (globalThis.__SZ_VIDEO_STUDIO_EXPOSE_TESTING__ === true) {";
    runInContext(source.replace(marker, "  globalThis.__creditVideoTest = {state:state,dom:dom,estimate:updateEstimate,label:updatePrimaryActionLabel,retry:retryCreditSpec,production:productionCreditSpec,resume:productionRunCreditSpec};\n" + marker), h.context);
    const api = h.context.__creditVideoTest;
    for (const name of ["primaryAction", "primaryActionLabel", "confirmReview", "retryJob", "reanalyze", "resetDraft", "addShot", "viewResult", "openApiSettings", "refreshCapabilities", "refreshHistory", "cancelJob", "creditEstimate", "estimateNote"]) api.dom[name] = h.button().node;
    api.state.modelCatalog = [{ productKey: "seedance-2.0", providerModel: "video-provider", providerModelConfigured: true, configured: true, creditsPerSecond: 999 }];
    return { h, api };
  }
  it("shows personal API billing at 4 and 30 seconds without an unrelated platform estimate", async () => {
    const { api } = await video();
    api.state.settings.durationSeconds = 4; api.estimate(); const first = api.dom.creditEstimate.textContent;
    api.state.settings.durationSeconds = 30; api.estimate();
    expect(api.dom.creditEstimate.textContent).toBe(first);
    expect(first).toBe("自有 API 计费"); expect(first).not.toContain("0 积分");
    expect(api.dom.estimateNote.textContent).toContain("API 服务计收");
  });
  it("quotes analysis but removes its caption when the action becomes review navigation", async () => {
    const { api } = await video();
    api.state.mode = "assist"; api.label();
    expect(api.dom.primaryAction.parentNode.children[1].textContent).toContain("自有 API 计费");
    api.state.review.state = "editing"; api.label();
    expect(api.dom.primaryAction.parentNode.children).toEqual([api.dom.primaryAction]);
    api.state.settings.productKey = "unknown"; api.estimate();
    expect(api.dom.creditEstimate.textContent).toBe("自有 API 计费");
  });
  it("quotes retries from the original provider-model receipt, not the currently selected model", async () => {
    const { h, api } = await video();
    expect(api.retry({ providerModel: "video-provider", purpose: "generation" })).toMatchObject({ model: "video-provider", kind: "video" });
    expect(h.api.describe(api.retry({ purpose: "generation" })).estimatedPoints).toBeUndefined();
    expect(api.retry({ providerModel: "chat-provider", purpose: "analysis" }).kind).toBe("chat");
  });
  it("shows native reservation points next to the actual submit and removes local controls' captions", async () => {
    const { api } = await video();
    Object.assign(api.state.modelCatalog[0], { nativePlatform: true, billingMode: "reservation", reservationCents: 300 });
    api.label();
    expect(api.dom.primaryAction.parentNode.children[1].textContent).toContain("提交预占 30 积分");
    expect(api.dom.confirmReview.parentNode.children[1].textContent).toContain("提交预占 30 积分");
    for (const name of ["resetDraft", "addShot", "viewResult", "openApiSettings", "refreshHistory", "cancelJob"]) {
      expect(api.dom[name].parentNode.children).toEqual([api.dom[name]]);
    }
  });
  it("quotes only reachable pending AI shots when continuing or retrying a production plan", async () => {
    const { h, api } = await video();
    Object.assign(api.state.modelCatalog[0], { nativePlatform: true, billingMode: "reservation", reservationCents: 300 });
    const plan = { shots: [
      { id: "done", kind: "ai", productKey: "seedance-2.0" },
      { id: "failed", kind: "ai", productKey: "seedance-2.0" },
      { id: "local", kind: "local" },
      { id: "pending", kind: "ai", productKey: "seedance-2.0" }
    ] };
    const run = { plan, shotRuns: [{ id: "done", status: "succeeded" }, { id: "failed", status: "failed" }, { id: "pending", status: "pending" }] };
    expect(api.resume(run)).toEqual({ kind: "local" });
    const retry = api.resume(run, "failed");
    expect(retry).toMatchObject({ kind: "video", count: 2, billingMode: "reservation", reservationPoints: 30, perRequestReservation: true });
    expect(h.api.describe(retry).text).toBe("每镜最多预占 30 积分");
    run.shotRuns[1].status = "succeeded";
    expect(api.resume(run)).toMatchObject({ count: 1, billingMode: "reservation", reservationPoints: 30 });
    run.shotRuns[2].status = "succeeded";
    expect(api.resume(run)).toEqual({ kind: "local" });
    expect(api.production({ shots: [{ kind: "local" }] })).toEqual({ kind: "local" });
  });
  it("loads shared submission quotes in the actual video page", () => {
    const html = script("labs/ecommerce-video-studio/video-studio.html");
    expect(html.indexOf('/creative/credit-display.js?')).toBeGreaterThan(0);
    expect(html.indexOf('/creative/credit-display.js?')).toBeLessThan(html.indexOf('src="./video-studio.js?'));
  });
});
