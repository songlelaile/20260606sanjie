import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls=vi.hoisted(()=>({snapshot:vi.fn(),model:vi.fn(),reserve:vi.fn(),dispatch:vi.fn(),bind:vi.fn(),settle:vi.fn(),usage:vi.fn(),refund:vi.fn()}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/model-gateway/store", () => ({ assertGatewayBalance: vi.fn(), recordGatewayUsage: calls.usage }));
vi.mock("@/lib/model-gateway/billing", () => ({ getGatewayBillingSnapshot: calls.snapshot }));
vi.mock("@/lib/model-gateway/runtime-catalog", () => ({ findAvailableGatewayModel: calls.model }));
vi.mock("@/lib/model-gateway/billing-hold", () => ({ isGatewaySharedBillingHold: vi.fn(async()=>false), refundGatewayBillingHold:calls.refund, reserveGatewayBillingHold: calls.reserve, markGatewayBillingHoldDispatched: calls.dispatch, bindGatewayBillingHoldCredential: calls.bind, markGatewayBillingHoldUnknown: vi.fn(), releaseGatewayBillingHold: vi.fn(), settleGatewayBillingHold: calls.settle }));

import { hostedSupplyKind, hostedVideoTaskId, readHostedSupplyRequest, replaceSupplyModel, reserveHostedSupply, markHostedSupplyDispatched, bindHostedSupplyCredential, settleHostedSupply } from "@/lib/model-gateway/hosted-supply";

import { GATEWAY_MODELS } from "./catalog";
import { centsToPoints } from "./billing-contract";

describe("hosted supply request classification", () => {
  it("bills only official generation posts and leaves polling alone", () => {
    expect(hostedSupplyKind("https://sub.shaozhuangai.com/v1/chat/completions", "POST")).toBe("chat.completions");
    expect(hostedSupplyKind("https://sub.shaozhuangai.com/v1/images/generations", "POST")).toBe("images.generations");
    expect(hostedSupplyKind("https://sub.shaozhuangai.com/v1/images/edits", "POST")).toBe("images.edits");
    expect(hostedSupplyKind("https://sub.shaozhuangai.com/v1/videos", "POST")).toBe("videos");
    expect(hostedSupplyKind("https://sub.shaozhuangai.com/v1/videos/task_1", "GET")).toBeNull();
    expect(hostedSupplyKind("https://api.openai.com/v1/chat/completions", "POST")).toBeNull();
  });

  it("reads the public model and rewrites the outbound body to the supply model", () => {
    const source = JSON.stringify({ model: "chatGPT5.5", messages: [{ role: "user", content: "你好" }] });
    expect(readHostedSupplyRequest({ bodyText: source }).modelName).toBe("chatGPT5.5");
    expect(JSON.parse(String(replaceSupplyModel(source, "gpt-5.6-sol")))).toMatchObject({
      model: "gpt-5.6-sol", messages: [{ role: "user", content: "你好" }]
    });
  });

  it.each([
    "https://sub.shaozhuangai.com/bypass/images/generations",
    "https://sub.shaozhuangai.com/v1/images/generations?model=image2",
    "https://sub.shaozhuangai.com/v1/images/generations#fragment",
    "http://sub.shaozhuangai.com/v1/images/generations",
    "https://user:password@sub.shaozhuangai.com/v1/images/generations",
    "https://sub.shaozhuangai.com:8443/v1/images/generations"
  ])("does not classify an unsafe or alternate path as a hosted generation (%s)", (url) => {
    expect(hostedSupplyKind(url, "POST")).toBeNull();
  });

  it.each([{ request_id: "video_1" }, { data: { task_id: "video_1" } }, { video: { id: "video_1" } }])("normalizes accepted video IDs for ownership (%j)", (data) => {
    expect(hostedVideoTaskId(data)).toBe("video_1");
  });

  it("does not allow path traversal in a video task ID", () => {
    expect(hostedVideoTaskId({ task_id: "../another-task" })).toBe("");
  });
});


describe("durable hosted FX quote settlement",()=>{
  const quote={userId:"u",tenantId:"t",username:"user",userName:"User",planCode:"growth",planName:"Growth",multiplierBps:10000,ruleVersion:1,quotedAt:"2026-10-02T16:05:00.000Z"};
  const fx={rate:7.2,source:"ecb" as const,referenceDate:"2026-10-02",fetchedAt:"2026-10-02T16:05:00.000Z",id:"f".repeat(64)};
  const request=()=>({user:{id:"u",username:"user"},kind:"chat.completions" as const,modelName:"chatGPT5.5",body:{messages:[{role:"user",content:"hi"}]},usdCnyRate:9,fxSnapshot:fx,baseUrl:"https://sub.shaozhuangai.com/v1"});
  const response=()=>({status:200,contentType:"application/json",bytes:new TextEncoder().encode(JSON.stringify({choices:[{message:{content:"ok"}}],usage:{actual_cost:0.01}}))});
  beforeEach(()=>{
    vi.resetAllMocks();vi.stubEnv("MODEL_GATEWAY_FX_AUTOMATIC","0");
    calls.snapshot.mockResolvedValue(quote);calls.model.mockResolvedValue(GATEWAY_MODELS[0]);
    calls.reserve.mockImplementation(async input=>({hold:{eventId:input.eventId,billingSnapshot:JSON.parse(JSON.stringify(input.billingSnapshot))},shouldDispatch:true,replayed:false}));
    calls.dispatch.mockImplementation(async input=>({hold:{eventId:input.eventId,billingSnapshot:calls.reserve.mock.calls.find(([value])=>value.eventId===input.eventId)![0].billingSnapshot},shouldDispatch:true}));
    calls.settle.mockImplementation(async input=>{const snapshot=calls.dispatch.mock.results.at(-1) ? (await calls.dispatch.mock.results.at(-1)!.value).hold.billingSnapshot : quote;await input.writeUsage({}, {billingSnapshot:snapshot,eventId:input.eventId});return{};});
  });
  afterEach(()=>vi.unstubAllEnvs());
  it("refunds confirmed failures while preserving positive supplier consumption",async()=>{
    const hold=await reserveHostedSupply(request());await markHostedSupplyDispatched(hold);
    const data={error:{message:"fixture rejection"},usage:{actual_cost:0.01}};
    await settleHostedSupply(hold,{status:400,contentType:"application/json",bytes:new TextEncoder().encode(JSON.stringify(data))});
    expect(calls.refund).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({userId:"u",eventId:hold.billingEventId,reason:"confirmed_failed"}));
    expect(calls.usage).toHaveBeenCalledWith(expect.objectContaining({status:"error",baseCostCents:8,costCents:8}),expect.anything());
    expect(calls.reserve).toHaveBeenCalledWith(expect.objectContaining({billingMode:"prepaid_quote"}));
  });
  it("survives JSON storage and a restart/day change without looking up live FX during settlement",async()=>{
    const hold=await reserveHostedSupply(request());await markHostedSupplyDispatched(hold);
    const restored=JSON.parse(JSON.stringify(hold));vi.stubEnv("MODEL_GATEWAY_FX_AUTOMATIC","1");vi.stubEnv("MODEL_GATEWAY_FX_CACHE_FILE","/nonexistent/test-only-fx");
    await expect(settleHostedSupply(restored,response())).resolves.toEqual({reject:false});
    const usage=calls.usage.mock.calls[0][0];expect(usage).toMatchObject({baseCostCents:8,costCents:8,billingSnapshot:{fxSnapshot:fx},metadata:{costSource:"upstream_usd",usdCnyRate:"7.2",fxQuoteId:fx.id}});expect(centsToPoints(usage.costCents)).toBe(0.8);
    expect(calls.snapshot).toHaveBeenCalledTimes(1);expect(calls.reserve).toHaveBeenCalledTimes(1);
  });
  it("durably binds the selected credential and records only the final id with the frozen quote",async()=>{
    const hold=await reserveHostedSupply(request());await markHostedSupplyDispatched(hold);
    await bindHostedSupplyCredential(hold,"u-primary");await bindHostedSupplyCredential(hold,"u-backup");
    expect(calls.bind.mock.calls.map(([value])=>value)).toEqual([
      {userId:"u",eventId:hold.billingEventId,credentialId:"u-primary"},
      {userId:"u",eventId:hold.billingEventId,credentialId:"u-backup"}
    ]);
    expect(hold.billingSnapshot.fxSnapshot).toEqual(fx);
    await settleHostedSupply(hold,response());
    expect(calls.settle).toHaveBeenCalledTimes(1);expect(calls.usage).toHaveBeenCalledTimes(1);
    expect(calls.usage.mock.calls[0][0]).toMatchObject({baseCostCents:8,metadata:{credentialId:"u-backup",usdCnyRate:"7.2"}});
  });
  it("uses DB reservation and dispatched quotes as the persisted authority",async()=>{
    calls.reserve.mockImplementation(async input=>({hold:{eventId:input.eventId,billingSnapshot:{...quote,fxSnapshot:{...fx,rate:7.1}}},shouldDispatch:true}));
    const hold=await reserveHostedSupply(request());expect(hold.billingSnapshot.fxSnapshot?.rate).toBe(7.1);
    const persisted={...quote,fxSnapshot:{...fx,rate:7}};calls.dispatch.mockResolvedValue({hold:{eventId:hold.billingEventId,billingSnapshot:persisted},shouldDispatch:true});await markHostedSupplyDispatched(hold);expect(hold.billingSnapshot).toEqual(persisted);
    await settleHostedSupply(hold,response());expect(calls.usage.mock.calls[0][0]).toMatchObject({baseCostCents:7,costCents:7,metadata:{usdCnyRate:"7"}});
  });
  it("keeps a legacy stored snapshot without FX on catalog settlement even when a new live rate exists",async()=>{
    const hold=await reserveHostedSupply(request());calls.dispatch.mockResolvedValue({hold:{eventId:hold.billingEventId,billingSnapshot:quote},shouldDispatch:true});await markHostedSupplyDispatched(hold);
    vi.stubEnv("MODEL_GATEWAY_FX_AUTOMATIC","1");await settleHostedSupply(JSON.parse(JSON.stringify(hold)),response());
    const usage=calls.usage.mock.calls[0][0];expect(usage).toMatchObject({baseCostCents:1,costCents:1,billingSnapshot:quote,metadata:{costSource:"catalog"}});expect(centsToPoints(usage.costCents)).toBe(0.1);expect(usage.metadata).not.toHaveProperty("usdCnyRate");expect(usage.metadata).not.toHaveProperty("fxQuoteId");
  });
});
