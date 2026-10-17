'use strict';

// Offline-only three-file overlay. Frozen installed-v7 bytes are immutable inputs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { applyEdits } = require('./prepare-sku-durable-production-overlay-v7.cjs');
const ROOT = path.resolve(__dirname, '..');
const PREFIX = 'public/creative/labs/image-prompt-lab/';
const SCOPE = ['promptlab.js', 'sku-durable-receipt.js', 'promptlab.html'];
const PROTECTED = ['background.js', 'studio-runtime-20261010-credit-v3.js',
  'sku-region-ui.js', 'sku-region-ui.css', 'sku-delivery-store.js'];
const INVENTORY = ['promptlab.js', 'background.js', 'studio-runtime-20261010-credit-v3.js', 'promptlab.html',
  'sku-region-ui.js', 'sku-region-ui.css', 'sku-delivery-store.js', 'sku-durable-receipt.js'];
const V7_PINS = {
  'manifest.json': 'fb65d8f64c8dcc8631172db81a469e53b9023126a829d560c3ef6c04f0217255',
  'patch-spec.json': 'c10055038b7cd76b1d627367cadf2ebbcf17f6e79c50c0230b4f760128ae52c6',
  'scope-audit.json': 'c4840b277e6c42c5b03dfa79ceb5dc38fb8442d644712991cdbf7d8df6082756'
};
const SOURCE_PINS = {
  'promptlab.js': '28ab07fdc0e15377b815fd13e774e0a506bc5bc2c3e66d55206962861d187edf',
  'sku-durable-receipt.js': 'c6f88d41167f769c1e847a9fabbc7fc982d3ec9c5ebd33267e41aca9376464c8',
  'promptlab.html': 'cd07595146cd1e073eb44ce176ed80faa9782b44d614a4f006880516f0512ec8'
};
const SELECTED = ['setArchiveAccountKey', 'skuSaveReturnedDelivery', 'skuPrepareDurableRequest',
  'sendLegacyImage', 'acknowledgeSkuDelivery', 'renderSkuWorkspace', 'generateSkuOne', 'generateSkuBatch'];
const ADDED = [{ before: 'skuPrepareDurableRequest', names: ['skuResolvePaidWorkspaceRequest',
  'skuSendAuthorizedImage', 'skuPaidTaskDescriptor', 'skuPaidSemanticScope', 'skuCheckPaidTaskForGeneration', 'authorizeNewPaidSkuBatch',
  'renderSkuPaidWorkspaceControls', 'restoreSkuPaidWorkspaceProducts', 'exportSkuPaidWorkspaceMetadata'] }];
