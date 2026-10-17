import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../public/creative/web-chrome.js", import.meta.url), "utf8");

function studio(nativeFetch: typeof fetch) {
  const context = vm.createContext({
    console, URL, Headers, Request, FormData, Blob, ArrayBuffer, Uint8Array, Promise, setTimeout, crypto: webcrypto, TextEncoder, TextDecoder,
    location: { href: "https://shaozhuangai.com/creative/studio.html", origin: "https://shaozhuangai.com" },
    localStorage: {}, sessionStorage: {}, fetch: nativeFetch
  });
  vm.runInContext(source, context);
  return context;
}

function forwardingFetch() {
  return vi.fn(async (url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    if (url === '/api/creative/billing/cancel') return Response.json({cancelled:true,providerCancelled:false,refundOnCancel:false});
    if (url === '/api/creative/billing/quote') return Response.json({ billingMode: 'prepaid_quote', quoteCents: 50 });
    void options;
    return url === "/api/auth/me"
      ? Response.json({ data: { tenantId: "tenant-a", username: "alice", creativeEntitlement: { allowed: true } } })
      : new Response("ok");
  });
}

describe("creative website Chrome compatibility", () => {
  it("renders this request's fixed quote before its real POST instead of a final-token adjustment",async()=>{
    const nativeFetch=forwardingFetch(),context=studio(nativeFetch);
    const nodes=new Map<string,{id?:string;textContent?:string;style:unknown;setAttribute:(key:string,value:string)=>void}>();
    context.document={getElementById:(id:string)=>nodes.get(id),createElement:()=>({style:{},setAttribute:vi.fn()}),body:{firstChild:null,insertBefore:(node:{id:string})=>nodes.set(node.id,node as never)}};
    const original=nativeFetch.getMockImplementation()!;
    nativeFetch.mockImplementation(async(url,init)=>{
      if(url==="/api/creative/proxy") expect(nodes.get("sz-submission-quote")?.textContent).toBe("本次文本/分析报价 5 积分 · 提交时扣，失败退回，取消不退");
      return original(url,init);
    });
    await context.fetch("https://sub.shaozhuangai.com/v1/chat/completions",{method:"POST",body:JSON.stringify({model:"chatGPT5.5",messages:[{role:"user",content:"private fixture"}]})});
    expect(nodes.get("sz-submission-quote")?.textContent).not.toContain("private fixture");
  });
  it("binds explicit cancellation to the submitted idempotency key while an ordinary abort has no billing meaning", async () => {
    const nativeFetch = forwardingFetch(), context = studio(nativeFetch), controller = new AbortController();
    const key = "c91c4e17-dcf0-42a1-8012-19beacbd0d88";
    await context.fetch("https://sub.shaozhuangai.com/v1/images/generations", {method:"POST",headers:{"Idempotency-Key":key},body:JSON.stringify({model:"image2",n:1}),signal:controller.signal,szExpectedAccount:"tenant-a:alice"});
    controller.abort(); expect(nativeFetch.mock.calls.filter(([url])=>url==="/api/creative/billing/cancel")).toHaveLength(0);
    await context.SZCreativeBilling.cancelSignal(controller.signal);
    const call = nativeFetch.mock.calls.find(([url])=>url==="/api/creative/billing/cancel")!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({idempotencyKey:key,expectedAccount:"tenant-a:alice"});
    expect(call[1]?.signal).toBeUndefined();
    const submission = nativeFetch.mock.calls.find(([url])=>url==="/api/creative/proxy")!;
    expect(JSON.parse(String(submission[1]?.body)).expectedQuoteCents).toBe(50);
  });
  it("does not quote or persist a charge cancellation for personal API calls", async () => {
    const nativeFetch=forwardingFetch(), context=studio(nativeFetch), controller=new AbortController();
    await context.fetch("https://sub.shaozhuangai.com/v1/images/generations",{method:"POST",headers:{Authorization:"Bearer personal-key"},body:JSON.stringify({model:"image2"}),signal:controller.signal});
    await context.SZCreativeBilling.cancelSignal(controller.signal);
    expect(nativeFetch.mock.calls.some(([url])=>String(url).includes("/billing/"))).toBe(false);
  });
  it("pins the page to its account and blocks a confirmed switch until a new page is opened", async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { tenantId: "tenant-a", username: "alice", creativeEntitlement: { allowed: true } } }))
      .mockResolvedValueOnce(Response.json({ data: { tenantId: "tenant-b", username: "bob", creativeEntitlement: { allowed: true } } }));
    const context = studio(nativeFetch);
    expect((await context.authCheck()).user.id).toBe("tenant-a:alice");
    const changed = await context.authCheck();
    expect(changed).toEqual({ ok: false, reason: "account_changed" });
    expect(changed.user).toBeUndefined();
    expect(await context.authCheck()).toEqual({ ok: false, reason: "account_changed" });
    expect(nativeFetch).toHaveBeenCalledTimes(2);

    const freshFetch = forwardingFetch();
    freshFetch.mockResolvedValueOnce(Response.json({ data: { tenantId: "tenant-b", username: "bob", creativeEntitlement: { allowed: true } } }));
    expect((await studio(freshFetch).authCheck()).user.id).toBe("tenant-b:bob");
  });

  it("fails closed after sign out without returning the previous identity", async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { tenantId: "tenant-a", username: "alice", creativeEntitlement: { allowed: true } } }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const context = studio(nativeFetch);
    expect((await context.authCheck()).user.id).toBe("tenant-a:alice");
    expect(await context.authCheck()).toEqual({ ok: false, reason: "auth_error" });
    expect(await context.authCheck()).toEqual({ ok: false, reason: "account_changed" });
    expect(nativeFetch).toHaveBeenCalledTimes(2);
  });

  it.each(["json", "multipart"])("preserves cancellation for %s proxy requests", async (kind) => {
    const nativeFetch = forwardingFetch();
    const context = studio(nativeFetch);
    const controller = new AbortController();
    const form = new FormData(); form.set("model", "image2");
    await context.fetch("https://sub.shaozhuangai.com/v1/images/generations", {
      method: "POST", body: kind === "json" ? JSON.stringify({model:"image2"}) : form, signal: controller.signal
    });
    const proxy = nativeFetch.mock.calls.find(([url]) => url === "/api/creative/proxy")!;
    expect(proxy).toBeTruthy();
    expect(proxy[1]?.signal?.aborted).toBe(false);
    controller.abort();
    expect(proxy[1]?.signal?.aborted).toBe(true);
  });

  it("preserves cancellation from a Request object", async () => {
    const nativeFetch = forwardingFetch();
    const context = studio(nativeFetch);
    const controller = new AbortController();
    const request = new Request("https://sub.shaozhuangai.com/v1/models", { signal: controller.signal });
    await context.fetch(request);
    const proxy = nativeFetch.mock.calls.find(([url]) => url === "/api/creative/proxy")!;
    expect(proxy).toBeTruthy();
    expect(proxy[1]?.signal?.aborted).toBe(false);
    controller.abort();
    expect(request.signal.aborted).toBe(true);
    expect(proxy[1]?.signal?.aborted).toBe(true);
  });
  it('selects personal API ahead of points and preserves its Authorization header', async () => {
    const nativeFetch=forwardingFetch(); const context=studio(nativeFetch);
    const config={provider:'openai-compatible',imageEndpoint:'https://sub.shaozhuangai.com/v1/images/generations',visionBaseUrl:'https://sub.shaozhuangai.com/v1',apiKey:'personal-example-key'};
    expect(context.SZ_WEB_SUPPLY.usesPlatformWallet(config,'image')).toBe(false);
    expect(context.SZ_WEB_SUPPLY.usesPlatformWallet(config,'chat')).toBe(false);
    await context.fetch(config.imageEndpoint,{method:'POST',headers:{Authorization:'Bearer personal-example-key'},body:'{}'});
    const proxy=nativeFetch.mock.calls.find(([url])=>url==='/api/creative/proxy')!;
    const payload=JSON.parse(String(proxy[1]!.body));
    expect(payload.headers.Authorization).toBe('Bearer personal-example-key');
    expect(payload.headers['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('uses points for the existing platform configuration when no personal API is saved', () => {
    const context=studio(forwardingFetch());
    const config={provider:'openai-compatible',imageEndpoint:'https://sub.shaozhuangai.com/v1/images/generations',visionBaseUrl:'https://sub.shaozhuangai.com/v1',apiKey:'  '};
    expect(context.SZ_WEB_SUPPLY.usesPlatformWallet(config,'image')).toBe(true);
    expect(context.SZ_WEB_SUPPLY.usesPlatformWallet(config,'chat')).toBe(true);
  });

});
