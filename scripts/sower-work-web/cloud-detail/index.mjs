import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDetailOwnership, fail, ordinaryPath } from './ownership.mjs';

const ORIGINALS = 'detail-page-originals';
const ACTIONS = new Set(['load', 'assets', 'save', 'export', 'import']);
const IMAGE_EXTENSION = /\.(png|jpe?g|webp|avif)$/i;
const MAX_IMPORT_BYTES = 80 * 1024 * 1024;

/** Portable editing only: no generation, model, command, CDP or native archive capability is injected. */
export async function createCloudDetailService({ runtimeDir, store, filesystem, readConversation, DetailPageService, readFileSnapshot, inspectImage }) {
  const root = await fs.realpath(runtimeDir);
  const directory = path.join(root, 'cloud-detail');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await ordinaryPath(root, directory, { directory: true });
  const service = new DetailPageService(directory);
  const ownership = createDetailOwnership({ root, store, filesystem, readConversation });
  const importing = new Set();
  const unavailable = () => fail(403, 'DETAIL_CLOUD_GENERATION_DISABLED');
  return {
    capabilities: { cloudDetailEditor: true, cloudDetailImport: true, cloudDetailExport: true },
    async servePage(req, res, { path: route }) {
      const names = new Map([['/cloud-detail', ['page.html', 'text/html; charset=utf-8']], ['/cloud-detail/', ['page.html', 'text/html; charset=utf-8']], ['/cloud-detail/page.mjs', ['page.mjs', 'text/javascript; charset=utf-8']], ['/cloud-detail/page.css', ['page.css', 'text/css; charset=utf-8']]]);
      const item = names.get(route.split('?')[0]);
      if (!item) return false;
      if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'METHOD_NOT_ALLOWED');
      const bytes = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), item[0]));
      res.writeHead(200, { 'Content-Type': item[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'" });
      res.end(req.method === 'HEAD' ? '' : bytes);
      return true;
    },
    async handle(identity, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !ACTIONS.has(input.action)) fail(400, 'DETAIL_CLOUD_ACTION_UNAVAILABLE');
      const context = await ownership.contextFor(identity, input.conversationId);
      const validate = async () => {
        const current = await ownership.contextFor(identity, context.conversationId);
        if (current.workspace !== context.workspace || current.scope !== context.scope) fail(409, 'DETAIL_CLOUD_WORKSPACE_CHANGED');
      };
      if (input.action === 'import') {
        if (Object.keys(input).some((key) => !['action', 'conversationId', 'files'].includes(key)) || !Array.isArray(input.files) || !input.files.length || input.files.length > 40) fail(400, 'DETAIL_CLOUD_IMPORT_ARGUMENT_INVALID');
        const key = JSON.stringify([context.scope, context.conversationId]);
        if (importing.has(key)) fail(409, 'DETAIL_CLOUD_IMPORT_BUSY');
        importing.add(key);
        try {
          const snapshots = [];
          let total = 0;
          for (const item of input.files) {
            if (!item || typeof item !== 'object' || Object.keys(item).some((name) => !['path', 'sha256'].includes(name)) || !IMAGE_EXTENSION.test(item.path || '') || (item.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(item.sha256))) fail(400, 'DETAIL_CLOUD_IMPORT_ARGUMENT_INVALID');
            const source = await ownership.source(identity, context, item.path);
            const snapshot = await readFileSnapshot(root, source, item.sha256, 20 * 1024 * 1024);
            total += snapshot.bytes.length;
            if (total > MAX_IMPORT_BYTES) fail(413, 'DETAIL_CLOUD_IMPORT_TOO_LARGE');
            const evidence = await inspectImage(root, source, snapshot.sha256);
            if (evidence.width * evidence.height > 20_000_000) fail(413, 'DETAIL_CLOUD_IMPORT_TOO_LARGE');
            snapshots.push({ ...snapshot, extension: path.extname(source).toLowerCase() });
          }
          await validate();
          const destination = path.join(context.workspace, ORIGINALS);
          await fs.mkdir(destination, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
          await ordinaryPath(root, destination, { directory: true });
          const imported = [];
          for (const snapshot of snapshots) {
            await validate();
            const target = path.join(destination, snapshot.sha256 + snapshot.extension);
            const temporary = path.join(destination, `.${randomUUID()}.tmp`);
            await fs.writeFile(temporary, snapshot.bytes, { flag: 'wx', mode: 0o600, flush: true });
            try { await fs.link(temporary, target).catch((error) => { if (error.code !== 'EEXIST') throw error; }); }
            finally { await fs.unlink(temporary); }
            await ordinaryPath(root, target);
            await readFileSnapshot(context.workspace, target, snapshot.sha256);
            imported.push({ path: target, sha256: snapshot.sha256 });
          }
          return { imported, ...(await service.handle({ ...context, validate, submit: unavailable, job: unavailable, archiveIdentity: unavailable, archive: unavailable }, { action: 'assets', conversationId: context.conversationId })) };
        } finally { importing.delete(key); }
      }
      if (input.action === 'save') {
        for (const section of Array.isArray(input.project?.sections) ? input.project.sections : []) {
          for (const asset of Array.isArray(section?.versions) ? section.versions : []) {
            if (asset && typeof asset.path === 'string') await ownership.source(identity, context, asset.path);
          }
        }
      }
      return service.handle({ ...context, validate, submit: unavailable, job: unavailable, archiveIdentity: unavailable, archive: unavailable }, input);
    },
  };
}