const HTML_INSERTIONS = [
  { anchor: '                <button id="skuRetryFailedBtn" class="btn ghost" type="button" disabled hidden>重试失败项</button>\n',
    position: 'before', label: 'add explicit paid batch and receipt export controls',
    text: '                <button id="skuNewPaidBatchBtn" class="btn ghost" type="button">另建付费 SKU 批次</button>\n' +
      '                <button id="skuExportPaidReceiptBtn" class="btn ghost" type="button" disabled>查看并导出本批回执凭证</button>\n' },
  { anchor: '          <section class="sku-step sku-result-step">\n', position: 'before',
    label: 'add separate paid batch warning and receipt metadata preview',
    text: '          <p id="skuPaidBatchInfo" class="sku-preflight" role="status">旧请求未确认时，可明确另建付费批次；旧标记与原件保留，新批次可能另外扣费。</p>\n' +
      '          <pre id="skuPaidMetadataPreview" hidden style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto"></pre>\n\n' }
];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function insist(ok, message) { if (!ok) throw new Error(message); }
function readText(filename, expected) {
  const info = fs.lstatSync(filename);
  insist(info.isFile() && !info.isSymbolicLink(), 'Regular non-symlink source required: ' + filename);
  const bytes = fs.readFileSync(filename);
  insist(/^[a-f0-9]{64}$/.test(expected) && sha(bytes) === expected, 'Frozen source SHA mismatch: ' + filename);
  const text = bytes.toString('utf8');
  insist(Buffer.from(text).equals(bytes), 'Exact UTF-8 required: ' + filename);
  return text;
}
function context(filename, text) {
  const parsed = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  insist(parsed.parseDiagnostics.length === 0, 'JS parse failed: ' + filename);
  return { parsed, text };
}
function rootFunctions(value) {
  const functions = new Map();
  for (const node of value.parsed.statements.filter(ts.isFunctionDeclaration)) {
    insist(node.name && !functions.has(node.name.text), 'Ambiguous global function');
    const start = node.getStart(value.parsed), end = node.end;
    functions.set(node.name.text, { start, end, text: value.text.slice(start, end) });
  }
  return functions;
}
function selectivePromptlab(original, local, selected, additions) {
  const before = rootFunctions(context('promptlab.installed-v7', original));
  const current = rootFunctions(context('promptlab.local-frozen', local));
  insist(new Set(selected).size === selected.length, 'Duplicate selected global');
  const addedNames = additions.flatMap(group => group.names);
  insist(new Set(addedNames).size === addedNames.length && !addedNames.some(name => selected.includes(name)), 'Duplicate selected/added global');
  let ownerReadyHook = null;
  if (selected.includes('setArchiveAccountKey')) {
    const sourceOwner = current.get('setArchiveAccountKey'), oldOwner = before.get('setArchiveAccountKey');
    const counter = '  state.archiveIdentityVersion++;\n', assignment = '  state.archiveAccountKey = next;\n';
    const oldHook = 'try { Promise.resolve(restoreSkuDurableReceipts()).catch(function () {}); }';
    const newHook = 'try { renderSkuPaidWorkspaceControls();Promise.resolve(restoreSkuDurableReceipts()).catch(function () {}); }';
    insist(sourceOwner && oldOwner && sourceOwner.text.split(assignment).length === 2 &&
      !sourceOwner.text.includes(counter) && sourceOwner.text.split(newHook).length === 2 &&
      oldOwner.text.split(counter).length === 2 && oldOwner.text.split(oldHook).length === 2 &&
      sourceOwner.text.replace(newHook, oldHook) === oldOwner.text.replace(counter, ''),
    'Owner function differs beyond preserved checkout counter omission and paid-controls discovery hook');
    const text = sourceOwner.text.replace(assignment, assignment + counter);
    insist(text === oldOwner.text.replace(oldHook, newHook), 'Production owner counter must be retained');
    current.set('setArchiveAccountKey', { ...sourceOwner, text });
    ownerReadyHook = { baselineFunctionSha256: sha(oldOwner.text), sourceFunctionSha256: sha(sourceOwner.text),
      publishedCounterPreserved: true, checkoutCounterOmissionPreserved: true, paidControlsDiscoveryHookOnly: true };
  }
  if (selected.includes('generateSkuBatch')) {
    const earlyGuard = "  if (state._skuPaidAuthorizing) return Promise.resolve({ok:false,error:'请等待新付费批次授权保存完成。'});\n";
    const oldBatch = before.get('generateSkuBatch'), sourceBatch = current.get('generateSkuBatch');
    insist(oldBatch && sourceBatch && sourceBatch.text.split(earlyGuard).length === 2 &&
      sourceBatch.text.replace(earlyGuard, '') === oldBatch.text, 'Batch changed beyond paid-authorization early busy guard');
  }
  const edits = selected.map(name => {
    const old = before.get(name), next = current.get(name);
    insist(old && next && old.text !== next.text, 'Selected changed SKU global missing/unchanged: ' + name);
    return { start: old.start, end: old.end, text: next.text, label: 'replace SKU paid workspace global ' + name };
  });
  for (const group of additions) {
    const anchor = before.get(group.before);
    insist(anchor && group.names.length, 'Missing/empty added-global anchor');
    for (const name of group.names) insist(!before.has(name) && current.has(name), 'Added SKU global missing/already installed: ' + name);
    edits.push({ start: anchor.start, end: anchor.start,
      text: group.names.map(name => current.get(name).text).join('\n\n') + '\n\n', label: 'add SKU paid workspace helpers ' + group.names.join(',') });
  }
  const result = applyEdits(original, edits), after = rootFunctions(context('promptlab.v8b', result.text));
  const preserved = [];
  for (const [name, old] of before) {
    insist(after.get(name)?.text === (selected.includes(name) ? current.get(name).text : old.text), 'Nonselected promptlab function changed: ' + name);
    if (!selected.includes(name)) preserved.push({ name, sha256: sha(old.text) });
  }
  for (const name of after.keys()) insist(before.has(name) || addedNames.includes(name), 'Unexpected promptlab global');
  const excluded = [...before].filter(([name, old]) => !selected.includes(name) && current.has(name) && current.get(name).text !== old.text)
    .map(([name, old]) => ({ name, installedSha256: sha(old.text), excludedLocalSha256: sha(current.get(name).text) }));
  return { text: result.text, audit: { ...result.proof, selectedGlobals: selected, addedGlobals: addedNames,
    preservedGlobalFunctionCount: preserved.length, preservedGlobalFunctions: preserved,
    nonselectedGlobalFunctionsByteIdentical: true, excludedLocalFunctionChanges: excluded,
    ...(ownerReadyHook ? { ownerReadyHook, singleFlightEarlyGuardOnly: true } : {}) } };
}
function htmlOverlay(original, local, insertions, cachebuster) {
  insist(/^[A-Za-z0-9-]+$/.test(cachebuster), 'Invalid cachebuster');
  const edits = [];
  for (const insertion of insertions) {
    insist(insertion.anchor && insertion.text && original.split(insertion.anchor).length === 2 &&
      !original.includes(insertion.text) && local.split(insertion.text).length === 2, 'Missing/ambiguous exact HTML insertion: ' + insertion.label);
    const start = original.indexOf(insertion.anchor) + (insertion.position === 'before' ? 0 : insertion.anchor.length);
    insist(['before', 'after'].includes(insertion.position), 'Unsupported HTML insertion position');
    edits.push({ start, end: start, text: insertion.text, label: insertion.label });
  }
  for (const filename of ['promptlab.js', 'sku-durable-receipt.js']) {
    const expression = new RegExp('((?:src|href)="' + filename.replace(/[.]/g, '\\.') + '\\?v=)([^"\\s]+)', 'g');
    const matches = [...original.matchAll(expression)];
    insist(matches.length === (filename === 'promptlab.js' ? 2 : 1), 'Expected published cache references: ' + filename);
    for (const match of matches) edits.push({ start: match.index + match[1].length, end: match.index + match[0].length,
      text: cachebuster, label: 'refresh ' + filename + ' cache reference' });
  }
  return applyEdits(original, edits);
}
function build(options = {}) {
  insist(SOURCE_PINS && Object.keys(SOURCE_PINS).length === 3 && SELECTED.length && HTML_INSERTIONS.length,
    'V8B_SOURCE_FREEZE_REQUIRED');
  options = { baseline: path.join(ROOT, 'docs/uat-sku-workflow-20261012/production-overlay-v7'),
    local: path.join(ROOT, PREFIX), output: path.join(ROOT, 'docs/uat-sku-workflow-20261012/production-overlay-v8b'),
    cachebuster: '20261013-sku-paid-workspace-v8b', ...options };
  const outputRelative = path.relative(ROOT, options.output);
  insist(outputRelative && !outputRelative.startsWith('..') && !path.isAbsolute(outputRelative) &&
    !options.output.startsWith(options.baseline + path.sep) && !options.output.startsWith(options.local + path.sep), 'Output must be a new local review directory');
  insist(options.reviewOnly || !fs.existsSync(options.output), 'Output already exists; frozen candidate must not be overwritten');
  const documents = {};
  for (const [name, digest] of Object.entries(V7_PINS)) documents[name] = JSON.parse(readText(path.join(options.baseline, name), digest));
  const previous = documents['manifest.json'];
  insist(JSON.stringify(previous.inventory.map(file => file.file)) === JSON.stringify(INVENTORY), 'Installed-v7 inventory differs');
  const original = {}, local = {};
  for (const file of previous.inventory) {
    const text = readText(path.join(options.baseline, 'overlay', file.path), file.newSha256);
    insist(file.path === PREFIX + file.file && Buffer.byteLength(text) === file.bytes, 'Installed-v7 payload path/length differs');
    original[file.file] = text;
  }
  for (const [name, digest] of Object.entries(SOURCE_PINS)) local[name] = readText(path.join(options.local, name), digest);
  const promptlab = selectivePromptlab(original['promptlab.js'], local['promptlab.js'], SELECTED, ADDED);
  const html = htmlOverlay(original['promptlab.html'], local['promptlab.html'], HTML_INSERTIONS, options.cachebuster);
  const compiled = { ...original, 'promptlab.js': promptlab.text, 'promptlab.html': html.text,
    'sku-durable-receipt.js': local['sku-durable-receipt.js'] };
  for (const name of PROTECTED) insist(compiled[name] === original[name], 'Protected-v7 payload changed: ' + name);
  for (const [name, text] of Object.entries(compiled)) if (name.endsWith('.js')) {
    context(name + '.candidate', text);
    execFileSync(process.execPath, ['--check', '-'], { input: text, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  const inventory = INVENTORY.map(name => ({ file: name, path: PREFIX + name,
    baselineSha256: sha(original[name]), newSha256: sha(compiled[name]), bytes: Buffer.byteLength(compiled[name]),
    newFile: false, writeRequired: SCOPE.includes(name) }));
  for (const item of inventory) insist(item.writeRequired === (item.baselineSha256 !== item.newSha256), 'Three-write scope bytes differ: ' + item.file);
  const files = SCOPE.map(name => inventory.find(item => item.file === name));
  const protectedPayloads = PROTECTED.map(name => inventory.find(item => item.file === name));
  const manifest = { schema: 'SKU_STATIC_PRODUCTION_OVERLAY_V1', createdAt: new Date().toISOString(),
    deploymentPerformed: false, deploymentReady: true, baseline: { ...previous.baseline,
      installedOverlay: 'production-overlay-v7', installedManifestSha256: V7_PINS['manifest.json'],
      directory: options.baseline, freshRuntimeSourcePreflightRequired: true }, runtimeEvidence: previous.runtimeEvidence,
    files, inventory, protectedPayloads, requiredAdditionalBaselineFiles: [], untouchedStyles: previous.untouchedStyles,
    guard: 'Offline candidate only; installed-v7 CAS baselines. Fresh live fingerprint, trusted shared lock and rollback required. No provider or production action performed.' };
  const audit = { schema: 'SKU_PAID_WORKSPACE_OVERLAY_SCOPE_AUDIT_V1', installedV7DocumentPins: V7_PINS,
    frozenLocalSourcePins: SOURCE_PINS, promptlab: promptlab.audit, html: html.proof,
    moduleWholeCopySha256: sha(compiled['sku-durable-receipt.js']), protectedPayloads,
    protectedPayloadsByteIdentical: true, existingPackedStylesUnchanged: true, inventoryFiles: 8, writeFiles: 3,
    sourceConfigurationOrWalletChanges: false, productionRead: false, productionWrite: false, providerRequests: 0 };
  const spec = { schema: 'SKU_STATIC_COMPARE_AND_REPLACE_SPEC_V1', deploymentPerformed: false,
    manifestSha256: sha(JSON.stringify(manifest, null, 2) + '\n'), expectedRelease: manifest.baseline.release,
    expectedRuntime: { pm2Id: previous.runtimeEvidence.pm2Id, pid: previous.runtimeEvidence.pid, port: previous.runtimeEvidence.port },
    requiredPreflight: 'Fresh runtime/installed-v7 source SHA and trusted shared deployment lock. No reuse of old executed runner.',
    protectedPayloads, untouchedStyles: previous.untouchedStyles, files: files.map(file => ({ path: file.path,
      baselineSha256: file.baselineSha256, newSha256: file.newSha256, bytes: file.bytes,
      operation: 'replace_if_baseline_matches', existingDifferentBytes: 'reject', payload: 'overlay/' + file.path })) };
  for (const [name, digest] of Object.entries(SOURCE_PINS)) readText(path.join(options.local, name), digest);
  for (const [name, digest] of Object.entries(V7_PINS)) readText(path.join(options.baseline, name), digest);
  if (!options.reviewOnly) {
    for (const [name, text] of Object.entries(compiled)) {
      const target = path.join(options.output, 'overlay', PREFIX, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, { flag: 'wx', mode: 0o644 });
    }
    for (const [name, value] of [['manifest.json', manifest], ['patch-spec.json', spec], ['scope-audit.json', audit]])
      fs.writeFileSync(path.join(options.output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
  }
  return { compiled, manifest, spec, audit, output: options.output, reviewOnly: !!options.reviewOnly };
}
function main() {
  const options = {};
  for (let index = 2; index < process.argv.length; index++) {
    const name = process.argv[index].replace(/^--/, '');
    if (name === 'review-only') { options.reviewOnly = true; continue; }
    insist(['baseline', 'local', 'output', 'cachebuster'].includes(name) && process.argv[index + 1], 'Unsupported/incomplete option');
    options[name] = name === 'cachebuster' ? process.argv[++index] : path.resolve(process.argv[++index]);
  }
  const result = build(options);
  process.stdout.write(JSON.stringify({ output: result.output, mode: result.reviewOnly ? 'offline-review' : 'offline-build',
    inventoryFiles: result.manifest.inventory.length, writeFiles: result.manifest.files.length,
    protectedPayloadFiles: result.manifest.protectedPayloads.length, protectedStyleFiles: result.manifest.untouchedStyles.length,
    productionRead: false, productionWrite: false, providerRequests: 0 }, null, 2) + '\n');
}
module.exports = { build, applyEdits, selectivePromptlab, htmlOverlay, V7_PINS, SOURCE_PINS, SELECTED, ADDED,
  HTML_INSERTIONS, SCOPE, PROTECTED, INVENTORY };
if (require.main === module) main();
