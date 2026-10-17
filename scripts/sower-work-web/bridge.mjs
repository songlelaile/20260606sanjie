import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';

export const APP_PREFIX = '/sower-work/app';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BLOCKED = /^\/(?:login|logout)$|^\/api\/sower\/(?:login|logout|register|sso)(?:\/|$)/;
const INDEPENDENT_FINANCE_WRITE = /^\/api\/sower\/billing\/(?:orders|notify|admin\/orders\/[^/]+\/settle)$/;
const INDEPENDENT_CREDIT_WRITE = /^\/api\/sower\/credits(?:\/|$)/;
const errorReply = (res, status, code) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ success: false, error: { code } }));
};
const readBody = async (req, limit) => {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('BODY_TOO_LARGE'), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks);
};

export function validatePublicRequest(req, publicOrigin) {
  const origin = new URL(publicOrigin);
  if (req.headers.host !== origin.host) throw Object.assign(new Error('HOST_REJECTED'), { status: 403 });
  if (req.headers['sec-fetch-site'] === 'cross-site') throw Object.assign(new Error('ORIGIN_REJECTED'), { status: 403 });
  if ((req.headers.origin && req.headers.origin !== origin.origin) || (!SAFE_METHODS.has(req.method) && !req.headers.origin)) {
    throw Object.assign(new Error('ORIGIN_REJECTED'), { status: 403 });
  }
}

export function stripPrefix(raw) {
  if (typeof raw !== 'string' || !raw.startsWith(APP_PREFIX + '/') || /%2f|%5c|%25|\\|\0/i.test(raw.split('?')[0])) {
    throw Object.assign(new Error('INVALID_PATH'), { status: 400 });
  }
  const target = raw.slice(APP_PREFIX.length);
  const parts = decodeURIComponent(target.split('?')[0]).split('/');
  if (parts.some((value) => value === '..' || value === '.')) throw Object.assign(new Error('INVALID_PATH'), { status: 400 });
  return target;
}

/** Every authorization request is uncached and reads only the configured site service. */
export function createSiteAuthenticator(accessUrl, fetchImpl = fetch) {
  const url = new URL(accessUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/api/sower-work/access') {
    throw new Error('Website access URL must be the loopback authorization endpoint');
  }
  return async (req) => {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Cookie: req.headers.cookie || '', Accept: 'application/json' },
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000),
      });
    } catch { throw Object.assign(new Error('AUTH_SERVICE_UNAVAILABLE'), { status: 503 }); }
    if (!response.ok) throw Object.assign(new Error(response.status === 401 ? 'LOGIN_REQUIRED' : 'ADMIN_REQUIRED'), { status: [401, 403].includes(response.status) ? response.status : 503 });
    let body;
    try { body = await response.json(); } catch { throw Object.assign(new Error('AUTH_SERVICE_UNAVAILABLE'), { status: 503 }); }
    if (body.allowed !== true || !['userId', 'tenantId', 'userName'].every((key) => typeof body[key] === 'string' && body[key].trim() && body[key].length <= 256)) {
      throw Object.assign(new Error('ADMIN_REQUIRED'), { status: 403 });
    }
    return { userId: body.userId, tenantId: body.tenantId, userName: body.userName };
  };
}

