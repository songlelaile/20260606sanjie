import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const stage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineArg = process.argv.find(value => value.startsWith('--baseline-root='));
const baseline = baselineArg ? path.resolve(baselineArg.slice('--baseline-root='.length)) : null;
const exported = path.resolve(stage, '../production-source');
const frozen = path.resolve(stage, '../frozen-v2-node22/payload');
const lab = 'public/creative/labs/image-prompt-lab/';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = {
  'background.js': 'a7ab4ddca2a942da3fb24aaa2221aee46031d041bc455dd30dac362dfb18dcd8',
  'studio-runtime-20261010-credit-v1.js': 'decab94e23987eff03de98d02ae4a060336e26f5cc209efad5eca1fc584f2d87',
  'promptlab.html': '63f9856e29317700ec08f7b50d31c3640cac383d21297b9c7184acea996b2cab',
  'studio-genesis-ui.js': 'c7a7d2b7d2de4b084bd3feda2475a07153c186687a662294704f96be173b1f6e',
  'studio-views-20261009-v1.js': '8189e3107c315f1c839f91304677b89141e59e1fb71a6a71624c28f0c7dc36e0'
};
function before(name) {
  const root = baseline || (['background.js', 'studio-runtime-20261010-credit-v1.js', 'promptlab.html'].includes(name) ? frozen : exported);
  const bytes = fs.readFileSync(path.join(root, lab, name));
  assert.equal(sha(bytes), pins[name], `Verified V2 bytes: ${name}`);
  return bytes;
}
function replaceSource(bundle, original, replacement) {
  const offset = bundle.indexOf(original);
  assert.ok(offset >= 0, 'Original full source must occur in actual bundle');
  assert.equal(bundle.indexOf(original, offset + 1), -1, 'Source must occur exactly once');
  const prefix = bundle.subarray(0, offset), suffix = bundle.subarray(offset + original.length);
  const bytes = Buffer.concat([prefix, replacement, suffix]);
  assert.ok(bytes.subarray(0, prefix.length).equals(prefix));
  assert.ok(bytes.subarray(prefix.length + replacement.length).equals(suffix));
  return { bytes, originalSourceSha256: sha(original), replacementSourceSha256: sha(replacement), prefixBytes: prefix.length, suffixBytes: suffix.length, prefixSha256: sha(prefix), suffixSha256: sha(suffix) };
}
const newBackground = fs.readFileSync(path.join(stage, lab, 'background.js'));
const newUi = fs.readFileSync(path.join(stage, lab, 'studio-genesis-ui.js'));
const runtime = replaceSource(before('studio-runtime-20261010-credit-v1.js'), before('background.js'), newBackground);
const views = replaceSource(before('studio-views-20261009-v1.js'), before('studio-genesis-ui.js'), newUi);
let html = before('promptlab.html').toString('utf8');
for (const [oldName, newName, count] of [
  ['studio-runtime-20261009-v1.js', 'studio-runtime-20261010-credit-v3.js', 1],
  ['studio-runtime-20261010-credit-v1.js', 'studio-runtime-20261010-credit-v3.js', 1],
  ['studio-views-20261009-v1.js', 'studio-views-20261010-credit-v3.js', 2]
]) {
  assert.equal(html.split(oldName).length - 1, count, `Exact HTML reference count: ${oldName}`);
  html = html.split(oldName).join(newName);
}
const outputs = [
  ['studio-runtime-20261010-credit-v3.js', runtime.bytes],
  ['studio-views-20261010-credit-v3.js', views.bytes],
  ['promptlab.html', Buffer.from(html)]
];
const check = process.argv.includes('--check');
for (const [name, bytes] of outputs) {
  const target = path.join(stage, lab, name);
  if (check) assert.ok(fs.readFileSync(target).equals(bytes), `Full exact derived bytes: ${name}`);
  else fs.writeFileSync(target, bytes);
}
const describe = ({ bytes, ...preserved }) => ({ ...preserved, size: bytes.length, sha256: sha(bytes) });
console.log(JSON.stringify({ mode: check ? 'read-only-check' : 'local-build', runtime: describe(runtime), views: describe(views), promptlabSha256: sha(Buffer.from(html)), preservedOldBundles: true }));
