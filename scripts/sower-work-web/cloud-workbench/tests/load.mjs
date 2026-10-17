import { fork } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { originalCsv, annotations, scope, upload, marketFor } from './http-fixture.mjs';

const output = process.argv[2]; if (!output) throw new Error('Provide report output path');
const child = fork(new URL('./http-server.mjs', import.meta.url), [], { silent: true }); let childErrors = '';
child.stderr.on('data', data => { childErrors += data.toString(); });
const event = type => new Promise((resolve, reject) => { const timer = setTimeout(() => { child.off('message', onMessage); reject(new Error(`Child ${type} timeout`)); }, 10000); const onMessage = message => { if (message.type === type) { clearTimeout(timer); child.off('message', onMessage); resolve(message); } }; child.on('message', onMessage); });
const rpc = async type => { const pending = event(type === 'close' ? 'closed' : type); child.send({ type }); return pending; };
const ready = await event('ready'); const base = ready.base + '/sower-work/app/api/sower/cloud-workbench';
const request = async (route, method = 'GET', body) => fetch(base + route, { method, headers: { Cookie: 'fixture=a', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
const call = async (route, method, body) => { const response = await request(route, method, body); const value = await response.json(); if (!response.ok || !value.success) throw new Error(JSON.stringify(value)); return value.data; };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const percentile = (values, quantile) => values[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)] || 0;
const report = { generatedAt: new Date().toISOString(), environment: { node: ready.nodeVersion, os: `${os.platform()} ${os.release()} ${os.arch()}`, transport: 'real loopback HTTP; fixed trusted session fixture, real private file store and pinned engine', servicePid: child.pid, modelCalls: 0, platformCalls: 0, paymentCalls: 0, tempRuntime: ready.runtimeDir }, budget: { concurrent: [1, 8, 24], durationPerStageMs: 5000, requestTimeoutMs: 5000, stopPeakRssBytes: 512 * 1024 * 1024, stopUnexpectedErrorRatio: 0.01, workload: ['scoped job JSON', 'scored draft CSV download', 'literal knowledge search', 'immutable original download SHA256'] }, stages: [], failures: [], limitations: ['SaaS session and CSRF are simulated here; integrated bridge/browser acceptance is separate', 'small synthetic imported dataset; not live platform evidence or paid generation capacity', 'no unified billing, ledger, OAuth, local Chrome, MCP or tenant business collection exercised', 'file quota, request budget and worker limits are process-local; multiple service processes sharing one runtime are unsupported'] };
try {
  let job = await call('/jobs', 'POST', { scope, ...upload(originalCsv, '负载词表.csv') });
  job = await call(`/jobs/${job.id}/annotations`, 'PUT', { expectedRevision: job.revision, humanConfirmed: true, annotations });
  job = await call(`/jobs/${job.id}/market`, 'PUT', { expectedRevision: job.revision, scopeVerified: true, complete: true, ...upload(JSON.stringify(marketFor(job)), '负载市场.json') });
  job = await call(`/jobs/${job.id}/generate`, 'POST', { expectedRevision: job.revision, limit: 10 });
  const knowledge = await call('/knowledge', 'POST', upload('人工原文：婚礼喜糖，克重尚未提供。', '负载知识.md'));
  const originalHash = sha(originalCsv); let sequence = 0;
  for (const concurrency of report.budget.concurrent) {
    await rpc('reset'); const started = performance.now(), samples = []; let errors = 0, timeouts = 0, completed = 0, stopped = false;
    const worker = async () => { while (!stopped && performance.now() - started < report.budget.durationPerStageMs) {
      const begun = performance.now(); const routeKind = sequence++ % 4;
      try {
        const routes = [`/jobs/${job.id}`, `/jobs/${job.id}/export?format=csv`, '/knowledge/search?q=' + encodeURIComponent('喜糖'), `/jobs/${job.id}/original`];
        const response = await request(routes[routeKind]); if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (routeKind === 0 && JSON.parse(bytes).data.id !== job.id) throw new Error('job mismatch');
        if (routeKind === 1 && !bytes.toString().includes('链接编号')) throw new Error('CSV output missing');
        if (routeKind === 2 && JSON.parse(bytes).data.hits[0]?.id !== knowledge.id) throw new Error('knowledge mismatch');
        if (routeKind === 3 && (sha(bytes) !== originalHash || response.headers.get('x-content-sha256') !== originalHash)) throw new Error('download hash mismatch');
      } catch (error) { errors++; if (/timeout/i.test(error.message)) timeouts++; report.failures.push({ concurrency, routeKind, error: error.message }); }
      samples.push(performance.now() - begun); completed++; if (completed >= 100 && errors / completed > report.budget.stopUnexpectedErrorRatio) stopped = true;
    } };
    await Promise.all(Array.from({ length: concurrency }, worker)); const elapsedMs = performance.now() - started; const metrics = await rpc('metrics');
    samples.sort((a, b) => a - b); const stage = { concurrency, elapsedMs, completed, throughputPerSec: completed / (elapsedMs / 1000), p50Ms: percentile(samples, .5), p95Ms: percentile(samples, .95), p99Ms: percentile(samples, .99), maxMs: samples.at(-1), unexpectedErrors: errors, errorRate: errors / completed, timeouts, stopped, ...metrics, cpuPercentOfOneCore: 100 * (metrics.cpuMicroseconds.user + metrics.cpuMicroseconds.system) / (elapsedMs * 1000), maxQueue: 'bounded workers: global 2/per owner 1; requests reject rather than unbounded queue' };
    delete stage.type; report.stages.push(stage); process.stdout.write(JSON.stringify(stage) + '\n');
    if (metrics.peakRssBytes > report.budget.stopPeakRssBytes || stopped) break;
  }
  await rpc('restart'); const persisted = await call(`/jobs/${job.id}`); if (persisted.output.generated.links !== job.output.generated.links) throw new Error('restart output mismatch');
  report.originalHash = originalHash; report.originalBytesUnchanged = true; report.durableReload = true; report.generatedLinks = job.output.generated.links; report.ledgerDifference = 'not applicable; no accounting integrated or called';
  report.pass = report.failures.length === 0 && report.stages.length === 3;
} catch (error) { report.pass = false; report.failures.push({ error: error.message }); }
finally { await rpc('close'); report.tempRuntimeRemoved = !(await fs.stat(ready.runtimeDir).then(() => true, () => false)); report.stderr = childErrors; await fs.writeFile(output, JSON.stringify(report, null, 2)); }
if (!report.pass) process.exitCode = 1;
