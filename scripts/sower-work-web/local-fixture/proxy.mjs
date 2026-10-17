import { createServer, request } from 'node:http';

export const FIXTURE_COOKIE = 'sw_fixture=fixture-admin-local-only';
export const INNER_COOKIE = 'fixture=fixture-admin-local-only';
const safe = new Set(['GET', 'HEAD', 'OPTIONS']);
const reply = (res, status, code) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ success: false, error: { code } })); };

/** Local-only boundary; canonical production validation is retained behind this test proxy. */
export function validateFixtureRequest(req, origin, { cookie = true } = {}) {
  const expected = new URL(origin);
  if (req.headers.host !== expected.host) throw Object.assign(new Error('FIXTURE_HOST_REJECTED'), { status: 403 });
  if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== origin) || (!safe.has(req.method) && !req.headers.origin)) throw Object.assign(new Error('FIXTURE_ORIGIN_REJECTED'), { status: 403 });
  if (cookie && !(req.headers.cookie || '').split(';').map((part) => part.trim()).includes(FIXTURE_COOKIE)) throw Object.assign(new Error('FIXTURE_COOKIE_REQUIRED'), { status: 401 });
}

export async function startFixtureProxy({ port, bridgePort, nextPort, canonicalOrigin, health, stop }) {
  const origin = `http://localhost:${port}`;
  const sockets = new Set();
  const diagnostics = { blockedExecutionRequests: 0, modelMessageCallsForwarded: 0, providerWriteCallsForwarded: 0 };
  const target = (req) => req.url.startsWith('/sower-work/app/') ? { port: bridgePort, cloud: true } : { port: nextPort, cloud: false };
  const forwarded = (req, destination) => {
    const headers = { ...req.headers, host: destination.cloud ? new URL(canonicalOrigin).host : `localhost:${nextPort}`, origin: destination.cloud ? canonicalOrigin : origin, 'sec-fetch-site': 'same-origin' };
    for (const key of Object.keys(headers)) if (/^(?:forwarded|x-forwarded|x-sower-user|x-user|authorization)/i.test(key)) delete headers[key];
    if (destination.cloud) headers.cookie = INNER_COOKIE;
    return headers;
  };
  const server = createServer(async (req, res) => {
    try {
      const pathname = req.url.split('?')[0];
      const entry = ['/', '/sower-work'].includes(pathname) && ['GET', 'HEAD'].includes(req.method);
      validateFixtureRequest(req, origin, { cookie: !entry && pathname !== '/_fixture/health' });
      if (pathname === '/_fixture/health') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ...health(), origin, diagnostics })); return; }
      if (pathname === '/_fixture/stop' && req.method === 'POST') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ stopping: true })); setImmediate(() => { void stop(); }); return; }
      if (pathname === '/') { res.writeHead(302, { Location: '/sower-work', 'Set-Cookie': `${FIXTURE_COOKIE}; Path=/; HttpOnly; SameSite=Strict`, 'Cache-Control': 'no-store' }); res.end(); return; }
      if (entry) res.setHeader('Set-Cookie', `${FIXTURE_COOKIE}; Path=/; HttpOnly; SameSite=Strict`);
      const destination = target(req);
      if (destination.cloud && !safe.has(req.method)) {
        const inner = pathname.slice('/sower-work/app'.length);
        if (inner === '/api/conversations' && req.method === 'POST') {
          const chunks = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > 512 * 1024) throw Object.assign(new Error('BODY_TOO_LARGE'), { status: 413 }); chunks.push(chunk); }
          const bytes = Buffer.concat(chunks); let body;
          try { body = JSON.parse(bytes); } catch { throw Object.assign(new Error('INVALID_JSON'), { status: 400 }); }
          if (body.type !== 'aionrs' || body.model?.provider_id !== '' || body.model?.model !== '') { diagnostics.blockedExecutionRequests++; return reply(res, 403, 'FIXTURE_MODEL_CALLS_DISABLED'); }
          const upstream = request({ host: '127.0.0.1', port: destination.port, path: req.url, method: req.method, headers: { ...forwarded(req, destination), 'content-length': String(bytes.length) } }, (incoming) => { res.writeHead(incoming.statusCode || 502, incoming.headers); incoming.pipe(res); });
          upstream.on('error', () => { if (!res.headersSent) reply(res, 502, 'FIXTURE_UPSTREAM_UNAVAILABLE'); else res.destroy(); }); upstream.end(bytes); return;
        }
        if (!(req.method === 'POST' && ['/api/fs/upload', '/api/sower/detail-pages'].includes(inner)) && !inner.startsWith('/api/sower/cloud-workbench/')) { diagnostics.blockedExecutionRequests++; return reply(res, 403, 'FIXTURE_EXECUTION_DISABLED'); }
      }
      const upstream = request({ host: '127.0.0.1', port: destination.port, path: req.url, method: req.method, headers: forwarded(req, destination) }, (incoming) => { res.writeHead(incoming.statusCode || 502, incoming.headers); incoming.pipe(res); });
      upstream.on('error', () => { if (!res.headersSent) reply(res, 502, 'FIXTURE_UPSTREAM_UNAVAILABLE'); else res.destroy(); }); req.on('aborted', () => upstream.destroy()); res.on('close', () => { if (!res.writableEnded) upstream.destroy(); }); req.pipe(upstream);
    } catch (error) { if (!res.headersSent) reply(res, error.status || 503, error.message); else res.destroy(); }
  });
  server.on('upgrade', (req, socket, head) => {
    try {
      validateFixtureRequest(req, origin);
      if (req.headers.origin !== origin) throw new Error('FIXTURE_ORIGIN_REJECTED');
      const destination = target(req);
      if (destination.cloud && req.url.split('?')[0] !== '/sower-work/app/ws') throw new Error('FIXTURE_WS_EXECUTION_DISABLED');
      const upstream = request({ host: '127.0.0.1', port: destination.port, path: req.url, method: 'GET', headers: forwarded(req, destination) });
      upstream.on('upgrade', (incoming, remote, upstreamHead) => {
        sockets.add(remote); socket.write(`HTTP/1.1 ${incoming.statusCode} Switching Protocols\r\n${Object.entries(incoming.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`); if (upstreamHead.length) socket.write(upstreamHead); if (head.length) remote.write(head); socket.pipe(remote); remote.pipe(socket); const close = () => { sockets.delete(remote); socket.destroy(); remote.destroy(); }; socket.on('close', close); remote.on('close', close); socket.on('error', close); remote.on('error', close);
      }); upstream.on('response', (incoming) => { incoming.resume(); socket.end(`HTTP/1.1 ${incoming.statusCode || 502} Rejected\r\nConnection: close\r\n\r\n`); }); upstream.on('error', () => socket.destroy()); upstream.end();
    } catch { socket.end('HTTP/1.1 403 Rejected\r\nConnection: close\r\n\r\n'); }
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => undefined); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { origin, port, diagnostics, stop: async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); } };
}
