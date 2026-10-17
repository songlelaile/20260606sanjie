import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCloudWorkbench } from '../index.mjs';

// Isolated HTTP transport with fixed trusted contexts. Authentication is deliberately
// simulated here; SaaS session/CSRF/broker acceptance belongs to bridge integration.
export const identities = {
  a: { site: { tenantId: 'tenant-a', userId: 'site-a', userName: '测试甲' }, identity: { userId: 'control-a', workspaceId: 'workspace-a' } },
  b: { site: { tenantId: 'tenant-a', userId: 'site-b', userName: '测试乙' }, identity: { userId: 'control-b', workspaceId: 'workspace-b' } },
  tenant: { site: { tenantId: 'tenant-b', userId: 'site-a', userName: '另一租户' }, identity: { userId: 'control-a', workspaceId: 'workspace-a' } },
  workspace: { site: { tenantId: 'tenant-a', userId: 'site-a', userName: '另一工作区' }, identity: { userId: 'control-a', workspaceId: 'workspace-b' } },
};
export const scope = { platform: 'sycm', categoryId: '喜糖', startDate: '2026-09-01', endDate: '2026-09-07', objectId: null };
export const originalCsv = Buffer.from('关键词,人气,来源\r\n婚礼喜糖,1000,热词榜\r\n婚礼 喜糖,0,衍生词榜\r\n婚礼无糖喜糖,900,热词榜\r\n');
export const annotations = [
  { kw: '婚礼喜糖', parts: ['婚礼', '喜糖'], partTypes: ['场景', '品类'] },
  { kw: '婚礼无糖喜糖', parts: ['婚礼', '无糖', '喜糖'], partTypes: ['场景', '属性', '品类'] },
];
export const upload = (bytes, fileName) => ({ fileName, contentBase64: Buffer.from(bytes).toString('base64') });
export const marketFor = job => ({ scope: job.scope, kind: 'sycm-market-rank', complete: false, scopeVerified: false, rows: [{ 排名: 1, 商品名称: '婚礼喜糖礼盒', 商品关键词: '婚礼喜糖', 商品链接: 'https://example.test/item/1' }] });
export async function fixture() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-cloud-workbench-test-'));
  const runtimeDir = await fs.realpath(temporary);
  let service = createCloudWorkbench({ runtimeDir });
  const server = http.createServer(async (req, res) => {
    const key = /^fixture=([a-z]+)$/.exec(req.headers.cookie || '')?.[1];
    const context = identities[key];
    if (!context) { res.writeHead(401); res.end('Isolated fixture session required'); return; }
    const pathname = (req.url || '/').replace(/^\/sower-work\/app(?=\/|\?|$)/, '') || '/';
    // Browser tests can see the actual workbench UI and its ready handshake.
    if (pathname === '/_bridge-prefix.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end("window.__sowerCloudNotifyReady=()=>{window.__fixtureReady=true};"); return; }
    try { if (!await service.handle(req, res, { ...context, path: pathname })) { res.writeHead(404); res.end('Not found'); } }
    catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, { method = 'GET', body, who = 'a', headers = {}, signal } = {}) {
    return fetch(base + '/sower-work/app/api/sower/cloud-workbench' + route, { method, headers: { Cookie: `fixture=${who}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) });
  }
  async function call(route, options) { const response = await request(route, options); return { status: response.status, headers: response.headers, ...await response.json() }; }
  async function importJob(bytes = originalCsv, fileName = '词表.csv', extra = {}) { return call('/jobs', { method: 'POST', body: { ...upload(bytes, fileName), scope, ...extra } }); }
  async function annotate(job, values = annotations) { return call(`/jobs/${job.id}/annotations`, { method: 'PUT', body: { expectedRevision: job.revision, humanConfirmed: true, annotations: values } }); }
  async function market(job, value = marketFor(job)) { return call(`/jobs/${job.id}/market`, { method: 'PUT', body: { expectedRevision: job.revision, scopeVerified: true, complete: true, ...upload(JSON.stringify(value), '市场原表.json') } }); }
  async function generate(job) { return call(`/jobs/${job.id}/generate`, { method: 'POST', body: { expectedRevision: job.revision, category: '喜糖', limit: 10 } }); }
  return { runtimeDir, base, request, call, importJob, annotate, market, generate, restart() { service = createCloudWorkbench({ runtimeDir }); }, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(runtimeDir, { recursive: true, force: true }); } };
}
