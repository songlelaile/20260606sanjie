import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startBridge, createSiteAuthenticator } from './bridge.mjs';
import { createIdentityBroker } from './identity.mjs';
import { createCloudFilesystem } from './filesystem.mjs';
import { createCloudDetailService } from './cloud-detail/index.mjs';
import { createCloudWorkbench } from './cloud-workbench/index.mjs';

if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Sower cloud runtime requires Node 24');
if (process.platform === 'linux' && process.getuid?.() === 0) throw new Error('Run the cloud workbench as the dedicated non-root sower-web OS account');
const release = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.env.SOWER_WEB_RUNTIME_DIR;
const publicOrigin = process.env.SOWER_WEB_PUBLIC_ORIGIN;
const accessUrl = process.env.SOWER_WEB_ACCESS_URL;
if (!runtime || !path.isAbsolute(runtime) || publicOrigin !== 'https://shaozhuangai.com' || !accessUrl) throw new Error('Configure independent absolute runtime dir, canonical HTTPS public origin, and loopback website access URL');
if (path.resolve(runtime) === release || path.resolve(runtime).startsWith(release + path.sep)) throw new Error('Runtime must persist outside the release directory');
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
fs.chmodSync(runtime, 0o700);
const temporaryDir = path.join(runtime, 'tmp');
fs.mkdirSync(temporaryDir, { recursive: true, mode: 0o700 });
fs.chmodSync(temporaryDir, 0o700);
const bundle = process.env.SOWER_WEB_ENGINE_BUNDLE || path.join(release, 'resources/bundled-aioncore', `${process.platform}-${process.arch}`);
const binary = path.join(bundle, 'aioncore');
if (!fs.existsSync(binary) || !fs.existsSync(path.join(bundle, 'managed-resources/manifest.json'))) throw new Error('Complete platform AionCore bundle is required');
const snapshot = path.join(release, 'vendor/packages/sower-control/src');
const { startSowerControl } = await import(path.join(snapshot, 'index.ts'));
const { ControlStore } = await import(path.join(snapshot, 'store.ts'));
const { DetailPageService } = await import(path.join(snapshot, 'multimodal/detailPages/service.ts'));
const { readOwnedFile, inspectOwnedImage } = await import(path.join(snapshot, 'multimodal/production/files.ts'));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const enginePort = await freePort();
const secret = randomBytes(48).toString('base64url');
const log = fs.openSync(path.join(runtime, 'engine.log'), 'a', 0o600);
const engine = spawn(binary, ['--host', '127.0.0.1', '--port', String(enginePort), '--identity-mode', 'aionpro', '--data-dir', path.join(runtime, 'engine'), '--work-dir', path.join(runtime, 'workspaces'), '--parent-pid', String(process.pid), '--app-version', '2.2.2', '--log-level', 'warn', '--managed-resources-mode', 'bundled'], {
  env: { ...process.env, TMPDIR: temporaryDir, TMP: temporaryDir, TEMP: temporaryDir, AIONCORE_BOOTSTRAP_SECRET: secret, AIONUI_BUNDLED_MANAGED_RESOURCES: path.join(bundle, 'managed-resources'), AIONUI_BUILTIN_ASSISTANTS_PATH: path.join(release, 'resources/builtin-assistants') },
  stdio: ['ignore', log, log],
});
fs.closeSync(log);
let engineError;
engine.on('error', (error) => { engineError = error; });
const engineReady = async () => {
  if (engineError || engine.exitCode !== null || engine.signalCode !== null) return false;
  try { return (await fetch(`http://127.0.0.1:${enginePort}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
};
let control, bridge, store, stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await bridge?.stop();
  store?.close();
  await control?.stop();
  if (engine.pid && engine.exitCode === null && engine.signalCode === null) {
    engine.kill('SIGTERM');
    const timer = setTimeout(() => engine.kill('SIGKILL'), 5000);
    timer.unref();
    await new Promise((resolve) => engine.once('exit', resolve));
    clearTimeout(timer);
  }
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().then(() => { process.exitCode = 0; }); });
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await engineReady()) { ready = true; break; }
    if (engineError || engine.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('Engine did not become ready; inspect private engine.log');
  const dataDir = path.join(runtime, 'control');
  control = await startSowerControl({ dataDir, enginePort, bootstrapSecret: secret, staticDir: path.join(release, 'renderer') });
  store = new ControlStore(dataDir);
  const filesystem = createCloudFilesystem(runtime, store);
  const cloudDetail = await createCloudDetailService({ runtimeDir: runtime, store, filesystem, DetailPageService, readFileSnapshot: readOwnedFile, inspectImage: inspectOwnedImage, readConversation: async (identity, id) => {
    const response = await fetch(`http://127.0.0.1:${control.port}/api/conversations/${encodeURIComponent(id)}`, { headers: { cookie: `sower_session=${identity.token}`, 'x-sower-csrf': identity.csrf }, signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) return null;
    return (await response.json()).data;
  } });
  const cloudWorkbench = await createCloudWorkbench({ runtimeDir: runtime });
  bridge = await startBridge({ port: Number(process.env.SOWER_WEB_PORT || 32150), controlPort: control.port, publicOrigin, authenticate: createSiteAuthenticator(accessUrl), broker: createIdentityBroker(store), filesystem, cloudDetail, cloudWorkbench, engineReady, indexFile: path.join(release, 'renderer/index.html') });
  fs.writeFileSync(path.join(runtime, 'services.json'), JSON.stringify({ product: 'Sower Work Web', bridgePort: bridge.port, controlPort: control.port, enginePort, enginePid: engine.pid, startedAt: new Date().toISOString(), importedDesktopState: false, capabilities: { desktopCdp: false, multimodalBridge: false, ...cloudDetail.capabilities, ...cloudWorkbench.capabilities } }, null, 2), { mode: 0o600 });
  engine.once('exit', () => { if (!stopping) { process.exitCode = 1; void stop(); } });
  console.info(`Sower Work Web ready on loopback port ${bridge.port}; independent cloud runtime`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  await stop();
}
