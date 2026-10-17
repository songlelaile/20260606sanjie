'use strict';

// Build a reviewable static overlay from the independently downloaded live bytes.
// Never copy the local dirty-tree HTML, runtime bundles, or complete release.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const options = {
  baseline: path.join(root, 'docs/uat-sku-workflow-20261012/production-baseline'),
  local: path.join(root, 'public/creative/labs/image-prompt-lab'),
  output: path.join(root, 'docs/uat-sku-workflow-20261012/production-overlay-v3'),
  cachebuster: '20261013-sku-workflow-v3'
};
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index].replace(/^--/, '');
  if (!Object.prototype.hasOwnProperty.call(options, name) || !process.argv[index + 1]) throw new Error('Unsupported or incomplete option');
  options[name] = name === 'cachebuster' ? process.argv[index + 1] : path.resolve(process.argv[index + 1]);
}
if (!/^[a-zA-Z0-9-]+$/.test(options.cachebuster)) throw new Error('Invalid cachebuster');
if (fs.existsSync(options.output)) throw new Error('Output already exists; use a new --output directory to preserve the previous candidate');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const insist = (condition, message) => { if (!condition) throw new Error(message); };
const originals = {}, current = {}, compiled = {}, changes = [];
const baselineManifest = JSON.parse(fs.readFileSync(path.join(options.baseline, 'download-manifest.json'), 'utf8'));
for (const filename of ['promptlab.js', 'background.js', 'promptlab.html', 'promptlab.css']) {
  const bytes = fs.readFileSync(path.join(options.baseline, filename));
  const pin = baselineManifest.files.find(file => file.file === filename);
  insist(pin && pin.sha256 === sha(bytes) && pin.bytes === bytes.length, 'Downloaded baseline pin mismatch: ' + filename);
  originals[filename] = bytes.toString('utf8');
  insist(Buffer.from(originals[filename]).equals(bytes), 'Baseline is not exact UTF-8: ' + filename);
  current[filename] = fs.readFileSync(path.join(options.local, filename), 'utf8');
}
const packedPins = [
  { file: 'studio-runtime-20261010-credit-v3.js', bytes: 1192851, sha256: '89d38e3b6ac569619995099a7703d412c38606af57ce7f32f8a24f767bf48120' },
  { file: 'studio-workspace-20261009-v1.css', bytes: 216937, sha256: 'ebe9239385706ebe32afc3ccd440ab378070803f1f705cbbc7c5e95b4de0a777' }
];
for (const pin of packedPins) {
  const bytes = fs.readFileSync(path.join(options.baseline, pin.file));
  insist(bytes.length === pin.bytes && sha(bytes) === pin.sha256, 'Downloaded packed baseline pin mismatch: ' + pin.file);
  originals[pin.file] = bytes.toString('utf8');
  insist(Buffer.from(originals[pin.file]).equals(bytes), 'Packed baseline is not exact UTF-8: ' + pin.file);
}
function source(filename, text) {
  const parsed = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  insist(!parsed.parseDiagnostics.length, 'JavaScript parse failure: ' + filename);
  const functions = new Map();
  for (const node of parsed.statements.filter(ts.isFunctionDeclaration)) {
    insist(node.name && !functions.has(node.name.text), 'Ambiguous global function: ' + filename);
    functions.set(node.name.text, { node, start: node.getStart(parsed), end: node.end, text: text.slice(node.getStart(parsed), node.end) });
  }
  return { parsed, functions };
}
function apply(text, edits) {
  const sorted = edits.slice().sort((a, b) => b.start - a.start || b.end - a.end);
  for (let index = 0; index < sorted.length; index++) {
    const edit = sorted[index];
    insist(edit.start >= 0 && edit.end >= edit.start && edit.end <= text.length, 'Invalid edit span: ' + edit.label);
    if (index) insist(edit.end <= sorted[index - 1].start, 'Overlapping edits: ' + edit.label);
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return text;
}
function oneMatch(text, expression, label) {
  const matches = [...text.matchAll(expression)];
  insist(matches.length === 1, 'Expected exactly one anchor: ' + label);
  return matches[0];
}
const selected = ['sendLegacyImage', 'skuTaskBlueprints', 'skuStatusLabel', 'selectedSkuTasks', 'updateSkuCounts',
  'renderSkuTasks', 'skuValidateLocalizedInputGeometry', 'skuSubjectVerificationContractValid', 'skuNormalizedAuthorizedRegion',
  'skuGenerationSettings', 'generateSkuOne', 'generateSkuBatch', 'dispatchSkuJpegDownloads'];
const additions = ['acknowledgeSkuDelivery', 'skuRestoreDeliveredSettings', 'retrySkuReturnedImages'];
const baselineJs = source('promptlab.baseline.js', originals['promptlab.js']);
const localJs = source('promptlab.local.js', current['promptlab.js']);
const functionReview = [];
const jsEdits = selected.map(name => {
  const before = baselineJs.functions.get(name), after = localJs.functions.get(name);
  insist(before && after, 'Missing selected global function: ' + name);
  functionReview.push({ name, baselineSha256: sha(before.text), localSha256: sha(after.text),
    baselineLines: before.text.split('\n').length, localLines: after.text.split('\n').length,
    changed: before.text !== after.text, route: name === 'sendLegacyImage' ? 'shared_entry_with_SKU_branches' : 'sku' });
  return { start: before.start, end: before.end, text: after.text, label: 'replace global function ' + name };
});
for (const [name, anchor, after] of [['acknowledgeSkuDelivery', 'sendLegacyImage', true],
  ['skuRestoreDeliveredSettings', 'generateSkuOne', false], ['retrySkuReturnedImages', 'generateSkuBatch', false]]) {
  insist(!baselineJs.functions.has(name) && localJs.functions.has(name), 'New SKU helper is not new or missing: ' + name);
  const target = baselineJs.functions.get(anchor), point = after ? target.end : target.start;
  const text = localJs.functions.get(name).text;
  jsEdits.push({ start: point, end: point, text: after ? '\n\n' + text : text + '\n\n', label: 'add SKU helper ' + name });
  functionReview.push({ name, baselineSha256: null, localSha256: sha(text), added: true, route: 'sku' });
}
const bindBefore = baselineJs.functions.get('bind'), bindAfter = localJs.functions.get('bind');
insist(bindBefore && bindAfter, 'Missing bind function');
const regionBinding = oneMatch(bindAfter.text,
  /  if \(window\.SZ_SKU_REGION && window\.SZ_SKU_REGION\.bind\) \{\n    window\.SZ_SKU_REGION\.bind\(\);\n    document\.addEventListener\('sku-region-change', function \(\) \{\n      if \(!state\.skuActive\) \{ resetSkuVisualLock\(\); updateSkuCounts\(\); \}\n    \}\);\n  \}\n/g,
  'SKU region binding')[0];
const bindAnchor = oneMatch(bindBefore.text, /  bindReferenceDetailBatch\(\);\n/g, 'baseline region binding insertion');
jsEdits.push({ start: bindBefore.start + bindAnchor.index + bindAnchor[0].length,
  end: bindBefore.start + bindAnchor.index + bindAnchor[0].length, text: regionBinding, label: 'bind SKU region only' });
compiled['promptlab.js'] = apply(originals['promptlab.js'], jsEdits);
const resultJs = source('promptlab.overlay.js', compiled['promptlab.js']);
const preservedFunctions = [];
for (const [name, before] of baselineJs.functions) {
  const after = resultJs.functions.get(name);
  insist(after, 'Lost global function: ' + name);
  if (selected.includes(name)) insist(after.text === localJs.functions.get(name).text, 'Selected function copy mismatch: ' + name);
  else if (name === 'bind') insist(after.text.replace(regionBinding, '') === before.text, 'Non-SKU bind logic changed');
  else { insist(after.text === before.text, 'Unexpected global function change: ' + name); preservedFunctions.push(name); }
}
for (const name of resultJs.functions.keys()) insist(baselineJs.functions.has(name) || additions.includes(name), 'Unexpected new function: ' + name);
changes.push({ file: 'promptlab.js', edits: jsEdits.map(({ label, start, end }) => ({ label, baselineStart: start, baselineEnd: end })),
  preservedGlobalFunctionCount: preservedFunctions.length, untouchedGlobalFunctionsMatchBaseline: true });

// Copy only the authorized-region declarations from the backend validator.
// Its surrounding provider, billing, durable receipt, and routing code stays live.
const baselineBackground = source('background.baseline.js', originals['background.js']);
const localBackground = source('background.local.js', current['background.js']);
function variableStatement(context, functionName, name) {
  const functions = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === functionName) functions.push(node);
    ts.forEachChild(node, visit);
  }
  visit(context.parsed);
  insist(functions.length === 1, 'Missing or ambiguous backend validator ' + functionName);
  const matches = functions[0].body.statements.filter(node => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name));
  insist(matches.length === 1, 'Ambiguous backend declaration ' + name);
  const node = matches[0];
  return { start: node.getStart(context.parsed), end: node.end,
    text: context.parsed.text.slice(node.getStart(context.parsed), node.end) };
}
const oldRegion = variableStatement(baselineBackground, 'validateSkuSubjectReplacePayload', 'authorizedRegionValid');
const finiteRegion = variableStatement(localBackground, 'validateSkuSubjectReplacePayload', 'authorizedRegionFinite');
const newRegion = variableStatement(localBackground, 'validateSkuSubjectReplacePayload', 'authorizedRegionValid');
const regionText = finiteRegion.text + '\n  ' + newRegion.text;
compiled['background.js'] = apply(originals['background.js'], [{ start: oldRegion.start, end: oldRegion.end, text: regionText,
  label: 'confirmed SKU region acceptance' }]);
