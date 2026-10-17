// Local UI acceptance only: exact sidebar/workspace assets, synthetic transport.
// The preview has its own browser origin/storage environment and blocks proxy,
// payment and other API writes. It never loads account credentials.
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, ".codex-deploy/aesthetic-mirror-preview");
const port = Number(process.env.MIRROR_PREVIEW_PORT || 18824);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid preview port");
const themeSource = await readFile(path.join(root, "src/app/globals.css"), "utf8");
const themeVariables = themeSource.match(/^:root\s*\{[^}]+\}/)?.[0];
if (!themeVariables) throw new Error("Actual app theme variables unavailable");
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "entry.jsx"), `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CreativeStudio } from '../../src/components/creative/CreativeStudio';
function App() {
  const [url, setUrl] = useState(location.href);
  useEffect(() => { const read = () => setUrl(location.href); window.addEventListener('preview-navigate', read); window.addEventListener('popstate', read); return () => { window.removeEventListener('preview-navigate', read); window.removeEventListener('popstate', read); }; }, []);
  const params = new URL(url).searchParams;
  return <CreativeStudio kind="image" initialSurface={params.get('surface') || 'mirror'} initialBatch={params.get('batch') === '1'} initialHistory={params.get('history') === '1'} initialApiConfig={params.get('apiConfig') === '1'} />;
}
createRoot(document.getElementById('root')).render(<App />);
`);
await build({
  entryPoints: [path.join(output, "entry.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  platform: "browser", jsx: "automatic", alias: { "@": path.join(root, "src") },
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "local-preview-router", setup(builder) {
    builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "preview-router", namespace: "preview" }));
    builder.onLoad({ filter: /.*/, namespace: "preview" }, () => ({ loader: "js", contents: `
      const router = { replace(url) { history.replaceState(null, '', url); window.dispatchEvent(new Event('preview-navigate')); }, push(url) { history.pushState(null, '', url); window.dispatchEvent(new Event('preview-navigate')); } };
      export const useRouter = () => router;
    ` }));
  } }]
});

