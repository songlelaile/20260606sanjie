'use strict';

// Actual module in Chromium: native trusted clicks, WebCrypto and IndexedDB.
// The only HTTP server is this loopback fixture. No provider is callable.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const puppeteer = require('puppeteer');
const modulePath = process.env.SKU_PAID_RECEIPT_MODULE || path.resolve(__dirname, '../public/creative/labs/image-prompt-lab/sku-durable-receipt.js');
assert.ok(path.isAbsolute(modulePath));
const source = fs.readFileSync(modulePath, 'utf8');
const sourceSha256 = crypto.createHash('sha256').update(source).digest('hex');
let browser, server, origin, sequence = 0;
const blocked = [], errors = [];
test.before(async () => {
  server = http.createServer((request, response) => {
    if (request.url === '/module.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return response.end(source);
    }
    if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return response.end('<!doctype html><button id="skuNewPaidBatchBtn">另建付费 SKU 批次</button><button id="wrong">错误按钮</button><script src="/module.js"></script>');
    }
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await puppeteer.launch({ headless: true });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  assert.deepEqual(blocked, [], 'no external requests'); assert.deepEqual(errors, [], 'no page errors');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex'), sourceSha256, 'module bytes must remain stable during the run');
});

async function fixture(owner = 'user:sku-paid-fixture:alice', environment = 'sku-paid-native-' + ++sequence, reuse = null) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url().startsWith(origin + '/') || /^(blob|data):/.test(request.url())) return request.continue();
    blocked.push(request.url()); return request.abort('blockedbyclient');
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluateOnNewDocument((owner, environment) => { globalThis.__SANJIE_ENVIRONMENT = environment; globalThis.__owner = owner; }, owner, environment);
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.evaluate(async reuse => {
    const api = globalThis.SZ_SKU_DURABLE_RECEIPT;
    for (const name of ['beginPaidWorkspaceIntent','authorizePaidWorkspace','readActivePaidWorkspace','resolvePaidWorkspace','verifyPaidWorkspaceDispatch']) {
      if (typeof api[name] !== 'function') throw new Error('Actual paid API missing: ' + name);
    }
    globalThis.__api = api; globalThis.__intents = [];
    for (const id of ['skuNewPaidBatchBtn','wrong']) document.getElementById(id).addEventListener('click', event => {
      try { __intents.push(api.beginPaidWorkspaceIntent(event, __owner)); __intentError = null; }
      catch (error) { __intentError = error.code; }
    });
    function image(color, template) {
      const c = document.createElement('canvas'); c.width = c.height = template ? 1000 : 800;
      const ctx = c.getContext('2d'); ctx.fillStyle = template ? '#eee1c9' : '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = color; ctx.fillRect(c.width * .3, c.height * .22, c.width * .4, c.height * .55); return c.toDataURL('image/png');
    }
    const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(n => n.toString(16).padStart(2, '0')).join('');
    const material = reuse?.material || { baseImage: image('#b91c1c', true), subjects: [image('#1d4ed8'), image('#047857')] };
    const dbName = 'sz_image_upload_originals_v1:environment:' + encodeURIComponent(__SANJIE_ENVIRONMENT);
    const db = await new Promise((resolve, reject) => {
      const q = indexedDB.open(dbName, 1);
      q.onupgradeneeded = () => { const store = q.result.createObjectStore('originals', { keyPath: 'id' }); store.createIndex('derivative', 'derivative'); };
      q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error);
    });
    for (const value of [material.baseImage, ...material.subjects]) {
      const bytes = Uint8Array.from(atob(value.split(',')[1]), c => c.charCodeAt(0)), hash = await digest(bytes);
      const derivative = __owner + ':' + await digest(new TextEncoder().encode(value)), blob = new Blob([bytes], { type: 'image/png' });
      const record = { id: __owner + ':' + hash + ':' + derivative, accountKey: __owner, derivative, hash, blob, bytes: blob.size, name: 'protocol-fixture.png' };
      await new Promise((resolve, reject) => { const tx = db.transaction('originals', 'readwrite'); tx.objectStore('originals').put(record); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    }
    db.close();
    const model = { provider: 'openai-compatible', imageAdapter: 'openai-images', imageModel: 'gpt-image-2', imageEndpoint: 'https://sku-paid-fixture.invalid/v1/images/edits' };
    const output = { size: '1000*1000', ratio: '1:1', resolution: 'custom', width: 1000, height: 1000 };
    const jobs = ['job_1791824581525_774923246bf7e','job_1791824581874_8095a58ffa5c3'];
    const parents = reuse?.parents || await Promise.all(jobs.map(async (jobId, index) => {
      const key = 'sz.legacy-image-receipt.v1:' + encodeURIComponent(__owner) + ':' + await digest(new TextEncoder().encode(__SANJIE_ENVIRONMENT + ':' + index));
      const raw = JSON.stringify({ version: 1, state: 'uncertain', jobId, createdAt: 1791824581525 + index, code: 'IMAGE_RECEIPT_UNCONFIRMED', taskId: '' });
      localStorage.setItem(key, raw); return { key, raw, jobId };
    }));
    const preparations = material.subjects.map((subjectImage, index) => ({
      owner: __owner, legacyKey: parents[index].key, jobId: 'new-independent-job-' + index, batchId: 'new-explicit-batch',
      baseImage: material.baseImage, subjectImage, providerImages: { base: material.baseImage, subject: subjectImage },
      contract: { version: 'SKU_SUBJECT_REPLACE_V2', batchLockId: 'fixture-lock', contractFingerprint: 'fixture-fingerprint', coordinateSpace: 'source-image',
        canvas: { ratio: '1:1', width: 1000, height: 1000, safeMargin: 40 }, baseImageFingerprint: 'base', replacementSubjectFingerprint: 'subject-' + index,
        generatedSkuBadge: false, typography: { renderMode: 'preserve-base', addText: false, alterText: false },
        subject: { renderMode: 'provider-localized-replacement', replacementOnly: true, preservePlacement: true, preserveScale: true, preservePerspective: true,
          preserveLightingAndShadow: true, authorizedRegion: { x: .12, y: .18, w: .76, h: .72, confirmed: true } },
        variableWhitelist: { subjectIdentity: true, backgroundChanges: false, textChanges: false, layoutChanges: false, newProps: false, generatedLabels: false },
        immutableFromBase: ['背景','文字','图标'] },
      geometry: { version: 'SKU_PROVIDER_GEOMETRY_V1', contractFingerprint: 'fixture-fingerprint', adapter: 'openai-images', requestedSize: '1024*1024', effectiveSize: '1024*1024' },
      output, model, prompt: 'Replace the subject only and preserve the template.', negativePrompt: 'No new text or background.',
      snapshot: { skuId: 'new-dom-slot-' + index, skuCode: 'SKU' + index, title: '独立付费任务' + index, attribute: '独立付费任务' + index, index, archiveBatchTitle: '独立付费验收' }
    }));
    globalThis.__fixture = { material, parents, preparations, owner: __owner, environment: __SANJIE_ENVIRONMENT };
    globalThis.__authorize = intent => api.authorizePaidWorkspace({ owner: __owner, intent, parents,
      tasks: preparations.map(p => ({ parentLegacyKey: p.legacyKey, baseImage: p.baseImage, subjectImage: p.subjectImage, metadata: p.snapshot, output: p.output, model: p.model,
        snapshot: { baseImage: p.baseImage, subjectImage: p.subjectImage, providerImages: p.providerImages, contract: p.contract, geometry: p.geometry,
          output: p.output, prompt: p.prompt, negativePrompt: p.negativePrompt, model: p.model, metadata: p.snapshot } })) });
    globalThis.__entries = async () => {
      const db = await new Promise((resolve, reject) => { const q = indexedDB.open('sz_sku_durable_receipt_v1:environment:' + encodeURIComponent(__SANJIE_ENVIRONMENT)); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
      const values = await new Promise((resolve, reject) => { const q = db.transaction('entries').objectStore('entries').getAll(); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); }); db.close(); return values;
    };
    globalThis.__attempt = async fn => { try { return { returned: await fn() }; } catch (error) { return { rejected: true, code: error.code, error: error.message }; } };
  }, reuse);
  return { page, owner, environment };
}
async function authorize(h) {
  await h.page.click('#skuNewPaidBatchBtn');
  return h.page.evaluate(async () => { const auth = await __authorize(__intents.at(-1)); globalThis.__auth = auth; return auth; });
}
async function prepare(h, index = 0) {
  return h.page.evaluate(async index => {
    const p = __fixture.preparations[index], resolved = await __api.resolvePaidWorkspace(__owner, p.legacyKey, p);
    if (!resolved) throw new Error('Actual namespace resolver did not resolve');
    globalThis.__resolved = resolved;
    const entry = await __api.prepare({ ...p, legacyKey: resolved.key, paidWorkspaceKey: resolved.workspaceKey, parentLegacyKey: resolved.parentLegacyKey });
    globalThis.__entry = entry; return { resolved, entry };
  }, index);
}

test('untrusted DOM and forged events cannot create a paid authorization', async () => {
  const h = await fixture();
  const value = await h.page.evaluate(() => {
    const api = __api, codes = [];
    for (const event of [{ isTrusted: true, currentTarget: document.getElementById('skuNewPaidBatchBtn') }, new MouseEvent('click')]) {
      try { api.beginPaidWorkspaceIntent(event, __owner); codes.push('accepted'); } catch (error) { codes.push(error.code); }
    }
    document.getElementById('skuNewPaidBatchBtn').click(); codes.push(__intentError);
    document.getElementById('skuNewPaidBatchBtn').dispatchEvent(new MouseEvent('click', { bubbles: true })); codes.push(__intentError);
    return { codes, intents: __intents.length };
  });
  assert.ok(value.codes.every(code => code === 'SKU_PAID_EXPLICIT_ACTION_REQUIRED')); assert.equal(value.intents, 0);
  await h.page.click('#wrong'); assert.equal(await h.page.evaluate(() => __intentError), 'SKU_PAID_EXPLICIT_ACTION_REQUIRED');
  assert.equal(await h.page.evaluate(() => __api.readActivePaidWorkspace(__owner)), null); await h.page.close();
});

test('real trusted click persists exact owner/source/model/output/parent audit without changing either legacy marker', async () => {
  const h = await fixture(), auth = await authorize(h);
  assert.equal(auth.schema, 'SKU_PAID_WORKSPACE_AUTHORIZATION_V1'); assert.equal(auth.owner, h.owner);
  assert.match(auth.workspaceKey, /^sku_paid_workspace_/); assert.equal(auth.tasks.length, 2); assert.equal(auth.parents.length, 2);
  const value = await h.page.evaluate(async () => ({ active: await __api.readActivePaidWorkspace(__owner),
    parentsUnchanged: __fixture.parents.every(parent => localStorage.getItem(parent.key) === parent.raw),
    entries: (await __entries()).map(row => ({ schema: row.schema, jobId: row.identity?.jobId })) }));
  assert.deepEqual(value.active, auth); assert.equal(value.parentsUnchanged, true);
  assert.ok(value.entries.every(row => !row.jobId), 'authorization must not fabricate either legacy nine-field receipt');
  const signature = { ...auth }; delete signature.authorizationSha256;
  function canonical(x) { return x && typeof x === 'object' ? Array.isArray(x) ? '[' + x.map(canonical).join(',') + ']' : '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}' : JSON.stringify(x); }
  assert.equal(crypto.createHash('sha256').update(canonical(signature)).digest('hex'), auth.authorizationSha256);
  await h.page.close();
});

test('unprepared export exposes reviewable authorized source and region without inventing server evidence', async () => {
  const h = await fixture(), auth = await authorize(h);
  const exported = await h.page.evaluate(() => __api.exportPaidWorkspaceMetadata(__owner));
  assert.equal(exported.receipts.length, 2);
  assert.ok(exported.receipts.every(row => row.journalState === 'not-prepared' && auth.tasks.some(task => task.taskId === row.authorizedTaskId || task.taskId === row.taskId)));
  assert.ok(exported.receipts.every(row => row.sourceOriginals && row.authorizedRegion?.confirmed === true && row.output?.size === '1000*1000'));
  assert.ok(exported.receipts.every(row => !row.receiptIdentity && !row.serverResponseMetadata?.billingEventId && !row.serverResponseMetadata?.dispatchId));
  assert.doesNotMatch(JSON.stringify(exported), /data:image|https:\/\/|"raw"|apiKey|imageEndpoint/); await h.page.close();
});

test('intent is one use and bound to owner, environment, connected button and expiry', async () => {
  for (const change of ['reuse','owner','environment','detached','expired']) {
    const h = await fixture(); await h.page.click('#skuNewPaidBatchBtn');
    const result = await h.page.evaluate(async change => {
      const intent = __intents.at(-1);
      if (change === 'reuse') await __authorize(intent);
      if (change === 'owner') __owner = 'user:sku-paid-fixture:other';
      if (change === 'environment') __SANJIE_ENVIRONMENT += '-changed';
      if (change === 'detached') document.getElementById('skuNewPaidBatchBtn').remove();
      const originalNow = Date.now;
      if (change === 'expired') { const at = originalNow(); Date.now = () => at + 61000; }
      try { return await __attempt(() => __authorize(intent)); } finally { Date.now = originalNow; }
    }, change);
    assert.equal(result.rejected, true, change); assert.equal(result.code, 'SKU_PAID_EXPLICIT_ACTION_REQUIRED', change); await h.page.close();
  }
});

test('concurrent real clicks and repeat click keep one immutable active workspace', async () => {
  const h = await fixture(); await h.page.click('#skuNewPaidBatchBtn'); await h.page.click('#skuNewPaidBatchBtn');
  const values = await h.page.evaluate(() => Promise.all(__intents.map(__authorize)));
  assert.equal(values[0].workspaceKey, values[1].workspaceKey);
  const repeated = await authorize(h); assert.deepEqual(repeated, values[0]);
  const entries = await h.page.evaluate(() => __entries());
  assert.equal(entries.filter(row => row.schema === 'SKU_PAID_WORKSPACE_AUTHORIZATION_V1').length, 1);
  assert.equal(entries.filter(row => row.schema === 'SKU_PAID_ACTIVE_WORKSPACE_V1').length, 1); await h.page.close();
});

test('native transaction quota failure cannot leave authorization without its active pointer', async () => {
  const h = await fixture(); await h.page.click('#skuNewPaidBatchBtn');
  const result = await h.page.evaluate(async () => {
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (value, ...args) {
      if (value?.schema === 'SKU_PAID_ACTIVE_WORKSPACE_V1') throw new DOMException('Controlled quota fixture', 'QuotaExceededError');
      return original.call(this, value, ...args);
    };
    try { return await __attempt(() => __authorize(__intents.at(-1))); } finally { IDBObjectStore.prototype.add = original; }
  });
  assert.equal(result.rejected, true);
  assert.equal(await h.page.evaluate(() => __api.readActivePaidWorkspace(__owner)), null);
  assert.equal((await h.page.evaluate(() => __entries())).length, 0); await h.page.close();
});

test('native reload preserves namespace/task/UUID and one submission claim', async () => {
  const h = await fixture(), auth = await authorize(h), first = await prepare(h);
  assert.equal(first.entry.identity.workspaceKey, auth.workspaceKey); assert.equal(first.entry.identity.taskId, auth.tasks[0].taskId);
  assert.notEqual(first.resolved.key, (await h.page.evaluate(() => __fixture.parents[0].key)));
  const claimed = await h.page.evaluate(() => __api.markDispatched(__owner, __resolved.key, __entry.identity.receiptId)); assert.equal(claimed.dispatched, true);
  const reuse = await h.page.evaluate(() => __fixture); await h.page.close();
  const fresh = await fixture(h.owner, h.environment, reuse), restored = await prepare(fresh);
  assert.deepEqual(restored.entry.identity, first.entry.identity); assert.equal(restored.resolved.key, first.resolved.key);
  const duplicate = await fresh.page.evaluate(() => __api.markDispatched(__owner, __resolved.key, __entry.identity.receiptId));
  assert.equal(duplicate.ok, false); assert.equal(duplicate.reason, 'already_dispatched'); await fresh.page.close();
});

test('workspace namespace cannot be caller supplied without a persisted paid authorization', async () => {
  const h = await fixture();
  const results = await h.page.evaluate(async () => {
    const p = __fixture.preparations[0], workspaceKey = 'sku_paid_workspace_' + crypto.randomUUID();
    return Promise.all([
      __attempt(() => __api.prepare({ ...p, legacyKey: p.legacyKey + ':workspace:' + workspaceKey })),
      __attempt(() => __api.prepare({ ...p, legacyKey: p.legacyKey + ':workspace:' + workspaceKey, paidWorkspaceKey: workspaceKey, parentLegacyKey: p.legacyKey }))
    ]);
  });
  assert.ok(results.every(result => result.rejected), JSON.stringify(results.map(r => ({ rejected: r.rejected, code: r.code })))); await h.page.close();
});

test('each authorized source pair is bound to its corresponding original legacy parent', async () => {
  const h = await fixture(); await authorize(h);
  const result = await h.page.evaluate(() => __attempt(() => __api.resolvePaidWorkspace(__owner, __fixture.parents[1].key, __fixture.preparations[0])));
  assert.equal(result.rejected, true, 'source0 with parent1 must fail closed'); await h.page.close();
});

test('changed parent prevents first dispatch but preserves an already dispatched child for receipt recovery', async () => {
  const h = await fixture(); await authorize(h); await prepare(h);
  const result = await h.page.evaluate(async () => {
    const parent = __fixture.parents[0]; localStorage.setItem(parent.key, parent.raw + ' ');
    const changed = await __attempt(() => __api.verifyPaidWorkspaceDispatch(__owner, __entry.identity.workspaceKey, parent.key));
    localStorage.setItem(parent.key, parent.raw);
    await __api.markDispatched(__owner, __resolved.key, __entry.identity.receiptId);
    localStorage.setItem(parent.key, parent.raw + ' ');
    const resolved = await __api.resolvePaidWorkspace(__owner, parent.key, __fixture.preparations[0]);
    return { changed, resolved, original: __resolved };
  });
  assert.equal(result.changed.rejected, true); assert.equal(result.changed.code, 'SKU_PAID_PARENT_CHANGED');
  assert.equal(result.resolved.key, result.original.key); await h.page.close();
});

test('source, region, prompt, geometry, provider bytes, output, model and owner/environment mismatches cannot use the authorization', async () => {
  for (const change of ['source','region','prompt','negative','provider-input','geometry','output','model','title','owner','environment']) {
    const h = await fixture(); await authorize(h);
    const result = await h.page.evaluate(async change => {
      const p = structuredClone(__fixture.preparations[0]);
      if (change === 'source') p.subjectImage = __fixture.preparations[1].subjectImage;
      if (change === 'region') p.contract.subject.authorizedRegion.x += .01;
      if (change === 'prompt') p.prompt += ' changed';
      if (change === 'negative') p.negativePrompt += ' changed';
      if (change === 'provider-input') p.providerImages.base = p.subjectImage;
      if (change === 'geometry') p.geometry.effectiveSize = '1536*1024';
      if (change === 'output') p.output.width = 999;
      if (change === 'model') p.model.imageModel = 'unapproved-model';
      if (change === 'title') p.snapshot.title = 'changed title';
      if (change === 'owner') __owner = 'user:sku-paid-fixture:other';
      if (change === 'environment') __SANJIE_ENVIRONMENT += '-changed';
      return __attempt(async () => {
        const resolved = await __api.resolvePaidWorkspace(__owner, p.legacyKey, p);
        if (!resolved) return null;
        return __api.prepare({ ...p, owner: __owner, legacyKey: resolved.key, paidWorkspaceKey: resolved.workspaceKey, parentLegacyKey: resolved.parentLegacyKey });
      });
    }, change);
    assert.ok(result.rejected || result.returned === null, change); await h.page.close();
  }
});

test('legacy parent with extra credential fields is rejected before immutable audit storage', async () => {
  const h = await fixture(); await h.page.click('#skuNewPaidBatchBtn');
  const result = await h.page.evaluate(async () => {
    const p = __fixture.parents[0]; p.raw = JSON.stringify({ ...JSON.parse(p.raw), apiKey: 'SYNTHETIC-EXTRA-MUST-NOT-STORE' }); localStorage.setItem(p.key, p.raw);
    return __attempt(() => __authorize(__intents.at(-1)));
  });
  assert.equal(result.rejected, true); assert.equal(await h.page.evaluate(() => __api.readActivePaidWorkspace(__owner)), null); await h.page.close();
});

test('wrong nine fields or malformed server metadata cannot be attached to a receipt', async () => {
  for (const change of ['job','extra-nine','wrong-meta-shape','both-wallet-and-byok']) {
    const h = await fixture(); await authorize(h); await prepare(h);
    const result = await h.page.evaluate(async change => {
      const receipt = { ...__entry.identity };
      const response = { ok: true, images: ['data:image/png;base64,c3ludGhldGlj'], receipt,
        billingEventId: '11111111-1111-4111-8111-111111111111', resultSha256: 'a'.repeat(64) };
      if (change === 'job') receipt.jobId = 'other-job';
      if (change === 'extra-nine') receipt.extra = 'wrong';
      if (change === 'wrong-meta-shape') response.billingEventId = 'SYNTHETIC-NOT-A-UUID';
      if (change === 'both-wallet-and-byok') response.dispatchId = '22222222-2222-4222-8222-222222222222';
      const rejected = await __attempt(() => __api.recordReceiptEvidence(__owner, __resolved.key, response));
      const entries = await __entries(); return { rejected, metadataCount: entries.filter(row => row.schema === 'SKU_RECEIPT_SERVER_METADATA_V1').length };
    }, change);
    assert.equal(result.rejected.rejected, true, change); assert.equal(result.metadataCount, 0, change); await h.page.close();
  }
});

test('absent actual server metadata is explicitly not captured and export excludes credentials and image URLs', async () => {
  const h = await fixture(); await authorize(h); await prepare(h);
  const value = await h.page.evaluate(async () => {
    const before = await __api.exportPaidWorkspaceMetadata(__owner);
    await __api.recordReceiptEvidence(__owner, __resolved.key, { ok: true, receipt: __entry.identity,
      images: ['data:image/png;base64,c3ludGhldGlj'], apiKey: 'SYNTHETIC-KEY-MUST-NOT-EXPORT', headers: { Authorization: 'SYNTHETIC-TOKEN-MUST-NOT-EXPORT' },
      privateUrl: 'https://private.fixture.invalid/content?token=SYNTHETIC' });
    const after = await __api.exportPaidWorkspaceMetadata(__owner); return { before, after };
  });
  assert.equal(value.before.receipts[0].serverResponseMetadata.captureStatus, 'not-captured');
  assert.equal(value.before.receipts[0].serverResponseMetadata.evidenceRecordPresent, false);
  assert.equal(value.after.receipts[0].serverResponseMetadata.captureStatus, 'not-captured');
  assert.equal(value.after.receipts[0].serverResponseMetadata.evidenceRecordPresent, true);
  const text = JSON.stringify(value.after); assert.doesNotMatch(text, /SYNTHETIC|data:image|https:\/\/|Authorization|apiKey|imageEndpoint|"raw"/);
  assert.equal(value.after.receipts[0].serverResponseMetadata.billingEventId, undefined); await h.page.close();
});

test('bound fixture server metadata and native archive IDs remain readable after UUID acknowledgement', async () => {
  for (const kind of ['wallet','byok']) {
    const h = await fixture(); await authorize(h); const prepared = await prepare(h);
    const value = await h.page.evaluate(async kind => {
      const metadata = { resultSha256: 'b'.repeat(64) };
      if (kind === 'wallet') metadata.billingEventId = '11111111-1111-4111-8111-111111111111';
      else metadata.dispatchId = '22222222-2222-4222-8222-222222222222';
      const response = { ok: true, receipt: __entry.identity, images: ['data:image/png;base64,c3ludGhldGlj'], ...metadata };
      await __api.markDispatched(__owner, __resolved.key, __entry.identity.receiptId);
      await __api.recordReceiptEvidence(__owner, __resolved.key, response);
      await __api.recordReceiptEvidence(__owner, __resolved.key, response);
      const changed = await __attempt(() => __api.recordReceiptEvidence(__owner, __resolved.key, { ...response, resultSha256: 'c'.repeat(64) }));
      await __api.recordPaidArchive(__owner, __resolved.key, __entry.identity.receiptId,
        [{ archiveAssetId: 'fixture-actual-boundary-asset', archiveBatchId: 'fixture-actual-boundary-batch', jobId: __entry.identity.jobId, resultId: __entry.identity.jobId + ':1' }]);
      const ack = await __api.ack(__owner, __resolved.key, __entry.identity.receiptId);
      return { changed, ack, exported: await __api.exportPaidWorkspaceMetadata(__owner) };
    }, kind);
    assert.equal(value.changed.rejected, true); assert.equal(value.ack.ok, true);
    const row = value.exported.receipts[0]; assert.equal(row.localAcknowledged, true); assert.deepEqual(row.receiptIdentity, prepared.entry.identity);
    assert.equal(row.serverResponseMetadata.captureStatus, 'captured-from-server-response'); assert.equal(row.serverResponseMetadata.resultSha256, 'b'.repeat(64));
    assert.equal(row.nativeArchiveIds[0].jobId, prepared.entry.identity.jobId);
    assert.equal(row.serverResponseMetadata[kind === 'wallet' ? 'billingEventId' : 'dispatchId'], kind === 'wallet' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222');
    assert.match(value.exported.evidenceScope, /not provider or financial settlement/); await h.page.close();
  }
});

test('corrupt stored server billing UUID fails export even after prior valid receipt acknowledgement', async () => {
  const h = await fixture(); await authorize(h); await prepare(h);
  const result = await h.page.evaluate(async () => {
    await __api.markDispatched(__owner, __resolved.key, __entry.identity.receiptId);
    await __api.recordReceiptEvidence(__owner, __resolved.key, { ok: true, receipt: __entry.identity, images: ['data:image/png;base64,c3ludGhldGlj'],
      billingEventId: '11111111-1111-4111-8111-111111111111', resultSha256: 'd'.repeat(64) });
    await __api.ack(__owner, __resolved.key, __entry.identity.receiptId);
    const entry = (await __entries()).find(row => row.schema === 'SKU_RECEIPT_SERVER_METADATA_V1'); entry.billingEventId = '-'.repeat(36);
    const db = await new Promise(resolve => { const q = indexedDB.open('sz_sku_durable_receipt_v1:environment:' + encodeURIComponent(__SANJIE_ENVIRONMENT)); q.onsuccess = () => resolve(q.result); });
    await new Promise((resolve, reject) => { const tx = db.transaction('entries', 'readwrite'); tx.objectStore('entries').put(entry); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
    return __attempt(() => __api.exportPaidWorkspaceMetadata(__owner));
  });
  assert.equal(result.rejected, true); await h.page.close();
});
