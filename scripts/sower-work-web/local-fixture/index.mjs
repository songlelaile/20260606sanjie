import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createPortServer } from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createFixtureProject } from './project.mjs';
import { startFixtureProxy, FIXTURE_COOKIE, INNER_COOKIE } from './proxy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = fileURLToPath(import.meta.url);
const options = new Map();
for (let index = 3; index < process.argv.length; index += 2) options.set(process.argv[index], process.argv[index + 1]);
const command = process.argv[2] || 'start';
const workspace = path.resolve(options.get('--workspace') || path.join(here, '../../..'));
const session = path.resolve(options.get('--session') || path.join(workspace, '.codex-deploy/sw-cloud-first-batch-20261002', `local-fixture-${Date.now()}`));
const stateFile = path.join(session, 'fixture-state.json');
const readState = () => fs.readFile(stateFile, 'utf8').then(JSON.parse);
const saveState = (value) => fs.writeFile(stateFile, JSON.stringify(value, null, 2), { mode: 0o600 });
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const freePort = () => new Promise((resolve, reject) => { const server = createPortServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
async function healthy(origin) { try { const response = await fetch(`${origin}/_fixture/health`, { signal: AbortSignal.timeout(1500) }); return response.ok ? await response.json() : null; } catch { return null; } }

async function start() {
  if (Number(process.versions.node.split('.')[0]) !== 24 || process.platform !== 'darwin') throw new Error('This isolated launcher requires Node 24 and the real macOS AionCore bundle');
  if (await fs.stat(session).then(() => true, () => false)) throw new Error('Use a new fixture --session directory; never overwrite a running or unrelated session');
  await fs.mkdir(session, { recursive: true, mode: 0o700 });
  const baseRelease = path.resolve(options.get('--base-release') || path.join(workspace, '.codex-deploy/sower-work-web-20261002/sower-release'));
  const dependencies = path.resolve(options.get('--dependencies') || path.join(workspace, 'node_modules'));
  const runtimeSource = options.get('--runtime-source') || 'workspace';
  if (!['workspace', 'release'].includes(runtimeSource)) throw new Error('Use --runtime-source workspace or release');
  const engineBundle = path.resolve(options.get('--engine-bundle') || path.join(homedir(), 'Desktop/SowerWork/resources/bundled-aioncore/darwin-arm64'));
  await fs.access(path.join(baseRelease, 'renderer/index.html')); await fs.access(path.join(engineBundle, 'aioncore')); await fs.access(path.join(dependencies, 'next/dist/bin/next'));
  const release = path.join(session, 'development-runtime');
  await fs.mkdir(release);
  for (const name of ['vendor', 'renderer', 'resources', 'package.json']) await fs.cp(path.join(baseRelease, name), path.join(release, name), { recursive: true });
  await fs.mkdir(path.join(release, 'runtime'));
  const runtimeNames = ['runtime.mjs', 'bridge.mjs', 'identity.mjs', 'filesystem.mjs', 'browser-prefix.js', 'cloud-detail', 'cloud-workbench'];
  const runtimeFiles = [];
  async function collect(directory, relative = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = path.join(relative, entry.name), source = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(source, name);
      else if (entry.isFile()) { const bytes = await fs.readFile(source); runtimeFiles.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
    }
  }
  const runtimeRoot = runtimeSource === 'release' ? path.join(baseRelease, 'runtime') : path.join(workspace, 'scripts/sower-work-web');
  for (const name of runtimeNames) await fs.cp(path.join(runtimeRoot, name), path.join(release, 'runtime', name), { recursive: true });
  await collect(path.join(release, 'runtime'));
  await fs.symlink(dependencies, path.join(release, 'node_modules'));
  const componentFiles = await createFixtureProject({ workspace, directory: path.join(session, 'next-fixture'), dependencies });
  const ports = { proxy: Number(options.get('--port') || await freePort()), bridge: Number(options.get('--bridge-port') || await freePort()), next: await freePort(), access: await freePort() };
  if (new Set(Object.values(ports)).size !== 4 || Object.values(ports).some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('Fixture ports must be distinct unprivileged integers');
  const state = { schema: 'SW_LOCAL_FIXTURE_V1', status: 'starting', finalRelease: false, runtimeSource, runtimeRoot, session, workspace, baseRelease, dependencies, engineBundle, ports, origin: `http://localhost:${ports.proxy}`, url: `http://localhost:${ports.proxy}/sower-work`, fixtureIdentity: { userId: 'fixture-local-admin', tenantId: 'fixture-local-tenant', userName: '本地隔离测试管理员' }, componentFiles, runtimeFiles, startedAt: new Date().toISOString(), providerCalls: 0, modelMessageCalls: 0 };
  await saveState(state);
  const log = await fs.open(path.join(session, 'launcher.log'), 'a', 0o600);
  const child = spawn(process.execPath, [script, 'serve', '--session', session], { cwd: workspace, detached: true, env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8' }, stdio: ['ignore', log.fd, log.fd] }); child.unref(); await log.close();
  for (let attempt = 0; attempt < 180; attempt++) {
    const result = await healthy(state.origin);
    if (result?.ready === true) { const current = await readState(); console.info(JSON.stringify({ url: current.url, session, stateFile, launcherPid: current.launcherPid, bridgePort: current.ports.bridge, nextPort: current.ports.next, finalRelease: false, fixtureCredits: true, providerCalls: 0, modelMessageCalls: 0 }, null, 2)); return; }
    const current = await readState(); if (current.status === 'failed' || current.status === 'stopped') throw new Error(`Fixture failed: ${current.error || current.status}; inspect ${path.join(session, 'launcher.log')}`);
    await sleep(500);
  }
  throw new Error(`Fixture launch timed out; inspect ${path.join(session, 'launcher.log')}`);
}

async function serve() {
  let state = await readState();
  if (state.schema !== 'SW_LOCAL_FIXTURE_V1' || state.session !== session || state.status !== 'starting') throw new Error('Invalid fixture state');
  const children = [], logs = [];
  let auth, proxy, stopping = false;
  const stopChild = async (child) => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    if (child.exitCode !== null || child.signalCode !== null) return;
    let timer;
    await Promise.race([once(child, 'exit'), new Promise((resolve) => { timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} resolve(); }, 7000); })]); clearTimeout(timer);
  };
  const stop = async (error) => {
    if (stopping) return; stopping = true;
    await proxy?.stop();
    await Promise.all(children.map(stopChild));
    if (auth) await new Promise((resolve) => { auth.closeAllConnections(); auth.close(resolve); });
    for (const log of logs) await log.close();
    const runtimeLog = path.join(session, 'runtime/engine.log');
    if (await fs.stat(runtimeLog).then(() => true, () => false)) await fs.copyFile(runtimeLog, path.join(session, 'fixture-engine.log'));
    await fs.rm(path.join(session, 'runtime'), { recursive: true, force: true });
    await fs.rm(path.join(session, 'next-fixture/.next'), { recursive: true, force: true });
    state = { ...state, status: error ? 'failed' : 'stopped', error: error?.message, stoppedAt: new Date().toISOString(), cleanup: { runtimeRemoved: true, nextCacheRemoved: true, serversClosed: true, childGroupsStopped: true } };
    await saveState(state); process.exitCode = error ? 1 : 0;
  };
  process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); });
  try {
    auth = createServer((req, res) => {
      if (req.url !== '/api/sower-work/access' || req.headers.cookie !== INNER_COOKIE) { res.writeHead(401); res.end(JSON.stringify({ allowed: false })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ allowed: true, ...state.fixtureIdentity }));
    });
    await new Promise((resolve, reject) => { auth.once('error', reject); auth.listen(state.ports.access, '127.0.0.1', resolve); });
    const launch = async (name, args, cwd, env) => {
      const log = await fs.open(path.join(session, `${name}.log`), 'a', 0o600); logs.push(log);
      const child = spawn(process.execPath, args, { cwd, detached: true, env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', NEXT_TELEMETRY_DISABLED: '1', ...env }, stdio: ['ignore', log.fd, log.fd] }); children.push(child);
      child.once('error', (error) => { void stop(error); }); child.once('exit', (code) => { if (!stopping) void stop(new Error(`${name} exited unexpectedly (${code})`)); }); return child;
    };
    const runtime = await launch('runtime', ['--import', 'tsx', 'runtime/runtime.mjs'], path.join(session, 'development-runtime'), { SOWER_WEB_RUNTIME_DIR: path.join(session, 'runtime'), SOWER_WEB_PUBLIC_ORIGIN: 'https://shaozhuangai.com', SOWER_WEB_ACCESS_URL: `http://127.0.0.1:${state.ports.access}/api/sower-work/access`, SOWER_WEB_PORT: String(state.ports.bridge), SOWER_WEB_ENGINE_BUNDLE: state.engineBundle });
    const next = await launch('next', [path.join(state.dependencies, 'next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(state.ports.next)], path.join(session, 'next-fixture'), { NODE_ENV: 'development' });
    state = { ...state, launcherPid: process.pid, runtimePid: runtime.pid, nextPid: next.pid };
    await saveState(state);
    proxy = await startFixtureProxy({ port: state.ports.proxy, bridgePort: state.ports.bridge, nextPort: state.ports.next, canonicalOrigin: 'https://shaozhuangai.com', health: () => ({ ready: state.status === 'ready', schema: state.schema, finalRelease: false, fixtureCredits: true, fixtureIdentity: state.fixtureIdentity, launcherPid: process.pid, providerCalls: 0, modelMessageCalls: 0 }), stop: () => stop() });
    for (let attempt = 0; attempt < 180 && !stopping; attempt++) {
      try {
        const [engine, page] = await Promise.all([fetch(`${state.origin}/sower-work/app/api/sower/health`, { headers: { Cookie: FIXTURE_COOKIE }, signal: AbortSignal.timeout(2000) }), fetch(`${state.origin}/sower-work`, { signal: AbortSignal.timeout(10000) })]);
        const engineBody = await engine.json(); await page.arrayBuffer();
        if (engine.ok && engineBody.data?.ready === true && page.ok) { state = { ...state, status: 'ready', readyAt: new Date().toISOString(), capabilities: engineBody.data.capabilities }; await saveState(state); console.info(`Isolated fixture ready: ${state.url}`); return; }
      } catch {}
      await sleep(300);
    }
    if (!stopping) throw new Error('Fixture services did not become ready');
  } catch (error) { await stop(error); }
}

async function stop() {
  const state = await readState();
  if (state.schema !== 'SW_LOCAL_FIXTURE_V1' || state.session !== session) throw new Error('Refuse to stop an unrelated fixture');
  if (state.status === 'stopped') { console.info(JSON.stringify({ stopped: true, session, cleanup: state.cleanup })); return; }
  const response = await fetch(`${state.origin}/_fixture/stop`, { method: 'POST', headers: { Origin: state.origin, Cookie: FIXTURE_COOKIE }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Fixture stop endpoint rejected the request');
  for (let attempt = 0; attempt < 60; attempt++) { const current = await readState(); if (['stopped', 'failed'].includes(current.status) && current.cleanup?.runtimeRemoved) { console.info(JSON.stringify({ stopped: true, session, cleanup: current.cleanup })); return; } await sleep(250); }
  throw new Error('Fixture cleanup has not completed; inspect launcher.log before retrying');
}

try { if (command === 'start') await start(); else if (command === 'serve') await serve(); else if (command === 'stop') await stop(); else throw new Error('Use start or stop'); }
catch (error) { console.error(error.message); process.exitCode = 1; }
