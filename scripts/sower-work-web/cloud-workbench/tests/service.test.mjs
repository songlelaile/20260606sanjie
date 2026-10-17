import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, identities, scope, originalCsv, annotations, upload, marketFor } from './http-fixture.mjs';
import { parseCsv } from '../import.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const isolated = (name, run) => test(name, async () => { const f = await fixture(); try { await run(f); } finally { await f.close(); } });
const okay = (value, code = 200) => { assert.equal(value.status, code, JSON.stringify(value.error)); assert.equal(value.success, true); return value.data; };

isolated('actual HTTP CSV import → pinned dedup → human roots → market → 20-column links export retains originals', async f => {
  let job = okay(await f.importJob(), 201);
  assert.deepEqual(job.merged.stats, { inputCount: 3, uniqueCount: 2, removedCount: 1 });
  assert.equal(job.merged.words.find(word => word.kw === '婚礼喜糖').rankPop, 1000);
  assert.equal(job.merged.words.find(word => word.kw === '婚礼喜糖').derivePop, 0);
  assert.equal(job.merged.words[0].evidence.length, 2);
  assert.equal(job.originalSha256, sha(originalCsv));
  assert.equal(job.browserCollectionVerified, false); assert.equal(job.modelCalled, false);
  assert.equal(job.plan.modelCalled, false); assert.equal(job.plan.maxConcurrency, 3);
  job = okay(await f.annotate(job)); assert.equal(job.revision, 1); assert.equal(job.annotations[0].method, 'human');
  const marketOriginal = Buffer.from(JSON.stringify(marketFor(job))); job = okay(await f.market(job));
  assert.equal(job.market.verificationSource, 'importer-declared; platform-not-collected');
  job = okay(await f.generate(job));
  assert.equal(job.revision, 3); assert.equal(job.output.status, 'draft-needs-review');
  assert.equal(job.output.aiCopyRefinementExecuted, false); assert.equal(job.output.browserCollectionVerified, false); assert.equal(job.output.businessAccepted, false);
  assert.ok(job.output.generated.links > 0); assert.equal(job.output.generated.sheets[0].headers.length, 20);
  for (const [route, expected] of [['original', originalCsv], ['market-original', marketOriginal]]) {
    const response = await f.request(`/jobs/${job.id}/${route}`); const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200); assert.deepEqual(bytes, expected); assert.equal(response.headers.get('x-content-sha256'), sha(expected));
  }
  const jsonResponse = await f.request(`/jobs/${job.id}/export?format=json`); const jsonBytes = Buffer.from(await jsonResponse.arrayBuffer());
  assert.equal(JSON.parse(jsonBytes).output.generated.links, job.output.generated.links); assert.equal(jsonResponse.headers.get('x-content-sha256'), sha(jsonBytes));
  const csvResponse = await f.request(`/jobs/${job.id}/export?format=csv`); const csvBytes = Buffer.from(await csvResponse.arrayBuffer());
  const rows = parseCsv(csvBytes.toString('utf8')); assert.equal(Object.keys(rows[0]).length, 20); assert.equal(rows[0]['链接编号'], 'L001');
  assert.equal(csvResponse.headers.get('x-content-sha256'), sha(csvBytes));
  f.restart(); assert.equal(okay(await f.call(`/jobs/${job.id}`)).output.generated.links, job.output.generated.links);
  const after = Buffer.from(await (await f.request(`/jobs/${job.id}/original`)).arrayBuffer()); assert.deepEqual(after, originalCsv);
});
isolated('missing/range/overprecision CSV popularity stays null, real zero survives, scoring blocks and evidence exports', async f => {
  const original = Buffer.from('关键词,人气\n婚礼喜糖,100~200\n婚礼无糖喜糖,\n无糖喜糖,0\n喜糖,9007199254740993\n');
  let job = okay(await f.importJob(original), 201);
  assert.equal(job.merged.words.find(word => word.kw === '无糖喜糖').pop, 0);
  assert.equal(job.merged.words.filter(word => word.pop === null).length, 3);
  assert.equal(job.merged.words.find(word => word.kw === '婚礼喜糖').evidence[0].original.original['人气'], '100~200');
  job = okay(await f.annotate(job, [...annotations, { kw: '无糖喜糖', parts: ['无糖', '喜糖'], partTypes: ['属性', '品类'] }, { kw: '喜糖', parts: ['喜糖'], partTypes: ['品类'] }]));
  job = okay(await f.market(job)); const blocked = await f.generate(job);
  assert.equal(blocked.status, 400); assert.match(blocked.error.detail, /Missing popularity/);
  const csv = await (await f.request(`/jobs/${job.id}/export?format=csv`)).text(); const rows = parseCsv(csv);
  assert.equal(rows.find(row => row['关键词'] === '婚礼喜糖')['精确人气'], '');
  assert.equal(rows.find(row => row['关键词'] === '无糖喜糖')['精确人气'], '0');
  assert.equal(okay(await f.call(`/jobs/${job.id}`)).revision, 2);
});
isolated('cross-user, tenant and workspace cannot read, mutate or download another owner artifact; body identity ignored', async f => {
  const job = okay(await f.importJob(originalCsv, '词表.csv', { userId: 'control-b', tenantId: 'tenant-b', identity: identities.b.identity, scope: { ...scope, accountId: 'control-b', workspaceId: 'workspace-b' } }), 201);
  assert.equal(job.scope.accountId, identities.a.identity.userId); assert.equal(job.scope.workspaceId, identities.a.identity.workspaceId);
  for (const who of ['b', 'tenant', 'workspace']) {
    assert.deepEqual(okay(await f.call('/jobs', { who })).jobs, []);
    for (const action of ['', '/original', '/export?format=csv']) assert.equal((await f.request(`/jobs/${job.id}${action}`, { who })).status, 404);
    assert.equal((await f.call(`/jobs/${job.id}/annotations`, { who, method: 'PUT', body: { expectedRevision: 0, humanConfirmed: true, annotations } })).status, 404);
  }
  assert.equal((await f.request('/status', { who: 'unknown' })).status, 401);
});
isolated('JSON original semantic origin is preserved while storage owner stays server-bound; mismatched source scopes reject', async f => {
  const origin = { ...scope, accountId: 'desktop-origin', workspaceId: 'desktop-snapshot' };
  const value = { scope: origin, browserCollectionVerified: true, sources: [{ scope: origin, kind: '热词榜', artifactId: 'original-desktop-source', words: [{ kw: '喜糖', pop: 2 }] }] };
  const job = okay(await f.importJob(Buffer.from(JSON.stringify(value)), '原始来源.json'), 201);
  assert.equal(job.scope.accountId, 'desktop-origin'); assert.equal(job.merged.browserCollectionVerified, false);
  assert.match(job.merged.words[0].evidence[0].artifactId, new RegExp(`^uploaded:${job.originalSha256}:source:1$`));
  assert.deepEqual(okay(await f.call('/jobs', { who: 'b' })).jobs, []);
  value.sources[0].scope = { ...origin, startDate: '2026-09-02' };
  const rejected = await f.importJob(Buffer.from(JSON.stringify(value)), '异范围.json'); assert.equal(rejected.status, 400); assert.match(rejected.error.detail, /scope mismatch/);
});
isolated('human annotation checks reject incomplete, fabricated, unknown type and absent confirmation', async f => {
  const job = okay(await f.importJob(), 201);
  for (const value of [annotations.slice(0, 1), [null, annotations[1]], [annotations[0], annotations[0]], [{ ...annotations[0], parts: ['生日', '喜糖'] }, annotations[1]], [{ ...annotations[0], partTypes: ['编造', '品类'] }, annotations[1]]]) assert.equal((await f.annotate(job, value)).status, 400);
  assert.equal((await f.call(`/jobs/${job.id}/annotations`, { method: 'PUT', body: { expectedRevision: 0, annotations } })).error.code, 'HUMAN_CONFIRMATION_REQUIRED');
  assert.equal(okay(await f.call(`/jobs/${job.id}`)).revision, 0);
});
isolated('24 simultaneous compare-and-swap saves have one winner, conflicts or admission limits never overwrite current record', async f => {
  const job = okay(await f.importJob(), 201);
  const results = await Promise.all(Array.from({ length: 24 }, () => f.annotate(job)));
  assert.equal(results.filter(value => value.status === 200).length, 1); assert.equal(results.filter(value => (value.status === 409 && value.error.code === 'REVISION_CONFLICT') || (value.status === 429 && value.error.code === 'WORKBENCH_RATE_LIMIT')).length, 23);
  assert.equal(okay(await f.call(`/jobs/${job.id}`)).revision, 1); assert.equal((await f.annotate(job)).status, 409);
});
isolated('market scope, completeness and source checks fail closed; originals are immutable and generation gated', async f => {
  let job = okay(await f.importJob(), 201);
  assert.equal((await f.generate(job)).error.code, 'HUMAN_ANNOTATIONS_REQUIRED'); job = okay(await f.annotate(job));
  assert.equal((await f.generate(job)).error.code, 'COMPLETE_MARKET_INPUT_REQUIRED');
  for (const change of [{ scope: { ...job.scope, startDate: '2026-08-01' } }, { scope: { ...job.scope, categoryId: '其他品类' } }, { kind: 'taobao-sales-search' }, { rows: [] }]) assert.equal((await f.market(job, { ...marketFor(job), ...change })).status, 400);
  const input = { expectedRevision: job.revision, scopeVerified: false, complete: true, ...upload(JSON.stringify(marketFor(job)), '市场.json') };
  assert.equal((await f.call(`/jobs/${job.id}/market`, { method: 'PUT', body: input })).error.code, 'MARKET_SCOPE_AND_COMPLETENESS_REQUIRED');
  job = okay(await f.market(job)); assert.equal((await f.market(job)).error.code, 'MARKET_ALREADY_BOUND_IMPORT_NEW_JOB');
  assert.equal(okay(await f.call(`/jobs/${job.id}`)).revision, 2);
});
isolated('CSV formula injection is neutralized in export while original stays exact; rendered text is never markup', async f => {
  const original = Buffer.from('关键词,人气\n"=HYPERLINK(""http://example.test"",""click"")",1\n+SUM(A1),2\n@CMD,3\n-1,4\n<script>alert(1)</script>,5\n');
  const job = okay(await f.importJob(original), 201); const response = await f.request(`/jobs/${job.id}/export?format=csv`); const rows = parseCsv(await response.text());
  for (const kw of ['=HYPERLINK("http://example.test","click")', '+SUM(A1)', '@CMD', '-1']) assert.ok(rows.some(row => row['关键词'] === "'" + kw));
  assert.equal(rows.find(row => row['关键词'].includes('<script>'))['关键词'], '<script>alert(1)</script>');
  assert.deepEqual(Buffer.from(await (await f.request(`/jobs/${job.id}/original`)).arrayBuffer()), original);
  const source = await fs.readFile(new URL('../app.js', import.meta.url), 'utf8'); assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|document\.write\(/);
});
isolated('malformed CSV/JSON, paths, oversized files, invalid encoding and impossible scope reject without storing', async f => {
  for (const [bytes, name] of [['关键词,人气\n"bad,2', '词.csv'], ['关键词,关键词\na,b', '词.csv'], ['关键词,人气\na,2,3', '词.csv'], ['__proto__,人气\na,1', '词.csv'], ['not json', '词.json'], ['hello', '../词.csv'], ['hello', '词.exe'], [Buffer.from([0xff]), '词.csv']]) assert.ok((await f.importJob(Buffer.from(bytes), name)).status >= 400);
  assert.equal((await f.importJob(Buffer.alloc(5 * 1024 * 1024 + 1, 65))).status, 413);
  assert.equal((await f.call('/jobs', { method: 'POST', body: { ...upload('a', '词.csv'), contentBase64: '*not-base64*', scope } })).error.code, 'FILE_ENCODING_INVALID');
  assert.equal((await f.importJob(originalCsv, '词.csv', { scope: { ...scope, startDate: '2026-02-30' } })).status, 400);
  assert.deepEqual(okay(await f.call('/jobs')).jobs, []);
  assert.equal((await f.request('/jobs/%2e%2e/%2e%2e')).status, 404);
});
isolated('hard per-owner job quota rejects 17th job without altering prior records', async f => {
  const first = okay(await f.importJob(), 201);
  for (let i = 1; i < 16; i++) okay(await f.importJob(), 201);
  assert.equal((await f.importJob()).error.code, 'WORKSPACE_FILE_LIMIT'); assert.equal(okay(await f.call('/jobs')).jobs.length, 16);
  assert.equal(okay(await f.call(`/jobs/${first.id}`)).originalSha256, sha(originalCsv));
});
isolated('storage symlink original and directory reject and never return external content', async f => {
  const job = okay(await f.importJob(), 201); const partition = path.join(f.runtimeDir, 'cloud-workbench', sha(JSON.stringify(['tenant-a', 'site-a', 'control-a', 'workspace-a'])));
  const originalPath = path.join(partition, 'jobs', job.id, 'original.bin'); const outside = path.join(f.runtimeDir, 'outside.txt'); await fs.writeFile(outside, 'OUTSIDE_SECRET');
  await fs.unlink(originalPath); await fs.symlink(outside, originalPath);
  let response = await f.request(`/jobs/${job.id}/original`); assert.equal(response.status, 403); assert.doesNotMatch(await response.text(), /OUTSIDE_SECRET|outside\.txt/);
  const jobPath = path.join(partition, 'jobs', job.id); await fs.rm(jobPath, { recursive: true }); await fs.symlink(f.runtimeDir, jobPath);
  response = await f.request(`/jobs/${job.id}`); assert.equal(response.status, 403); assert.doesNotMatch(await response.text(), /outside\.txt/);
});
isolated('knowledge text upload → literal search → original hash → persistence and cross-owner isolation', async f => {
  const original = Buffer.from('商品参数\n婚礼喜糖由用户提供，<script>alert(1)</script>。\n缺失字段：未提供克重。');
  const record = okay(await f.call('/knowledge', { method: 'POST', body: upload(original, '商品资料.md') }), 201);
  assert.equal(record.status, 'ready'); assert.equal(record.textChars, original.toString().length); assert.equal(record.originalSha256, sha(original)); assert.equal(record.text, undefined);
  assert.match(okay(await f.call('/knowledge/search?q=' + encodeURIComponent('婚礼喜糖'))).hits[0].snippet, /未提供克重/);
  assert.equal(okay(await f.call(`/knowledge/${record.id}`)).text, original.toString());
  for (const who of ['b', 'tenant', 'workspace']) { assert.deepEqual(okay(await f.call('/knowledge', { who })).files, []); assert.deepEqual(okay(await f.call('/knowledge/search?q=' + encodeURIComponent('婚礼喜糖'), { who })).hits, []); assert.equal((await f.request(`/knowledge/${record.id}/original`, { who })).status, 404); }
  f.restart(); const response = await f.request(`/knowledge/${record.id}/original`); assert.deepEqual(Buffer.from(await response.arrayBuffer()), original); assert.equal(response.headers.get('x-content-sha256'), sha(original));
});
isolated('unsupported document parsers and image OCR stay explicit; invalid UTF8 text rejects and long text reports truncation', async f => {
  for (const name of ['样本.pdf', '样本.docx', '样本.xlsx']) { const record = okay(await f.call('/knowledge', { method: 'POST', body: upload('unparsed-original-bytes', name) }), 201); assert.equal(record.status, 'pending'); assert.equal(record.statusCode, 'parser_unavailable'); assert.equal(okay(await f.call(`/knowledge/${record.id}`)).text, ''); }
  const image = okay(await f.call('/knowledge', { method: 'POST', body: upload(Buffer.from([0xff, 0xd8, 0xff]), '原图.jpg') }), 201); assert.equal(image.statusCode, 'image_no_ocr'); assert.equal(image.textChars, 0);
  assert.equal((await f.call('/knowledge', { method: 'POST', body: upload(Buffer.from([0xff]), '坏编码.txt') })).status, 400);
  assert.equal((await f.call('/knowledge', { method: 'POST', body: upload('a', '禁止.html') })).status, 400);
  const long = okay(await f.call('/knowledge', { method: 'POST', body: upload('x'.repeat(1000001), '大正文.txt') }), 201); assert.equal(long.truncated, true); assert.equal(long.textChars, 1000000); assert.equal(long.sizeBytes, 1000001);
});
isolated('UI static assets enforce CSP and external script ready handshake; no Electron or remote/model API facade', async f => {
  const response = await fetch(f.base + '/sower-work/app/cloud-workbench', { headers: { Cookie: 'fixture=a' } }); const html = await response.text();
  assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy'), /script-src 'self'/); assert.match(html, /_bridge-prefix\.js/); assert.doesNotMatch(html, /onclick=|<script[^>]*>[^<]/);
  assert.match(html, /没有接入智能体|文本检索/); assert.doesNotMatch(html, /electronAPI/);
  const js = await (await fetch(f.base + '/sower-work/app/cloud-workbench/app.js', { headers: { Cookie: 'fixture=a' } })).text(); assert.match(js, /__sowerCloudNotifyReady/);
  assert.equal(okay(await f.call('/status')).capabilities.accountingIntegrated, false);
});
isolated('generation attempts have per-owner minute rate limit and retry header without poisoning other owners', async f => {
  const job = okay(await f.importJob(), 201);
  for (let i = 0; i < 6; i++) assert.equal((await f.generate(job)).status, 400);
  const blocked = await f.generate(job); assert.equal(blocked.status, 429); assert.equal(blocked.error.code, 'WORKBENCH_RATE_LIMIT'); assert.equal(blocked.headers.get('retry-after'), '60');
  assert.equal(okay(await f.call('/status', { who: 'b' })).limits.heavyTasksGlobal, 2);
  assert.equal(okay(await f.call(`/jobs/${job.id}`)).revision, 0);
});
isolated('per-owner worker admission rejects parallel generation, API stays responsive and CAS protects changes made during generation', async f => {
  let job = okay(await f.importJob(), 201); job = okay(await f.annotate(job)); job = okay(await f.market(job));
  const simultaneous = await Promise.all([f.generate(job), f.generate(job)]);
  assert.equal(simultaneous.filter(value => value.status === 200).length, 1);
  assert.equal(simultaneous.filter(value => value.status === 429 && value.error.code === 'WORKBENCH_TASK_BUSY').length, 1);
  job = okay(await f.call(`/jobs/${job.id}`)); let finished = false;
  const running = f.generate(job).then(value => { finished = true; return value; });
  okay(await f.call('/status')); assert.equal(finished, false, 'ordinary API answered while real comparison worker is pending');
  const changed = okay(await f.annotate(job)); assert.equal(changed.revision, job.revision + 1);
  const conflict = await running; assert.equal(conflict.status, 409); assert.equal(conflict.error.code, 'REVISION_CONFLICT');
  const final = okay(await f.call(`/jobs/${job.id}`)); assert.equal(final.output, null); assert.equal(final.stage, 'human-annotated');
});
isolated('global two-worker budget rejects third owner while retaining tenant isolation', async f => {
  const jobs = [];
  for (const who of ['a', 'b', 'tenant']) {
    let job = okay(await f.call('/jobs', { who, method: 'POST', body: { ...upload(originalCsv, '词表.csv'), scope } }), 201);
    job = okay(await f.call(`/jobs/${job.id}/annotations`, { who, method: 'PUT', body: { expectedRevision: job.revision, humanConfirmed: true, annotations } }));
    job = okay(await f.call(`/jobs/${job.id}/market`, { who, method: 'PUT', body: { expectedRevision: job.revision, complete: true, scopeVerified: true, ...upload(JSON.stringify(marketFor(job)), '市场.json') } })); jobs.push({ job, who });
  }
  const result = await Promise.all(jobs.map(({ job, who }) => f.call(`/jobs/${job.id}/generate`, { who, method: 'POST', body: { expectedRevision: job.revision, limit: 10 } })));
  assert.equal(result.filter(value => value.status === 200).length, 2); assert.equal(result.filter(value => value.status === 429 && value.error.code === 'WORKBENCH_TASK_BUSY').length, 1);
});
isolated('disconnect terminates pending comparison without committing output, then retry releases worker slot', async f => {
  let job = okay(await f.importJob(), 201); job = okay(await f.annotate(job)); job = okay(await f.market(job));
  const controller = new AbortController(); let finished = false;
  const pending = f.request(`/jobs/${job.id}/generate`, { method: 'POST', body: { expectedRevision: job.revision, limit: 10 }, signal: controller.signal }).then(value => { finished = true; return value; });
  okay(await f.call('/status')); assert.equal(finished, false); controller.abort(); await assert.rejects(pending, /abort/i);
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(okay(await f.call(`/jobs/${job.id}`)).revision, job.revision);
  assert.ok(okay(await f.generate(job)).output.generated.links > 0);
});
isolated('quota failure after market artifact write rolls back artifact, preserves record and permits clean retry', async f => {
  let job = okay(await f.importJob(), 201); job = okay(await f.annotate(job));
  const partition = path.join(f.runtimeDir, 'cloud-workbench', sha(JSON.stringify(['tenant-a', 'site-a', 'control-a', 'workspace-a'])));
  const jobDir = path.join(partition, 'jobs', job.id); const originalBytes = (await fs.stat(path.join(jobDir, 'original.bin'))).size; const recordBytes = (await fs.stat(path.join(jobDir, 'record.json'))).size;
  const marketBytes = Buffer.byteLength(JSON.stringify(marketFor(job))); const filler = path.join(partition, 'quota-fixture'); await fs.writeFile(filler, ''); await fs.truncate(filler, 128 * 1024 * 1024 - originalBytes - recordBytes - marketBytes - 20);
  const failed = await f.market(job); assert.equal(failed.status, 413); assert.equal(failed.error.code, 'WORKSPACE_STORAGE_LIMIT');
  assert.equal(okay(await f.call(`/jobs/${job.id}`)).market, null); assert.equal(await fs.stat(path.join(jobDir, 'market-original.bin')).then(() => true, () => false), false);
  await fs.unlink(filler); job = okay(await f.market(job)); assert.equal(job.revision, 2); assert.equal(job.market.originalSha256, sha(JSON.stringify(marketFor(job))));
});
