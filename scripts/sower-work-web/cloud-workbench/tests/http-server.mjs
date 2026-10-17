import { fixture } from './http-fixture.mjs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
const f = await fixture(); let peakRss = 0, peakHeap = 0;
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable(); let baseline = process.cpuUsage();
const sample = () => { const memory = process.memoryUsage(); peakRss = Math.max(peakRss, memory.rss); peakHeap = Math.max(peakHeap, memory.heapUsed); };
const timer = setInterval(sample, 50); sample();
process.send({ type: 'ready', base: f.base, runtimeDir: f.runtimeDir, nodeVersion: process.version });
process.on('message', async message => {
  if (message.type === 'metrics') { sample(); process.send({ type: 'metrics', cpuMicroseconds: process.cpuUsage(baseline), peakRssBytes: peakRss, peakHeapBytes: peakHeap, eventLoopP99Ms: loop.percentile(99) / 1e6 }); }
  if (message.type === 'reset') { baseline = process.cpuUsage(); peakRss = process.memoryUsage().rss; peakHeap = process.memoryUsage().heapUsed; loop.reset(); process.send({ type: 'reset' }); }
  if (message.type === 'restart') { f.restart(); process.send({ type: 'restart' }); }
  if (message.type === 'close') { clearInterval(timer); loop.disable(); await f.close(); process.send({ type: 'closed' }); process.disconnect(); }
});
