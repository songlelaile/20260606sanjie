vi.mock("server-only",()=>({}));
import { describe,it,expect,vi } from "vitest";
import { freezeGatewayLocalPricing,localGatewayCharge,validateGatewayLocalPricing } from "./local-pricing";
import {GATEWAY_MODELS} from "./catalog";
const H="a".repeat(64);
describe("durable local charge pricing",()=>{
 it("freezes token rates and rounds each component before local plan multiplier",()=>{
  const p=freezeGatewayLocalPricing(GATEWAY_MODELS[0],"chat.completions",{messages:[{role:"user",content:"中文"}],max_completion_tokens:1024});
  expect(localGatewayCharge(p,{schema:"SANJIE_LOCAL_CHARGE_V1",pricingHash:p.hash,outcomeHash:H,promptTokens:1000,completionTokens:1000,quantity:1,tokenSource:"reported",success:true})).toBe(8);
  expect(p.inputTokensEstimate).toBeGreaterThan(0);expect(p.version).toBe(1);
 });
 it("rejects repriced or unhashable stored prices and over-budget output",()=>{
  const p=freezeGatewayLocalPricing(GATEWAY_MODELS[0],"chat.completions",{messages:[],max_completion_tokens:10});
  expect(()=>validateGatewayLocalPricing({...p,promptCentsPer1K:999})).toThrow();
  expect(()=>localGatewayCharge(p,{schema:"SANJIE_LOCAL_CHARGE_V1",pricingHash:p.hash,outcomeHash:H,promptTokens:1,completionTokens:11,quantity:1,tokenSource:"reported",success:true})).toThrow();
 });
 it("charges accepted image quantity at frozen rate and rejects excess count",()=>{
  const p=freezeGatewayLocalPricing(GATEWAY_MODELS[1],"images.generations",{n:2});
  const e={schema:"SANJIE_LOCAL_CHARGE_V1" as const,pricingHash:p.hash,outcomeHash:H,promptTokens:0,completionTokens:0,quantity:1,tokenSource:"estimated" as const,success:true as const};
  expect(localGatewayCharge(p,e)).toBe(50);expect(()=>localGatewayCharge(p,{...e,quantity:3})).toThrow();
 });
});

describe("pricing serialization and evidence boundaries",()=>{
 it("survives PostgreSQL JSONB key ordering and refuses extra private fields",()=>{
  const p=freezeGatewayLocalPricing(GATEWAY_MODELS[1],"images.generations",{n:1});
  const reordered=Object.fromEntries(Object.entries(p).sort(([a],[b])=>a.localeCompare(b)));
  expect(validateGatewayLocalPricing(reordered)).toEqual(p);
  expect(()=>validateGatewayLocalPricing({...p,password:"must-not-store"})).toThrow();
 });
 it("cannot charge a shared chat estimate as reported token usage",()=>{
  const p=freezeGatewayLocalPricing(GATEWAY_MODELS[0],"chat.completions",{messages:[],max_completion_tokens:100});
  expect(()=>localGatewayCharge(p,{schema:"SANJIE_LOCAL_CHARGE_V1",pricingHash:p.hash,outcomeHash:H,promptTokens:1,completionTokens:1,quantity:1,tokenSource:"estimated",success:true})).toThrow();
 });
});