const bridgeFixture = `
(() => {
  'use strict';
  const owner = 'local-mirror-ui-fixture', requests = [], registered = new Set();
  const config = { provider: 'openai-compatible', imageAdapter: 'generic-json', imageModel: 'preview-image-model', imageEndpoint: 'https://preview.invalid/v1/images/generations' };
  let sequence = 0, database;
  window.__SANJIE_ENVIRONMENT = 'aesthetic-mirror-preview-v1';
  window.__MIRROR_PREVIEW = { synthetic: true, providerRequests: 0, billingActions: 0, requests, accountKey: owner };
  async function db() {
    if (database) return database;
    database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('sz_mirror_preview_archive_v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('assets', { keyPath: 'resultId' });
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }); return database;
  }
  async function store(item) {
    const connection = await db();
    await new Promise((resolve, reject) => { const tx = connection.transaction('assets', 'readwrite'); tx.objectStore('assets').put(item); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    return { ok: true, asset: item };
  }
  async function assets() {
    const connection = await db();
    return new Promise((resolve, reject) => { const tx = connection.transaction('assets', 'readonly'), request = tx.objectStore('assets').getAll(); request.onsuccess = () => resolve(request.result || []); request.onerror = () => reject(request.error); });
  }
  function downloadItems(items, filename) {
    (Array.isArray(items) ? items : [items]).filter(Boolean).forEach((item, index) => { const link = document.createElement('a'); link.href = typeof item === 'string' ? item : item.url || item.image || item.dataUrl; link.download = filename || item.filename || item.name || ('本地预览-' + (index + 1) + '.png'); link.click(); });
    return Promise.resolve({ ok: true });
  }
  const info = () => ({ ready: true, supportsReference: true, provider: config.provider, imageAdapter: config.imageAdapter, model: config.imageModel, imageModel: config.imageModel, label: '本地预览 · 无真实生成', qualityOptions: ['auto','high'], generationSpeeds: ['standard'], supportsQuality: true, supportsSpeed: false });
  const bridge = {
    ready: async () => ({ ok: true, accountKey: owner }),
    getAccountKey: async () => owner,
    archiveContext: () => ({ accountKey: owner, config: { provider: config.provider, imageModel: config.imageModel } }),
    config: () => ({ ...config }), modelInfo: info,
    refresh: async () => ({ ok: true, accountKey: owner }),
    listBoundApis: async () => ({ ok: true, accountKey: owner, providers: [{ provider: config.provider, label: '本地预览模型', imageModel: config.imageModel, configured: true, supportsReference: true }], activeProvider: config.provider }),
    selectBoundApi: async () => ({ ok: true }), useBoundApi: async () => ({ ok: true }),
    setApiBusy() {}, registerGenerationJob: (id) => registered.add(id), unregisterGenerationJob: (id) => registered.delete(id),
    newJobId: () => 'local-preview-' + (++sequence),
    send: async (type, message) => {
      if (type === 'CANCEL_GENERATION') return { ok: true, cancelled: true, providerSubmitted: false };
      if (type !== 'GENERATE_IMAGE') return { ok: false, code: 'LOCAL_PREVIEW_ONLY', error: '本地预览只接受模拟生图动作', providerSubmitted: false, definitiveFailure: true };
      const checked = window.SZ_AESTHETIC_MIRROR_CONTRACT.validatePayload(message.payload);
      if (!checked.ok) return { ...checked, providerSubmitted: false, definitiveFailure: true };
      requests.push({ type, jobId: message.jobId, payload: structuredClone(checked.payload), synthetic: true });
      await new Promise(resolve => setTimeout(resolve, 250));
      // Reuse uploaded product bytes for the preview result. No model ran.
      return { ok: true, images: [checked.payload.productImages[0]], jobId: message.jobId, taskId: 'synthetic-' + sequence, providerSubmitted: false, synthetic: true };
    },
    archive: async (item, context) => {
      if (context && context.accountKey !== owner) return { ok: false, error: '预览账号不匹配' };
      return store({ ...structuredClone(item), accountKey: owner, synthetic: true });
    },
    archiveOriginal: async (item) => store({ ...structuredClone(item), resultId: 'original-' + (++sequence), accountKey: owner, original: true, synthetic: true }),
    downloadItems, download: downloadItems,
    openHistory: async () => {
      const modal = document.getElementById('archiveHistoryModal'); modal.hidden = false;
      const rows = await assets(); document.getElementById('fixtureHistoryItems').innerHTML = rows.map(item => '<figure><img src="' + item.url + '" style="max-width:160px"><figcaption>本地预览 · ' + (item.businessRoleName || '原图') + '</figcaption></figure>').join('');
      return { ok: true };
    },
    openConfig: () => { document.getElementById('configModal').hidden = false; return { ok: true }; }
  };
  window.SZ_CREATIVE_TOOLS_BRIDGE = bridge;
  window.SZ_LAB_STARTUP = { ready() { document.documentElement.dataset.labStartup = 'ready'; }, fail(error) { document.documentElement.dataset.labStartup = 'error'; document.getElementById('fixtureError').textContent = String(error?.message || error || '启动失败'); } };
  window.SZCreativeCreditHints = { image() {}, local() {}, chat() {}, register() {} };
})();
`;
const workspace = `<!doctype html><html lang="zh-CN" data-lab-startup="pending"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>爆款复刻 · 本地验收</title>
<link rel="stylesheet" href="/creative/labs/image-prompt-lab/promptlab.css"><link rel="stylesheet" href="/creative/labs/image-prompt-lab/image-upload.css"><link rel="stylesheet" href="/creative/labs/image-prompt-lab/aesthetic-mirror.css">
<style>body{margin:0}.fixture-modal{position:fixed;inset:30px;z-index:2147483646;background:#17200f;color:#f3edd7;padding:30px;border:1px solid #675d24;overflow:auto}.fixture-modal[hidden]{display:none}.fixture-modal button{padding:10px}.fixture-modal h2{font-size:22px}</style></head><body>
<main class="app"><p id="fixtureError" role="alert"></p></main>
<section id="archiveHistoryModal" class="fixture-modal" hidden><button onclick="this.parentNode.hidden=true">关闭</button><h2>本地预览生成记录</h2><p>以下记录来自模拟传输；未调用模型、未扣分。</p><div id="fixtureHistoryItems"></div></section>
<section id="configModal" class="fixture-modal" hidden><button onclick="this.parentNode.hidden=true">关闭</button><h2>本地预览 API 配置</h2><p>此页面仅模拟输入和生图交互，真实 API 保存在原工作台且未被读取。</p></section>
<script>${bridgeFixture}</script><script src="/creative/labs/image-prompt-lab/creative-tools-contract.js"></script><script src="/creative/labs/image-prompt-lab/aesthetic-mirror-contract.js"></script><script src="/creative/labs/image-prompt-lab/image-upload.js"></script><script src="/creative/labs/image-prompt-lab/aesthetic-mirror-ui.js"></script></body></html>`;
const shell = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>创作工作台 · 爆款复刻本地验收</title><link rel="stylesheet" href="/app.css"><style>${themeVariables}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px system-ui,-apple-system,sans-serif}.preview-banner{height:34px;display:flex;align-items:center;justify-content:center;background:#372b07;color:#ffdf85;font-size:12px}#root{height:calc(100vh - 34px);padding:16px}.creative-studio{height:100%}button,a{font-family:inherit}</style></head><body><div class="preview-banner">本地 UI 验收 · 模拟传输和结果 · 未调用模型、未扣积分</div><div id="root"></div><script src="/app.js"></script></body></html>`;
const mime = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json" };
createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
  try {
    if (req.method !== "GET") { json({ error: "本地预览禁止 API 写入和模型/支付请求" }, 403); return; }
    if (url.pathname === "/" || url.pathname === "/dashboards/operating-network") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(shell); return; }
    if (url.pathname === "/creative/labs/image-prompt-lab/promptlab.html" && url.searchParams.get("mode") === "mirror") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(workspace); return; }
    if (url.pathname === "/api/creative/credits") { json({ data: { wallet: { balanceCents: 14444 }, plan: { name: "本地预览", multiplierBps: 10000, ruleVersion: 1 }, models: [] } }); return; }
    if (url.pathname === "/api/creative/credits/ledger") { json({ data: { items: [], total: 0, page: 1, pageSize: 20 } }); return; }
    if (url.pathname.startsWith("/api/")) { json({ error: "本地 UI 验收不连接真实 API" }, 403); return; }
    const filename = ["/app.js", "/app.css"].includes(url.pathname) ? path.join(output, url.pathname.slice(1)) : path.resolve(root, "public", "." + decodeURIComponent(url.pathname));
    if (!filename.startsWith(output + path.sep) && !filename.startsWith(path.join(root, "public") + path.sep)) { json({ error: "Invalid asset path" }, 403); return; }
    res.setHeader("content-type", mime[path.extname(filename)] || "application/octet-stream"); res.setHeader("cache-control", "no-store"); res.end(await readFile(filename));
  } catch (error) { json({ error: error.code === "ENOENT" ? "Preview asset not ready" : "Preview server error" }, error.code === "ENOENT" ? 404 : 500); }
}).listen(port, "127.0.0.1", () => console.log(`Aesthetic mirror UI preview: http://127.0.0.1:${port}/dashboards/operating-network?surface=mirror (synthetic transport, zero paid/provider calls)`));
