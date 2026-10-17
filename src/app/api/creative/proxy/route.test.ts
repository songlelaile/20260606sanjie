import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), access: vi.fn(), lookup: vi.fn(), fetch: vi.fn(), rate: vi.fn(), relay: vi.fn(),
  refund: vi.fn(), reconcileVideo: vi.fn(), balance: vi.fn(), usage: vi.fn(), snapshot: vi.fn(), findModel: vi.fn(), videoJob: vi.fn(),
  reserve: vi.fn(), dispatch: vi.fn(), unknown: vi.fn(), release: vi.fn(), settle: vi.fn(), bind: vi.fn(),
  supply: vi.fn(), credential: vi.fn(), available: vi.fn(), sharedSupply: vi.fn(), sharedBind: vi.fn(), sharedHold: vi.fn(), sharedVideoBinding: vi.fn(), sharedRuntime: vi.fn(), durablePricing: vi.fn()
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/server-session', () => ({ getCurrentSession: mocks.session, getCurrentUser: mocks.user }));
vi.mock('@/lib/model-gateway/relay-config', () => ({ getRelayRuntime: mocks.relay }));
vi.mock('@/lib/model-gateway/user-supply', () => ({ getUserSupplyRuntime: mocks.supply, getUserSupplyCredential: mocks.credential, UserSupplyError: class UserSupplyError extends Error { constructor(message: string, readonly status=503, readonly code='USER_SUPPLY_UNAVAILABLE') { super(message); } } }));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/model-gateway/shared-wallet-source', () => ({ getSharedWalletPlatformSupply: mocks.sharedSupply, getGatewaySharedPlatformRuntime: mocks.sharedRuntime }));
vi.mock('@/lib/model-gateway/store', () => ({ assertGatewayBalance: mocks.balance, recordGatewayUsage: mocks.usage }));
vi.mock('@/lib/model-gateway/billing', () => ({ getGatewayBillingSnapshot: mocks.snapshot }));
vi.mock('@/lib/model-gateway/runtime-catalog', () => ({ findAvailableGatewayModel: mocks.findModel }));
vi.mock('@/lib/model-gateway/video-jobs', () => ({ findGatewayVideoJob: mocks.videoJob, reconcileGatewayVideoTerminal: mocks.reconcileVideo }));
vi.mock('@/lib/model-gateway/relay-network', () => ({ relayFetch: mocks.fetch }));
vi.mock('@/lib/model-gateway/billing-hold', () => ({
  refundGatewayBillingHold: mocks.refund, reserveGatewayBillingHold: mocks.reserve, markGatewayBillingHoldDispatched: mocks.dispatch,
  markGatewayBillingHoldUnknown: mocks.unknown, releaseGatewayBillingHold: mocks.release, settleGatewayBillingHold: mocks.settle,
  bindGatewayBillingHoldCredential: mocks.bind, getGatewayAvailableBalance: mocks.available, bindGatewayBillingHoldSharedSource: mocks.sharedBind,
  isGatewaySharedBillingHold: mocks.sharedHold, getGatewaySharedVideoSupplyBinding: mocks.sharedVideoBinding, getGatewayBillingHoldPricing: mocks.durablePricing
}));
vi.mock('@/lib/creative-entitlements', () => ({ getCreativeAccessForSession: mocks.access }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('@/lib/security-rate-limit', () => ({ consumeSecurityRateLimit: mocks.rate }));
vi.mock('@/lib/security-web-account', () => ({ securityAccountIdentity: () => 'stable-account' }));
import { POST } from './route';
import { GatewayBillingError } from '@/lib/model-gateway/billing-contract';
import { UserSupplyError } from '@/lib/model-gateway/user-supply';
function request(body: unknown, origin='http://localhost') {
  return new Request('http://localhost/api/creative/proxy', { method:'POST', headers:{ origin, host:'localhost', 'content-type':'application/json' }, body:JSON.stringify(body) });
}
const body = { url:'https://sub.shaozhuangai.com/v1/images/generations', method:'POST', bodyText:JSON.stringify({model:'image2',prompt:'商品主图'}) };
const snapshot = { userId: 'user-1', tenantId: 'tenant', username: 'tenant', userName: '租户', planCode: 'free', planName: '体验版', multiplierBps: 10000, ruleVersion: 0, quotedAt: '2026-10-03T00:00:00.000Z' };
describe('creative forwarding live access gates', () => {
  beforeEach(() => {
    vi.resetAllMocks(); vi.stubGlobal('fetch', mocks.fetch); vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('PUBLIC_APP_ORIGIN', '');
    vi.stubEnv("MODEL_GATEWAY_FX_AUTOMATIC", "0");
    mocks.rate.mockResolvedValue({ allowed:true, remaining:10, retryAfterSeconds:0 });
    mocks.session.mockResolvedValue({ username:'user', role:'tenant', tenantId:'tenant' });
    mocks.user.mockResolvedValue({ id:'user-1', username:'tenant' });
    mocks.relay.mockResolvedValue({ apiKey: 'platform-key', shopKeys: [], usdCnyRate: null, baseUrl: 'https://sub.shaozhuangai.com/v1', models: [] });
    mocks.supply.mockImplementation(async () => { const relay = await mocks.relay.mock.results.at(-1)!.value; return { baseUrl: relay.baseUrl, primary: { id: 'user-1-primary', apiKey: relay.apiKey }, backup: null, usdCnyRate: relay.usdCnyRate }; });
    mocks.credential.mockResolvedValue({ baseUrl: 'https://sub.shaozhuangai.com/v1', apiKey: 'retained-user-key' });
    mocks.bind.mockResolvedValue({}); mocks.sharedBind.mockResolvedValue({});
    mocks.sharedHold.mockResolvedValue(false); mocks.sharedVideoBinding.mockResolvedValue(null);
    mocks.durablePricing.mockImplementation(async (_userId,eventId) => { const input=mocks.reserve.mock.calls.find(([value]) => value.eventId===eventId)![0]; return {billingSnapshot:input.billingSnapshot,endpoint:input.endpoint,model:input.model}; });
    mocks.available.mockResolvedValue({balanceCents:10000,reservedCents:0,availableCents:10000});
    mocks.sharedSupply.mockRejectedValue(new GatewayBillingError('SHARED_SOURCE_NOT_CONFIGURED','source not configured',503));
    mocks.findModel.mockResolvedValue({ id:'image2',upstreamModel:'gpt-image-2',provider:'shaozhuang',kind:'image',endpoint:'images.generations',imageCents:50 });
    mocks.snapshot.mockResolvedValue(snapshot);
    mocks.usage.mockResolvedValue({id:'usage-1'});
    mocks.reserve.mockImplementation(async (input) => ({hold:{eventId:input.eventId,billingSnapshot:input.billingSnapshot},shouldDispatch:true,replayed:false}));
    mocks.dispatch.mockImplementation(async input => ({shouldDispatch:true,hold:{eventId:input.eventId,billingSnapshot:mocks.reserve.mock.calls.find(([value]) => value.eventId===input.eventId)![0].billingSnapshot}}));
    mocks.unknown.mockResolvedValue({}); mocks.release.mockResolvedValue({}); mocks.refund.mockResolvedValue({hold:{refundedCents:50}});
    mocks.settle.mockImplementation(async (input) => {
      const reservation = mocks.reserve.mock.calls.find(([value])=>value.eventId===input.eventId)![0];
      await input.writeUsage({transaction:'settlement'}, {billingSnapshot:reservation.billingSnapshot,eventId:input.eventId});
      return {};
    });
    mocks.videoJob.mockResolvedValue(null);
    mocks.access.mockResolvedValue({ allowed:true, reason:'invited' });
    mocks.lookup.mockResolvedValue([{ address:'8.8.8.8' }]);
    mocks.fetch.mockResolvedValue(Response.json({ data:[{url:'https://images.example/result.png'}] }));
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  it('refunds a known local credential-binding failure after dispatch claim and before any provider POST',async()=>{
    mocks.bind.mockRejectedValueOnce(new Error('private local persistence failure'));
    const response=await POST(request(body));
    expect(response.status).toBe(503); expect(response.headers.get('X-Sanjie-Provider-Submission')).toBe('not-submitted');
    expect(mocks.dispatch).toHaveBeenCalledOnce(); expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.refund).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({userId:'user-1',reason:'confirmed_failed'}));
    expect(mocks.unknown).not.toHaveBeenCalled();
  });

  it('charges the exact quoted amount in prepaid mode before dispatch and rejects a changed quote before charging', async () => {
    expect((await POST(request({...body,expectedQuoteCents:49}))).status).toBe(409);
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
    expect((await POST(request({...body,expectedQuoteCents:50}))).status).toBe(200);
    expect(mocks.reserve).toHaveBeenCalledWith(expect.objectContaining({billingMode:'prepaid_quote',quoteCents:50,endpoint:'images.generations'}));
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(mocks.dispatch.mock.invocationCallOrder[0]);
    expect(mocks.dispatch.mock.invocationCallOrder[0]).toBeLessThan(mocks.fetch.mock.invocationCallOrder[0]);
  });

  it('refunds a parsed confirmed failure even when supplier observation accounting is unavailable', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({error:{message:'supplier rejected'},usage:{actual_cost:0.01}},{status:500}));
    mocks.settle.mockRejectedValueOnce(new GatewayBillingError('POOL_SOURCE_USAGE_UNPROVEN','private source receipt',409));
    await POST(request(body));
    expect(mocks.refund).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({userId:'user-1',reason:'confirmed_failed'}));
    expect(mocks.refund.mock.invocationCallOrder[0]).toBeLessThan(mocks.settle.mock.invocationCallOrder[0]);
    expect(mocks.reserve).toHaveBeenCalledWith(expect.objectContaining({billingMode:'prepaid_quote'}));
  });

  it.each(['POOL_SOURCE_STALE', 'POOL_EQUATION_BROKEN', 'FX_RATE_STALE', 'SOURCE_TIMEOUT'])('masks internal %s without assuming the reservation result', async code => {
    mocks.reserve.mockRejectedValueOnce(new GatewayBillingError(code, '总积分池 internal USD private-key', 409));
    const response = await POST(request(body));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error:'服务暂时繁忙，请稍后查看原任务状态，避免重复提交。',code:'CREDIT_SERVICE_UNAVAILABLE',stateUncertain:true});
    expect(response.headers.get('X-Sanjie-Provider-Submission')).toBeNull();
    expect(mocks.dispatch).not.toHaveBeenCalled();expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('provides non-submission proof only after a known pre-dispatch hold is released', async () => {
    mocks.supply.mockRejectedValue(new UserSupplyError('pending',503,'USER_SUPPLY_PROVISION_PENDING'));
    mocks.sharedSupply.mockResolvedValue({apiKey:'platform-key',baseUrl:'https://sub.shaozhuangai.com/v1',credentialFingerprint:'f'.repeat(64)});
    mocks.sharedBind.mockRejectedValueOnce(new GatewayBillingError('POOL_SOURCE_STALE','内部来源过期',409));
    const response=await POST(request(body));
    expect(response.status).toBe(503);expect(response.headers.get('X-Sanjie-Provider-Submission')).toBe('not-submitted');
    expect(await response.json()).toEqual({error:'生成服务暂时繁忙，请稍后重试。',code:'CREDIT_SERVICE_UNAVAILABLE',providerSubmitted:false,definitiveFailure:true});
    expect(mocks.release).toHaveBeenCalledOnce();expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('keeps an internal settlement failure uncertain after the provider response', async () => {
    mocks.settle.mockRejectedValueOnce(new GatewayBillingError('POOL_EQUATION_BROKEN','internal account balance USD',409));
    const response=await POST(request(body));
    expect(response.status).toBe(503);expect(response.headers.get('X-Sanjie-Provider-Submission')).toBeNull();
    const value=await response.json();expect(value).toMatchObject({code:'CREDIT_SERVICE_UNAVAILABLE',stateUncertain:true});
    expect(value).not.toHaveProperty('providerSubmitted');expect(value).not.toHaveProperty('definitiveFailure');
    expect(JSON.stringify(value)).not.toMatch(/POOL_|USD|internal/);expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.unknown).toHaveBeenCalledWith(expect.objectContaining({reason:'settlement_failed'}));expect(mocks.release).not.toHaveBeenCalled();
  });
  it('keeps failed unknown-state persistence uncertain without a non-submission claim', async () => {
    mocks.settle.mockRejectedValueOnce(new Error('private settlement database failure'));
    mocks.unknown.mockRejectedValue(new Error('private persistence failure'));
    const response=await POST(request(body));
    expect(response.status).toBe(503);expect(response.headers.get('X-Sanjie-Provider-Submission')).toBeNull();
    expect(await response.json()).toEqual({error:'服务暂时繁忙，请稍后查看原任务状态，避免重复提交。',code:'CREDIT_SERVICE_UNAVAILABLE',stateUncertain:true});
    expect(mocks.fetch).toHaveBeenCalledOnce();expect(mocks.release).not.toHaveBeenCalled();
  });
  it('uses the user primary and one safe backup with one persisted event, FX quote and settlement', async () => {
    mocks.relay.mockResolvedValue({apiKey:'',baseUrl:'https://sub.shaozhuangai.com/v1',usdCnyRate:7.2});
    mocks.supply.mockResolvedValue({baseUrl:'https://sub.shaozhuangai.com/v1',primary:{id:'user-1-primary',apiKey:'user-private-main'},backup:{id:'user-1-backup',apiKey:'user-private-backup'},usdCnyRate:7.2});
    mocks.fetch.mockResolvedValueOnce(Response.json({code:'INVALID_API_KEY',message:'user-private-main'},{status:401}))
      .mockResolvedValueOnce(Response.json({data:[{url:'https://images.example/result.png'}],debug:['user-private-main','user-private-backup'],usage:{actual_cost:0.01}}));
    const response=await POST(request(body));
    expect(response.status).toBe(200);expect(mocks.supply).toHaveBeenCalledExactlyOnceWith('user-1');
    expect(mocks.fetch.mock.calls.map(([,init])=>init.headers.authorization)).toEqual(['Bearer user-private-main','Bearer user-private-backup']);
    const event=mocks.reserve.mock.calls[0][0].eventId;
    expect(mocks.fetch.mock.calls.map(([,init])=>init.headers['idempotency-key'])).toEqual([event,event]);
    expect(mocks.bind.mock.calls.map(([input])=>input)).toEqual([{userId:'user-1',eventId:event,credentialId:'user-1-primary'},{userId:'user-1',eventId:event,credentialId:'user-1-backup'}]);
    expect(mocks.reserve).toHaveBeenCalledOnce();expect(mocks.dispatch).toHaveBeenCalledOnce();expect(mocks.settle).toHaveBeenCalledOnce();expect(mocks.unknown).not.toHaveBeenCalled();
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({costCents:8,metadata:expect.objectContaining({credentialId:'user-1-backup',usdCnyRate:'7.2'})}),{transaction:'settlement'});
    const text=await response.text();expect(text).not.toContain('user-private-main');expect(text).not.toContain('user-private-backup');
    expect(JSON.stringify(mocks.usage.mock.calls)).not.toContain('user-private');
  });
  it('persists the attempted backup before an uncertain POST and retains its billing hold', async () => {
    mocks.supply.mockResolvedValue({baseUrl:'https://sub.shaozhuangai.com/v1',primary:{id:'main-id',apiKey:'main-secret'},backup:{id:'backup-id',apiKey:'backup-secret'},usdCnyRate:null});
    mocks.fetch.mockResolvedValueOnce(Response.json({code:'API_KEY_DISABLED'},{status:401})).mockImplementationOnce(async()=>{
      expect(mocks.bind.mock.calls.at(-1)![0].credentialId).toBe('backup-id');throw new DOMException('timeout','TimeoutError');
    });
    expect((await POST(request(body))).status).toBe(504);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);expect(mocks.unknown).toHaveBeenCalledOnce();expect(mocks.settle).not.toHaveBeenCalled();expect(mocks.usage).not.toHaveBeenCalled();
  });
  it('polls a per-user task with its immutable credential even when no global Key is configured', async()=>{
    mocks.relay.mockResolvedValue({apiKey:'',baseUrl:'https://sub.shaozhuangai.com/v1',usdCnyRate:null});
    mocks.videoJob.mockResolvedValue({provider:'shaozhuang',baseUrl:'https://sub.shaozhuangai.com/v1',model:'video',upstreamModel:'video',credentialId:'retained-old-credential'});
    mocks.fetch.mockResolvedValue(Response.json({id:'task_1',status:'pending'}));
    expect((await POST(request({url:'https://sub.shaozhuangai.com/v1/videos/task_1',method:'GET'}))).status).toBe(200);
    expect(mocks.credential).toHaveBeenCalledExactlyOnceWith('user-1','retained-old-credential');
    expect(mocks.fetch.mock.calls[0][1].headers.authorization).toBe('Bearer retained-user-key');
    expect(mocks.supply).not.toHaveBeenCalled();expect(mocks.bind).not.toHaveBeenCalled();expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it.each(['json', 'multipart'])('blocks account changes before billing or provider calls (%s)', async (format) => {
    let input: Request;
    if (format === 'multipart') {
      const form = new FormData();
      form.set('__sz_url', 'https://sub.shaozhuangai.com/v1/images/edits');
      form.set('__sz_method', 'POST');
      form.set('__sz_headers', '{}');
      form.set('__sz_expected_account', 'tenant:previous-user');
      form.set('model', 'image2'); form.set('prompt', '商品图');
      form.set('image[]', new Blob(['original-image'], {type:'image/png'}), 'original.png');
      input = new Request('http://localhost/api/creative/proxy', {method:'POST',headers:{host:'localhost'},body:form});
    } else input = request({...body, expectedAccount:'tenant:previous-user'});
    const response = await POST(input);
    expect(response.status).toBe(409);
    expect(response.headers.get('X-Sanjie-Provider-Submission')).toBe('not-submitted');
    expect(await response.json()).toMatchObject({code:'CREATIVE_ACCOUNT_CHANGED',providerSubmitted:false,definitiveFailure:true});
    for (const fn of [mocks.lookup,mocks.rate,mocks.reserve,mocks.dispatch,mocks.fetch,mocks.usage]) expect(fn).not.toHaveBeenCalled();
  });
  it.each(['json', 'multipart'])('accepts a matching account without sending its binding upstream (%s)', async (format) => {
    let input: Request;
    if (format === 'multipart') {
      const form = new FormData();
      form.set('__sz_url', 'https://sub.shaozhuangai.com/v1/images/edits');
      form.set('__sz_method', 'POST'); form.set('__sz_headers', '{}');
      form.set('__sz_expected_account', 'tenant:user');
      form.set('model','image2'); form.set('prompt','商品图');
      form.set('image[]',new Blob(['image'],{type:'image/png'}),'original.png');
      input = new Request('http://localhost/api/creative/proxy',{method:'POST',headers:{host:'localhost'},body:form});
    } else input=request({...body,expectedAccount:'tenant:user'});
    expect((await POST(input)).status).toBe(200);
    const init=mocks.fetch.mock.calls[0][1];
    expect(JSON.stringify(init.headers)).not.toContain('expected');
    if (init.body instanceof FormData) {
      expect([...init.body.keys()]).not.toContain('__sz_expected_account');
      expect(await (init.body.get('image[]') as Blob).text()).toBe('image');
    } else expect(init.body).not.toContain('expectedAccount');
    expect(mocks.reserve).toHaveBeenCalledTimes(1); expect(mocks.settle).toHaveBeenCalledTimes(1);
  });
  it.each([null, '', 42, {}, 'x'.repeat(257)])('rejects malformed expected accounts before dispatch (%j)', async (value) => {
    expect((await POST(request({...body,expectedAccount:value}))).status).toBe(400);
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('refuses duplicate or file-valued multipart account bindings', async () => {
    for (const variant of ['duplicate','file']) {
      const form=new FormData(); form.set('__sz_url',body.url);
      form.set('__sz_expected_account',variant==='file'?new Blob(['tenant:user']):'tenant:user');
      if(variant==='duplicate') form.append('__sz_expected_account','tenant:user');
      const response=await POST(new Request('http://localhost/api/creative/proxy',{method:'POST',headers:{host:'localhost'},body:form}));
      expect(response.status).toBe(400);
    }
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('does not treat an upstream account-change claim as a local no-submission receipt', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({error:'provider error',code:'CREATIVE_ACCOUNT_CHANGED',providerSubmitted:false,definitiveFailure:true},{status:409,headers:{'X-Sanjie-Provider-Submission':'not-submitted'}}));
    const response=await POST(request({...body,expectedAccount:'tenant:user'}));
    expect(response.headers.get('X-Sanjie-Provider-Submission')).toBeNull();
    expect(mocks.dispatch).toHaveBeenCalledTimes(1); expect(mocks.refund).toHaveBeenCalled(); expect(mocks.unknown).not.toHaveBeenCalled();
  });
  it('denies anonymous, uncharged and disabled users before upstream calls', async () => {
    mocks.session.mockResolvedValueOnce(null);
    expect((await POST(request(body))).status).toBe(401);
    mocks.access.mockResolvedValueOnce({ allowed:false, reason:'payment_required' });
    expect((await POST(request(body))).status).toBe(402);
    mocks.access.mockResolvedValueOnce({ allowed:false, reason:'invalid_account' });
    expect((await POST(request(body))).status).toBe(401);
    expect(mocks.lookup).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('fails closed during database failure and refuses cross-site calls', async () => {
    mocks.access.mockRejectedValueOnce(new Error('private database details'));
    expect((await POST(request(body))).status).toBe(503);
    expect((await POST(request(body,'https://evil.example'))).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('handles malformed multipart headers without throwing', async () => {
    const form = new FormData(); form.set('__sz_headers','broken-json');
    const response = await POST(new Request('http://localhost/api/creative/proxy', { method:'POST', headers:{host:'localhost'}, body:form }));
    expect(response.status).toBe(400);
  });
  it('reports upstream connection failure without secret leakage', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('secret upstream key'));
    const response=await POST(request(body)); expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('secret');
  });
  it('rejects excessive generation before DNS or paid upstream execution', async () => {
    mocks.rate.mockResolvedValueOnce({ allowed:false, reason:'rate_limited', retryAfterSeconds:40, remaining:0 });
    const response=await POST(request(body));
    expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('40');
    expect(mocks.lookup).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('admits a 100 request image burst and rejects its overflow while retaining the hourly account limit',async()=>{
    const counts=new Map<string,number>();
    mocks.rate.mockImplementation(async(namespace:string,_identity:string,limit:number)=>{
      const count=(counts.get(namespace)||0)+1;counts.set(namespace,count);
      return {allowed:count<=limit,remaining:Math.max(0,limit-count),retryAfterSeconds:count<=limit?0:60,reason:'rate_limited'};
    });
    mocks.fetch.mockImplementation(async()=>Response.json({data:[]}));
    const responses=await Promise.all(Array.from({length:100},()=>POST(request({url:"https://api.openai.com/v1/images/generations",method:"POST",headers:{authorization:"Bearer synthetic-concurrency-key"},bodyText:"{}"}))));
    expect(responses.every(response=>response.status===200)).toBe(true);
    expect(mocks.rate).toHaveBeenCalledWith('creative-execute-minute','stable-account',100,60);
    expect(mocks.rate).toHaveBeenCalledWith('creative-execute-hour','stable-account',500,3600);
    expect((await POST(request({url:"https://api.openai.com/v1/images/generations",method:"POST",headers:{authorization:"Bearer synthetic-concurrency-key"},bodyText:"{}"}))).status).toBe(429);expect(mocks.fetch).toHaveBeenCalledTimes(100);
  });
  it('fails closed if the shared security database is unavailable', async () => {
    mocks.rate.mockResolvedValueOnce({ allowed:false, reason:'unavailable', retryAfterSeconds:30, remaining:0 });
    expect((await POST(request(body))).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('uses a personal API on the same provider without reading or charging the platform wallet', async () => {
    mocks.available.mockResolvedValue({balanceCents:0,reservedCents:0,availableCents:0});
    const response = await POST(request({ ...body, headers: { authorization: 'Bearer client-secret' } }));
    expect(response.status).toBe(200);
    expect(mocks.fetch.mock.calls[0][1].headers.authorization).toBe('Bearer client-secret');
    expect(mocks.available).not.toHaveBeenCalled(); expect(mocks.supply).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.usage).not.toHaveBeenCalled(); expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('does not switch a rejected personal API to platform points', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({error:'invalid key'},{status:401}));
    const response=await POST(request({...body,headers:{authorization:'Bearer bad-personal-key'}}));
    expect(response.status).toBe(401); expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.supply).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.usage).not.toHaveBeenCalled();
  });

  it('offers a package before looking up platform supply when no points are available', async () => {
    mocks.available.mockResolvedValue({balanceCents:100,reservedCents:100,availableCents:0});
    const response=await POST(request(body)); expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({code:'INSUFFICIENT_BALANCE',purchaseUrl:'/models',providerSubmitted:false});
    expect(response.headers.get('X-Sanjie-Provider-Submission')).toBe('not-submitted');
    expect(mocks.supply).not.toHaveBeenCalled(); expect(mocks.sharedSupply).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('uses the approved existing platform source when personal API is absent and provisioned supply is pending', async () => {
    mocks.relay.mockResolvedValue({apiKey:'',baseUrl:'https://sub.shaozhuangai.com/v1',usdCnyRate:7.2});
    mocks.supply.mockRejectedValue(new UserSupplyError('pending',503,'USER_SUPPLY_PROVISION_PENDING'));
    mocks.sharedSupply.mockResolvedValue({baseUrl:'https://sub.shaozhuangai.com/v1',apiKey:'selected-existing-source',credentialFingerprint:'f'.repeat(64)});
    mocks.sharedHold.mockResolvedValue(true);
    mocks.fetch.mockResolvedValueOnce(new Response('{"data":[{"url":"https://images.example/result.png"}],"usage":{"actual_cost":0.01234567}}',{headers:{'content-type':'application/json'}}));
    const response=await POST(request(body));
    expect(response.status).toBe(200);
    expect(mocks.fetch.mock.calls[0][1].headers.authorization).toBe('Bearer selected-existing-source');
    expect(mocks.reserve).toHaveBeenCalledOnce(); expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(mocks.sharedBind).toHaveBeenCalledExactlyOnceWith({userId:'user-1',eventId:mocks.reserve.mock.calls[0][0].eventId,credentialFingerprint:'f'.repeat(64)});
    expect(mocks.bind).not.toHaveBeenCalled();
    expect(mocks.usage.mock.calls[0][0].metadata).toMatchObject({usdCostLexical:'0.01234567'});
    expect(await response.text()).not.toContain('selected-existing-source');
  });

  it('settles a normal successful platform image without a fabricated upstream cost', async () => {
    mocks.relay.mockResolvedValue({apiKey:'',baseUrl:'https://sub.shaozhuangai.com/v1',usdCnyRate:7.2});
    mocks.supply.mockRejectedValue(new UserSupplyError('pending',503,'USER_SUPPLY_PROVISION_PENDING'));
    mocks.sharedSupply.mockResolvedValue({baseUrl:'https://sub.shaozhuangai.com/v1',apiKey:'selected-existing-source',credentialFingerprint:'f'.repeat(64)});
    mocks.sharedHold.mockResolvedValue(true);
    mocks.fetch.mockResolvedValueOnce(Response.json({data:[{url:'https://images.example/result.png'}]}));
    const response=await POST(request(body));
    expect(response.status).toBe(200); expect(mocks.durablePricing).toHaveBeenCalledOnce();
    expect(mocks.unknown).not.toHaveBeenCalled(); expect(mocks.settle).toHaveBeenCalledOnce();
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({costCents:50,baseCostCents:50,imageCount:1,
      metadata:expect.objectContaining({costSource:'catalog',localChargeEvidence:expect.objectContaining({success:true,quantity:1,pricingHash:expect.stringMatching(/^[a-f0-9]{64}$/),outcomeHash:expect.stringMatching(/^[a-f0-9]{64}$/)})})}),{transaction:'settlement'});
    const metadata=mocks.usage.mock.calls[0][0].metadata;
    expect(metadata.usdCost).toBeUndefined(); expect(metadata.usdCostLexical).toBeUndefined();
    expect(await response.text()).not.toContain('selected-existing-source');
  });

  it('preserves supply configuration failures without switching to the shared platform credential', async () => {
    mocks.supply.mockRejectedValue(new UserSupplyError('decryption unavailable',503,'USER_SUPPLY_DECRYPTION_FAILED'));
    expect((await POST(request(body))).status).toBe(503);
    expect(mocks.sharedSupply).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('polls a shared-source video with its fixed existing source key without charging again', async () => {
    mocks.relay.mockResolvedValue({apiKey:'',baseUrl:'https://sub.shaozhuangai.com/v1',usdCnyRate:7.2});
    mocks.videoJob.mockResolvedValue({provider:'shaozhuang',baseUrl:'https://sub.shaozhuangai.com/v1',model:'video',upstreamModel:'video'});
    mocks.sharedVideoBinding.mockResolvedValue({epochId:'epoch-fixed',providerBaseUrl:'https://sub.shaozhuangai.com/v1',credentialFingerprint:'f'.repeat(64),configVersion:'v-fixed'});
    mocks.sharedRuntime.mockResolvedValue({baseUrl:'https://sub.shaozhuangai.com/v1',apiKey:'fixed-original-source',credentialFingerprint:'f'.repeat(64),configVersion:'v-fixed',epoch:null});
    expect((await POST(request({url:'https://sub.shaozhuangai.com/v1/videos/task_1',method:'GET'}))).status).toBe(200);
    expect(mocks.sharedVideoBinding).toHaveBeenCalledExactlyOnceWith('user-1','task_1');
    expect(mocks.fetch.mock.calls[0][1].headers.authorization).toBe('Bearer fixed-original-source');
    expect(mocks.available).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.usage).not.toHaveBeenCalled();
  });

  it('keeps the original shared video task when the source key has changed', async () => {
    mocks.videoJob.mockResolvedValue({provider:'shaozhuang',baseUrl:'https://sub.shaozhuangai.com/v1',model:'video',upstreamModel:'video'});
    mocks.sharedVideoBinding.mockResolvedValue({epochId:'epoch-fixed',providerBaseUrl:'https://sub.shaozhuangai.com/v1',credentialFingerprint:'f'.repeat(64),configVersion:'v-fixed'});
    mocks.sharedRuntime.mockResolvedValue({baseUrl:'https://sub.shaozhuangai.com/v1',apiKey:'changed-source',credentialFingerprint:'e'.repeat(64),configVersion:'v-fixed',epoch:null});
    const response=await POST(request({url:'https://sub.shaozhuangai.com/v1/videos/task_1',method:'GET'}));
    expect(response.status).toBe(409); expect(response.headers.get('X-Sanjie-Provider-Submission')).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.release).not.toHaveBeenCalled(); expect(mocks.unknown).not.toHaveBeenCalled();
  });

  it('debits the logged-in tenant and calls the supply subscription with the billed upstream model', async () => {
    mocks.user.mockResolvedValue({ id: 'user-1', username: 'tenant', shopName: '西西礼', tenant: { name: '西西礼' } });
    mocks.relay.mockResolvedValue({ apiKey: 'platform-key', shopKeys: [{ shopName: '西西礼', purpose: 'default', apiKey: 'xixi-key' }], usdCnyRate: 7.2, baseUrl: 'https://sub.shaozhuangai.com/v1', models: [] });
    mocks.findModel.mockResolvedValue({ id: 'chatGPT5.5', upstreamModel: 'gpt-5.6-sol', provider: 'shaozhuang', kind: 'chat', endpoint: 'chat.completions', promptCentsPer1K: 2, completionCentsPer1K: 6 });
    mocks.snapshot.mockResolvedValue({ userId: 'user-1', tenantId: 'tenant', username: 'tenant', userName: '租户', planCode: 'growth', planName: '增长版', multiplierBps: 10000, ruleVersion: 1, quotedAt: '2026-10-03T00:00:00.000Z' });
    mocks.balance.mockResolvedValue(true);
    mocks.usage.mockResolvedValue({ id: 'usage-1' });
    mocks.fetch.mockResolvedValue(Response.json({ id: 'chat_1', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, actual_cost: 0.01 } }));
    const response = await POST(request({
      url: 'https://sub.shaozhuangai.com/v1/chat/completions', method: 'POST',
      bodyText: JSON.stringify({ model: 'chatGPT5.5', messages: [{ role: 'user', content: '你好' }] })
    }));
    expect(response.status).toBe(200);
    const init = mocks.fetch.mock.calls[0][1];
    expect(init.headers.authorization).toBe('Bearer platform-key');
    expect(JSON.parse(init.body)).toMatchObject({ model: 'gpt-5.6-sol' });
    expect(JSON.stringify(init.headers)).not.toContain('client-secret');
    expect(JSON.stringify(init.headers)).not.toContain('xixi-key');
    expect(mocks.usage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      baseCostCents: 8, costCents: 8, status: 'ok', model: 'chatGPT5.5',
      metadata: expect.objectContaining({ costSource: 'upstream_usd', usdCost: '0.01', source: 'hosted_supply' })
    }), {transaction:'settlement'});
    expect(JSON.stringify(mocks.usage.mock.calls[0][0])).not.toContain('platform-key');
  });

  it('stops before the supply call when the tenant balance cannot cover the model', async () => {
    mocks.user.mockResolvedValue({ id: 'user-1', username: 'tenant', shopName: '', tenant: { name: '租户' } });
    mocks.relay.mockResolvedValue({ apiKey: 'platform-key', shopKeys: [], usdCnyRate: null, baseUrl: 'https://sub.shaozhuangai.com/v1', models: [] });
    mocks.findModel.mockResolvedValue({ id: 'image2', upstreamModel: 'gpt-image-2', provider: 'shaozhuang', kind: 'image', endpoint: 'images.generations', imageCents: 50 });
    mocks.snapshot.mockResolvedValue({ userId: 'user-1', tenantId: 'tenant', username: 'tenant', userName: '租户', planCode: 'free', planName: '体验版', multiplierBps: 10000, ruleVersion: 0, quotedAt: '2026-10-03T00:00:00.000Z' });
    mocks.reserve.mockRejectedValueOnce(new GatewayBillingError('INSUFFICIENT_BALANCE','可用积分不足',402));
    mocks.usage.mockResolvedValue({ id: 'usage-rejected' });
    const response = await POST(request({
      url: 'https://sub.shaozhuangai.com/v1/images/generations', method: 'POST',
      bodyText: JSON.stringify({ model: 'image2', prompt: '一张主图', n: 1 })
    }));
    expect(response.status).toBe(402);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.usage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'error', error: 'INSUFFICIENT_BALANCE', costCents: 0 }));
  });

  it('retains the reservation when the supply connection fails after dispatch', async () => {
    mocks.user.mockResolvedValue({ id: 'user-1', username: 'tenant', shopName: '', tenant: { name: '租户' } });
    mocks.relay.mockResolvedValue({ apiKey: 'platform-key', shopKeys: [], usdCnyRate: null, baseUrl: 'https://sub.shaozhuangai.com/v1', models: [] });
    mocks.findModel.mockResolvedValue({ id: 'image2', upstreamModel: 'gpt-image-2', provider: 'shaozhuang', kind: 'image', endpoint: 'images.generations', imageCents: 50 });
    mocks.snapshot.mockResolvedValue({ userId: 'user-1', tenantId: 'tenant', username: 'tenant', userName: '租户', planCode: 'free', planName: '体验版', multiplierBps: 10000, ruleVersion: 0, quotedAt: '2026-10-03T00:00:00.000Z' });
    mocks.balance.mockResolvedValue(true);
    mocks.usage.mockResolvedValue({ id: 'usage-failed' });
    mocks.fetch.mockRejectedValueOnce(new Error('secret upstream key'));
    const response = await POST(request({
      url: 'https://sub.shaozhuangai.com/v1/images/generations', method: 'POST',
      bodyText: JSON.stringify({ model: 'image2', prompt: '一张主图' })
    }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('secret');
    expect(mocks.usage).not.toHaveBeenCalled();
    expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({userId:'user-1',reason:'disconnect'}));
  });

  it('accepts the official public origin behind an internal proxy without trusting Host', async () => {
    vi.stubEnv('NODE_ENV','production');
    const response=await POST(new Request('https://localhost:3040/api/creative/proxy', {
      method:'POST', headers:{origin:'https://shaozhuangai.com',host:'localhost:3040','content-type':'application/json'}, body:JSON.stringify(body)
    }));
    expect(response.status).toBe(200);
  });

  it.each(['{}', '{"prompt":"image"}', '{"model":""}', '{"model":42}', '[]', 'null', 'broken-json'])('rejects hosted generation without a valid model (%s)', async (bodyText) => {
    expect((await POST(request({...body,bodyText}))).status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it.each([
    ['/v1/models','GET'],['/v1/videos','GET'],['/v1/responses','POST'],['/v1/batches','POST'],
    ['/admin/keys','GET'],['/other/images/generations','POST'],['/v1/images/generations?model=image2','POST'],
    ['/v1/videos/task_foreign','DELETE']
  ])('does not lend the platform key to unknown hosted path %s (%s)', async (path,method) => {
    expect((await POST(request({...body,url:`https://sub.shaozhuangai.com${path}`,method}))).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('keeps personal API usable when no platform key is configured', async () => {
    mocks.relay.mockResolvedValue({...await mocks.relay(),apiKey:''});
    const response=await POST(request({...body,headers:{authorization:'Bearer client-key'}}));
    expect(response.status).toBe(200); expect(mocks.fetch.mock.calls[0][1].headers.authorization).toBe('Bearer client-key');
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.sharedSupply).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled(); expect(mocks.usage).not.toHaveBeenCalled();
  });

  it('fails closed when the live user or relay lookup is unavailable', async () => {
    mocks.user.mockResolvedValueOnce(null);
    expect((await POST(request(body))).status).toBe(401);
    mocks.relay.mockRejectedValueOnce(new Error('private file details'));
    const response = await POST(request(body));
    expect(response.status).toBe(503);
    expect(response.headers.get('X-Sanjie-Provider-Submission')).toBe('not-submitted');
    expect(await response.json()).toEqual({ error:'供应订阅暂不可用，请稍后重试', code:'CREATIVE_SUPPLY_UNAVAILABLE', providerSubmitted:false, definitiveFailure:true });
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled(); expect(mocks.usage).not.toHaveBeenCalled();
  });

  it('rejects multipart image edits before submitting reference images when supply is unconfigured', async () => {
    mocks.relay.mockResolvedValue({...await mocks.relay(),apiKey:''});
    const form = new FormData();
    form.set('__sz_url', 'https://sub.shaozhuangai.com/v1/images/edits');
    form.set('__sz_method', 'POST');
    form.set('__sz_headers', '{}');
    form.set('model', 'gpt-image-2');
    form.set('prompt', '商品主图');
    form.set('image', new Blob(['reference image fixture'], { type: 'image/png' }), 'product.png');
    const response = await POST(new Request('http://localhost/api/creative/proxy', { method:'POST', headers:{host:'localhost'}, body:form }));
    expect(response.status).toBe(503);
    expect(response.headers.get('X-Sanjie-Provider-Submission')).toBe('not-submitted');
    expect(await response.json()).toMatchObject({ code:'CREATIVE_SUPPLY_NOT_CONFIGURED', providerSubmitted:false, definitiveFailure:true });
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.usage).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('never forwards a provider-supplied pre-submission marker', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({
      error:'provider unavailable', code:'CREATIVE_SUPPLY_NOT_CONFIGURED', providerSubmitted:false, definitiveFailure:true
    }, { status:503, headers:{'X-Sanjie-Provider-Submission':'not-submitted'} }));
    const response = await POST(request({...body,url:'https://api.openai.com/v1/images/generations'}));
    expect(response.status).toBe(503);
    expect(response.headers.get('X-Sanjie-Provider-Submission')).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    {method:'GET',unavailable:false}, {method:'HEAD',unavailable:false},
    {method:'GET',unavailable:true}, {method:'HEAD',unavailable:true}
  ])('does not mark an existing video task unsubmitted when $method polling fails (unavailable=$unavailable)', async ({method,unavailable}) => {
    if (unavailable) mocks.relay.mockRejectedValueOnce(new Error('private relay configuration details'));
    else mocks.relay.mockResolvedValue({...await mocks.relay(),apiKey:''});
    mocks.videoJob.mockResolvedValue({ provider:'shaozhuang', baseUrl:'https://sub.shaozhuangai.com/v1', upstreamModel:'video', model:'video' });
    const response = await POST(request({url:'https://sub.shaozhuangai.com/v1/videos/existing-task',method}));
    expect(response.status).toBe(503);
    expect(response.headers.get('X-Sanjie-Provider-Submission')).toBeNull();
    const error = await response.json();
    expect(error).not.toHaveProperty('providerSubmitted');
    expect(error).not.toHaveProperty('definitiveFailure');
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('does not apply a credential from another relay origin to the hosted origin', async () => {
    mocks.relay.mockResolvedValue({...await mocks.relay(),baseUrl:'https://other.example/v1'});
    expect((await POST(request(body))).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('redacts a platform key reflected in upstream JSON and exposes the public model alias', async () => {
    mocks.fetch.mockResolvedValue(Response.json({data:[{url:'https://images.example/image.png',message:'Bearer platform-key'}],debug:{key:'platform-key'},'platform-key':'key name'}));
    const response=await POST(request(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({model:'image2',debug:{key:'[redacted]'},data:[{message:'Bearer [redacted]'}],'[redacted]':'key name'});
  });

  it('namespaces supplier idempotency by the persisted billing event and marks dispatch before fetch', async () => {
    expect((await POST(request({...body,headers:{'idempotency-key':'same-browser-key'}}))).status).toBe(200);
    const reservation=mocks.reserve.mock.calls[0][0];
    expect(reservation.idempotencyKey).toBe('same-browser-key');
    expect(mocks.fetch.mock.calls[0][1].headers['idempotency-key']).toBe(reservation.eventId);
    expect(mocks.fetch.mock.calls[0][1].headers['content-type']).toBe('application/json');
    expect(mocks.dispatch.mock.invocationCallOrder[0]).toBeLessThan(mocks.fetch.mock.invocationCallOrder[0]);
  });

  it('does not send duplicate supplier requests for a persisted idempotency replay', async () => {
    mocks.reserve.mockResolvedValueOnce({hold:{eventId:'original-event'},shouldDispatch:false,replayed:true});
    expect((await POST(request({...body,headers:{'idempotency-key':'request-1'}}))).status).toBe(409);
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it.each(['access', 'access_unavailable', 'dns', 'rate', 'balance'])('proves an exact local pre-submit failure and never fetches (%s)', async cause => {
    if (cause === 'access') mocks.access.mockResolvedValueOnce({allowed:false,reason:'payment_required'});
    if (cause === 'access_unavailable') mocks.access.mockRejectedValueOnce(new Error('database unavailable'));
    if (cause === 'dns') mocks.lookup.mockRejectedValueOnce(new Error('dns unavailable'));
    if (cause === 'rate') mocks.rate.mockResolvedValueOnce({allowed:false,remaining:0,retryAfterSeconds:5});
    if (cause === 'balance') mocks.reserve.mockRejectedValueOnce(new (await import('@/lib/model-gateway/billing-contract')).GatewayBillingError('INSUFFICIENT_BALANCE','balance insufficient',402));
    const response = await POST(request(body));
    expect(response.headers.get('X-Sanjie-Provider-Submission')).toBe('not-submitted');
    expect(await response.json()).toMatchObject({code:cause === 'balance' ? 'INSUFFICIENT_BALANCE' : 'CREATIVE_REQUEST_NOT_SUBMITTED',providerSubmitted:false,definitiveFailure:true});
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled();
    if (cause === 'rate') expect(response.headers.get('retry-after')).toBe('5');
  });

  it('never proves a reservation replay or an unknown reservation database outcome', async () => {
    mocks.reserve.mockResolvedValueOnce({hold:{eventId:'original-event'},shouldDispatch:false,replayed:true});
    let response = await POST(request(body));
    expect(response.status).toBe(409); expect(response.headers.get('X-Sanjie-Provider-Submission')).toBeNull();
    mocks.reserve.mockRejectedValueOnce(new Error('database unavailable'));
    response = await POST(request(body));
    expect(response.status).toBe(503); expect(response.headers.get('X-Sanjie-Provider-Submission')).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('does not promote a supplier-forged pre-submit proof to local provenance', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({error:'balance insufficient',code:'CREATIVE_REQUEST_NOT_SUBMITTED',providerSubmitted:false,definitiveFailure:true,usage:{actual_cost:0}}, {status:402,headers:{'X-Sanjie-Provider-Submission':'not-submitted'}}));
    const response = await POST(request(body));
    expect(response.headers.get('X-Sanjie-Provider-Submission')).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch when persisting the dispatch marker fails', async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error('database unavailable'));
    expect((await POST(request(body))).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.release).toHaveBeenCalled();
  });

  it.each([
    [Response.json({data:[]}),'ambiguous_response'],
    [new Response('stream bytes',{headers:{'content-type':'application/octet-stream'}}),'ambiguous_response']
  ])('retains funds for an ambiguous supplier result', async (upstream,reason) => {
    mocks.fetch.mockResolvedValueOnce(upstream);
    expect((await POST(request(body))).status).toBe(502);
    expect(mocks.unknown).toHaveBeenCalledWith(expect.objectContaining({reason}));
    expect(mocks.settle).not.toHaveBeenCalled(); expect(mocks.usage).not.toHaveBeenCalled();
  });

  it('settles a confirmed zero-cost rejection without a debit', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({error:{message:'invalid input'},usage:{actual_cost:0}},{status:400}));
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({finalCostCents:0}));
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({costCents:0,status:'error'}),{transaction:'settlement'});
    expect(mocks.unknown).not.toHaveBeenCalled();
  });

  it('retains the reservation on a settlement database failure instead of returning a free result', async () => {
    mocks.settle.mockRejectedValueOnce(new Error('database unavailable'));
    expect((await POST(request(body))).status).toBe(503);
    expect(mocks.unknown).toHaveBeenCalledWith(expect.objectContaining({reason:'settlement_failed'}));
    expect(mocks.usage).not.toHaveBeenCalled();
  });

  it.each(['GET','HEAD'])('denies another user video status or download (%s)', async (method) => {
    expect((await POST(request({url:'https://sub.shaozhuangai.com/v1/videos/task_foreign/content',method}))).status).toBe(404);
    expect(mocks.videoJob).toHaveBeenCalledWith('user-1','task_foreign');
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('checks owned video metadata before reading without charging again', async () => {
    mocks.videoJob.mockResolvedValueOnce({provider:'shaozhuang',model:'relay-video',baseUrl:'https://sub.shaozhuangai.com/v1',upstreamModel:'provider-video'});
    mocks.fetch.mockResolvedValueOnce(Response.json({id:'task_1',status:'completed',debug:'platform-key'}));
    const response=await POST(request({url:'https://sub.shaozhuangai.com/v1/requests/task_1',method:'GET'}));
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('platform-key');
    expect(mocks.fetch.mock.calls[0][0]).toBe('https://sub.shaozhuangai.com/v1/requests/task_1');
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.usage).not.toHaveBeenCalled();
  });

  it('streams only owned video content without leaking upstream cookies', async () => {
    mocks.videoJob.mockResolvedValueOnce({provider:'shaozhuang',model:'relay-video',baseUrl:'https://sub.shaozhuangai.com/v1',upstreamModel:'provider-video'});
    mocks.fetch.mockResolvedValueOnce(new Response('video',{headers:{'content-type':'video/mp4','set-cookie':'private=session'}}));
    const response=await POST(request({url:'https://sub.shaozhuangai.com/v1/videos/task_1/content?variant=video',method:'GET'}));
    expect(response.status).toBe(200); expect(await response.text()).toBe('video');
    expect(response.headers.get('set-cookie')).toBeNull(); expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('normalizes accepted hosted video task IDs and records ownership metadata', async () => {
    mocks.findModel.mockResolvedValueOnce({id:'relay-video',upstreamModel:'provider-video',provider:'shaozhuang',kind:'video',endpoint:'videos',videoCents:120});
    mocks.fetch.mockResolvedValueOnce(Response.json({data:{task_id:'task_new'},status:'queued'},{status:202}));
    const response=await POST(request({url:'https://sub.shaozhuangai.com/v1/videos',method:'POST',bodyText:JSON.stringify({model:'relay-video',prompt:'视频画面'})}));
    expect(response.status).toBe(202); expect(await response.json()).toMatchObject({id:'task_new',model:'relay-video'});
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({requestId:'task_new',costCents:120,metadata:expect.objectContaining({baseUrl:'https://sub.shaozhuangai.com/v1',billing:'accepted_task'})}),{transaction:'settlement'});
  });

  it('keeps another provider BYOK isolated from the platform key and wallet', async () => {
    const response=await POST(request({...body,url:'https://api.openai.com/v1/images/generations',headers:{authorization:'Bearer own-key'}}));
    expect(response.status).toBe(200); expect(mocks.fetch.mock.calls[0][1].headers.authorization).toBe('Bearer own-key');
    expect(mocks.relay).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.usage).not.toHaveBeenCalled();
  });

  it.each([{}, {max_tokens:256}, {max_completion_tokens:512}])('quotes the exact chat output-token budget that it sends (%j)', async (budget) => {
    mocks.findModel.mockResolvedValueOnce({id:'chatGPT5.5',upstreamModel:'gpt-5.6-sol',provider:'shaozhuang',kind:'chat',endpoint:'chat.completions',promptCentsPer1K:2,completionCentsPer1K:6});
    mocks.fetch.mockResolvedValueOnce(Response.json({id:'chat_1',choices:[{message:{content:'ok'}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));
    expect((await POST(request({url:'https://sub.shaozhuangai.com/v1/chat/completions',method:'POST',bodyText:JSON.stringify({model:'chatGPT5.5',messages:[{role:'user',content:'你好'}],...budget})}))).status).toBe(200);
    const sent=JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(sent.max_tokens??sent.max_completion_tokens).toBe(budget.max_tokens??budget.max_completion_tokens??1024);
    expect(mocks.reserve.mock.calls[0][0].quoteCents).toBe(1+Math.ceil((sent.max_tokens??sent.max_completion_tokens)/1000*6));
    expect(mocks.reserve.mock.calls[0][0].requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([{max_tokens:10,max_completion_tokens:20},{max_tokens:-1},{max_tokens:1.5},{stream:true}])('rejects invalid or ambiguous chat budgets before freezing (%j)', async (budget) => {
    mocks.findModel.mockResolvedValueOnce({id:'chatGPT5.5',upstreamModel:'gpt-5.6-sol',provider:'shaozhuang',kind:'chat',endpoint:'chat.completions',promptCentsPer1K:2,completionCentsPer1K:6});
    expect((await POST(request({url:'https://sub.shaozhuangai.com/v1/chat/completions',method:'POST',bodyText:JSON.stringify({model:'chatGPT5.5',messages:[{role:'user',content:'你好'}],...budget})}))).status).toBe(400);
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects duplicate multipart count before the supplier can select a different value', async () => {
    const form=new FormData(); form.set('__sz_url','https://sub.shaozhuangai.com/v1/images/edits');
    form.set('model','image2'); form.set('prompt','商品主图'); form.append('image',new Blob(['image']), 'sample.png');
    form.append('n','1'); form.append('n','10');
    expect((await POST(new Request('http://localhost/api/creative/proxy',{method:'POST',headers:{origin:'http://localhost'},body:form}))).status).toBe(400);
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rewrites billed multipart edits while preserving the uploaded image and canonical fingerprint', async () => {
    const form=new FormData(); form.set('__sz_url','https://sub.shaozhuangai.com/v1/images/edits');
    form.set('model','image2'); form.set('prompt','商品主图'); form.set('n','1'); form.append('image',new Blob(['image'],{type:'image/png'}), 'sample.png');
    expect((await POST(new Request('http://localhost/api/creative/proxy',{method:'POST',headers:{origin:'http://localhost'},body:form}))).status).toBe(200);
    const sent=mocks.fetch.mock.calls[0][1].body as FormData;
    expect(sent.get('model')).toBe('gpt-image-2'); expect((sent.get('image') as Blob).size).toBe(5);
    expect(mocks.reserve.mock.calls[0][0]).toMatchObject({endpoint:'images.edits',quoteCents:50,requestFingerprint:expect.stringMatching(/^[a-f0-9]{64}$/)});
  });

  it('enforces the actual request stream limit without Content-Length before reading JSON or dispatching', async () => {
    const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(32*1024*1024+1));controller.close();}});
    const req=new Request('http://localhost/api/creative/proxy',{method:'POST',headers:{origin:'http://localhost','content-type':'application/json'},body:stream,duplex:'half'} as RequestInit);
    expect((await POST(req)).status).toBe(413); expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('bounds chunked upstream JSON and retains funds when the response exceeds the limit', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(32*1024*1024+1));controller.close();}}),{headers:{'content-type':'application/json'}}));
    const response=await POST(request(body));
    expect(response.status).toBe(502); expect(response.headers.get('x-gateway-billing-id')).toBe(mocks.reserve.mock.calls[0][0].eventId);
    expect(mocks.unknown).toHaveBeenCalled(); expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('retains a timed out call as unknown and tells the caller not to retry generation automatically', async () => {
    const error=new Error('timeout'); error.name='TimeoutError'; mocks.fetch.mockRejectedValueOnce(error);
    const response=await POST(request(body));
    expect(response.status).toBe(504); expect(await response.text()).toContain('请勿自动重试');
    expect(mocks.unknown).toHaveBeenCalledWith(expect.objectContaining({reason:'timeout'})); expect(mocks.settle).not.toHaveBeenCalled();
  });


describe("creative hosted supply exchange-rate quote", () => {
  const fx={rate:7.2,source:"ecb",referenceDate:"2026-10-02",fetchedAt:"2026-10-02T16:05:00.000Z",id:"c".repeat(64)};
  const fxView={mode:"automatic",status:"ready",source:fx.source,referenceDate:fx.referenceDate,fetchedAt:fx.fetchedAt,id:fx.id};
  it("blocks invalid automatic FX before reservation or supply POST", async () => {
    vi.stubEnv("MODEL_GATEWAY_FX_AUTOMATIC","1");
    mocks.relay.mockResolvedValue({...await mocks.relay(),usdCnyRate:null,exchangeRate:{...fxView,status:"unavailable"}});
    expect((await POST(request(body))).status).toBe(503);
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("freezes server provenance, ignores browser FX, and settles the old rate across a daily update", async () => {
    vi.stubEnv("MODEL_GATEWAY_FX_AUTOMATIC","1");
    mocks.relay.mockResolvedValue({...await mocks.relay(),usdCnyRate:7.2,exchangeRate:fxView});
    mocks.fetch.mockImplementation(async () => {
      mocks.relay.mockResolvedValue({...await mocks.relay(),usdCnyRate:9,exchangeRate:{...fxView,id:"d".repeat(64)}});
      return Response.json({data:[{url:"https://images.example/result.png"}],usage:{actual_cost:0.01}});
    });
    expect((await POST(request({...body,fxSnapshot:{...fx,rate:0.01},bodyText:JSON.stringify({model:"image2",prompt:"photo",fxSnapshot:{...fx,rate:0.01}})}))).status).toBe(200);
    expect(mocks.reserve.mock.calls[0][0].billingSnapshot.fxSnapshot).toEqual(fx);
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({baseCostCents:8,costCents:8,
      metadata:expect.objectContaining({fxSource:"ecb",fxQuoteId:fx.id,fxReferenceDate:fx.referenceDate,usdCnyRate:"7.2"})}),{transaction:"settlement"});
  });
  it("preserves BYOK calls when automatic platform FX is unavailable", async () => {
    vi.stubEnv("MODEL_GATEWAY_FX_AUTOMATIC","1");
    mocks.relay.mockResolvedValue({...await mocks.relay(),usdCnyRate:null,exchangeRate:{...fxView,status:"unavailable"}});
    mocks.relay.mockClear();
    expect((await POST(request({...body,url:"https://api.openai.com/v1/images/generations",headers:{authorization:"Bearer test-byok"}}))).status).toBe(200);
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.relay).not.toHaveBeenCalled();
    expect(mocks.fetch.mock.calls[0][1].headers.authorization).toBe("Bearer test-byok");
  });
});

});
