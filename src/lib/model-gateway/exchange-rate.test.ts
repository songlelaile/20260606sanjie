import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
vi.mock("server-only", () => ({}));
import { parseEcbXml } from "./exchange-rate-core.mjs";
import { readEffectiveExchangeRate, requireGatewayFxSnapshot, gatewayFxMetadata } from "./exchange-rate";
import { sanitizeGatewayFxSnapshot } from "./billing-contract";

const now=new Date("2026-10-03T01:00:00.000Z");
const xml=(cny="7.2",date="2026-10-02")=>`<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><gesmes:subject>Reference rates</gesmes:subject><gesmes:Sender><gesmes:name>European Central Bank</gesmes:name></gesmes:Sender><Cube><Cube time="${date}"><Cube currency="USD" rate="1"/><Cube currency="CNY" rate="${cny}"/></Cube></Cube></gesmes:Envelope>`;
let directory:string, file:string;
beforeEach(async()=>{directory=await mkdtemp(path.join(tmpdir(),"gateway-fx-app-"));file=path.join(directory,"fx.json");vi.stubEnv("MODEL_GATEWAY_FX_AUTOMATIC","1");vi.stubEnv("MODEL_GATEWAY_FX_CACHE_FILE",file);});
afterEach(async()=>{vi.unstubAllEnvs();await rm(directory,{recursive:true,force:true});});
const save=async(rate="7.2",fetched=now,date="2026-10-02")=>{const cache=parseEcbXml(xml(rate,date),fetched);await writeFile(file,JSON.stringify(cache));return cache;};