source('background.overlay.js', compiled['background.js']);
changes.push({ file: 'background.js', edits: [{ label: 'confirmed SKU region acceptance', baselineStart: oldRegion.start, baselineEnd: oldRegion.end }],
  outsideRegionDeclarationUnchanged: true });
const runtimeName = 'studio-runtime-20261010-credit-v3.js';
const packedRuntime = source('runtime.baseline.js', originals[runtimeName]);
const packedRegion = variableStatement(packedRuntime, 'validateSkuSubjectReplacePayload', 'authorizedRegionValid');
insist(packedRegion.text === oldRegion.text, 'Packed and source SKU preflight baselines disagree');
compiled[runtimeName] = apply(originals[runtimeName], [{ start: packedRegion.start, end: packedRegion.end, text: regionText,
  label: 'confirmed SKU region acceptance in loaded packed runtime' }]);
source('runtime.overlay.js', compiled[runtimeName]);
changes.push({ file: runtimeName, edits: [{ label: 'confirmed SKU region acceptance in existing packed backend scope',
  baselineStart: packedRegion.start, baselineEnd: packedRegion.end }], outsideRegionDeclarationUnchanged: true,
  registeredListenersAdded: 0, packedComponentsRebuilt: false });

// Keep the published packed-resource HTML and its first-paint/auth/init contracts.
const panel = oneMatch(current['promptlab.html'], /^ {16}<div id="skuRegionPanel"[\s\S]*?(?=^ {16}<div class="sku-template-controls">)/gm, 'local SKU region panel')[0];
let html = originals['promptlab.html'];
const panelAnchor = oneMatch(html, /^ *<div id="skuTemplatePreview"[^\n]*\n/gm, 'live SKU template preview');
html = html.slice(0, panelAnchor.index + panelAnchor[0].length) + panel + html.slice(panelAnchor.index + panelAnchor[0].length);
const style = oneMatch(current['promptlab.html'], /^ *<link rel="stylesheet" href="sku-region-ui\.css[^\n]*\n/gm, 'SKU stylesheet')[0];
html = html.replace('</head>', style + '</head>');
const regionScript = oneMatch(current['promptlab.html'], /^ *<script src="sku-region-ui\.js[^\n]*\n/gm, 'SKU region script')[0];
const deliveryScript = oneMatch(current['promptlab.html'], /^ *<script src="sku-delivery-store\.js[^\n]*\n/gm, 'SKU delivery script')[0];
const scriptAnchor = oneMatch(html, /^ *<script src="promptlab\.js\?v=[^\n]*\n/gm, 'live promptlab script');
html = html.slice(0, scriptAnchor.index) + regionScript + deliveryScript + html.slice(scriptAnchor.index);
const oldPromptlabReferences = [...html.matchAll(/((?:src|href)="promptlab\.js)\?v=[^"\s]+/g)];
insist(oldPromptlabReferences.length === 2, 'Unexpected live promptlab cache references');
html = html.replace(/((?:src|href)="promptlab\.js)\?v=[^"\s]+/g, '$1?v=' + options.cachebuster);
const runtimeReferences = [...html.matchAll(/((?:src|href)="studio-runtime-20261010-credit-v3\.js)\?v=[^"\s]+/g)];
insist(runtimeReferences.length === 2, 'Unexpected packed runtime cache references');
html = html.replace(/((?:src|href)="studio-runtime-20261010-credit-v3\.js)\?v=[^"\s]+/g, '$1?v=' + options.cachebuster);
compiled['promptlab.html'] = html;
changes.push({ file: 'promptlab.html', edits: ['insert SKU region panel', 'insert SKU region stylesheet', 'insert SKU region and delivery scripts',
  'update two promptlab.js and two packed runtime cache references'], packedStylesReferencesPreserved: true,
  duplicateBackgroundRuntimeLoaded: false });
for (const filename of ['sku-region-ui.js', 'sku-region-ui.css', 'sku-delivery-store.js']) {
  compiled[filename] = fs.readFileSync(path.join(options.local, filename), 'utf8');
  if (filename.endsWith('.js')) source(filename, compiled[filename]);
  if (filename === 'sku-region-ui.css') insist(/\.sku-task-state\.processing_failed,\s*\.sku-task-state\.uncertain\s*\{/.test(compiled[filename]), 'New SKU stylesheet lacks receipt status rules');
  changes.push({ file: filename, newFile: true, copiedLocalSha256: sha(compiled[filename]) });
}

const excludedLocalFunctionChanges = [];
for (const [name, before] of baselineJs.functions) {
  const local = localJs.functions.get(name);
  if (!selected.includes(name) && name !== 'bind' && local && before.text !== local.text) {
    excludedLocalFunctionChanges.push({ name, baselineSha256: sha(before.text), localSha256: sha(local.text) });
  }
}
const pendingRuntimeFiles = [];
const prefix = 'public/creative/labs/image-prompt-lab/';
const manifest = {
  schema: 'SKU_STATIC_PRODUCTION_OVERLAY_V1', createdAt: new Date().toISOString(), deploymentPerformed: false,
  deploymentReady: pendingRuntimeFiles.length === 0, baseline: { release: baselineManifest.release, pm2Id: baselineManifest.pm2Id,
    pid: baselineManifest.pid, port: baselineManifest.port, directory: options.baseline,
    downloadManifestSha256: sha(fs.readFileSync(path.join(options.baseline, 'download-manifest.json'))), packedPins: packedPins },
  files: Object.entries(compiled).map(([name, text]) => ({ path: prefix + name, file: name,
    baselineSha256: originals[name] === undefined ? null : sha(originals[name]),
    newSha256: sha(text), bytes: Buffer.byteLength(text), newFile: originals[name] === undefined })),
  changes, requiredAdditionalBaselineFiles: pendingRuntimeFiles,
  untouchedStyles: [{ path: prefix + 'promptlab.css', sha256: sha(originals['promptlab.css']) },
    { path: prefix + 'studio-workspace-20261009-v1.css', sha256: sha(originals['studio-workspace-20261009-v1.css']) }],
  guard: 'Offline candidate only. Fresh live fingerprint, shared deployment lock, rollback and packed runtime coverage remain required before production application.'
};
const audit = { schema: 'SKU_OVERLAY_SCOPE_AUDIT_V1', functionSelection: functionReview,
  preservedGlobalFunctionCount: preservedFunctions.length, unchangedNonselectedGlobalFunctions: true,
  baselineGlobalsOutsideFunctionEditsPreserved: true, bindRegionOnly: true,
  packedRuntimeOutsideRegionDeclarationPreserved: true, existingPackedStylesUnchanged: true,
  excludedLocalFunctionChanges, requiredAdditionalBaselineFiles: pendingRuntimeFiles,
  sharedEntryReview: 'sendLegacyImage selects all new durable behavior only for labMode=sku/detailMode=sku. Its common receipt-read order and receipt metadata changed during this task; no unrelated pre-task feature is copied.' };
const overlay = path.join(options.output, 'overlay');
for (const [filename, text] of Object.entries(compiled)) {
  const destination = path.join(overlay, prefix, filename);
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, text);
}
const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
fs.writeFileSync(path.join(options.output, 'manifest.json'), manifestBytes);
fs.writeFileSync(path.join(options.output, 'scope-audit.json'), JSON.stringify(audit, null, 2) + '\n');
const patchSpec = { schema: 'SKU_STATIC_COMPARE_AND_REPLACE_SPEC_V1', deploymentPerformed: false,
  manifestSha256: sha(manifestBytes), expectedRelease: manifest.baseline.release,
  expectedRuntime: { pm2Id: manifest.baseline.pm2Id, pid: manifest.baseline.pid, port: manifest.baseline.port },
  requiredPreflight: 'Fresh current runtime/source fingerprint and shared deployment lock; preserve rollback bytes for every changed existing file.',
  files: manifest.files.map(file => ({ path: file.path, baselineSha256: file.baselineSha256, newSha256: file.newSha256,
    bytes: file.bytes, operation: file.newFile ? 'create_if_absent_or_identical' : 'replace_if_baseline_matches',
    existingDifferentBytes: 'reject', payload: 'overlay/' + file.path })) };
fs.writeFileSync(path.join(options.output, 'patch-spec.json'), JSON.stringify(patchSpec, null, 2) + '\n');
process.stdout.write(JSON.stringify({ output: options.output, overlay, files: manifest.files.length,
  manifest: path.join(options.output, 'manifest.json'), preservedGlobalFunctionCount: preservedFunctions.length,
  deploymentReady: manifest.deploymentReady, requiredAdditionalBaselineFiles: pendingRuntimeFiles.map(file => file.file) }, null, 2) + '\n');
