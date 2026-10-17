import { readFile } from 'node:fs/promises';
import { createWorkbenchStore, digest, safeName } from './store.mjs';
import { createLimiter, limits } from './limits.mjs';
import { analysisPlan, importKeywords, mergeImported, validateAnnotations, csvExport, decodeContent, jsonFile, knowledgeText, DEMAND_TYPES, fail } from './import.mjs';

const PREFIX = '/api/sower/cloud-workbench';
const capabilities = Object.freeze({ cloudKeywordWorkbench: true, cloudKnowledgeText: true, keywordFileImport: true, keywordDeduplication: true, humanRootAnnotation: true, scoredLinkDraftFromCompleteImportedEvidence: true, knowledgeTextImportSearch: true, retainedOriginals: true, modelsCalled: false, platformCollection: false, desktopStateImported: false, accountingIntegrated: false });
const asset = new Map([['/cloud-workbench', ['page.html', 'text/html; charset=utf-8']], ['/cloud-workbench/', ['page.html', 'text/html; charset=utf-8']], ['/cloud-workbench/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/cloud-workbench/style.css', ['style.css', 'text/css; charset=utf-8']]]);
const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify({ success: status < 400, ...(status < 400 ? { data } : { error: data }) })); };
async function body(req) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) fail('BODY_TOO_LARGE', 413); chunks.push(chunk); } try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) fail('JSON_BODY_REQUIRED'); return value; } catch { fail('JSON_BODY_REQUIRED'); } }
const jobSummary = job => ({ id: job.id, fileName: job.fileName, createdAt: job.createdAt, revision: job.revision, stage: job.stage, stats: job.merged.stats, missingPopularity: job.merged.words.filter(word => word.pop === null).length, scope: job.scope, links: job.output?.generated?.links || 0, originalSha256: job.originalSha256 });
const knowledgeSummary = ({ text: _text, ...record }) => record;
function workflow(call) { try { return call(); } catch (error) { if (error.status) throw error; const validation = Object.assign(new Error('WORKFLOW_INPUT_INVALID'), { status: 400 }); validation.detail = String(error.message).slice(0, 200); throw validation; } }
function expectedRevision(job, value) { if (!Number.isSafeInteger(value) || value !== job.revision) fail('REVISION_CONFLICT', 409); }
const download = (req, res, bytes, fileName, type) => { res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename="sower-work-export"; filename*=UTF-8''${encodeURIComponent(safeName(fileName)).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Content-SHA256': digest(bytes) }); res.end(req.method === 'HEAD' ? '' : bytes); };

/** The bridge supplies authenticated site/control identities; no user headers or body identities are accepted. */
export function createCloudWorkbench({ runtimeDir }) {
  const store = createWorkbenchStore(runtimeDir), limiter = createLimiter();
  return {
    capabilities,
    async handle(req, res, context) {
      const url = new URL(context.path, 'http://workbench.local'); const pathname = url.pathname;
      if (!asset.has(pathname) && !pathname.startsWith(PREFIX + '/') && pathname !== PREFIX) return false;
      let finishWrite;
      try {
        store.partition(context);
        if (asset.has(pathname)) {
          if (!['GET', 'HEAD'].includes(req.method)) fail('METHOD_NOT_ALLOWED', 405);
          const [file, type] = asset.get(pathname); const bytes = await readFile(new URL(file, import.meta.url));
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'" }); res.end(req.method === 'HEAD' ? '' : bytes); return true;
        }
        const route = pathname.slice(PREFIX.length);
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) finishWrite = limiter.beginWrite(context, route);
        if (route === '/status' && req.method === 'GET') { send(res, 200, { capabilities, limits, userName: context.site.userName, accountId: context.identity.userId, workspaceId: context.identity.workspaceId, demandTypes: DEMAND_TYPES, maxFileBytes: limits.fileBytes, notes: ['文件在当前云端账号工作区保存；桌面原件与历史尚未同步', '拆词需人工确认；没有调用模型', '市场完整性和范围由导入者核对；系统没有采集或验证真实平台', '知识库为文本文件检索，未接入智能体、向量检索或OCR', '需补齐精确人气及同范围完整市场数据才可生成评分清单'] }); return true; }
        if (route === '/jobs' && req.method === 'GET') { send(res, 200, { jobs: store.list(context, 'jobs').map(jobSummary) }); return true; }
        if (route === '/jobs' && req.method === 'POST') {
          const input = await body(req); const fileName = safeName(input.fileName); const original = decodeContent(input.contentBase64);
          const suppliedScope = { ...input.scope, accountId: context.identity.userId, workspaceId: context.identity.workspaceId, objectId: input.scope?.objectId || null };
          const source = workflow(() => importKeywords(original, fileName, suppliedScope, input.sourceKind));
          const merged = workflow(() => mergeImported(source, digest(original))); const plan = workflow(() => analysisPlan(merged));
          const job = store.create(context, 'jobs', original, fileName, { schemaVersion: 1, revision: 0, stage: 'awaiting-human-annotation', scope: merged.scope, merged, plan, annotations: null, market: null, output: null, browserCollectionVerified: false, businessAccepted: false, modelCalled: false });
          send(res, 201, job); return true;
        }
        const match = /^\/jobs\/([0-9a-f-]{36})(?:\/(annotations|market|generate|export|original|market-original))?$/i.exec(route);
        if (match) {
          const [, id, action] = match; let job = store.get(context, 'jobs', id);
          if (!action && req.method === 'GET') { send(res, 200, job); return true; }
          if (action === 'original' && ['GET', 'HEAD'].includes(req.method)) { download(req, res, store.original(context, 'jobs', id), job.fileName, 'application/octet-stream'); return true; }
          if (action === 'market-original' && ['GET', 'HEAD'].includes(req.method)) { if (!job.market) fail('NOT_FOUND', 404); download(req, res, store.original(context, 'jobs', id, true), job.market.fileName, 'application/json; charset=utf-8'); return true; }
          if (action === 'export' && ['GET', 'HEAD'].includes(req.method)) {
            if (url.searchParams.get('format') === 'csv') {
              const sheet = job.output?.generated?.sheets?.[0] || { headers: ['关键词', '精确人气', '词根', '词根类型', '数据状态'], rows: job.merged.words.map(word => { const annotation = job.annotations?.find(value => value.kw === word.kw); return [word.kw, word.pop, annotation?.parts.join('|') || '', annotation?.partTypes.join('|') || '', job.output ? '规则草稿·待复核' : annotation ? '人工确认词根·尚未生成链接' : '尚未确认词根']; }) };
              download(req, res, csvExport(sheet), job.output ? '链接清单草稿.csv' : '关键词与词根清单.csv', 'text/csv; charset=utf-8');
            } else download(req, res, Buffer.from(JSON.stringify(job, null, 2)), '关键词工作台完整记录.json', 'application/json; charset=utf-8');
            return true;
          }
          if (['annotations', 'market', 'generate'].includes(action) && ['POST', 'PUT'].includes(req.method)) {
            const input = await body(req); job = store.get(context, 'jobs', id); expectedRevision(job, input.expectedRevision);
            let artifact;
            if (job.revision >= 100) fail('JOB_REVISION_LIMIT', 413);
            if (action === 'annotations') {
              if (input.humanConfirmed !== true) fail('HUMAN_CONFIRMATION_REQUIRED');
              job.annotations = validateAnnotations(job.merged, input.annotations); job.output = null; job.stage = 'human-annotated';
            } else if (action === 'market') {
              if (input.scopeVerified !== true || input.complete !== true) fail('MARKET_SCOPE_AND_COMPLETENESS_REQUIRED');
              const fileName = safeName(input.fileName); if (!/\.json$/i.test(fileName)) fail('MARKET_JSON_REQUIRED');
              const original = decodeContent(input.contentBase64); const parsed = jsonFile(original); const market = parsed.market || parsed;
              const scopeValues = scope => ['accountId', 'workspaceId', 'platform', 'categoryId', 'startDate', 'endDate', 'objectId'].map(key => scope?.[key]);
              if (!Array.isArray(market.rows) || !market.rows.length || market.rows.length > 5000 || market.kind !== 'sycm-market-rank' || JSON.stringify(scopeValues(market.scope)) !== JSON.stringify(scopeValues(job.scope))) fail('MARKET_SCOPE_MISMATCH');
              if (job.market) fail('MARKET_ALREADY_BOUND_IMPORT_NEW_JOB', 409);
              job.market = { ...market, artifactId: `uploaded:${digest(original)}`, complete: true, scopeVerified: true, fileName, originalSha256: digest(original), verificationSource: 'importer-declared; platform-not-collected' };
              artifact = { name: 'market-original.bin', bytes: original }; job.output = null; job.stage = 'market-imported';
            } else {
              if (!job.annotations) fail('HUMAN_ANNOTATIONS_REQUIRED'); if (!job.market) fail('COMPLETE_MARKET_INPUT_REQUIRED');
              if (job.merged.words.length > 200) fail('LINK_GENERATION_MAX_200_KEYWORDS', 413);
              if (input.category != null && (typeof input.category !== 'string' || input.category.length > 256)) fail('CATEGORY_FIELD_INVALID');
              const output = await limiter.compare(context, { merged: job.merged, category: input.category || job.scope.categoryId, annotations: job.annotations, market: job.market, limit: input.limit ?? 20, browserCollectionVerified: false }, res);
              job = store.get(context, 'jobs', id); expectedRevision(job, input.expectedRevision); job.output = output;
              job.output.browserCollectionVerified = false; job.output.businessAccepted = false; job.stage = 'draft-needs-review';
            }
            job.revision++; job.updatedAt = new Date().toISOString();
            if (job.output) artifact = { name: `output-${job.revision}.json`, bytes: Buffer.from(JSON.stringify(job.output, null, 2)) };
            store.commit(context, 'jobs', id, job, artifact); send(res, 200, job); return true;
          }
          fail('METHOD_NOT_ALLOWED', 405);
        }
        if (route === '/knowledge' && req.method === 'GET') { send(res, 200, { files: store.list(context, 'knowledge').map(knowledgeSummary) }); return true; }
        if (route === '/knowledge' && req.method === 'POST') {
          const input = await body(req); const fileName = safeName(input.fileName); const original = decodeContent(input.contentBase64); const parsed = knowledgeText(fileName, original);
          send(res, 201, knowledgeSummary(store.create(context, 'knowledge', original, fileName, { schemaVersion: 1, ...parsed }))); return true;
        }
        if (route === '/knowledge/search' && req.method === 'GET') {
          const query = (url.searchParams.get('q') || '').trim().toLowerCase(); if (!query || query.length > 200) fail('SEARCH_QUERY_REQUIRED');
          const hits = store.list(context, 'knowledge').flatMap(record => { const index = record.text.toLowerCase().indexOf(query); if (index < 0 && !record.fileName.toLowerCase().includes(query)) return []; return [{ ...knowledgeSummary(record), snippet: index >= 0 ? record.text.slice(Math.max(0, index - 80), index + query.length + 80) : record.fileName }]; }).slice(0, 20);
          send(res, 200, { hits, mode: 'literal-text-and-file-name' }); return true;
        }
        const knowledge = /^\/knowledge\/([0-9a-f-]{36})(?:\/(original))?$/i.exec(route);
        if (knowledge && ['GET', 'HEAD'].includes(req.method)) { const record = store.get(context, 'knowledge', knowledge[1]); if (knowledge[2]) download(req, res, store.original(context, 'knowledge', knowledge[1]), record.fileName, 'application/octet-stream'); else send(res, 200, record); return true; }
        fail('NOT_FOUND', 404);
      } catch (error) {
        if (!res.headersSent && !res.destroyed) { if (error.status === 429) res.setHeader('Retry-After', '60'); send(res, error.status || 503, { code: error.status ? error.message : 'WORKBENCH_UNAVAILABLE', ...(error.detail ? { detail: error.detail } : {}) }); } else res.destroy();
      } finally {
        finishWrite?.();
      }
      return true;
    },
  };
}
