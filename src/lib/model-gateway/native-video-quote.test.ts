import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { NativeVideoModel } from "./native-video-contract";
import type { GatewayBillingSnapshot } from "./billing-contract";
import { nativeSubmissionBaseQuote, nativeModelSubmissionQuotes, issueNativeSubmissionQuote, verifyNativeSubmissionQuote } from "./native-video-quote";

const model: NativeVideoModel = { id:"seedance-2.0",label:"fixture",upstreamModel:"fixture",priceVersion:"fixture-v1",
  completionCentsPerMillion:4600,reservationCents:1000,durations:[5,10,15],resolutions:["480p","720p","1080p"],ratios:["16:9","9:16","adaptive"],generateAudio:true,mediaHosts:["media.example.com"] };
const tariff = { priceVersion:"fixture-v1",completionCentsPerMillion:4600,reservationCents:1000,mediaHosts:["media.example.com"] };
const owner = {id:"fixture",tenantId:"tenant",username:"fixture"};
const snapshot: GatewayBillingSnapshot = {userId:owner.id,tenantId:owner.tenantId,username:owner.username,userName:"Fixture",tenantName:"Fixture",planCode:"free",planName:"Fixture",multiplierBps:10000,ruleVersion:1,quotedAt:"2026-10-11T00:00:00Z"};
const fingerprint = "a".repeat(64);
describe("native fixed submission quote", () => {
  beforeEach(()=>{ vi.stubEnv("SESSION_SECRET","fixture-only-signing-secret-123456789"); });
  afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();});
  it("quotes requested output from its explicit tariff, not the old 100-point reserve",()=>{
    expect(nativeSubmissionBaseQuote(model,{duration:5,resolution:"720p",ratio:"16:9"},tariff)).toBe(497);
    expect(nativeSubmissionBaseQuote({...model,reservationCents:9999},{duration:5,resolution:"720p",ratio:"16:9"},{...tariff,reservationCents:9999})).toBe(497);
  });
  it("duration/resolution changes affect the fixed quote",()=>{
    expect(nativeSubmissionBaseQuote(model,{duration:10,resolution:"720p",ratio:"9:16"},tariff)).toBe(994);
    expect(nativeSubmissionBaseQuote(model,{duration:5,resolution:"1080p",ratio:"16:9"},tariff)).toBe(1118);
  });
  it("pins adaptive to a published maximum area instead of guessing an uploaded image's size",()=>{
    expect(nativeSubmissionBaseQuote(model,{duration:5,resolution:"720p",ratio:"adaptive"},tariff)).toBe(500);
  });
  it("quotes the production mini model from its own resolution and reference tariff",()=>{
    const mini: NativeVideoModel = {...model,id:"seedance-2.0-mini",resolutions:["720p"],ratios:["16:9"],durations:[5],completionCentsPerMillion:undefined,
      priceTiers:[{resolution:"720p",hasVideoInput:false,completionCentsPerMillion:1000},{resolution:"720p",hasVideoInput:true,completionCentsPerMillion:2000}]};
    expect(nativeModelSubmissionQuotes(mini,snapshot)).toEqual([
      {duration:5,resolution:"720p",ratio:"16:9",hasVideoInput:false,quoteCents:108,quotePoints:10.8},
      {duration:5,resolution:"720p",ratio:"16:9",hasVideoInput:true,quoteCents:216,quotePoints:21.6}
    ]);
  });
  it("refuses an unpriced output size or duration",()=>{
    expect(()=>nativeSubmissionBaseQuote(model,{duration:5,resolution:"8k",ratio:"16:9"},tariff)).toThrow();
    expect(()=>nativeSubmissionBaseQuote(model,{duration:7,resolution:"720p",ratio:"16:9"},tariff)).toThrow();
  });
  it("issues only a public price and a bounded owner/request-bound signature",()=>{
    const quote = issueNativeSubmissionQuote(owner,fingerprint,tariff,snapshot,497);
    expect(quote).toMatchObject({billingMode:"prepaid_quote",quoteCents:497,quotePoints:49.7,refundOnFailure:true,refundOnCancel:false,adjustmentOnSuccess:false});
    expect(()=>verifyNativeSubmissionQuote(quote.quoteToken,owner,fingerprint,tariff,snapshot,497)).not.toThrow();
    expect(JSON.stringify(quote)).not.toContain("completionCentsPerMillion");
  });
  it.each(["user","request","tariff","rule","amount"])("rejects a changed %s before charge",(field)=>{
    const quote=issueNativeSubmissionQuote(owner,fingerprint,tariff,snapshot,497);
    expect(()=>verifyNativeSubmissionQuote(quote.quoteToken,field==="user"?{...owner,id:"another"}:owner,field==="request"?"b".repeat(64):fingerprint,field==="tariff"?{...tariff,priceVersion:"v2"}:tariff,field==="rule"?{...snapshot,ruleVersion:2}:snapshot,field==="amount"?498:497)).toThrow();
  });
  it("rejects a tampered or expired signed quote",()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
    const quote=issueNativeSubmissionQuote(owner,fingerprint,tariff,snapshot,497);
    expect(()=>verifyNativeSubmissionQuote(quote.quoteToken.slice(0,-1)+"x",owner,fingerprint,tariff,snapshot,497)).toThrow();
    vi.advanceTimersByTime(300001);
    expect(()=>verifyNativeSubmissionQuote(quote.quoteToken,owner,fingerprint,tariff,snapshot,497)).toThrow();
  });
});