export async function startBridge(options) {
  const prefixScript = await readFile(options.prefixScript || new URL('./browser-prefix.js', import.meta.url), 'utf8');
  const html = (await readFile(options.indexFile, 'utf8')).replace('<head>', '<head>\n<script src="/sower-work/app/_bridge-prefix.js"></script>');
  const peers = new Set();
  const sockets = new Set();
  const authorized = new Map();
  // Image composition is separate from engine jobs, so bound it at this entry point.
  const detailBusy = new Set();
  const detailStarts = new Map();
  let detailActive = 0;
  const detailBudget = { concurrent: 2, perMinute: 6, ...(options.detailBudget || {}) };
  if (!Number.isInteger(detailBudget.concurrent) || detailBudget.concurrent < 1 || detailBudget.concurrent > 4 || !Number.isInteger(detailBudget.perMinute) || detailBudget.perMinute < 1 || detailBudget.perMinute > 60) throw new Error('INVALID_DETAIL_BUDGET');
  const remember = (req, site) => authorized.set(JSON.stringify([site.tenantId, site.userId]), { req: { headers: { cookie: req.headers.cookie || '' } }, site });
  const headersFor = (req, identity) => {
    const headers = { ...req.headers, host: `127.0.0.1:${options.controlPort}`, origin: `http://127.0.0.1:${options.controlPort}`, cookie: `sower_session=${identity.token}`, 'x-sower-csrf': identity.csrf, 'sec-fetch-site': 'same-origin' };
    for (const name of Object.keys(headers)) if (/^(?:x-sower-user|x-user|x-forwarded|forwarded|authorization|x-csrf-token)/i.test(name)) delete headers[name];
    return headers;
  };
  const server = createServer(async (req, res) => {
    try {
      validatePublicRequest(req, options.publicOrigin);
      const path = stripPrefix(req.url);
      const site = await options.authenticate(req);
      remember(req, site);
      const pathname = path.split('?')[0];
      if (BLOCKED.test(pathname)) return errorReply(res, 403, 'WEBSITE_SESSION_MANAGED');
      if (!SAFE_METHODS.has(req.method) && (INDEPENDENT_FINANCE_WRITE.test(pathname) || INDEPENDENT_CREDIT_WRITE.test(pathname))) {
        return errorReply(res, 409, 'CREDITS_MANAGED_BY_SANJIE');
      }
      if (path === '/_bridge-status' || path === '/api/sower/health') {
        const ready = await options.engineReady();
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        const state = { ready, product: 'Sower Work', version: '0.2.0', authMode: 'website-admin', capabilities: { desktopCdp: false, desktopBrowser: false, multimodalBridge: false, cloudDetailEditor: Boolean(options.cloudDetail), ...(options.cloudWorkbench?.capabilities || {}) }, modelConfiguration: 'independent-cloud-account', creditAuthority: 'sanjie_gateway', taskBilling: 'not_integrated' };
        res.end(JSON.stringify(path === '/api/sower/health' ? { success: true, data: state } : state));
        return;
      }
      if (['/', '/index.html'].includes(path.split('?')[0])) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(req.method === 'HEAD' ? '' : html);
        return;
      }
      if (path === '/_bridge-prefix.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(prefixScript);
        return;
      }
      const identity = options.broker.forSite(site);
      if (options.cloudWorkbench && await options.cloudWorkbench.handle(req, res, { path, identity, site })) return;
      if (options.cloudDetail?.servePage && await options.cloudDetail.servePage(req, res, { path, identity, site })) return;
      if (pathname === '/api/sower/detail-pages' && req.method === 'POST' && options.cloudDetail) {
        if (!req.headers['content-type']?.startsWith('application/json')) return errorReply(res, 415, 'JSON_REQUIRED');
        let body;
        try { body = JSON.parse((await readBody(req, 512 * 1024)).toString('utf8')); }
        catch (error) { if (error.status) throw error; return errorReply(res, 400, 'INVALID_JSON'); }
        let releaseDetail = () => {};
        if (body?.action === 'import' || body?.action === 'export') {
          const key = JSON.stringify([site.tenantId, site.userId]);
          const now = Date.now();
          const recent = (detailStarts.get(key) || []).filter((time) => now - time < 60_000);
          if (detailBusy.has(key) || detailActive >= detailBudget.concurrent) return errorReply(res, 429, 'DETAIL_CAPACITY_BUSY');
          if (recent.length >= detailBudget.perMinute) return errorReply(res, 429, 'DETAIL_RATE_LIMITED');
          detailStarts.set(key, [...recent, now]); detailBusy.add(key); detailActive++;
          releaseDetail = () => { detailBusy.delete(key); detailActive--; };
        }
        let data;
        try { data = await options.cloudDetail.handle(identity, body); }
        finally { releaseDetail(); }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify({ success: true, data }));
        return;
      }
      let payload;
      const upload = path.split('?')[0] === '/api/fs/upload' && req.method === 'POST';
      options.filesystem?.authorizeQuery(identity, path);
      if (options.filesystem && upload) {
        payload = await readBody(req, 30 * 1024 * 1024);
        await options.filesystem.validateUpload(identity, payload, req.headers['content-type'], async (id) => {
          const response = await fetch(`http://127.0.0.1:${options.controlPort}/api/conversations/${id}`, { headers: headersFor({ headers: {} }, identity), signal: AbortSignal.timeout(5000) });
          if (!response.ok) return null;
          return (await response.json()).data;
        });
      } else if (options.filesystem && !SAFE_METHODS.has(req.method) && req.headers['content-type']?.startsWith('application/json')) {
        const bytes = await readBody(req, 512 * 1024);
        let body;
        try { body = JSON.parse(bytes); } catch { throw Object.assign(new Error('INVALID_JSON'), { status: 400 }); }
        payload = Buffer.from(JSON.stringify(options.filesystem.prepareJson(identity, path, body)));
      }
      const forwardedHeaders = headersFor(req, identity);
      if (payload) { forwardedHeaders['content-length'] = String(payload.length); delete forwardedHeaders['transfer-encoding']; }
      const upstream = httpRequest({ host: '127.0.0.1', port: options.controlPort, path, method: req.method, headers: forwardedHeaders }, (incoming) => {
        const headers = { ...incoming.headers, 'cache-control': 'no-store' };
        delete headers['set-cookie'];
        if (typeof headers.location === 'string' && headers.location.startsWith('/')) headers.location = APP_PREFIX + headers.location;
        if (options.filesystem && upload) {
          void (async () => {
            try {
              const bytes = await readBody(incoming, 64 * 1024);
              const envelope = JSON.parse(bytes);
              if (incoming.statusCode >= 200 && incoming.statusCode < 300 && envelope.success && typeof envelope.data === 'string') options.filesystem.registerUpload(identity, envelope.data);
              res.writeHead(incoming.statusCode || 502, headers); res.end(bytes);
            } catch (error) { if (!res.headersSent) errorReply(res, error.status || 502, error.message); else res.destroy(); }
          })();
          return;
        }
        res.writeHead(incoming.statusCode || 502, headers);
        incoming.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) errorReply(res, 502, 'CONTROL_UNAVAILABLE'); else res.destroy(); });
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
      if (payload) upstream.end(payload); else req.pipe(upstream);
    } catch (error) { if (!res.headersSent) errorReply(res, error.status || 503, error.message); else res.destroy(); }
  });
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      validatePublicRequest(req, options.publicOrigin);
      if (req.headers.origin !== new URL(options.publicOrigin).origin) throw Object.assign(new Error('ORIGIN_REJECTED'), { status: 403 });
      const path = stripPrefix(req.url);
      if (!['/ws', '/api/stt/stream'].includes(path.split('?')[0])) throw Object.assign(new Error('WS_ROUTE_FORBIDDEN'), { status: 403 });
      const site = await options.authenticate(req);
      remember(req, site);
      const identity = options.broker.forSite(site);
      const upstream = httpRequest({ host: '127.0.0.1', port: options.controlPort, path, method: 'GET', headers: headersFor(req, identity) });
      upstream.on('upgrade', (incoming, remote, upstreamHead) => {
        socket.write(`HTTP/1.1 ${incoming.statusCode} Switching Protocols\r\n${Object.entries(incoming.headers).filter(([key]) => key !== 'set-cookie').map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) remote.write(head);
        const peer = { req, site, socket, remote };
        peers.add(peer);
        socket.pipe(remote); remote.pipe(socket);
        const close = () => { peers.delete(peer); socket.destroy(); remote.destroy(); };
        socket.on('close', close); remote.on('close', close); socket.on('error', close); remote.on('error', close);
      });
      upstream.on('response', (response) => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode || 502} Rejected\r\nConnection: close\r\n\r\n`); });
      upstream.on('error', () => socket.destroy());
      upstream.end();
    })().catch((error) => socket.end(`HTTP/1.1 ${error.status || 503} Rejected\r\nConnection: close\r\n\r\n`));
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => undefined); });
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      await Promise.allSettled([...authorized.entries()].map(async ([key, entry]) => {
        try {
          const current = await options.authenticate(entry.req);
          if (current.userId !== entry.site.userId || current.tenantId !== entry.site.tenantId) throw new Error('IDENTITY_CHANGED');
        } catch {
          authorized.delete(key);
          options.broker.revoke(entry.site);
          for (const peer of peers) if (peer.site.userId === entry.site.userId && peer.site.tenantId === entry.site.tenantId) {
            peer.socket.destroy(); peer.remote.destroy();
          }
        }
      }));
    } finally { checking = false; }
  }, options.recheckMs || 30000);
  timer.unref();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port || 0, '127.0.0.1', resolve); });
  return { port: server.address().port, stop: async () => { clearInterval(timer); for (const socket of sockets) socket.destroy(); for (const peer of peers) peer.remote.destroy(); await new Promise((resolve) => server.close(resolve)); } };
}