describe("fresh bounded server FX cache",()=>{
  it("reads changed cache on each new quote instead of memoizing",async()=>{
    const a=await save();expect(await readEffectiveExchangeRate(9,now)).toMatchObject({rate:7.2,view:{mode:"automatic",status:"ready",source:"ecb",id:a.id}});
    const b=await save("7.3");expect(await readEffectiveExchangeRate(9,now)).toMatchObject({rate:7.3,view:{id:b.id}});expect(b.id).not.toBe(a.id);
  });
  it("does not access a cache in manual mode and freezes a minimal manual snapshot",async()=>{
    vi.stubEnv("MODEL_GATEWAY_FX_AUTOMATIC","0");const result=await readEffectiveExchangeRate(7.2,now);
    expect(result).toEqual({rate:7.2,view:{mode:"manual",status:"ready",source:"manual",referenceDate:null,fetchedAt:null,id:null}});
    expect(requireGatewayFxSnapshot({usdCnyRate:result.rate,exchangeRate:result.view})).toEqual({rate:7.2,source:"manual",referenceDate:null,fetchedAt:null,id:null});
  });
  it.each(["missing","invalid-json","oversize","forged-id","extra-key"])("fails closed for %s without using the manual fallback",async(kind)=>{
    const cache=await save();if(kind==="missing")await rm(file);if(kind==="invalid-json")await writeFile(file,"{broken");if(kind==="oversize")await writeFile(file," ".repeat(16385));if(kind==="forged-id")await writeFile(file,JSON.stringify({...cache,id:"0".repeat(64)}));if(kind==="extra-key")await writeFile(file,JSON.stringify({...cache,apiKey:"test-only-secret"}));
    const effective=await readEffectiveExchangeRate(9,now);expect(effective.rate).toBeNull();expect(effective.view.status).toBe("unavailable");
    expect(()=>requireGatewayFxSnapshot({usdCnyRate:effective.rate,exchangeRate:effective.view})).toThrowError(expect.objectContaining({status:503}));
    expect(JSON.stringify(effective)).not.toContain("test-only-secret");
  });
  it("marks a cache older than36h stale but allows it until the72h hard boundary",async()=>{
    await save("7.2",new Date(now.getTime()-36*3600000-1),"2026-10-01");const stale=await readEffectiveExchangeRate(9,now);expect(stale).toMatchObject({rate:7.2,view:{status:"stale"}});expect(requireGatewayFxSnapshot({usdCnyRate:stale.rate,exchangeRate:stale.view})?.rate).toBe(7.2);
    await save("7.2",new Date(now.getTime()-72*3600000-1),"2026-09-30");const expired=await readEffectiveExchangeRate(9,now);expect(expired).toMatchObject({rate:null,view:{status:"unavailable",errorCode:"FX_CACHE_STALE"}});
  });
  it("rejects an expired published reference date even after a recent fetch",async()=>{
    const original=parseEcbXml(xml("7.2","2026-09-25"),new Date("2026-09-25T12:00:00.000Z"));await writeFile(file,JSON.stringify({...original,fetchedAt:now.toISOString()}));
    expect(await readEffectiveExchangeRate(9,now)).toMatchObject({rate:null,view:{status:"unavailable",errorCode:"FX_CACHE_STALE"}});
  });
  it("allows valid weekend data, but makes a matching failed refresh visible",async()=>{
    const cache=await save();await writeFile(file+".status.json",JSON.stringify({version:1,cacheId:cache.id,fetchedAt:cache.fetchedAt,attemptedAt:now.toISOString(),success:false,errorCode:"FX_FETCH_FAILED"}));
    const result=await readEffectiveExchangeRate(9,now);expect(result).toMatchObject({rate:7.2,view:{status:"stale",errorCode:"FX_FETCH_FAILED"}});
    expect(requireGatewayFxSnapshot({usdCnyRate:result.rate,exchangeRate:result.view})).toMatchObject({rate:7.2,source:"ecb",id:cache.id});
  });
  it.each(["wrong-id","older-attempt","future-attempt","unknown-error","extra","bad-json"])("ignores untrusted refresh status %s",async(kind)=>{
    const cache=await save();const status:Record<string,unknown>={version:1,cacheId:cache.id,fetchedAt:cache.fetchedAt,attemptedAt:now.toISOString(),success:false,errorCode:"FX_FETCH_FAILED"};
    if(kind==="wrong-id")status.cacheId="0".repeat(64);if(kind==="older-attempt")status.attemptedAt="2026-10-02T00:00:00.000Z";if(kind==="future-attempt")status.attemptedAt="2026-10-04T00:00:00.000Z";if(kind==="unknown-error")status.errorCode="Bearer secret";if(kind==="extra")status.private="secret";
    await writeFile(file+".status.json",kind==="bad-json"?"{bad":JSON.stringify(status));expect(await readEffectiveExchangeRate(9,now)).toMatchObject({rate:7.2,view:{status:"ready"}});
  });
  it("normalizes a valid cache instant without milliseconds into a canonical frozen instant",async()=>{
    const cache=await save();await writeFile(file,JSON.stringify({...cache,fetchedAt:cache.fetchedAt.replace(".000Z","Z")}));const effective=await readEffectiveExchangeRate(9,now);
    expect(requireGatewayFxSnapshot({usdCnyRate:effective.rate,exchangeRate:effective.view})?.fetchedAt).toBe(now.toISOString());
  });
  it("maps a cross rate outside the billing numeric contract to a fixed503 and no snapshot",async()=>{
    await save("1001");const effective=await readEffectiveExchangeRate(9,now);
    expect(()=>requireGatewayFxSnapshot({usdCnyRate:effective.rate,exchangeRate:effective.view})).toThrowError(expect.objectContaining({code:"FX_RATE_UNAVAILABLE",status:503}));
  });
  it("freezes only public provenance and permits historical validation after cache expiry",async()=>{
    const cache=await save();const effective=await readEffectiveExchangeRate(9,now);const frozen=requireGatewayFxSnapshot({usdCnyRate:effective.rate,exchangeRate:effective.view})!;
    const stored=JSON.parse(JSON.stringify({...frozen,apiKey:"test-only-secret",sourceUrl:"http://evil"}));
    expect(sanitizeGatewayFxSnapshot(stored)).toEqual({rate:7.2,source:"ecb",referenceDate:cache.referenceDate,fetchedAt:cache.fetchedAt,id:cache.id});
    expect(gatewayFxMetadata(frozen)).toEqual({fxSource:"ecb",fxQuoteId:cache.id,fxReferenceDate:cache.referenceDate,fxFetchedAt:cache.fetchedAt});
  });
});
