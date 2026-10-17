import { Worker } from 'node:worker_threads';
import { digest } from './store.mjs';
import { fail } from './import.mjs';

export const limits = Object.freeze({ fileBytes: 5 * 1024 * 1024, requestBytes: 8 * 1024 * 1024, workspaceBytes: 128 * 1024 * 1024, jobsPerWorkspace: 16, knowledgeFilesPerWorkspace: 50, keywordsPerJob: 5000, scoringKeywords: 200, revisionsPerJob: 100, activeWritesGlobal: 8, activeWritesPerAccount: 2, writesPerMinutePerAccount: 60, importsPerMinutePerAccount: 20, heavyTasksGlobal: 2, heavyTasksPerAccount: 1, generationsPerMinutePerAccount: 6, generationTimeoutMs: 20000 });
export function createLimiter() {
  const owners = new Map(); let writes = 0, heavy = 0;
  const stateFor = ({ site, identity }) => {
    const key = digest(JSON.stringify([site.tenantId, site.userId, identity.userId, identity.workspaceId])); const now = Date.now();
    for (const [owner, state] of owners) if (!state.writes && !state.heavy && now - state.minuteStart >= 60000) owners.delete(owner);
    if (!owners.has(key)) { if (owners.size >= 5000) fail('SERVER_BUSY', 429); owners.set(key, { minuteStart: now, writes: 0, heavy: 0, calls: 0, imports: 0, generations: 0 }); }
    const state = owners.get(key); if (now - state.minuteStart >= 60000) { state.minuteStart = now; state.calls = 0; state.imports = 0; state.generations = 0; } return state;
  };
  return {
    beginWrite(context, route) {
      const state = stateFor(context); const importing = ['/jobs', '/knowledge'].includes(route), generating = /\/generate$/.test(route);
      if (writes >= limits.activeWritesGlobal || state.writes >= limits.activeWritesPerAccount || state.calls >= limits.writesPerMinutePerAccount || (importing && state.imports >= limits.importsPerMinutePerAccount) || (generating && state.generations >= limits.generationsPerMinutePerAccount)) fail('WORKBENCH_RATE_LIMIT', 429);
      state.calls++; if (importing) state.imports++; if (generating) state.generations++; state.writes++; writes++;
      return () => { state.writes--; writes--; };
    },
    compare(context, input, response) {
      const state = stateFor(context); if (heavy >= limits.heavyTasksGlobal || state.heavy >= limits.heavyTasksPerAccount) fail('WORKBENCH_TASK_BUSY', 429);
      heavy++; state.heavy++;
      return new Promise((resolve, reject) => {
        let settled = false, worker;
        try { worker = new Worker(new URL('./compare-worker.mjs', import.meta.url), { workerData: input, resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } }); }
        catch { heavy--; state.heavy--; reject(Object.assign(new Error('WORKBENCH_TASK_FAILED'), { status: 503 })); return; }
        const finish = (error, output) => { if (settled) return; settled = true; clearTimeout(timer); response.off('close', disconnected); worker.terminate().catch(() => {}); heavy--; state.heavy--; error ? reject(error) : resolve(output); };
        const error = code => Object.assign(new Error(code), { status: code === 'WORKBENCH_TASK_TIMEOUT' ? 504 : code === 'WORKFLOW_INPUT_INVALID' ? 400 : 503 });
        const timer = setTimeout(() => finish(error('WORKBENCH_TASK_TIMEOUT')), limits.generationTimeoutMs);
        const disconnected = () => finish(error('WORKBENCH_TASK_CANCELLED'));
        response.once('close', disconnected);
        worker.once('message', message => { if (message.error) { const validation = error('WORKFLOW_INPUT_INVALID'); validation.detail = message.error; finish(validation); } else finish(null, message.output); });
        worker.once('error', () => finish(error('WORKBENCH_TASK_FAILED')));
        worker.once('exit', () => { if (!settled) finish(error('WORKBENCH_TASK_FAILED')); });
      });
    },
  };
}
