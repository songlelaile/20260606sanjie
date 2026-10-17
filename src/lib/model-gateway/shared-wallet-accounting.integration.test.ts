import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createPaymentUatDatabase } from "../../../scripts/payment-uat-db.mjs";
import { contractHash } from "./source-quote.mjs";
import type { SharedWalletSourceObservation } from "./shared-wallet-source";

const sandbox = vi.hoisted(() => ({client:null as PrismaClient|null,balance:"10",rate:1,available:true,config:"c".repeat(64),sourceAgeMs:3_000,sourceCapturedAt:null as string|null,sourceReads:0,sourceReadGate:null as (()=>Promise<void>)|null,nativeEnabled:true,nativeKey:"synthetic-native-private",nativeFetch:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/db",()=>({get prisma(){return sandbox.client;}}));
vi.mock("./relay-config",()=>({getRelayRuntime:async()=>({baseUrl:"https://sub.shaozhuangai.com/v1",apiKey:"synthetic-private-only",models:[],shopKeys:[],usdCnyRate:sandbox.rate})}));
vi.mock("./shared-wallet-source",()=>({getGatewaySharedSourceConfigVersion:async()=>sandbox.config,readGatewaySharedWalletSource:async()=>{
  sandbox.sourceReads++;
  const capturedAt=sandbox.sourceCapturedAt??new Date(Date.now()-sandbox.sourceAgeMs).toISOString(),balance=sandbox.balance;
  await sandbox.sourceReadGate?.();
  if (!sandbox.available) throw new (await import("./shared-wallet-usage.mjs")).SharedWalletSourceError("SOURCE_READ_UNAVAILABLE");
  const bindingBase = {origin:"https://sub.shaozhuangai.com" as const,credentialFingerprint:"a".repeat(64),ownerSubject:"operator-owned-fixture",routeGroupBinding:{groupId:null,groupName:"少壮专属分组",bindingEvidenceHash:"b".repeat(64)},approvalEvidenceHash:"d".repeat(64),approvedExposure:"posted_balance_with_unobservable_external_requests" as const,approvedCredentialFingerprints:[]};
  const binding = {...bindingBase,authorityHash:contractHash(bindingBase)};
  const sourceBase = {capturedAt,responseHash:contractHash(randomUUID()),httpStatus:200 as const,isValid:true as const,mode:"unrestricted" as const,nativeUnit:"USD" as const,balanceUsd:balance,remainingUsd:balance,balanceRaw:balance,remainingRaw:balance};
  return {schema:"SANJIE_SHARED_WALLET_PROOF_V1",scope:"shared_user_lifetime_wallet",binding,epoch:null,policy:{configVersion:sandbox.config,maxSourceAgeMs:60_000,maxFxAgeMs:259_200_000,reserveBps:0,frozenValuationProduct:null},source:{...sourceBase,evidenceHash:contractHash({source:sourceBase,binding})},externalCommitments:{state:"unobservable",amountUsd:null,evidenceHash:binding.approvalEvidenceHash}} satisfies SharedWalletSourceObservation;
},readGatewaySharedWalletSourceConfiguration:async()=>({})}));

const nativeModels=()=>[{id:"seedance-2.0",label:"Native fixture",upstreamModel:"doubao-seedance-2-0-260128",priceVersion:"native-price-v1",reservationCents:100,
  priceTiers:[false,true].map(hasVideoInput=>({resolution:"720p",hasVideoInput,completionCentsPerMillion:100000})),durations:[5],resolutions:["720p"],ratios:["16:9"],generateAudio:false,mediaHosts:["media.example.com"]}];
const nativeSupply=()=>({kind:"ark" as const,provider:"volc" as const,key:sandbox.nativeKey,endpoint:"https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",binding:createHash("sha256").update("native:"+sandbox.nativeKey).digest("hex"),models:nativeModels()});
vi.mock("./native-video-supply",async importOriginal=>({...await importOriginal<typeof import("./native-video-supply")>(),
  readNativeVideoSupplyConfig:async()=>({enabled:sandbox.nativeEnabled,activeBindingId:"native-fixture",bindings:[{provider:"ark",bindingId:"native-fixture",apiKey:sandbox.nativeKey,models:nativeModels()}]}),
  getNativeVideoCreateSupply:async()=>nativeSupply(),getNativeVideoSupplyForJob:async(binding:string)=>{if(binding!==nativeSupply().binding)throw new Error("synthetic_binding_changed");return nativeSupply();}}));
vi.mock("./relay-network",async importOriginal=>({...await importOriginal<typeof import("./relay-network")>(),relayFetch:sandbox.nativeFetch}));

const H=(text:string)=>createHash("sha256").update(text).digest("hex");
describe.skipIf(process.env.CREDIT_POOL_INTEGRATION!=="1")("shared posted wallet — isolated PostgreSQL",()=>{
  let cleanup:(()=>Promise<void>)|undefined,tenantId:string,adminId:string,userId:string;
  let service:typeof import("./credit-pool-accounting"),gifts:typeof import("./credit-gifts"),holds:typeof import("./billing-hold"),billing:typeof import("./billing"),store:typeof import("./store"),hosted:typeof import("./hosted-supply");
  const db=()=>sandbox.client!;
  const pool=()=>db().gatewayCreditPool.findUniqueOrThrow({where:{id:"total"}});
  const wallet=()=>db().gatewayWallet.findUniqueOrThrow({where:{userId}});
  const gift=(points="10",requestKey=randomUUID())=>gifts.giftGatewayCredits(adminId,{userId,points,requestKey,reason:"shared isolated test"});
  async function migration(sql:string){
    const bodies:string[]=[];
    sql=sql.replace(/\$\$[\s\S]*?\$\$/g,body=>{bodies.push(body);return `__BODY_${bodies.length-1}__`;}).replace(/--[^\n]*/g,"");
    for(const part of sql.split(";").map(x=>x.trim()).filter(Boolean))await db().$executeRawUnsafe(part.replace(/__BODY_(\d+)__/g,(_,n)=>bodies[Number(n)]));
  }
  async function adoption(){
    const snap=await service.persistGatewaySharedSourceSnapshot(adminId);
    const proposal=await service.prepareGatewayPoolAdoption(adminId,{snapshotId:snap.snapshotId,snapshotHash:snap.snapshotHash});
    const input={proposalId:proposal.proposalId,version:proposal.version,snapshotHash:proposal.snapshotHash,requestKey:randomUUID()};
    await service.initializeGatewayCreditPool(adminId,input);return {snap,proposal,input};
  }
  async function frozen(eventId=randomUUID()){
    const user=await db().user.findUniqueOrThrow({where:{id:userId}});
    return {auth:{userId,username:user.username,apiKeyId:null,keyPrefix:"isolated"},billingSnapshot:{...await billing.getGatewayBillingSnapshot(userId),fxSnapshot:{rate:sandbox.rate,source:"manual" as const,id:null,fetchedAt:null,referenceDate:null}},eventId,requestFingerprint:H(eventId),endpoint:"images.generations",provider:"shaozhuang",model:"image2"};
  }
  async function dispatch(quote=10){
    const f=await frozen();await holds.reserveGatewayBillingHold({...f,quoteCents:quote});
    await holds.bindGatewayBillingHoldSharedSource({userId,eventId:f.eventId,credentialFingerprint:"a".repeat(64)});
    await holds.markGatewayBillingHoldDispatched({userId,eventId:f.eventId});return f;
  }
  async function settle(f:Awaited<ReturnType<typeof frozen>>,cost=10){
    const usd=String(cost/(100*f.billingSnapshot.fxSnapshot.rate));
    const metadata={baseUrl:"https://sub.shaozhuangai.com/v1",costSource:"upstream_usd",usdCost:usd,usdCostLexical:usd,upstreamCostField:"usage.actual_cost"};
    return holds.settleGatewayBillingHold({userId,eventId:f.eventId,finalCostCents:cost,outcomeFingerprint:H(f.eventId),writeUsage:tx=>store.recordGatewayUsage({auth:f.auth,billingSnapshot:f.billingSnapshot,billingEventId:f.eventId,endpoint:f.endpoint,provider:f.provider,model:f.model,costCents:cost,baseCostCents:cost,status:"ok",metadata},tx)});
  }
  beforeAll(async()=>{
    const isolated=await createPaymentUatDatabase();cleanup=isolated.cleanup;sandbox.client=new PrismaClient({datasources:{db:{url:isolated.url}},log:[]});
    for(const table of ["GatewayCreditSourceUsage","GatewayCreditPoolLedger","GatewayCreditPoolProposal","GatewayCreditSourceSnapshot","GatewayCreditFundingEvidence"])await db().$executeRawUnsafe(`DROP TABLE "${table}" CASCADE`);
    for(const column of ["accountingVersion","capacityCents","allocatedCents","consumedCents","deficitCents","sourceSnapshotId","revision","sourceScope","accountingEpochId","accountingEpochStartedAt","frozenValuationProduct"])await db().$executeRawUnsafe(`ALTER TABLE "GatewayCreditPool" DROP COLUMN "${column}"`);
    await db().$executeRawUnsafe('ALTER TABLE "GatewayOrder" DROP COLUMN "creditAllocationState"');
    await db().$executeRawUnsafe('ALTER TABLE "GatewayBillingHold" DROP COLUMN "sourceBinding"');
    await migration(await readFile("prisma/migrations/20261009090000_gateway_shared_credit_accounting/migration.sql","utf8"));
    await migration(await readFile("prisma/migrations/20261009120000_shared_lifetime_usd_wallet/migration.sql","utf8"));
    await migration(await readFile("prisma/migrations/20261009150000_shared_local_catalog_coverage/migration.sql","utf8"));
    vi.stubEnv("MODEL_GATEWAY_FX_AUTOMATIC","0");vi.stubEnv("MODEL_GATEWAY_PAYMENT_PROVIDER","manual");vi.stubEnv("MODEL_GATEWAY_MANUAL_PAY_URL","");
    service=await import("./credit-pool-accounting");gifts=await import("./credit-gifts");holds=await import("./billing-hold");billing=await import("./billing");store=await import("./store");hosted=await import("./hosted-supply");
    tenantId=(await db().tenant.create({data:{name:"Shared isolated",slug:randomUUID()}})).id;
  },60_000);
  beforeEach(async()=>{
    await db().$executeRawUnsafe('TRUNCATE "GatewayCreditSourceUsage", "GatewayCreditPoolLedger", "GatewayCreditPoolProposal", "GatewayCreditSourceSnapshot", "GatewayCreditFundingEvidence", "GatewayCreditPool", "GatewayCreditGift", "GatewayBillingLedger", "GatewayBillingHoldEvent", "GatewayBillingHold", "GatewayUsage", "GatewayOrder", "GatewayWallet", "GatewayBillingRuleAudit", "GatewayBillingRule", "User" CASCADE');
    // Existing source-drain/failure cases intentionally fall outside only the
    // immediate reuse window while staying within the approved 60-second TTL.
    sandbox.balance="10";sandbox.rate=1;sandbox.available=true;sandbox.config="c".repeat(64);sandbox.sourceAgeMs=3_000;sandbox.sourceCapturedAt=null;sandbox.sourceReads=0;sandbox.sourceReadGate=null;sandbox.nativeEnabled=true;sandbox.nativeKey="synthetic-native-private";sandbox.nativeFetch.mockReset();
    adminId=(await db().user.create({data:{tenantId,username:randomUUID(),password:"unused",name:"Admin",authRole:"admin"}})).id;
    userId=(await db().user.create({data:{tenantId,username:randomUUID(),password:"unused",name:"User"}})).id;
    await db().gatewayWallet.create({data:{userId,balanceCents:100}});
  });
  afterAll(async()=>{vi.unstubAllEnvs();await sandbox.client?.$disconnect();await cleanup?.();});

  it("never seeds a source and preserves real pre-init payment",async()=>{
    expect(await db().gatewayCreditPool.count()).toBe(0);
    const o=await db().gatewayOrder.create({data:{userId,planCode:"free",planName:"fixture",amountCents:100,creditCents:100,paymentProvider:"manual"}});
    await store.markGatewayOrderPaidByOrderId(o.id,{receipt:randomUUID(),receivedAmountCents:100,confirmedBy:adminId,note:"fixture"});
    expect((await wallet()).balanceCents).toBe(200);expect(await db().gatewayCreditPool.count()).toBe(0);
    await adoption();expect(await pool()).toMatchObject({allocatedCents:200n,consumedCents:0n,balanceCents:800});
  });
  it("adoption re-reads posted balance and never promotes a stale larger proposal",async()=>{
    const snap=await service.persistGatewaySharedSourceSnapshot(adminId);
    const proposal=await service.prepareGatewayPoolAdoption(adminId,{snapshotId:snap.snapshotId,snapshotHash:snap.snapshotHash});
    sandbox.balance="0.5";
    await expect(service.initializeGatewayCreditPool(adminId,{proposalId:proposal.proposalId,version:proposal.version,snapshotHash:proposal.snapshotHash,requestKey:randomUUID()})).rejects.toMatchObject({code:"POOL_PROPOSAL_STALE"});
    expect(await db().gatewayCreditPool.count()).toBe(0);expect((await wallet()).balanceCents).toBe(100);expect(await db().gatewayCreditPoolLedger.count()).toBe(0);
  });
  it("adopts held subset once, fixes epoch/valuation and handles exact replay",async()=>{
    const f=await frozen();await holds.reserveGatewayBillingHold({...f,quoteCents:40});const original=await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:f.eventId}});
    const {input}=await adoption();const adopted=await pool();await service.initializeGatewayCreditPool(adminId,input);
    expect(await pool()).toMatchObject({sourceScope:"shared_user_lifetime_wallet",capacityCents:1000n,allocatedCents:100n,consumedCents:0n,balanceCents:900,frozenValuationProduct:10000000000n});
    expect(await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:f.eventId}})).toEqual(original);
    expect(await db().gatewayCreditPoolLedger.count({where:{kind:"adoption"}})).toBe(1);
    await expect(db().gatewayCreditPool.update({where:{id:"total"},data:{accountingEpochId:randomUUID()}})).rejects.toThrow();
    expect((await pool()).accountingEpochId).toBe(adopted.accountingEpochId);
  });
  it("rejects pre-epoch dispatched/unknown holds without adopting their historical USD",async()=>{
    const f=await frozen();await holds.reserveGatewayBillingHold({...f,quoteCents:20});await holds.markGatewayBillingHoldDispatched({userId,eventId:f.eventId});
    const snap=await service.persistGatewaySharedSourceSnapshot(adminId);
    await expect(service.prepareGatewayPoolAdoption(adminId,{snapshotId:snap.snapshotId,snapshotHash:snap.snapshotHash})).rejects.toMatchObject({code:"POOL_SHARED_INFLIGHT_UNPROVEN"});
    expect(await db().gatewayCreditPool.count()).toBe(0);
  });
  it("shared real source permits gifts with exactly-once wallet and pool journals",async()=>{
    await adoption();const key=randomUUID();const results=await Promise.all(Array.from({length:5},()=>gift("10",key)));
    expect(new Set(results.map(row=>row.id)).size).toBe(1);expect((await wallet()).balanceCents).toBe(200);
    expect(await db().gatewayCreditPoolLedger.count({where:{kind:"gift"}})).toBe(1);
    expect(await pool()).toMatchObject({balanceCents:800,allocatedCents:200n});
  });
  it("commits external-drain deficit before a rejected gift and keeps W/H/C",async()=>{
    await adoption();await gift();const f=await dispatch(50),before=await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:f.eventId}});
    sandbox.balance="1";await expect(gift("1")).rejects.toMatchObject({code:"CREDIT_POOL_NOT_READY"});
    expect(await pool()).toMatchObject({status:"blocked",capacityCents:100n,balanceCents:0,deficitCents:100n,allocatedCents:200n,consumedCents:0n});
    expect((await wallet()).balanceCents).toBe(200);expect(await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:f.eventId}})).toEqual(before);
    const journal=await db().gatewayCreditPoolLedger.findFirstOrThrow({where:{kind:"source_observation",deficitAfterCents:100n}});
    expect(journal).toMatchObject({deficitBeforeCents:0n,deltaAllocatedCents:0n,deltaConsumedCents:0n,allocatableAfterCents:0});
  });
  it("response-only actual USD settles W to C but never adds L before/after asynchronous posting",async()=>{
    await adoption();const f=await dispatch(10);await settle(f);
    expect(await pool()).toMatchObject({allocatedCents:90n,consumedCents:10n,balanceCents:900,capacityCents:1000n});
    const observation=await db().gatewayCreditSourceUsage.findUniqueOrThrow({where:{billingEventId:f.eventId}});
    expect(observation).toMatchObject({actualUsdUnits:10000000n,eligibleUsdUnits:0n,ownerDebitPosting:"unproven",cycleId:null,credentialFingerprint:"a".repeat(64)});
    await service.refreshGatewaySharedPoolFromSource();expect(await pool()).toMatchObject({balanceCents:900,capacityCents:1000n});
    sandbox.balance="9.9";await service.refreshGatewaySharedPoolFromSource();expect(await pool()).toMatchObject({balanceCents:890,capacityCents:990n,consumedCents:10n,allocatedCents:90n});
    await settle(f);expect(await db().gatewayCreditSourceUsage.count()).toBe(1);expect((await wallet()).balanceCents).toBe(90);
  });
  it("explicit exact zero actual cost settles without inventing C or USD add-back",async()=>{
    await adoption();const f=await dispatch(10);await settle(f,0);
    expect((await wallet()).balanceCents).toBe(100);expect(await pool()).toMatchObject({consumedCents:0n,balanceCents:900});
    expect(await db().gatewayCreditSourceUsage.count()).toBe(0);expect(await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:f.eventId}})).toMatchObject({status:"settled",settledCents:0});
    await service.refreshGatewaySharedPoolFromSource();expect((await pool()).balanceCents).toBe(900);
  });
  it("fresh network/config rejection stops allocation without dropping verified payment",async()=>{
    await adoption();sandbox.available=false;
    const o=await db().gatewayOrder.create({data:{userId,planCode:"free",planName:"fixture",amountCents:100,creditCents:100,paymentProvider:"manual"}});
    const c={receipt:randomUUID(),receivedAmountCents:100,confirmedBy:adminId,note:"fixture"};
    expect(await store.markGatewayOrderPaidByOrderId(o.id,c)).toMatchObject({status:"pending",creditAllocationState:"awaiting_capacity",paymentReceipt:c.receipt});
    expect((await wallet()).balanceCents).toBe(100);expect(await db().gatewayCreditFundingEvidence.count()).toBe(1);
    sandbox.available=true;await store.retryGatewayPendingCredit(adminId,o.id);expect((await wallet()).balanceCents).toBe(200);
    expect(await db().gatewayCreditPoolLedger.count({where:{kind:"recharge"}})).toBe(1);
  });
  it("never uses TTL to settle a frozen old dispatched hold at a new price",async()=>{
    await adoption();const f=await dispatch(10);sandbox.available=false;
    await service.refreshGatewaySharedPoolFromSource();expect((await pool()).status).toBe("blocked");
    await settle(f);expect((await wallet()).balanceCents).toBe(90);expect((await pool()).consumedCents).toBe(10n);
  });
  it("foreign credential and catalog cost cannot debit the adopted shared pool",async()=>{
    await adoption();const f=await frozen();await holds.reserveGatewayBillingHold({...f,quoteCents:10});
    await expect(holds.bindGatewayBillingHoldSharedSource({userId,eventId:f.eventId,credentialFingerprint:"e".repeat(64)})).rejects.toMatchObject({code:"POOL_SOURCE_USAGE_UNPROVEN"});
    await holds.bindGatewayBillingHoldSharedSource({userId,eventId:f.eventId,credentialFingerprint:"a".repeat(64)});await holds.markGatewayBillingHoldDispatched({userId,eventId:f.eventId});
    await expect(holds.settleGatewayBillingHold({userId,eventId:f.eventId,finalCostCents:10,outcomeFingerprint:H(f.eventId),writeUsage:tx=>store.recordGatewayUsage({auth:f.auth,billingSnapshot:f.billingSnapshot,billingEventId:f.eventId,endpoint:f.endpoint,provider:f.provider,model:f.model,costCents:10,baseCostCents:10,status:"ok",metadata:{costSource:"catalog"}},tx)})).rejects.toMatchObject({code:"POOL_SOURCE_USAGE_UNPROVEN"});
    expect(await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:f.eventId}})).toMatchObject({status:"unknown",heldCents:10});expect((await wallet()).balanceCents).toBe(100);
  });
  it("uses original exact raw actual_cost while keeping secret response fields out of journals",async()=>{
    await adoption();const f=await dispatch(2);
    const model=(await import("./catalog")).GATEWAY_MODELS.find(row=>row.provider==="shaozhuang")!;
    const hold={auth:f.auth,model,kind:"chat.completions" as const,body:{messages:[{role:"user",content:"hi"}]},billingSnapshot:f.billingSnapshot,billingEventId:f.eventId,startedAt:Date.now(),baseUrl:"https://sub.shaozhuangai.com/v1",dispatched:true};
    const publicBody=JSON.stringify({choices:[{message:{content:"ok"}}],usage:{actual_cost:0.01000001}});
    await expect(hosted.settleHostedSupply(hold,{status:200,bytes:new TextEncoder().encode(publicBody),contentType:"application/json",rawResponseText:'{"choices":[{"message":{"content":"ok"}}],"private_key":"do-not-persist","usage":{"actual_cost":0.01000001}}'})).resolves.toEqual({reject:false});
    const entry=await db().gatewayBillingLedger.findUniqueOrThrow({where:{billingEventId:f.eventId}});
    expect(entry).toMatchObject({chargedCostCents:2,metadata:{usdCost:"0.01000001",usdCostLexical:"0.01000001",upstreamCostField:"usage.actual_cost"}});
    expect(JSON.stringify(entry)).not.toContain("do-not-persist");
  });
  it.each([undefined,'{"usage":{"cost":0.1}}','{"usage":{"actual_cost":0.123456789}}','{"usage":{"actual_cost":1e-3}}'])("missing frozen local pricing or inexact actual USD keeps a hold unknown (%s)",async(raw)=>{
    await adoption();const f=await dispatch(10);const model=(await import("./catalog")).GATEWAY_MODELS.find(row=>row.provider==="shaozhuang")!;
    const hold={auth:f.auth,model,kind:"chat.completions" as const,body:{messages:[{role:"user",content:"hi"}]},billingSnapshot:f.billingSnapshot,billingEventId:f.eventId,startedAt:Date.now(),baseUrl:"https://sub.shaozhuangai.com/v1",dispatched:true};
    const body=JSON.stringify({choices:[{message:{content:"ok"}}],usage:{cost:0.1}});
    expect(await hosted.settleHostedSupply(hold,{status:200,bytes:new TextEncoder().encode(body),contentType:"application/json",rawResponseText:raw})).toEqual({reject:true});
    expect(await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:f.eventId}})).toMatchObject({status:"unknown",heldCents:10});expect((await wallet()).balanceCents).toBe(100);expect(await db().gatewayCreditSourceUsage.count()).toBe(0);
  });
  async function catalogHold(kind: "images.generations" | "chat.completions" = "images.generations") {
    const model=(await import("./catalog")).GATEWAY_MODELS.find(row=>row.provider==="shaozhuang" && row.endpoint===kind)!;
    const body=kind==="chat.completions" ? {messages:[{role:"user",content:"hi"}],max_completion_tokens:1024} : {prompt:"fixture",n:1};
    const {freezeGatewayLocalPricing}=await import("./local-pricing");
    const f=await frozen();f.endpoint=kind;f.model=model.id;
    const billingSnapshot={...f.billingSnapshot,localPricing:freezeGatewayLocalPricing(model,kind,body)};
    await holds.reserveGatewayBillingHold({...f,billingSnapshot,quoteCents:kind==="chat.completions" ? 10 : 50});
    await holds.bindGatewayBillingHoldSharedSource({userId,eventId:f.eventId,credentialFingerprint:"a".repeat(64)});await holds.markGatewayBillingHoldDispatched({userId,eventId:f.eventId});
    return {auth:f.auth,model,kind,body,billingSnapshot,billingEventId:f.eventId,startedAt:Date.now(),baseUrl:"https://sub.shaozhuangai.com/v1",dispatched:true};
  }
  it("standard image success with no supplier price settles frozen local C, unknown USD and no asset addback",async()=>{
    await adoption();const h=await catalogHold();const body=JSON.stringify({data:[{url:"https://example.test/image"}]});
    expect(await hosted.settleHostedSupply(h,{status:200,bytes:new TextEncoder().encode(body),contentType:"application/json",rawResponseText:body})).toEqual({reject:false});
    expect(await wallet()).toMatchObject({balanceCents:50});expect(await pool()).toMatchObject({allocatedCents:50n,consumedCents:50n,capacityCents:1000n,balanceCents:900});
    expect(await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:h.billingEventId}})).toMatchObject({status:"settled",heldCents:50,settledCents:50});
    expect(await db().gatewayCreditSourceUsage.findUniqueOrThrow({where:{billingEventId:h.billingEventId}})).toMatchObject({actualUsdUnits:null,eligibleUsdUnits:0n,billingProvenance:"local_catalog",ownerDebitPosting:"unproven",localPricingHash:h.billingSnapshot.localPricing.hash});
    await service.refreshGatewaySharedPoolFromSource();expect(await pool()).toMatchObject({capacityCents:1000n,balanceCents:900});
    sandbox.balance="9.5";await service.refreshGatewaySharedPoolFromSource();expect(await pool()).toMatchObject({capacityCents:950n,balanceCents:850,consumedCents:50n,allocatedCents:50n});
    sandbox.balance="0.5";await service.refreshGatewaySharedPoolFromSource();expect(await pool()).toMatchObject({capacityCents:50n,balanceCents:0,deficitCents:50n,consumedCents:50n,allocatedCents:50n,status:"blocked"});
    expect((await wallet()).balanceCents).toBe(50);
  });
  it("standard chat token usage uses durable original catalog rates, ignores usage.cost and replays once",async()=>{
    await adoption();const h=await catalogHold("chat.completions");h.model={...h.model,promptCentsPer1K:999,completionCentsPer1K:999};
    const body=JSON.stringify({choices:[{message:{content:"ok"}}],usage:{prompt_tokens:1000,completion_tokens:1000,total_tokens:2000,cost:10}});
    const response={status:200,bytes:new TextEncoder().encode(body),contentType:"application/json",rawResponseText:body};
    expect(await hosted.settleHostedSupply(h,response)).toEqual({reject:false});expect(await hosted.settleHostedSupply(h,response)).toEqual({reject:false});
    expect((await wallet()).balanceCents).toBe(92);expect(await db().gatewayCreditSourceUsage.count()).toBe(1);expect((await pool()).consumedCents).toBe(8n);
    expect(await db().gatewayCreditSourceUsage.findUniqueOrThrow({where:{billingEventId:h.billingEventId}})).toMatchObject({actualUsdUnits:null,billingProvenance:"local_catalog",eligibleUsdUnits:0n});
  });
  it.each([{}, {prompt_tokens:1}, {input_tokens:1,output_tokens:1,prompt_tokens:2}, {prompt_tokens:1,completion_tokens:1,output_tokens:2}, {prompt_tokens:1,completion_tokens:1,total_tokens:3}])("missing/ambiguous reported tokens preserve unknown rather than estimating local charge (%j)",async usage=>{
    await adoption();const h=await catalogHold("chat.completions");const body=JSON.stringify({choices:[{message:{content:"ok"}}],usage});
    expect(await hosted.settleHostedSupply(h,{status:200,bytes:new TextEncoder().encode(body),contentType:"application/json"})).toEqual({reject:true});
    expect((await wallet()).balanceCents).toBe(100);expect(await db().gatewayCreditSourceUsage.count()).toBe(0);expect(await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:h.billingEventId}})).toMatchObject({status:"unknown"});
  });
  it("accepts complete Responses input/output token names as reported local usage",async()=>{
    await adoption();const h=await catalogHold("chat.completions");const body=JSON.stringify({choices:[{message:{content:"ok"}}],usage:{input_tokens:1000,output_tokens:1000,total_tokens:2000}});
    expect(await hosted.settleHostedSupply(h,{status:200,bytes:new TextEncoder().encode(body),contentType:"application/json"})).toEqual({reject:false});expect((await wallet()).balanceCents).toBe(92);
  });
  it.each([{status:500,body:{error:{message:"failed"}}},{status:200,body:{choices:[]}},{status:200,body:{choices:[{message:{content:"ok"}}],usage:{prompt_tokens:1,completion_tokens:1025}}}])("error/empty/over-budget evidence preserves the shared hold (%j)",async item=>{
    await adoption();const h=await catalogHold("chat.completions");const body=JSON.stringify(item.body);
    expect(await hosted.settleHostedSupply(h,{status:item.status,bytes:new TextEncoder().encode(body),contentType:"application/json"})).toEqual({reject:true});
    expect(await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:h.billingEventId}})).toMatchObject({status:"unknown"});expect((await wallet()).balanceCents).toBe(100);expect(await db().gatewayCreditSourceUsage.count()).toBe(0);
  });
  it("forged catalog evidence/outcome cannot write W/C coverage",async()=>{
    await adoption();const h=await catalogHold();const evidence={schema:"SANJIE_LOCAL_CHARGE_V1",pricingHash:h.billingSnapshot.localPricing.hash,outcomeHash:H("different"),promptTokens:0,completionTokens:0,quantity:1,tokenSource:"estimated",success:true};
    await expect(holds.settleGatewayBillingHold({userId,eventId:h.billingEventId,finalCostCents:50,outcomeFingerprint:H("actual"),writeUsage:tx=>store.recordGatewayUsage({auth:h.auth,billingSnapshot:h.billingSnapshot,billingEventId:h.billingEventId,endpoint:h.kind,provider:"shaozhuang",model:h.model.id,costCents:50,baseCostCents:50,status:"ok",metadata:{baseUrl:h.baseUrl,costSource:"catalog",localChargeEvidence:evidence}},tx)})).rejects.toMatchObject({code:"POOL_SOURCE_USAGE_UNPROVEN"});
    expect((await wallet()).balanceCents).toBe(100);expect(await db().gatewayCreditSourceUsage.count()).toBe(0);
  });
  it("database nullable USD keeps independent proof strict and rejects shared false eligible credit",async()=>{
    await adoption();const h=await catalogHold();const body=JSON.stringify({data:[{url:"https://example.test/image"}]});await hosted.settleHostedSupply(h,{status:200,bytes:new TextEncoder().encode(body),contentType:"application/json"});
    const usage=await db().gatewayCreditSourceUsage.findUniqueOrThrow({where:{billingEventId:h.billingEventId}});
    const data={...usage};delete (data as {createdAt?:Date}).createdAt;
    await expect(db().gatewayCreditSourceUsage.create({data:{...data,billingEventId:randomUUID(),eligibleUsdUnits:1n}})).rejects.toThrow();
    await expect(db().gatewayCreditSourceUsage.create({data:{...data,billingEventId:randomUUID(),sourceScope:"independent_usd",groupId:"fixture",cycleId:"fixture",accountingEpochId:null,billingProvenance:"upstream_actual_usd",actualUsdUnits:null}})).rejects.toThrow();
  });
  async function nativeOwner(){const user=await db().user.findUniqueOrThrow({where:{id:userId}});return {id:userId,tenantId,username:user.username};}
  const nativeRequest=()=>({model:"seedance-2.0",content:[{type:"text",text:"isolated fixture"}],duration:5,resolution:"720p",ratio:"16:9",generate_audio:false});
  const nativeReply=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{"Content-Type":"application/json"}});
  async function createNative(){const native=await import("./native-video");sandbox.nativeFetch.mockResolvedValueOnce(nativeReply({id:"native_fixture_1"}));return {native,owner:await nativeOwner(),view:await native.createNativeVideo(await nativeOwner(),nativeRequest(),randomUUID())};}
  it("native Ark freezes funding FX independently of true supplier, settles original token tariff once and keeps null USD",async()=>{
    await adoption();const {native,owner,view}=await createNative();
    const job=await db().gatewayNativeVideoJob.findUniqueOrThrow({where:{id:view.id}}),hold=await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:job.eventId}});
    expect(hold).toMatchObject({provider:"volc",endpoint:"seedance.tasks",status:"dispatched",billingSnapshot:{fxSnapshot:{rate:1}},sourceBinding:{bindingPurpose:"native_funding",credentialFingerprint:"a".repeat(64),nativeDispatch:{provider:"volc",endpoint:nativeSupply().endpoint,keyFingerprint:H(sandbox.nativeKey),bindingFingerprint:nativeSupply().binding}}});
    expect(H(sandbox.nativeKey)).not.toBe("a".repeat(64));expect((await wallet()).balanceCents).toBe(100);
    sandbox.rate=2; // Site cents stay the original tariff, not the new funding FX.
    sandbox.nativeFetch.mockResolvedValueOnce(nativeReply({id:"native_fixture_1",status:"succeeded",usage:{completion_tokens:250,total_tokens:250},content:{video_url:"https://media.example.com/result.mp4"}}));
    const result=await native.pollNativeVideo(owner,view.id);expect(result.status).toBe("succeeded");expect(result.billing.settledCents).toBe(25);
    expect(await pool()).toMatchObject({allocatedCents:75n,consumedCents:25n,balanceCents:900,capacityCents:1000n});expect((await wallet()).balanceCents).toBe(75);
    const row=await db().gatewayCreditSourceUsage.findUniqueOrThrow({where:{billingEventId:job.eventId}});expect(row).toMatchObject({actualUsdUnits:null,eligibleUsdUnits:0n,billingProvenance:"local_catalog",credentialFingerprint:"a".repeat(64),localPricingHash:contractHash(job.tariff)});
    expect(await native.pollNativeVideo(owner,view.id)).toMatchObject({status:"succeeded"});expect(sandbox.nativeFetch).toHaveBeenCalledTimes(2);
    await service.refreshGatewaySharedPoolFromSource();expect(await pool()).toMatchObject({balanceCents:900,consumedCents:25n,capacityCents:1000n});
  });
  it("native empty balance rejects with purchase 402 before pending supply configuration or provider submission",async()=>{
    await db().gatewayWallet.update({where:{userId},data:{balanceCents:0}});sandbox.nativeEnabled=false;
    const native=await import("./native-video");await expect(native.createNativeVideo(await nativeOwner(),nativeRequest(),randomUUID())).rejects.toMatchObject({code:"INSUFFICIENT_BALANCE",status:402});
    expect(sandbox.nativeFetch).not.toHaveBeenCalled();expect(await db().gatewayNativeVideoJob.count()).toBe(0);
  });
  it("native source refresh rejects durable token/evidence divergence without minting capacity",async()=>{
    await adoption();const {native,owner,view}=await createNative();sandbox.nativeFetch.mockResolvedValueOnce(nativeReply({id:"native_fixture_1",status:"succeeded",usage:{completion_tokens:250,total_tokens:250},content:{video_url:"https://media.example.com/result.mp4"}}));
    await native.pollNativeVideo(owner,view.id);const before=await pool(),journalCount=await db().gatewayCreditPoolLedger.count();
    await db().gatewayNativeVideoJob.update({where:{id:view.id},data:{completionTokens:251}});
    await expect(service.persistGatewaySharedSourceSnapshot(adminId)).rejects.toMatchObject({code:"POOL_SOURCE_USAGE_UNPROVEN"});
    expect(await pool()).toEqual(before);expect(await db().gatewayCreditPoolLedger.count()).toBe(journalCount);
    await service.refreshGatewaySharedPoolFromSource();const blocked=await pool();
    expect(blocked).toEqual({...before,status:"blocked",revision:before.revision+1,updatedAt:blocked.updatedAt});
    expect(await db().gatewayCreditPoolLedger.count()).toBe(journalCount+1);expect(await db().gatewayCreditPoolLedger.count({where:{kind:"source_unavailable"}})).toBe(1);
    await expect(db().$transaction(tx=>service.assertGatewayPoolReady(tx,blocked))).rejects.toMatchObject({code:"CREDIT_POOL_NOT_READY"});
    expect((await wallet()).balanceCents).toBe(75);
  });
  it("native source binding drift preserves original task and active H, without another POST",async()=>{
    await adoption();const {native,owner,view}=await createNative();sandbox.nativeKey="different-native-private";
    await expect(native.pollNativeVideo(owner,view.id)).rejects.toThrow();expect(sandbox.nativeFetch).toHaveBeenCalledTimes(1);expect((await wallet()).balanceCents).toBe(100);
    const job=await db().gatewayNativeVideoJob.findUniqueOrThrow({where:{id:view.id}});expect(job.state).toBe("processing");expect(await db().gatewayCreditSourceUsage.count()).toBe(0);
    expect(await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:job.eventId}})).toMatchObject({status:"dispatched",heldCents:100});
  });
  it("native zero reported completion preserves existing zero charge semantics and no positive C coverage",async()=>{
    await adoption();const {native,owner,view}=await createNative();sandbox.nativeFetch.mockResolvedValueOnce(nativeReply({id:"native_fixture_1",status:"succeeded",usage:{completion_tokens:0,total_tokens:0},content:{video_url:"https://media.example.com/result.mp4"}}));
    expect(await native.pollNativeVideo(owner,view.id)).toMatchObject({status:"succeeded",billing:{settledCents:0}});expect((await wallet()).balanceCents).toBe(100);expect((await pool()).consumedCents).toBe(0n);expect(await db().gatewayCreditSourceUsage.count()).toBe(0);
    await service.refreshGatewaySharedPoolFromSource();expect((await pool()).balanceCents).toBe(900);
  });
  it("native missing/contradictory reported usage retains the original hold and job",async()=>{
    await adoption();const {native,owner,view}=await createNative();sandbox.nativeFetch.mockResolvedValueOnce(nativeReply({id:"native_fixture_1",status:"succeeded",usage:{completion_tokens:250,total_tokens:251},content:{video_url:"https://media.example.com/result.mp4"}}));
    await expect(native.pollNativeVideo(owner,view.id)).rejects.toMatchObject({code:"NATIVE_VIDEO_USAGE_INVALID"});expect((await wallet()).balanceCents).toBe(100);expect(await db().gatewayCreditSourceUsage.count()).toBe(0);
  });
  it("gift/recharge concurrency never overdraws A and preserves verified waiting money",async()=>{
    sandbox.balance="2.5";await adoption();
    const o=await db().gatewayOrder.create({data:{userId,planCode:"free",planName:"fixture",amountCents:100,creditCents:100,paymentProvider:"manual"}});
    const c={receipt:randomUUID(),receivedAmountCents:100,confirmedBy:adminId,note:"fixture"};
    const outcomes=await Promise.allSettled([gift("10"),store.markGatewayOrderPaidByOrderId(o.id,c)]);
    expect(outcomes.some(row=>row.status==="fulfilled")).toBe(true);
    const current=await pool();expect(current.balanceCents).toBe(50);expect(current.allocatedCents).toBe(200n);expect((await wallet()).balanceCents).toBe(200);
    expect(await db().gatewayCreditFundingEvidence.count()).toBe(1);
    expect(await db().gatewayCreditPoolLedger.count({where:{kind:{in:["gift","recharge"]}}})).toBe(1);
    const paid=await db().gatewayOrder.findUniqueOrThrow({where:{id:o.id}});expect(["credited","awaiting_capacity"]).toContain(paid.creditAllocationState);
  });
  it("financial journal failure rolls back all gift allocation while source observation stays committed",async()=>{
    await adoption();
    await db().$executeRawUnsafe(`CREATE FUNCTION shared_test_fail_gift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_financial_failure'; END; $$`);
    await db().$executeRawUnsafe(`CREATE TRIGGER shared_test_fail_gift BEFORE INSERT ON "GatewayCreditGift" FOR EACH ROW EXECUTE FUNCTION shared_test_fail_gift()`);
    try {await expect(gift()).rejects.toThrow();}
    finally {await db().$executeRawUnsafe('DROP TRIGGER shared_test_fail_gift ON "GatewayCreditGift"');await db().$executeRawUnsafe('DROP FUNCTION shared_test_fail_gift()');}
    expect(await pool()).toMatchObject({allocatedCents:100n,consumedCents:0n,balanceCents:900});expect((await wallet()).balanceCents).toBe(100);
    expect(await db().gatewayCreditPoolLedger.count({where:{kind:"gift"}})).toBe(0);expect(await db().gatewayBillingLedger.count({where:{kind:"gift"}})).toBe(0);
    expect(await db().gatewayCreditPoolLedger.count({where:{kind:"source_observation"}})).toBe(1);
  });
  it("USD observation failure rolls back debit and retains the dispatched hold",async()=>{
    await adoption();const f=await dispatch(10);
    await db().$executeRawUnsafe(`CREATE FUNCTION shared_test_fail_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_usd_journal_failure'; END; $$`);
    await db().$executeRawUnsafe(`CREATE TRIGGER shared_test_fail_usage BEFORE INSERT ON "GatewayCreditSourceUsage" FOR EACH ROW EXECUTE FUNCTION shared_test_fail_usage()`);
    try {await expect(settle(f)).rejects.toThrow();}
    finally {await db().$executeRawUnsafe('DROP TRIGGER shared_test_fail_usage ON "GatewayCreditSourceUsage"');await db().$executeRawUnsafe('DROP FUNCTION shared_test_fail_usage()');}
    expect((await wallet()).balanceCents).toBe(100);expect((await pool()).consumedCents).toBe(0n);
    expect(await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:f.eventId}})).toMatchObject({status:"dispatched",heldCents:10});
    expect(await db().gatewayUsage.count()).toBe(0);expect(await db().gatewayCreditPoolLedger.count({where:{kind:"debit"}})).toBe(0);
  });
  it("late source proof failure rolls back callback money before preserving unknown hold",async()=>{
    await adoption();const f=await dispatch(10);const {GatewayBillingError}=await import("./billing-contract");
    await expect(holds.settleGatewayBillingHold({userId,eventId:f.eventId,finalCostCents:10,outcomeFingerprint:H(f.eventId),writeUsage:async tx=>{
      await store.recordGatewayUsage({auth:f.auth,billingSnapshot:f.billingSnapshot,billingEventId:f.eventId,endpoint:f.endpoint,provider:f.provider,model:f.model,costCents:10,baseCostCents:10,status:"ok",metadata:{baseUrl:"https://sub.shaozhuangai.com/v1",costSource:"upstream_usd",usdCost:"0.1",usdCostLexical:"0.1",upstreamCostField:"usage.actual_cost"}},tx);
      throw new GatewayBillingError("POOL_SOURCE_USAGE_UNPROVEN","synthetic late evidence failure",409);
    }})).rejects.toMatchObject({code:"POOL_SOURCE_USAGE_UNPROVEN"});
    expect((await wallet()).balanceCents).toBe(100);expect((await pool()).consumedCents).toBe(0n);
    expect(await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:f.eventId}})).toMatchObject({status:"unknown",heldCents:10});
    expect(await db().gatewayUsage.count()).toBe(0);expect(await db().gatewayCreditSourceUsage.count()).toBe(0);expect(await db().gatewayCreditPoolLedger.count({where:{kind:"debit"}})).toBe(0);
  });
  it("shared video polling retains original fingerprint/epoch and rejects config drift",async()=>{
    await adoption();const f=await dispatch(10);
    await holds.settleGatewayBillingHold({userId,eventId:f.eventId,finalCostCents:10,outcomeFingerprint:H(f.eventId),writeUsage:tx=>store.recordGatewayUsage({auth:f.auth,billingSnapshot:f.billingSnapshot,billingEventId:f.eventId,endpoint:"videos",requestId:"video_fixture_1",provider:f.provider,model:f.model,costCents:10,baseCostCents:10,status:"ok",metadata:{baseUrl:"https://sub.shaozhuangai.com/v1",costSource:"upstream_usd",usdCost:"0.1",usdCostLexical:"0.1",upstreamCostField:"actual_cost"}},tx)});
    expect(await holds.getGatewaySharedVideoSupplyBinding(userId,"video_fixture_1")).toMatchObject({credentialFingerprint:"a".repeat(64),epochId:(await pool()).accountingEpochId,providerBaseUrl:"https://sub.shaozhuangai.com/v1",configVersion:sandbox.config});
    expect(await holds.getGatewaySharedVideoSupplyBinding(adminId,"video_fixture_1")).toBeNull();
    sandbox.config="f".repeat(64);await expect(holds.getGatewaySharedVideoSupplyBinding(userId,"video_fixture_1")).rejects.toMatchObject({code:"POOL_SHARED_POLL_BINDING_CHANGED"});
  });
  it("reserved gift event prefix cannot be used by model consumption",async()=>{
    await adoption();const f=await frozen(`gift:${randomUUID()}`);
    await expect(holds.reserveGatewayBillingHold({...f,quoteCents:1})).rejects.toMatchObject({code:"INVALID_BILLING_EVENT"});
    await expect(store.recordGatewayUsage({auth:f.auth,billingSnapshot:f.billingSnapshot,billingEventId:f.eventId,endpoint:f.endpoint,provider:f.provider,model:f.model,costCents:1,baseCostCents:1,status:"ok"})).rejects.toMatchObject({code:"INVALID_BILLING_EVENT"});
    expect((await wallet()).balanceCents).toBe(100);expect(await db().gatewayCreditPoolLedger.count()).toBe(1);
  });
  it("database deficit conservation and immutable source journals reject corrupt state",async()=>{
    await adoption();const original=await pool();sandbox.balance="0.5";await service.refreshGatewaySharedPoolFromSource();
    expect(await pool()).toMatchObject({deficitCents:50n,balanceCents:0,allocatedCents:100n});
    await expect(db().gatewayCreditPoolLedger.create({data:{poolId:"total",kind:"source_observation",eventId:randomUUID(),capacityBeforeCents:50n,capacityCents:50n,allocatedBeforeCents:100n,allocatedAfterCents:100n,consumedBeforeCents:0n,consumedAfterCents:0n,allocatableBeforeCents:0,allocatableAfterCents:1,deficitBeforeCents:50n,deficitAfterCents:50n,deltaAllocatedCents:0n,deltaConsumedCents:0n}})).rejects.toThrow();
    const journal=await db().gatewayCreditPoolLedger.findFirstOrThrow({where:{kind:"adoption"}});await expect(db().gatewayCreditPoolLedger.update({where:{id:journal.id},data:{capacityCents:1n}})).rejects.toThrow();
    expect((await pool()).frozenValuationProduct).toBe(original.frozenValuationProduct);
  });
  it("FX decline commits lower fully backed capacity and rebound cannot exceed the adopted ceiling",async()=>{
    await adoption();const adopted=await pool(),originalWallet=await wallet();
    const financial=await db().gatewayCreditPoolLedger.findMany({where:{kind:{notIn:["source_observation","source_unavailable"]}},orderBy:{id:"asc"}});
    sandbox.rate=0.5;await service.refreshGatewaySharedPoolFromSource();
    const reduced=await pool();expect(reduced).toMatchObject({status:"ready",capacityCents:500n,allocatedCents:100n,consumedCents:0n,balanceCents:400,deficitCents:0n,frozenValuationProduct:adopted.frozenValuationProduct,accountingEpochId:adopted.accountingEpochId});
    const snapshot=await db().gatewayCreditSourceSnapshot.findUniqueOrThrow({where:{id:reduced.sourceSnapshotId!}});
    expect(snapshot.proof).toMatchObject({policy:{frozenValuationProduct:String(adopted.frozenValuationProduct)},pricing:{fx:{rate:"0.5"}}});
    await db().$transaction(tx=>service.assertGatewayPoolReady(tx,reduced));
    sandbox.rate=2;await service.refreshGatewaySharedPoolFromSource();
    expect(await pool()).toMatchObject({status:"ready",capacityCents:1000n,allocatedCents:100n,consumedCents:0n,frozenValuationProduct:adopted.frozenValuationProduct,balanceCents:900});
    expect(await wallet()).toEqual(originalWallet);expect(await db().gatewayCreditPoolLedger.findMany({where:{kind:{notIn:["source_observation","source_unavailable"]}},orderBy:{id:"asc"}})).toEqual(financial);
    const journals=await db().gatewayCreditPoolLedger.findMany({where:{kind:"source_observation"},orderBy:{createdAt:"asc"}});
    expect(journals.map(row=>[row.capacityBeforeCents,row.capacityCents,row.deltaAllocatedCents,row.deltaConsumedCents])).toEqual([[1000n,500n,0n,0n],[500n,1000n,0n,0n]]);
  });
  it("FX decline with insufficient fresh backing records a conserved deficit and preserves active holds",async()=>{
    await adoption();const f=await dispatch(40),originalHold=await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:f.eventId}}),originalWallet=await wallet();
    sandbox.rate=0.05;await service.refreshGatewaySharedPoolFromSource();const blocked=await pool();
    expect(blocked).toMatchObject({status:"blocked",capacityCents:50n,allocatedCents:100n,consumedCents:0n,balanceCents:0,deficitCents:50n,frozenValuationProduct:10000000000n});
    expect(BigInt(blocked.balanceCents)+blocked.allocatedCents+blocked.consumedCents).toBe(blocked.capacityCents+blocked.deficitCents);
    expect(await wallet()).toEqual(originalWallet);expect(await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:f.eventId}})).toEqual(originalHold);
    expect(await db().gatewayCreditPoolLedger.count({where:{kind:"source_unavailable"}})).toBe(0);
    await expect(db().$transaction(tx=>service.assertGatewayPoolReady(tx,blocked))).rejects.toMatchObject({code:"CREDIT_POOL_NOT_READY"});
  });
  it("a changed effective plan floor revalues only source capacity without mutating the saved rule",async()=>{
    await adoption();const rule=await db().gatewayBillingRule.create({data:{planCode:"free",planName:"Isolated free fixture",multiplierBps:5000,version:1}});
    await service.refreshGatewaySharedPoolFromSource();expect(await pool()).toMatchObject({status:"ready",capacityCents:500n,balanceCents:400,frozenValuationProduct:10000000000n});
    expect(await db().gatewayBillingRule.findUniqueOrThrow({where:{planCode:"free"}})).toEqual(rule);expect((await wallet()).balanceCents).toBe(100);
  });
  it("new dispatch requires the exact fresh effective quote floor rather than the adopted ceiling",async()=>{
    await adoption();sandbox.rate=0.5;await service.refreshGatewaySharedPoolFromSource();const before=await pool(),snapshot=(await frozen()).billingSnapshot;
    await db().$transaction(tx=>service.assertGatewayPoolNewQuote(tx,snapshot));
    const underfunded={...snapshot,fxSnapshot:{...snapshot.fxSnapshot,rate:0.49}};
    await expect(db().$transaction(tx=>service.assertGatewayPoolNewQuote(tx,underfunded))).rejects.toMatchObject({code:"POOL_QUOTE_UNBACKED"});
    expect(await pool()).toEqual(before);expect(await db().gatewayBillingHold.count()).toBe(0);
    sandbox.rate=0.4;await expect(db().$transaction(tx=>service.assertGatewayPoolNewQuote(tx,snapshot))).rejects.toMatchObject({code:"POOL_PRICING_CHANGED"});
  });
  it("native historical hold and settled C evidence stay exact across lower FX and rebound",async()=>{
    await adoption();const {native,owner,view}=await createNative();
    const job=await db().gatewayNativeVideoJob.findUniqueOrThrow({where:{id:view.id}}),originalHold=await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:job.eventId}});
    sandbox.rate=0.5;await service.refreshGatewaySharedPoolFromSource();
    expect(await pool()).toMatchObject({status:"ready",capacityCents:500n,balanceCents:400});
    expect(await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:job.eventId}})).toEqual(originalHold);
    sandbox.nativeFetch.mockResolvedValueOnce(nativeReply({id:"native_fixture_1",status:"succeeded",usage:{completion_tokens:250,total_tokens:250},content:{video_url:"https://media.example.com/result.mp4"}}));
    expect(await native.pollNativeVideo(owner,view.id)).toMatchObject({status:"succeeded",billing:{settledCents:25}});
    const settledHold=await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:job.eventId}}),usage=await db().gatewayCreditSourceUsage.findUniqueOrThrow({where:{billingEventId:job.eventId}});
    expect(settledHold.billingSnapshot).toEqual(originalHold.billingSnapshot);expect(settledHold.sourceBinding).toEqual(originalHold.sourceBinding);
    expect(usage).toMatchObject({actualUsdUnits:null,eligibleUsdUnits:0n,ownerDebitPosting:"unproven",localPricingHash:contractHash(job.tariff)});
    const debit=await db().gatewayCreditPoolLedger.findUniqueOrThrow({where:{eventId:job.eventId}}),settledWallet=await wallet();
    sandbox.rate=0.25;await service.refreshGatewaySharedPoolFromSource();expect(await pool()).toMatchObject({status:"ready",capacityCents:250n,allocatedCents:75n,consumedCents:25n,balanceCents:150});
    sandbox.rate=2;await service.refreshGatewaySharedPoolFromSource();expect(await pool()).toMatchObject({status:"ready",capacityCents:1000n,allocatedCents:75n,consumedCents:25n,balanceCents:900,frozenValuationProduct:10000000000n});
    expect(await wallet()).toEqual(settledWallet);expect(await db().gatewayCreditSourceUsage.findUniqueOrThrow({where:{billingEventId:job.eventId}})).toEqual(usage);
    expect(await db().gatewayCreditPoolLedger.findUniqueOrThrow({where:{eventId:job.eventId}})).toEqual(debit);expect(await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:job.eventId}})).toEqual(settledHold);expect(sandbox.nativeFetch).toHaveBeenCalledTimes(2);
  });
  it("an active low-FX hold blocks a rebound without repricing, but its original settled debit remains valid",async()=>{
    await adoption();sandbox.rate=0.5;await service.refreshGatewaySharedPoolFromSource();const f=await dispatch(10),originalHold=await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:f.eventId}});
    sandbox.rate=1;await service.refreshGatewaySharedPoolFromSource();const blocked=await pool();
    expect(blocked).toMatchObject({status:"blocked",capacityCents:500n,balanceCents:400,frozenValuationProduct:10000000000n});
    expect((await db().gatewayCreditPoolLedger.findFirstOrThrow({where:{kind:"source_unavailable"}})).eventId).toContain("HOLD_PRICE_UNPROVEN");
    expect(await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:f.eventId}})).toEqual(originalHold);
    await settle(f,10);const usage=await db().gatewayCreditSourceUsage.findUniqueOrThrow({where:{billingEventId:f.eventId}}),debit=await db().gatewayCreditPoolLedger.findUniqueOrThrow({where:{eventId:f.eventId}});
    await service.refreshGatewaySharedPoolFromSource();expect(await pool()).toMatchObject({status:"ready",capacityCents:1000n,allocatedCents:90n,consumedCents:10n,balanceCents:900});
    expect(await db().gatewayCreditSourceUsage.findUniqueOrThrow({where:{billingEventId:f.eventId}})).toEqual(usage);expect(await db().gatewayCreditPoolLedger.findUniqueOrThrow({where:{eventId:f.eventId}})).toEqual(debit);
    expect(await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:f.eventId}})).toMatchObject({status:"settled",billingSnapshot:originalHold.billingSnapshot,sourceBinding:originalHold.sourceBinding});
  });
  it("merges concurrent immediate checks without GET or renewing source freshness",async()=>{
    sandbox.sourceAgeMs=0;await adoption();sandbox.sourceReads=0;
    const before=await pool(),original=await db().gatewayCreditSourceSnapshot.findUniqueOrThrow({where:{id:before.sourceSnapshotId!}});
    await Promise.all(Array.from({length:8},()=>service.refreshGatewaySharedPoolFromSource()));
    const after=await pool(),snapshot=await db().gatewayCreditSourceSnapshot.findUniqueOrThrow({where:{id:after.sourceSnapshotId!}});
    expect(sandbox.sourceReads).toBe(0);expect(after.revision).toBe(before.revision+1);
    expect(snapshot.observedAt).toEqual(original.observedAt);expect(snapshot.expiresAt).toEqual(original.expiresAt);
    expect(after).toMatchObject({status:"ready",capacityCents:before.capacityCents,allocatedCents:100n,consumedCents:0n,balanceCents:900});
  });
  it("reuses only B and recomputes current held subset and consumed liabilities",async()=>{
    sandbox.sourceAgeMs=0;await adoption();sandbox.sourceReads=0;
    const f=await dispatch(40);await service.refreshGatewaySharedPoolFromSource();
    let current=await pool(),snapshot=await db().gatewayCreditSourceSnapshot.findUniqueOrThrow({where:{id:current.sourceSnapshotId!}});
    const heldProof=snapshot.proof as unknown as {liabilities:{holds:{eventId:string;heldCents:number}[]}};
    expect(heldProof.liabilities.holds).toMatchObject([{eventId:f.eventId,heldCents:40}]);
    await settle(f,10);await service.refreshGatewaySharedPoolFromSource();
    current=await pool();snapshot=await db().gatewayCreditSourceSnapshot.findUniqueOrThrow({where:{id:current.sourceSnapshotId!}});
    expect(snapshot.proof).toMatchObject({liabilities:{consumedCents:10,accountedUsd:"0",wallets:[{userId,balanceCents:90,ledgerBalanceCents:90}],holds:[]}});
    expect(current).toMatchObject({capacityCents:1000n,allocatedCents:90n,consumedCents:10n,balanceCents:900});expect(sandbox.sourceReads).toBe(0);
    expect(await db().gatewayCreditSourceUsage.count()).toBe(1);expect(await db().gatewayCreditPoolLedger.count({where:{kind:"debit"}})).toBe(1);
  });
  it("past the immediate reuse window a failed GET blocks without changing capacity or hiding its code",async()=>{
    await adoption();const before=await pool();sandbox.available=false;sandbox.sourceReads=0;
    await Promise.all(Array.from({length:5},()=>service.refreshGatewaySharedPoolFromSource()));
    const after=await pool();expect(sandbox.sourceReads).toBe(1);
    expect(after).toMatchObject({status:"blocked",capacityCents:before.capacityCents,allocatedCents:before.allocatedCents,consumedCents:before.consumedCents,balanceCents:before.balanceCents});
    const journals=await db().gatewayCreditPoolLedger.findMany({where:{kind:"source_unavailable"}});
    expect(journals).toHaveLength(1);expect(journals[0].eventId).toMatch(/^source-unavailable:SOURCE_READ_UNAVAILABLE:[a-f0-9-]+$/);
    expect(JSON.stringify(journals[0],(_key,value)=>typeof value==="bigint"?String(value):value)).not.toContain("synthetic-private");
  });
  it("expired new source evidence fails closed without promoting its apparent higher balance",async()=>{
    await adoption();const before=await pool();sandbox.sourceReads=0;sandbox.sourceAgeMs=61_000;sandbox.balance="999";
    await service.refreshGatewaySharedPoolFromSource();
    expect(sandbox.sourceReads).toBe(1);expect(await pool()).toMatchObject({status:"blocked",sourceSnapshotId:before.sourceSnapshotId,capacityCents:before.capacityCents,balanceCents:before.balanceCents});
    expect((await db().gatewayCreditPoolLedger.findFirstOrThrow({where:{kind:"source_unavailable"}})).eventId).toContain("SOURCE_STALE");
  });
  it("config drift invalidates even an immediate observation and never changes approved identity",async()=>{
    sandbox.sourceAgeMs=0;await adoption();const before=await pool();sandbox.sourceReads=0;sandbox.config="f".repeat(64);
    await service.refreshGatewaySharedPoolFromSource();
    expect(sandbox.sourceReads).toBe(1);expect(await pool()).toMatchObject({status:"blocked",sourceSnapshotId:before.sourceSnapshotId,capacityCents:before.capacityCents,allocatedCents:before.allocatedCents});
    expect((await db().gatewayCreditPoolLedger.findFirstOrThrow({where:{kind:"source_unavailable"}})).eventId).toContain("POOL_REFRESH_SCOPE_CHANGED");
  });
  it("source GET waits outside the global accounting fence",async()=>{
    await adoption();sandbox.sourceAgeMs=0;sandbox.sourceReads=0;
    let entered!:()=>void,release!:()=>void;
    const enteredPromise=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    sandbox.sourceReadGate=async()=>{entered();await gate;};
    const refresh=service.refreshGatewaySharedPoolFromSource();await enteredPromise;
    try {
      const available=await db().$transaction(async tx=>{
        const rows=await tx.$queryRaw<{available:boolean}[]>`SELECT pg_try_advisory_xact_lock(1935765098,1129466192) AS available`;
        return rows[0].available;
      },{timeout:2_000});
      expect(available).toBe(true);
    } finally {release();await refresh;sandbox.sourceReadGate=null;}
    expect(sandbox.sourceReads).toBe(1);expect((await pool()).status).toBe("ready");
  });
  it.each([[false,"9"],[true,"9"],[false,"0.5"],[true,"0.5"]] as const)("a newer committed observation wins over an older pending GET (old failure %s, posted B %s)",async(oldFails,newBalance)=>{
    await adoption();sandbox.sourceAgeMs=0;sandbox.sourceReads=0;
    let entered!:()=>void,release!:()=>void;
    const enteredPromise=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    sandbox.sourceReadGate=async()=>{
      if(sandbox.sourceReads!==1)return;
      entered();await gate;
      if(oldFails)throw new (await import("./shared-wallet-usage.mjs")).SharedWalletSourceError("SOURCE_READ_UNAVAILABLE");
    };
    const refresh=service.refreshGatewaySharedPoolFromSource();await enteredPromise;
    try {
      await new Promise(resolve=>setTimeout(resolve,5));sandbox.balance=newBalance;
      const newer=await service.persistGatewaySharedSourceSnapshot(adminId);expect(newer.capacityCents).toBe(newBalance==="9"?900:50);
    } finally {release();await refresh;sandbox.sourceReadGate=null;}
    expect(await pool()).toMatchObject(newBalance==="9"?{status:"ready",capacityCents:900n,balanceCents:800,allocatedCents:100n,consumedCents:0n}:{status:"blocked",capacityCents:50n,balanceCents:0,deficitCents:50n,allocatedCents:100n,consumedCents:0n});
    expect(await db().gatewayCreditPoolLedger.count({where:{kind:"source_unavailable"}})).toBe(0);
  });
  it("equal observation timestamps conservatively keep the smaller posted balance",async()=>{
    await adoption();sandbox.sourceReads=0;sandbox.sourceCapturedAt=new Date().toISOString();sandbox.balance="0.5";
    let entered!:()=>void,release!:()=>void;
    const enteredPromise=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    sandbox.sourceReadGate=async()=>{if(sandbox.sourceReads===1){entered();await gate;}};
    const refresh=service.refreshGatewaySharedPoolFromSource();await enteredPromise;
    try {sandbox.balance="9";await service.persistGatewaySharedSourceSnapshot(adminId);}
    finally {release();await refresh;sandbox.sourceReadGate=null;}
    expect(await pool()).toMatchObject({status:"blocked",capacityCents:50n,balanceCents:0,deficitCents:50n,allocatedCents:100n,consumedCents:0n});
  });
  it("administrator source GET also waits outside the accounting fence",async()=>{
    await adoption();sandbox.sourceAgeMs=0;sandbox.sourceReads=0;
    let entered!:()=>void,release!:()=>void;
    const enteredPromise=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    sandbox.sourceReadGate=async()=>{entered();await gate;};
    const pending=service.persistGatewaySharedSourceSnapshot(adminId);await enteredPromise;
    try {
      expect(await db().$transaction(async tx=>(await tx.$queryRaw<{available:boolean}[]>`SELECT pg_try_advisory_xact_lock(1935765098,1129466192) AS available`)[0].available,{timeout:2_000})).toBe(true);
    } finally {release();await pending;sandbox.sourceReadGate=null;}
    expect(sandbox.sourceReads).toBe(1);expect((await pool()).status).toBe("ready");
  });
  it("an older administrator high-balance GET cannot overwrite a newer blocked observation",async()=>{
    await adoption();sandbox.sourceAgeMs=0;sandbox.sourceReads=0;
    let entered!:()=>void,release!:()=>void;
    const enteredPromise=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    sandbox.sourceReadGate=async()=>{if(sandbox.sourceReads===1){entered();await gate;}};
    const older=service.persistGatewaySharedSourceSnapshot(adminId);await enteredPromise;
    try {
      await new Promise(resolve=>setTimeout(resolve,5));sandbox.balance="0.5";
      const newer=await service.persistGatewaySharedSourceSnapshot(adminId);expect(newer).toMatchObject({ready:false,capacityCents:50,deficitCents:50});
    } finally {release();await older;sandbox.sourceReadGate=null;}
    expect(await pool()).toMatchObject({status:"blocked",capacityCents:50n,balanceCents:0,deficitCents:50n,allocatedCents:100n,consumedCents:0n});
  });
  it("administrator status is rechecked after GET and rejected writes leave all journals intact",async()=>{
    await adoption();const before=await pool(),snapshots=await db().gatewayCreditSourceSnapshot.count(),journals=await db().gatewayCreditPoolLedger.count();
    let entered!:()=>void,release!:()=>void;
    const enteredPromise=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    sandbox.sourceReadGate=async()=>{entered();await gate;};
    const pending=service.persistGatewaySharedSourceSnapshot(adminId);await enteredPromise;
    try {await db().user.update({where:{id:adminId},data:{status:"disabled"}});}
    finally {release();}
    await expect(pending).rejects.toMatchObject({code:"ADMIN_REQUIRED"});sandbox.sourceReadGate=null;
    expect(await pool()).toEqual(before);expect(await db().gatewayCreditSourceSnapshot.count()).toBe(snapshots);expect(await db().gatewayCreditPoolLedger.count()).toBe(journals);
  });
});
