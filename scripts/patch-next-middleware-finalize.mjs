#!/usr/bin/env node
// Backport https://github.com/vercel/next.js/pull/85418 to pinned packages.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const nextRootIndex = args.indexOf('--next-root');
if (nextRootIndex < 0 || !args[nextRootIndex + 1] || args.some((arg, i) => !['--next-root', '--apply'].includes(arg) && i !== nextRootIndex + 1)) {
  throw new Error('Usage: node patch-next-middleware-finalize.mjs --next-root PATH [--apply]');
}
const apply = args.includes('--apply');
const root = await fs.realpath(args[nextRootIndex + 1]);
const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'next-patch-manifest.json'), 'utf8'));
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const expectedFiles = manifest.versions[version];
if (!expectedFiles) throw new Error(`Refusing unknown Next version: ${version}`);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const beforeText = 'requestData.body.finalize();';
const afterText = 'await requestData.body.finalize();';
const changes = [];
const report = [];
for (const [relative, expected] of Object.entries(expectedFiles)) {
  const target = path.join(root, relative);
  const data = await fs.readFile(target);
  const digest = sha256(data);
  if (digest === expected.patchedSha256) {
    report.push({ file: relative, status: 'already_patched', sha256: digest });
    continue;
  }
  if (digest !== expected.baselineSha256) throw new Error(`Refusing unexpected contents: ${target} (${digest})`);
  const source = data.toString('utf8');
  if (source.split(beforeText).length !== 2) throw new Error(`Refusing unexpected finalize call count: ${target}`);
  const patched = Buffer.from(source.replace(beforeText, afterText), 'utf8');
  if (sha256(patched) !== expected.patchedSha256) throw new Error(`Patched digest mismatch: ${target}`);
  changes.push({ target, patched });
  report.push({ file: relative, status: apply ? 'patched' : 'ready', sha256: expected.patchedSha256 });
}
// Validate every file before changing either CJS or ESM.
if (apply) for (const { target, patched } of changes) await fs.writeFile(target, patched);
console.log(JSON.stringify({ nextRoot: root, version, applied: apply, files: report }, null, 2));
