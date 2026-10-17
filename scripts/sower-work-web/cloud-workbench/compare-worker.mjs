import { parentPort, workerData } from 'node:worker_threads';
import { compare } from './workflow/scripts/core.mjs';
try { parentPort.postMessage({ output: compare(workerData) }); }
catch (error) { parentPort.postMessage({ error: String(error.message).slice(0, 200) }); }
