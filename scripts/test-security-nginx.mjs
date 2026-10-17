import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Dedicated throwaway process only: never reads/reloads the host configuration.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nginx = process.env.SECURITY_NGINX_BIN || 'nginx';
const probe = spawnSync(nginx, ['-v'], { encoding: 'utf8' });
if (probe.error?.code === 'ENOENT') {
  console.error('UNVERIFIED: Nginx is unavailable; no syntax/runtime acceptance.');
  process.exit(2);
}
assert.equal(probe.status, 0, probe.error?.message || probe.stderr);

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sanjie-edge-security-'));
let worker;
let upstream;
let passed = 0;
const check = (name, condition) => {
  assert.ok(condition, name);
  passed += 1;
};
const quote = (value) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};
const request = (port, resource, { method = 'GET', headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: resource, method,
      headers: { 'User-Agent': 'Codex computer-use test', ...headers }
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Sandbox request timed out')));
    req.end();
  });

try {
  const readme = await readFile(path.join(root, 'security/nginx/README.md'), 'utf8');
  const identity = readme.match(/```nginx\n(# Apply inside every existing proxy location[\s\S]*?)\n```/);
  assert.ok(identity, 'README client identity snippet must be testable');
  upstream = http.createServer((req, res) => {
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ url: req.url, method: req.method, headers: req.headers }));
  });
  const upstreamPort = await listen(upstream);
  const reservation = net.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  await mkdir(path.join(sandbox, 'body'));
  await mkdir(path.join(sandbox, 'proxy'));

  const proxyLocation = (prefix) => `
      location ${prefix} {
        proxy_pass http://127.0.0.1:${upstreamPort};
        proxy_set_header Host $host;
        ${identity[1]}
      }`;
  const config = `
pid ${quote(path.join(sandbox, 'nginx.pid'))};
error_log ${quote(path.join(sandbox, 'error.log'))} warn;
events { worker_connections 128; }
http {
  access_log off;
  client_body_temp_path ${quote(path.join(sandbox, 'body'))};
  proxy_temp_path ${quote(path.join(sandbox, 'proxy'))};
  include ${quote(path.join(root, 'security/nginx/anti-clone-http.conf'))};
  server {
    listen 127.0.0.1:${port};
    include ${quote(path.join(root, 'security/nginx/anti-clone-server.conf'))};
    ${proxyLocation('^~ /_next/')}
    ${proxyLocation('^~ /downloads/')}
    ${proxyLocation('^~ /creative/')}
    ${proxyLocation('/')}
  }
}`;
  const configPath = path.join(sandbox, 'nginx.conf');
  await writeFile(configPath, config);
  const syntax = spawnSync(nginx, ['-t', '-p', sandbox + '/', '-c', configPath], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.error?.message || syntax.stderr);
  check('Actual Nginx accepts the composed http/server configuration', true);

  let output = '';
  worker = spawn(nginx, ['-p', sandbox + '/', '-c', configPath, '-g', 'daemon off;'], { stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', (chunk) => { output += chunk; });
  worker.stderr.on('data', (chunk) => { output += chunk; });
  worker.on('error', (error) => { output += error.message; });
  let ready = false;
  for (let i = 0; i < 50; i += 1) {
    if (worker.exitCode !== null) throw new Error('Sandbox Nginx exited: ' + output);
    try {
      ready = (await request(port, '/health')).status === 200;
      if (ready) break;
    } catch {}
    await delay(50);
  }
  check('Dedicated loopback Nginx started', ready);

  const blocked = [
    '/.env', '/.env.production.local', '/.git/config', '/downloads/.env.local',
    '/downloads/collector.zip.map', '/_next/static/chunks/app.js.map?cache=1',
    '/_next/static/chunks/app.js.MAP', '/api/creative/assets/vendor.js.map',
    '/creative/private.pem', '/private-assets/dmp/test.zip',
    '/downloads/config/database.sqlite3', '/package.json', '/downloads/archive.zip.bak',
    '/_next/static/%2eenv', '/_next/static/foo/%2e%2e/%2eenv', '/downloads//.git/config'
  ];
  for (const resource of blocked) {
    check('Sensitive path rejected: ' + resource, (await request(port, resource)).status === 404);
  }
  const allowed = [
    '/_next/static/chunks/app.js', '/_next/image?url=%2Fimage.png&w=640&q=75',
    '/creative/promptlab.html', '/creative/assets/extension.js',
    '/downloads/sycm-keyword-collector-v1.9.80.zip',
    '/downloads/shaozhuang-ai-v1.9.80-macos-full.zip',
    '/downloads/shaozhuang-ai-legacy-icon.png', '/api/auth/me', '/.well-known/security.txt'
  ];
  for (const resource of allowed) {
    check('Ordinary resource and Codex UA preserved: ' + resource, (await request(port, resource)).status === 200);
  }

  const echoed = JSON.parse((await request(port, '/inspect-identity', {
    headers: { 'X-Real-IP': '192.0.2.1', 'X-Forwarded-For': '192.0.2.2', Forwarded: 'for=192.0.2.3' }
  })).body).headers;
  check('X-Real-IP spoof overwritten', echoed['x-real-ip'] === '127.0.0.1');
  check('X-Forwarded-For spoof overwritten', echoed['x-forwarded-for'] === '127.0.0.1');
  check('Forwarded spoof removed', echoed.forwarded === undefined);

  const login = [];
  for (let i = 0; i < 30; i += 1) {
    login.push((await request(port, i % 2 ? '/api/auth/login/' : '/api/auth/login', {
      method: 'POST', headers: { 'X-Real-IP': `192.0.2.${i}`, 'X-Forwarded-For': `192.0.2.${i}` }
    })).status);
  }
  check('Login burst initially permits requests', login.includes(200));
  check('Login spoofed IP burst is rejected with 429', login.filter((status) => status === 429).length >= 15);
  check('Registration allowance remains independent', (await request(port, '/api/auth/register', { method: 'POST' })).status === 200);
  const registration = [];
  for (let i = 0; i < 15; i += 1) {
    registration.push((await request(port, '/api/auth/register', { method: 'POST' })).status);
  }
  check('Registration has its own lower burst budget', registration.filter((status) => status === 429).length >= 10);
  for (let i = 0; i < 30; i += 1) {
    check('Resources bypass exhausted auth budgets ' + i, (await request(port, '/_next/static/app.js?i=' + i)).status === 200);
    check('GET authentication endpoint is not POST-limited ' + i, (await request(port, '/api/auth/login')).status === 200);
  }

  console.log(`PASS ${passed} checks; isolated Nginx syntax and runtime accepted.`);
  console.log('Production remains UNVERIFIED: no real config, routing, CDN chain, or application download authorization was tested.');
} finally {
  if (worker && worker.exitCode === null) {
    worker.kill('SIGQUIT');
    for (let i = 0; i < 50 && worker.exitCode === null; i += 1) await delay(50);
    if (worker.exitCode === null) {
      worker.kill('SIGKILL');
      await once(worker, 'exit');
    }
  }
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
  await rm(sandbox, { recursive: true, force: true });
}
