import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), access: vi.fn(), lookup: vi.fn(), fetch: vi.fn(), rate: vi.fn(), relay: vi.fn(),
  balance: vi.fn(), usage: vi.fn(), snapshot: vi.fn(), findModel: vi.fn(),
  supply: vi.fn(), credential: vi.fn(), videoJob: vi.fn()
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/server-session', () => ({ getCurrentSession: mocks.session, getCurrentUser: mocks.user }));
vi.mock('@/lib/model-gateway/relay-config', () => ({ getRelayRuntime: mocks.relay }));
vi.mock('@/lib/model-gateway/user-supply', () => ({ getUserSupplyRuntime: mocks.supply, getUserSupplyCredential: mocks.credential }));
vi.mock('@/lib/model-gateway/video-jobs', () => ({ findGatewayVideoJob: mocks.videoJob }));
vi.mock('@/lib/model-gateway/store', () => ({ assertGatewayBalance: mocks.balance, recordGatewayUsage: mocks.usage }));
vi.mock('@/lib/model-gateway/billing', () => ({ getGatewayBillingSnapshot: mocks.snapshot }));
vi.mock('@/lib/model-gateway/runtime-catalog', () => ({ findAvailableGatewayModel: mocks.findModel }));
vi.mock('@/lib/creative-entitlements', () => ({ getCreativeAccessForSession: mocks.access }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('@/lib/model-gateway/relay-network', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/model-gateway/relay-network')>(), relayFetch: mocks.fetch
}));
vi.mock('@/lib/security-rate-limit', () => ({ consumeSecurityRateLimit: mocks.rate }));
vi.mock('@/lib/security-web-account', () => ({ securityAccountIdentity: () => 'stable-account' }));
import { POST } from './route';
function request(body: unknown, origin='http://localhost') {
  return new Request('http://localhost/api/creative/proxy', { method:'POST', headers:{ origin, host:'localhost', 'content-type':'application/json' }, body:JSON.stringify(body) });
}
const body = { url:'https://api.openai.com/v1/images/generations', method:'POST', bodyText:'{}' };
const supplyUrl = 'https://sub.shaozhuangai.com/v1/images/generations';
function supplyRuntime(apiKey = '', usdCnyRate: number | null = null) {
  return { baseUrl: 'https://sub.shaozhuangai.com/v1', primary: { id: 'user-1-primary', apiKey }, backup: { id: 'user-1-backup', apiKey: apiKey ? 'backup-key' : '' }, usdCnyRate };
}
function imageFixture() {
  mocks.user.mockResolvedValue({ id: 'user-1', username: 'tenant' });
  mocks.supply.mockResolvedValue(supplyRuntime('user-1-key'));
  mocks.findModel.mockResolvedValue({ id: 'image2', upstreamModel: 'gpt-image-2', provider: 'shaozhuang', kind: 'image', endpoint: 'images.generations', imageCents: 50 });
  mocks.snapshot.mockResolvedValue({ userId: 'user-1', tenantId: 'tenant', username: 'tenant', userName: '租户', planCode: 'free', planName: '体验版', multiplierBps: 10000, ruleVersion: 0, quotedAt: '2026-10-03T00:00:00.000Z' });
  mocks.balance.mockResolvedValue(true);
  mocks.usage.mockResolvedValue({ id: 'usage-1' });
}
describe('creative forwarding live access gates', () => {
  beforeEach(() => {
    vi.resetAllMocks(); vi.stubGlobal('fetch', mocks.fetch); vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('PUBLIC_APP_ORIGIN', '');
    mocks.rate.mockResolvedValue({ allowed:true, remaining:10, retryAfterSeconds:0 });
    mocks.session.mockResolvedValue({ username:'user', role:'tenant', tenantId:'tenant' });
    mocks.user.mockResolvedValue(null);
    mocks.relay.mockResolvedValue({ apiKey: '', shopKeys: [], usdCnyRate: null, baseUrl: 'https://sub.shaozhuangai.com/v1', models: [] });
    mocks.supply.mockResolvedValue(supplyRuntime());
    mocks.access.mockResolvedValue({ allowed:true, reason:'invited' });
    mocks.lookup.mockResolvedValue([{ address:'8.8.8.8' }]);
    mocks.fetch.mockResolvedValue(Response.json({ data:[] }));
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
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
    const responses=await Promise.all(Array.from({length:100},()=>POST(request(body))));
    expect(responses.every(response=>response.status===200)).toBe(true);
    expect(mocks.rate).toHaveBeenCalledWith('creative-execute-minute','stable-account',100,60);
    expect(mocks.rate).toHaveBeenCalledWith('creative-execute-hour','stable-account',500,3600);
    expect((await POST(request(body))).status).toBe(429);expect(mocks.fetch).toHaveBeenCalledTimes(100);
  });
  it('fails closed if the shared security database is unavailable', async () => {
    mocks.rate.mockResolvedValueOnce({ allowed:false, reason:'unavailable', retryAfterSeconds:30, remaining:0 });
    expect((await POST(request(body))).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('replaces a browser relay key with the authenticated account supply key during model reads', async () => {
    mocks.user.mockResolvedValue({ id: 'user-1', username: 'tenant', shopName: '西西礼', tenant: { name: '西西礼' } });
    mocks.relay.mockResolvedValue({ apiKey: 'platform-key', shopKeys: [{ shopName: '西西礼', purpose: 'default', apiKey: 'xixi-key' }], usdCnyRate: 7.2, baseUrl: 'https://sub.shaozhuangai.com/v1', models: [] });
    mocks.supply.mockResolvedValue(supplyRuntime('user-1-key'));
    const response = await POST(request({ url: 'https://sub.shaozhuangai.com/v1/models', method: 'GET', headers: { authorization: 'Bearer client-secret' } }));
    expect(response.status).toBe(200);
    const headers = mocks.fetch.mock.calls[0][1].headers;
    expect(headers.authorization).toBe('Bearer user-1-key');
    expect(mocks.supply).toHaveBeenCalledExactlyOnceWith('user-1');
    expect(JSON.stringify(headers)).not.toContain('client-secret');
    expect(JSON.stringify(headers)).not.toContain('xixi-key');
    expect(await response.text()).not.toContain('platform-key');
    expect(mocks.usage).not.toHaveBeenCalled();
  });

  it.each([
    { unavailable: false, code: 'CREATIVE_SUPPLY_NOT_CONFIGURED', error: '供应订阅未配置，请联系管理员' },
    { unavailable: true, code: 'CREATIVE_SUPPLY_UNAVAILABLE', error: '供应订阅暂不可用，请稍后重试' }
  ])('marks $code as a local rejection before billing or provider submission', async ({ unavailable, code, error }) => {
    mocks.user.mockResolvedValue({ id: 'user-1', username: 'tenant' });
    if (unavailable) mocks.supply.mockRejectedValueOnce(new Error('private relay configuration details'));
    const response = await POST(request({ ...body, url: supplyUrl, bodyText: JSON.stringify({ model: 'image2', prompt: '商品主图' }) }));
    expect(response.status).toBe(503);
    expect(response.headers.get('X-Sanjie-Provider-Submission')).toBe('not-submitted');
    expect(await response.json()).toEqual({ error, code, providerSubmitted: false, definitiveFailure: true });
    expect(mocks.findModel).not.toHaveBeenCalled();
    expect(mocks.balance).not.toHaveBeenCalled();
    expect(mocks.usage).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects multipart image edits before submitting uploaded reference images when supply is unconfigured', async () => {
    mocks.user.mockResolvedValue({ id: 'user-1', username: 'tenant' });
    const form = new FormData();
    form.set('__sz_url', 'https://sub.shaozhuangai.com/v1/images/edits');
    form.set('__sz_method', 'POST');
    form.set('__sz_headers', '{}');
    form.set('model', 'gpt-image-2');
    form.set('prompt', '商品主图');
    form.set('image', new Blob(['reference image fixture'], { type: 'image/png' }), 'product.png');
    const response = await POST(new Request('http://localhost/api/creative/proxy', { method: 'POST', headers: { host: 'localhost' }, body: form }));
    expect(response.status).toBe(503);
    expect(response.headers.get('X-Sanjie-Provider-Submission')).toBe('not-submitted');
    expect(await response.json()).toMatchObject({ code: 'CREATIVE_SUPPLY_NOT_CONFIGURED', providerSubmitted: false, definitiveFailure: true });
    expect(mocks.usage).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('never forwards a provider-supplied pre-submission marker', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({
      error: 'provider unavailable', code: 'CREATIVE_SUPPLY_NOT_CONFIGURED', providerSubmitted: false, definitiveFailure: true
    }, { status: 503, headers: { 'X-Sanjie-Provider-Submission': 'not-submitted' } }));
    const response = await POST(request({ ...body, url: 'https://api.openai.com/v1/images/generations' }));
    expect(response.status).toBe(503);
    expect(response.headers.get('X-Sanjie-Provider-Submission')).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it('debits the logged-in tenant and calls the supply subscription with the billed upstream model', async () => {
    mocks.user.mockResolvedValue({ id: 'user-1', username: 'tenant', shopName: '西西礼', tenant: { name: '西西礼' } });
    mocks.relay.mockResolvedValue({ apiKey: 'platform-key', shopKeys: [{ shopName: '西西礼', purpose: 'default', apiKey: 'xixi-key' }], usdCnyRate: 7.2, baseUrl: 'https://sub.shaozhuangai.com/v1', models: [] });
    mocks.supply.mockResolvedValue(supplyRuntime('user-1-key', 7.2));
    mocks.findModel.mockResolvedValue({ id: 'chatGPT5.5', upstreamModel: 'gpt-5.6-sol', provider: 'shaozhuang', kind: 'chat', endpoint: 'chat.completions', promptCentsPer1K: 2, completionCentsPer1K: 6 });
    mocks.snapshot.mockResolvedValue({ userId: 'user-1', tenantId: 'tenant', username: 'tenant', userName: '租户', planCode: 'growth', planName: '增长版', multiplierBps: 10000, ruleVersion: 1, quotedAt: '2026-10-03T00:00:00.000Z' });
    mocks.balance.mockResolvedValue(true);
    mocks.usage.mockResolvedValue({ id: 'usage-1' });
    mocks.fetch.mockResolvedValue(Response.json({ id: 'chat_1', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, actual_cost: 0.01 } }));
    const response = await POST(request({
      url: 'https://sub.shaozhuangai.com/v1/chat/completions', method: 'POST',
      headers: { authorization: 'Bearer client-secret' },
      bodyText: JSON.stringify({ model: 'chatGPT5.5', messages: [{ role: 'user', content: '你好' }] })
    }));
    expect(response.status).toBe(200);
    const init = mocks.fetch.mock.calls[0][1];
    expect(init.headers.authorization).toBe('Bearer user-1-key');
    expect(JSON.parse(init.body)).toMatchObject({ model: 'gpt-5.6-sol' });
    expect(JSON.stringify(init.headers)).not.toContain('client-secret');
    expect(JSON.stringify(init.headers)).not.toContain('xixi-key');
    expect(mocks.usage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      baseCostCents: 8, costCents: 8, status: 'ok', model: 'chatGPT5.5',
      metadata: expect.objectContaining({ credentialId: 'user-1-primary', baseUrl: 'https://sub.shaozhuangai.com/v1', costSource: 'upstream_usd', usdCost: '0.01', source: 'hosted_supply' })
    }));
    expect(JSON.stringify(mocks.usage.mock.calls[0][0])).not.toContain('platform-key');
  });

  it('stops before the supply call when the tenant balance cannot cover the model', async () => {
    mocks.user.mockResolvedValue({ id: 'user-1', username: 'tenant', shopName: '', tenant: { name: '租户' } });
    mocks.relay.mockResolvedValue({ apiKey: 'platform-key', shopKeys: [], usdCnyRate: null, baseUrl: 'https://sub.shaozhuangai.com/v1', models: [] });
    mocks.supply.mockResolvedValue(supplyRuntime('user-1-key'));
    mocks.findModel.mockResolvedValue({ id: 'image2', upstreamModel: 'gpt-image-2', provider: 'shaozhuang', kind: 'image', endpoint: 'images.generations', imageCents: 50 });
    mocks.snapshot.mockResolvedValue({ userId: 'user-1', tenantId: 'tenant', username: 'tenant', userName: '租户', planCode: 'free', planName: '体验版', multiplierBps: 10000, ruleVersion: 0, quotedAt: '2026-10-03T00:00:00.000Z' });
    mocks.balance.mockResolvedValue(false);
    mocks.usage.mockResolvedValue({ id: 'usage-rejected' });
    const response = await POST(request({
      url: 'https://sub.shaozhuangai.com/v1/images/generations', method: 'POST',
      bodyText: JSON.stringify({ model: 'image2', prompt: '一张主图', n: 1 })
    }));
    expect(response.status).toBe(402);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.usage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'error', error: 'INSUFFICIENT_BALANCE', costCents: 0 }));
  });

  it('does not debit when the supply connection fails after the balance check', async () => {
    mocks.user.mockResolvedValue({ id: 'user-1', username: 'tenant', shopName: '', tenant: { name: '租户' } });
    mocks.relay.mockResolvedValue({ apiKey: 'platform-key', shopKeys: [], usdCnyRate: null, baseUrl: 'https://sub.shaozhuangai.com/v1', models: [] });
    mocks.supply.mockResolvedValue(supplyRuntime('user-1-key'));
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
    expect(mocks.usage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'error', costCents: 0 }));
  });

  it('accepts the official public origin behind an internal proxy without trusting Host', async () => {
    vi.stubEnv('NODE_ENV','production');
    const response=await POST(new Request('https://localhost:3040/api/creative/proxy', {
      method:'POST', headers:{origin:'https://shaozhuangai.com',host:'localhost:3040','content-type':'application/json'}, body:JSON.stringify(body)
    }));
    expect(response.status).toBe(200);
  });

  it('falls back only after an explicit authentication rejection and settles the final image once', async () => {
    imageFixture();
    mocks.fetch.mockResolvedValueOnce(Response.json({ code: 'INVALID_API_KEY', message: 'user-1-key' }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ data: [{ b64_json: 'fixture-image' }], debug: { 'user-1-key': ['user-1-key', 'backup-key'] } }));
    const response = await POST(request({ url: supplyUrl, method: 'POST', headers: { authorization: 'Bearer client-secret' }, bodyText: JSON.stringify({ model: 'image2', prompt: '主图', n: 1 }) }));
    expect(response.status).toBe(200);
    expect(mocks.fetch.mock.calls.map(([, init]) => init.headers.authorization)).toEqual(['Bearer user-1-key', 'Bearer backup-key']);
    expect(mocks.usage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'ok', costCents: 50,
      metadata: expect.objectContaining({ credentialId: 'user-1-backup' }) }));
    const text = await response.text();
    expect(text).not.toContain('user-1-key'); expect(text).not.toContain('backup-key'); expect(text).not.toContain('client-secret');
    expect(JSON.stringify(mocks.usage.mock.calls)).not.toContain('user-1-key');
    expect(JSON.stringify(mocks.usage.mock.calls)).not.toContain('backup-key');
  });

  it.each([429, 500, 503])('does not resubmit image generation after ambiguous HTTP %i', async (status) => {
    imageFixture();
    mocks.fetch.mockResolvedValue(Response.json({ error: { code: 'invalid_api_key' } }, { status }));
    expect((await POST(request({ url: supplyUrl, method: 'POST', bodyText: JSON.stringify({ model: 'image2', prompt: '主图' }) }))).status).toBe(status);
    expect(mocks.fetch).toHaveBeenCalledOnce(); expect(mocks.usage).toHaveBeenCalledOnce();
  });

  it('does not create a second image after a transport timeout', async () => {
    imageFixture();
    mocks.fetch.mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
    expect((await POST(request({ url: supplyUrl, method: 'POST', bodyText: JSON.stringify({ model: 'image2', prompt: '主图' }) }))).status).toBe(504);
    expect(mocks.fetch).toHaveBeenCalledOnce(); expect(mocks.usage).toHaveBeenCalledOnce();
  });

  it.each([
    { url: supplyUrl, method: 'POST', bodyText: '{}' },
    { url: 'https://sub.shaozhuangai.com/v1/admin/users', method: 'POST', bodyText: '{}' },
    { url: 'https://sub.shaozhuangai.com/v1/videos/task-1', method: 'DELETE' },
    { url: 'https://sub.shaozhuangai.com/v1/admin/users', method: 'GET' }
  ])('does not attach a supply credential to an unsupported or unbilled request %j', async (payload) => {
    mocks.user.mockResolvedValue({ id: 'user-1', username: 'tenant' });
    expect((await POST(request(payload))).status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.supply).not.toHaveBeenCalled(); expect(mocks.usage).not.toHaveBeenCalled();
  });

  it('reads owned video status with the original immutable backup credential', async () => {
    mocks.user.mockResolvedValue({ id: 'user-1', username: 'tenant' });
    mocks.videoJob.mockResolvedValue({ provider: 'shaozhuang', model: 'video', baseUrl: 'https://sub.shaozhuangai.com/v1', credentialId: 'old-backup-1' });
    mocks.credential.mockResolvedValue({ baseUrl: 'https://sub.shaozhuangai.com/v1', apiKey: 'old-backup-key' });
    mocks.fetch.mockResolvedValue(Response.json({ id: 'task-1', status: 'pending' }));
    expect((await POST(request({ url: 'https://sub.shaozhuangai.com/v1/videos/task-1', method: 'GET' }))).status).toBe(200);
    expect(mocks.videoJob).toHaveBeenCalledExactlyOnceWith('user-1', 'task-1');
    expect(mocks.credential).toHaveBeenCalledExactlyOnceWith('user-1', 'old-backup-1');
    expect(mocks.fetch.mock.calls[0][1].headers.authorization).toBe('Bearer old-backup-key');
    expect(mocks.supply).not.toHaveBeenCalled(); expect(mocks.usage).not.toHaveBeenCalled();
  });

  it('denies a foreign video before dispatch or credential lookup', async () => {
    mocks.user.mockResolvedValue({ id: 'user-2', username: 'same-shop' });
    mocks.videoJob.mockResolvedValue(null);
    expect((await POST(request({ url: 'https://sub.shaozhuangai.com/v1/videos/task-1', method: 'GET' }))).status).toBe(404);
    expect(mocks.videoJob).toHaveBeenCalledExactlyOnceWith('user-2', 'task-1');
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.credential).not.toHaveBeenCalled();
  });

  it('preserves thumbnail bytes and strips upstream secret headers during an owned video read', async () => {
    mocks.user.mockResolvedValue({ id: 'user-1', username: 'tenant' });
    mocks.videoJob.mockResolvedValue({ provider: 'shaozhuang', model: 'video', baseUrl: 'https://sub.shaozhuangai.com/v1', credentialId: 'old-backup-1' });
    mocks.credential.mockResolvedValue({ baseUrl: 'https://sub.shaozhuangai.com/v1', apiKey: 'old-backup-key' });
    const fixture = new Uint8Array([137, 80, 78, 71, 0, 255]);
    mocks.fetch.mockResolvedValue(new Response(fixture, { headers: { 'content-type': 'image/png', 'x-upstream-key': 'old-backup-key' } }));
    const response = await POST(request({ url: 'https://sub.shaozhuangai.com/v1/videos/task-1/content?variant=thumbnail', method: 'GET' }));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(fixture);
    expect(response.headers.get('x-upstream-key')).toBeNull(); expect(mocks.usage).not.toHaveBeenCalled();
  });
});
