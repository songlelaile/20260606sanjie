'use strict';

// Offline-only selective overlay builder. Installed v4 bytes are immutable inputs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const ROOT = path.resolve(__dirname, '..');
const PREFIX = 'public/creative/labs/image-prompt-lab/';
const RUNTIME = 'studio-runtime-20261010-credit-v3.js';
const INSTALLED_NAMES = ['promptlab.js', 'background.js', RUNTIME, 'promptlab.html',
  'sku-region-ui.js', 'sku-region-ui.css', 'sku-delivery-store.js'];
const V4_PINS = {
  'manifest.json': 'accabb8d91219808f16017c1a9d7a54f331662043dd0cd3f0389f4b4b19cbe78',
  'patch-spec.json': '6ff04041dbc040222c3cd66a2a30d178c97d414c0ded27d643e946ff3d5a34da',
  'scope-audit.json': '242e607cb194386e4135733fa6fcd7dabe9dd83eec5841145db599cddaa96f72'
};
const V5_PINS = {
  'manifest.json': '2199a6a98848a848259d73b7c0440aee487b4f268dad939583ef79e1635aa05a',
  'patch-spec.json': '66794f00f236c3d8867982d2527825798b9cb2b3c41dda416278aa05ed8959d4',
  'scope-audit.json': '9318725cf7e8338847e4dcc1ae3dfcf79414ad0f9ff0ddf3058ffe0d213882a2'
};
const OWNER_HOOK_DEFINITION = "  var discoverSkuOwnerReceipts = function () {\n    if (next === 'local' || currentLabMode() !== 'sku' || !globalThis.chrome || !globalThis.chrome.runtime ||\n        globalThis.chrome.runtime.id !== 'shaozhuang-web-studio') return;\n    try { Promise.resolve(restoreSkuDurableReceipts()).catch(function () {}); } catch (_) {}\n  };\n";
function stripOwnerHook(text) {
  insist(text.split(OWNER_HOOK_DEFINITION).length === 2, 'Missing/ambiguous SKU owner-ready hook definition');
  let stripped = text.replace(OWNER_HOOK_DEFINITION, '');
  const equalHook = "    if (options.refresh) {\n      discoverSkuOwnerReceipts();\n      return refreshArchiveHistory({ silent: options.silent !== false });\n    }";
  insist(stripped.split(equalHook).length === 2, 'Missing/ambiguous same-owner refresh hook');
  stripped = stripped.replace(equalHook, "    if (options.refresh) return refreshArchiveHistory({ silent: options.silent !== false });");
  const changedHook = "  renderArchiveHistory();\n  discoverSkuOwnerReceipts();\n  if (options.deferArchive)";
  insist(stripped.split(changedHook).length === 2, 'Missing/ambiguous changed-owner hook');
  return stripped.replace(changedHook, "  renderArchiveHistory();\n  if (options.deferArchive)");
}
const V6_PINS = {
  'manifest.json': 'e657f505f107978e8194f31cfbf2a4111ceb44ca312d9cb44fd72b6cb3e0b20a',
  'patch-spec.json': '259b11aee0ac05a6497f9a75e0762747d95d66d2dd2cb1cd9519176d77ec131a',
  'scope-audit.json': 'f9a0fc32aabe6c162ce39f1b8eead60f01efeea2c93802033d9d7720c3337d68'
};
const SOURCE_PINS = {
  'promptlab.js': 'b22a85283b92a4ee1d76180e028ad4b0b04bbb696dc7080c42ebad0f2680f62a',
  'background.js': 'ac5fa71fb520830645955b3250fd51e84ef8cbb81ac7c509d3bc5d8e3ff04d3a',
  'promptlab.html': '41ff798ef35880eb683ee6da4af950eead0971aa44282ce923473e70f47b083a',
  'sku-durable-receipt.js': '0067f86d64a9218ffee0d01ef977826f9b50f9396287ad542d1c6fbe743e6eaf'
};
const SELECTED = ['setArchiveAccountKey', 'sendLegacyImage', 'acknowledgeSkuDelivery', 'skuTaskBlueprints', 'renderSkuTasks',
  'renderSkuWorkspace', 'skuReplicaBaseImage', 'generateSkuOne'];
const ADDED = ['skuWebsiteDurableRequest', 'skuDurableResponse', 'skuSaveReturnedDelivery',
  'skuGetOriginalReceipt', 'skuPrepareDurableRequest', 'skuSettingsFromDurableEntry',
  'restoreSkuDurableReceipts', 'recoverSkuDurableReceipt'];
const BACKGROUND_HELPERS = ['skuDurableRuntimeSupported', 'skuDurableRuntimeFailure', 'skuDurableRuntimeValidate'];
const RECEIPT_HELPERS = ['normalizeImageReceiptIdentity', 'imageReceiptIdentityForPayload',
  'imageReceiptRequestOptions', 'durableByokOpenAIConfig', 'imageReceiptDescriptor', 'openAIImageResponse',
  'readImageResponseBody', 'getDurableImageReceipt', 'imagePreSubmissionFailure'];
const RUNTIME_EVIDENCE = {
  pm2Id: 78, pid: 3612309, port: 53428, uptime: 1791824679509,
  name: 'sanjie-studio-native-reliability-20261012-v1',
  cwd: '/opt/sanjie-releases/studio-native-reliability-20261012-v1',
  exec: '/opt/sanjie-releases/studio-native-reliability-20261012-v1/node_modules/next/dist/bin/next',
  args: ['start', '--hostname', '127.0.0.1', '--port', '53428'],
  observationOnly: true, freshLivePreflightRequired: true
};
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
function insist(ok, message) { if (!ok) throw new Error(message); }
function readText(filename, expected) {
  const info = fs.lstatSync(filename);
  insist(info.isFile() && !info.isSymbolicLink(), 'Regular non-symlink source required: ' + filename);
  const bytes = fs.readFileSync(filename);
  insist(!expected || sha(bytes) === expected, 'Frozen source SHA mismatch: ' + filename);
  const text = bytes.toString('utf8');
  insist(Buffer.from(text).equals(bytes), 'Exact UTF-8 required: ' + filename);
  return text;
}
function context(filename, text) {
  const parsed = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  insist(parsed.parseDiagnostics.length === 0, 'JS parse failed: ' + filename);
  return { parsed, text };
}
function visitMatches(context, predicate, scope = context.parsed) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(scope);
  return found;
}
function span(context, node) {
  const start = node.getStart(context.parsed), end = node.end;
  return { start, end, text: context.text.slice(start, end) };
}
function namedFunction(context, name, scope = context.parsed) {
  const found = visitMatches(context, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name, scope);
  insist(found.length === 1, 'Missing/ambiguous function: ' + name);
  return span(context, found[0]);
}
function rootFunctions(context) {
  const functions = new Map();
  for (const node of context.parsed.statements.filter(ts.isFunctionDeclaration)) {
    insist(node.name && !functions.has(node.name.text), 'Ambiguous global function');
    functions.set(node.name.text, span(context, node));
  }
  return functions;
}
function ifCondition(context, predicate, scope = context.parsed) {
  const found = visitMatches(context, (node) => ts.isIfStatement(node) && predicate(node.expression.getText(context.parsed)), scope);
  insist(found.length === 1, 'Missing/ambiguous conditional anchor');
  return found[0];
}
function messageIf(context, name) {
  return ifCondition(context, (text) => text === "msg.type === '" + name + "'");
}
function namedVariableStatement(context, name, scope = context.parsed) {
  const found = visitMatches(context, (node) => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name), scope);
  insist(found.length === 1, 'Missing/ambiguous variable anchor: ' + name);
  return span(context, found[0]);
}
function applyEdits(original, edits) {
  const ascending = edits.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  let previousEnd = 0, output = '', cursor = 0;
  const chunks = [], audited = [];
  for (const edit of ascending) {
    insist(edit.start >= previousEnd && edit.end >= edit.start && edit.end <= original.length, 'Overlapping/invalid edit: ' + edit.label);
    const unchanged = original.slice(cursor, edit.start), outputStart = output.length;
    output += unchanged;
    chunks.push({ baselineStart: cursor, baselineEnd: edit.start, outputStart, outputEnd: output.length,
      bytes: Buffer.byteLength(unchanged), sha256: sha(unchanged) });
    const insertedStart = output.length;
    output += edit.text;
    audited.push({ label: edit.label, baselineStart: edit.start, baselineEnd: edit.end,
      outputStart: insertedStart, outputEnd: output.length, beforeSha256: sha(original.slice(edit.start, edit.end)),
      afterSha256: sha(edit.text) });
    cursor = previousEnd = edit.end;
  }
  const lastStart = output.length, last = original.slice(cursor);
  output += last;
  chunks.push({ baselineStart: cursor, baselineEnd: original.length, outputStart: lastStart,
    outputEnd: output.length, bytes: Buffer.byteLength(last), sha256: sha(last) });
  for (const chunk of chunks) insist(original.slice(chunk.baselineStart, chunk.baselineEnd) ===
    output.slice(chunk.outputStart, chunk.outputEnd), 'Nonselected byte chunk changed');
  const preserved = chunks.map((chunk) => original.slice(chunk.baselineStart, chunk.baselineEnd)).join('');
  return { text: output, proof: { offsetUnit: 'UTF16_code_units', outsideSelectedEditsByteIdentical: true,
    preservedBytes: Buffer.byteLength(preserved), preservedChunksSha256: sha(preserved), chunks, edits: audited } };
}
function functionDeclarations(context) {
  const groups = new Map();
  for (const node of visitMatches(context, ts.isFunctionDeclaration)) {
    if (!node.name) continue;
    const name = node.name.text;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(span(context, node).text);
  }
  return groups;
}
function runtimeOverlay(filename, original, local) {
  const before = context(filename + '.installed-v4', original), current = context('background.local-frozen', local);
  const additions = [namedVariableStatement(current, 'pendingSkuDurableReceipts').text,
    ...BACKGROUND_HELPERS.map((name) => namedFunction(current, name).text)].join('\n');
  for (const name of BACKGROUND_HELPERS) insist(visitMatches(before, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name).length === 0,
    'SKU runtime helper already exists');
  const loader = visitMatches(current, (node) => ts.isIfStatement(node) &&
    node.getText(current.parsed).includes("importScripts('sku-durable-receipt.js')"));
  insist(loader.length === 1, 'SKU import loader missing/ambiguous');
  const oldLoader = visitMatches(before, (node) => ts.isIfStatement(node) &&
    node.getText(before.parsed).includes("importScripts('image-archive-store.js')"));
  insist(oldLoader.length === 1, 'Installed archive loader missing/ambiguous');
  const generate = messageIf(before, 'GENERATE_IMAGE');
  const localGenerate = messageIf(current, 'GENERATE_IMAGE');
  const noBatch = ifCondition(before, (text) => text === '!imageHasBatch', generate);
  const localNoBatch = ifCondition(current, (text) => text === '!imageHasBatch', localGenerate);
  insist(ts.isBlock(noBatch.thenStatement), 'Unbatched route must be a block');
  const skuBranch = ifCondition(current, (text) => text.includes("imageTaskPayload.labMode === 'sku'") && text.includes('imageTaskPayload.skuDurablePlan'), localNoBatch);
  const cancel = messageIf(before, 'CANCEL_GENERATION');
  const localCancel = messageIf(current, 'CANCEL_GENERATION');
  const pendingCancel = ifCondition(current, (text) => text === 'pendingSkuDurableReceipts[cancelJobId]', localCancel);
  const cancelAnchor = namedVariableStatement(before, 'pendingFormalClaim', cancel);
  const normalize = namedFunction(before, 'normalizeCfg');
  const capability = span(current, messageIf(current, 'GET_SKU_RECEIPT_CAPABILITY')).text;
  const edits = [
    { start: span(before, oldLoader[0]).end, end: span(before, oldLoader[0]).end,
      text: '\n' + span(current, loader[0]).text, label: 'add SKU durable module worker loader' },
    { start: normalize.end, end: normalize.end, text: '\n\n' + additions,
      label: 'add pending SKU validation claims and three SKU-only runtime helpers' },
    { start: generate.getStart(before.parsed), end: generate.getStart(before.parsed),
      text: capability + '\n  ', label: 'add GET_SKU_RECEIPT_CAPABILITY handler' },
    { start: noBatch.thenStatement.statements[0].getStart(before.parsed), end: noBatch.thenStatement.statements[0].getStart(before.parsed),
      text: span(current, skuBranch).text + '\n      ', label: 'add SKU durable branch before untouched existing non-SKU receipt route' },
    { start: cancelAnchor.start, end: cancelAnchor.start, text: span(current, pendingCancel).text + '\n    ',
      label: 'add pending SKU cancellation before untouched formal/provider cancellation' }
  ];
  const result = applyEdits(original, edits), after = context(filename + '.v7', result.text);
  const oldFunctions = functionDeclarations(before), afterFunctions = functionDeclarations(after);
  for (const [name, texts] of oldFunctions) insist(JSON.stringify(texts) === JSON.stringify(afterFunctions.get(name)), 'Existing runtime function changed: ' + name);
  for (const name of afterFunctions.keys()) insist(oldFunctions.has(name) || BACKGROUND_HELPERS.includes(name), 'Unexpected runtime helper added: ' + name);
  insist((original.match(/chrome\.runtime\.onMessage\.addListener/g) || []).length ===
    (result.text.match(/chrome\.runtime\.onMessage\.addListener/g) || []).length, 'Runtime listeners changed');
  const beforeBackend = visitMatches(before, (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'normalizeCfg')[0].parent;
  const afterBackend = visitMatches(after, (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'normalizeCfg')[0].parent;
  const preservedReceipts = filename === RUNTIME ? RECEIPT_HELPERS.map((name) => {
    const text = namedFunction(before, name, beforeBackend).text;
    insist(namedFunction(after, name, afterBackend).text === text, 'Published receipt prerequisite changed: ' + name);
    return { name, sha256: sha(text) };
  }) : [];
  let formalRoute = null;
  if (filename === RUNTIME) {
    const formal = ifCondition(before, (text) => text === 'msg.receiptIdentity', noBatch);
    const preserved = span(before, formal).text;
    const nextFormal = ifCondition(after, (text) => text === 'msg.receiptIdentity', messageIf(after, 'GENERATE_IMAGE'));
    insist(span(after, nextFormal).text === preserved, 'Published formalGenesis receipt branch changed');
    formalRoute = { byteIdentical: true, sha256: sha(preserved), skuBranchBeforeExistingFormalGenesis: true };
  }
  return { text: result.text, audit: { ...result.proof, existingNamedFunctionCount: [...oldFunctions.values()].flat().length,
    existingNamedFunctionsByteIdentical: true, existingReceiptHelpers: preservedReceipts,
    formalGenesisReceiptRoute: formalRoute, listenersAdded: 0, packedComponentsRebuilt: false } };
}

function build(options = {}) {
  options = { baseline: path.join(ROOT, 'docs/uat-sku-workflow-20261012/production-overlay-v4'),
    local: path.join(ROOT, PREFIX), output: path.join(ROOT, 'docs/uat-sku-workflow-20261012/production-overlay-v7'),
    cachebuster: '20261013-sku-durable-v7', ...options };
  insist(/^[A-Za-z0-9-]+$/.test(options.cachebuster), 'Invalid cachebuster');
  const outputRelative = path.relative(ROOT, options.output);
  insist(outputRelative && !outputRelative.startsWith('..') && !path.isAbsolute(outputRelative) &&
    !options.output.startsWith(options.baseline + path.sep) && !options.output.startsWith(options.local + path.sep), 'Output must be a new local review directory');
  insist(options.reviewOnly || !fs.existsSync(options.output), 'Output already exists; frozen candidate must not be overwritten');
  const documents = {};
  for (const [name, digest] of Object.entries(V4_PINS)) documents[name] = JSON.parse(readText(path.join(options.baseline, name), digest));
  const previous = documents['manifest.json'];
  insist(JSON.stringify(previous.files.map((file) => file.file)) === JSON.stringify(INSTALLED_NAMES), 'Installed-v4 inventory differs');
  const original = {}, local = {};
  for (const file of previous.files) {
    const text = readText(path.join(options.baseline, 'overlay', file.path), file.newSha256);
    insist(Buffer.byteLength(text) === file.bytes, 'Installed-v4 payload length differs');
    original[file.file] = text;
  }
  for (const [name, digest] of Object.entries(SOURCE_PINS)) local[name] = readText(path.join(options.local, name), digest);
  const beforeJs = context('promptlab.installed-v4', original['promptlab.js']), currentJs = context('promptlab.local-frozen', local['promptlab.js']);
  const beforeFunctions = rootFunctions(beforeJs), currentFunctions = rootFunctions(currentJs);
  const ownerBefore = beforeFunctions.get('setArchiveAccountKey').text;
  const sourceOwnerAfter = currentFunctions.get('setArchiveAccountKey').text;
  const sourceOwnerWithoutHook = stripOwnerHook(sourceOwnerAfter);
  const sourceCounterOmission = '  state.archiveAccountKey = next;\n';
  insist(sourceOwnerWithoutHook.split(sourceCounterOmission).length === 2 &&
    !sourceOwnerWithoutHook.includes('state.archiveIdentityVersion++') &&
    sourceOwnerWithoutHook.replace(sourceCounterOmission, sourceCounterOmission + '  state.archiveIdentityVersion++;\n') === ownerBefore,
    'Checkout owner function differs beyond preserved counter omission and reviewed SKU-only discovery hook');
  // Keep the pre-existing checkout delta out of the production transplant.
  const ownerAfter = sourceOwnerAfter.replace(sourceCounterOmission, sourceCounterOmission + '  state.archiveIdentityVersion++;\n');
  currentFunctions.set('setArchiveAccountKey', {...currentFunctions.get('setArchiveAccountKey'), text: ownerAfter});
  insist(stripOwnerHook(ownerAfter) === ownerBefore, 'Production owner function differs beyond reviewed SKU-only discovery hook');
  const edits = SELECTED.map((name) => {
    const before = beforeFunctions.get(name), after = currentFunctions.get(name);
    insist(before && after, 'Selected SKU global missing: ' + name);
    return { start: before.start, end: before.end, text: after.text, label: 'replace SKU durable global ' + name };
  });
  for (const name of ADDED) insist(!beforeFunctions.has(name) && currentFunctions.has(name), 'New SKU global missing/already exists: ' + name);
  for (const [anchor, names] of [['sendLegacyImage', ADDED.slice(0, 5)], ['generateSkuBatch', ADDED.slice(5)]]) {
    const point = beforeFunctions.get(anchor).start;
    edits.push({ start: point, end: point, text: names.map((name) => currentFunctions.get(name).text).join('\n\n') + '\n\n',
      label: 'add SKU durable helpers ' + names.join(',') });
  }
  const promptlab = applyEdits(original['promptlab.js'], edits), resultFunctions = rootFunctions(context('promptlab.v7', promptlab.text));
  const preserved = [];
  for (const [name, before] of beforeFunctions) {
    const after = resultFunctions.get(name);
    insist(after && after.text === (SELECTED.includes(name) ? currentFunctions.get(name).text : before.text), 'Nonselected promptlab function changed: ' + name);
    if (!SELECTED.includes(name)) preserved.push({ name, sha256: sha(before.text) });
  }
  for (const name of resultFunctions.keys()) insist(beforeFunctions.has(name) || ADDED.includes(name), 'Unexpected promptlab global');
  const background = runtimeOverlay('background.js', original['background.js'], local['background.js']);
  const runtime = runtimeOverlay(RUNTIME, original[RUNTIME], local['background.js']);
  const htmlEdits = [];
  const delivery = [...original['promptlab.html'].matchAll(/^ *<script src="sku-delivery-store\.js[^\n]*\n/gm)];
  const durable = [...local['promptlab.html'].matchAll(/^ *<script src="sku-durable-receipt\.js[^\n]*\n/gm)];
  insist(delivery.length === 1 && durable.length === 1 && !original['promptlab.html'].includes('sku-durable-receipt.js'), 'Durable HTML script anchor differs');
  const insertion = delivery[0].index + delivery[0][0].length;
  htmlEdits.push({ start: insertion, end: insertion, text: durable[0][0], label: 'load SKU durable module immediately after delivery store' });
  for (const filename of ['promptlab.js', RUNTIME]) {
    const expression = new RegExp('((?:src|href)="' + filename.replace(/[.]/g, '\\.') + '\\?v=)([^"\\s]+)', 'g');
    const matches = [...original['promptlab.html'].matchAll(expression)];
    insist(matches.length === 2, 'Expected two published preload/script references: ' + filename);
    for (const match of matches) htmlEdits.push({ start: match.index + match[1].length, end: match.index + match[0].length,
      text: options.cachebuster, label: 'refresh ' + filename + ' cache reference' });
  }
  const html = applyEdits(original['promptlab.html'], htmlEdits);
  const compiled = { ...original, 'promptlab.js': promptlab.text, 'background.js': background.text,
    [RUNTIME]: runtime.text, 'promptlab.html': html.text, 'sku-durable-receipt.js': local['sku-durable-receipt.js'] };
  for (const [name, text] of Object.entries(compiled)) if (name.endsWith('.js')) {
    context(name + '.candidate', text);
    execFileSync(process.execPath, ['--check', '-'], { input: text, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  const frozenV5 = path.join(ROOT, 'docs/uat-sku-workflow-20261012/production-overlay-v5');
  const v5Documents = {};
  for (const [name, digest] of Object.entries(V5_PINS)) v5Documents[name] = JSON.parse(readText(path.join(frozenV5, name), digest));
  const v5Inventory = v5Documents['manifest.json'].inventory;
  insist(v5Inventory.length === 8, 'Frozen-v5 inventory differs');
  const v5Comparison = v5Inventory.map((file) => {
    const before = readText(path.join(frozenV5, 'overlay', file.path), file.newSha256);
    const after = compiled[file.file];
    insist(after !== undefined, 'Frozen-v5 payload absent from v6');
    if (!['promptlab.js', 'promptlab.html'].includes(file.file)) insist(after === before, 'Non-owner-ready payload differs from frozen-v5: ' + file.file);
    if (file.file === 'promptlab.js') {
      const ownerSpan = namedFunction(context('promptlab.frozen-v5', before), 'setArchiveAccountKey');
      const settingsSpan = namedFunction(context('promptlab.frozen-v5', before), 'skuSettingsFromDurableEntry');
      const replacement = applyEdits(before, [
        {start:ownerSpan.start,end:ownerSpan.end,text:ownerAfter,label:'SKU owner-ready discovery hook only'},
        {start:settingsSpan.start,end:settingsSpan.end,text:currentFunctions.get('skuSettingsFromDurableEntry').text,label:'canonical frozen model tuple recovery only'}
      ]);
      insist(replacement.text === after && ownerSpan.text === ownerBefore, 'V7 promptlab differs from v5 beyond owner-ready hook and canonical recovery settings');
    }
    if (file.file === 'promptlab.html') insist(before.replaceAll('20261013-sku-durable-v5', options.cachebuster) === after, 'V7 HTML differs beyond cache references');
    return {file:file.file,beforeSha256:sha(before),afterSha256:sha(after),byteIdentical:before === after};
  });
  const frozenV6 = path.join(ROOT, 'docs/uat-sku-workflow-20261012/production-overlay-v6');
  const v6Documents = {};
  for (const [name, digest] of Object.entries(V6_PINS)) v6Documents[name] = JSON.parse(readText(path.join(frozenV6, name), digest));
  insist(v6Documents['manifest.json'].inventory.length === 8, 'Frozen-v6 inventory differs');
  const v6Comparison = v6Documents['manifest.json'].inventory.map((file) => {
    const before = readText(path.join(frozenV6, 'overlay', file.path), file.newSha256), after = compiled[file.file];
    if (!['promptlab.js','promptlab.html'].includes(file.file)) insist(after === before, 'V7 non-recovery payload differs from frozen-v6: ' + file.file);
    if (file.file === 'promptlab.js') {
      const settingsSpan = namedFunction(context('promptlab.frozen-v6', before), 'skuSettingsFromDurableEntry');
      insist(applyEdits(before,[{start:settingsSpan.start,end:settingsSpan.end,text:currentFunctions.get('skuSettingsFromDurableEntry').text,label:'canonical frozen provider tuple recovery'}]).text === after,
        'V7 promptlab differs from v6 beyond canonical frozen provider tuple recovery');
    }
    if (file.file === 'promptlab.html') insist(before.replaceAll('20261013-sku-durable-v6',options.cachebuster) === after, 'V7 HTML differs from v6 beyond cache references');
    return {file:file.file,beforeSha256:sha(before),afterSha256:sha(after),byteIdentical:before === after};
  });
  const inventory = Object.entries(compiled).map(([name, text]) => ({ file: name, path: PREFIX + name,
    baselineSha256: original[name] === undefined ? null : sha(original[name]), newSha256: sha(text),
    bytes: Buffer.byteLength(text), newFile: original[name] === undefined, writeRequired: original[name] !== text }));
  const files = inventory.filter((file) => file.writeRequired);
  insist(files.length === 5 && inventory.length === 8, 'Durable overlay must have five write targets/eight inventory files');
  const protectedPayloads = inventory.filter((file) => !file.writeRequired);
  const manifest = { schema: 'SKU_STATIC_PRODUCTION_OVERLAY_V1', createdAt: new Date().toISOString(),
    deploymentPerformed: false, deploymentReady: true, baseline: {
      release: previous.baseline.release, pm2Id: RUNTIME_EVIDENCE.pm2Id, pid: RUNTIME_EVIDENCE.pid, port: RUNTIME_EVIDENCE.port,
      installedOverlay: 'production-overlay-v4', installedManifestSha256: V4_PINS['manifest.json'],
      directory: options.baseline, freshRuntimeSourcePreflightRequired: true },
    runtimeEvidence: RUNTIME_EVIDENCE, files, inventory, protectedPayloads,
    requiredAdditionalBaselineFiles: [], untouchedStyles: previous.untouchedStyles,
    guard: 'Offline candidate only; installed-v4 CAS baselines. Fresh live fingerprint, trusted shared lock and rollback required. No provider or production action performed.' };
  const excludedLocalFunctionChanges = [...beforeFunctions].filter(([name, item]) => !SELECTED.includes(name) &&
    currentFunctions.has(name) && currentFunctions.get(name).text !== item.text).map(([name, item]) => ({ name,
      installedSha256: sha(item.text), excludedLocalSha256: sha(currentFunctions.get(name).text) }));
  const audit = { schema: 'SKU_DURABLE_OVERLAY_SCOPE_AUDIT_V1', installedV4DocumentPins: V4_PINS, frozenLocalSourcePins: SOURCE_PINS,
    frozenV5DocumentPins: V5_PINS, frozenV5PayloadComparison: v5Comparison,
    frozenV6DocumentPins: V6_PINS, frozenV6PayloadComparison: v6Comparison,
    frozenProviderTupleRecoveryOnly: true, archiveValidationRelaxed: false,
    promptlab: { ...promptlab.proof, selectedGlobals: SELECTED, addedGlobals: ADDED,
      ownerReadyHook: { baselineFunctionSha256: sha(ownerBefore), hookStrippedFunctionSha256: sha(stripOwnerHook(ownerAfter)),
        publishedCounterPreserved: true, checkoutCounterOmissionPreserved: true, sourceWithoutHookSha256: sha(sourceOwnerWithoutHook), exactOnlySkuWebDiscoveryHook: true, automaticReceiptGet: false,
        sameOwnerRefresh: true, changedOwnerAfterAssignment: true },
      preservedGlobalFunctionCount: preserved.length, preservedGlobalFunctions: preserved,
      nonselectedGlobalFunctionsByteIdentical: true, excludedLocalFunctionChanges, noBindInitOrTestApiChanges: true },
    background: background.audit, packedRuntime: runtime.audit, html: html.proof,
    protectedPayloads, inventoryFiles: 8, writeFiles: 5, oldPendingReceiptsMigration: false,
    existingPackedStylesUnchanged: true, sourceConfigurationOrWalletChanges: false,
    productionRead: false, productionWrite: false, providerRequests: 0 };
  const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
  const spec = { schema: 'SKU_STATIC_COMPARE_AND_REPLACE_SPEC_V1', deploymentPerformed: false,
    manifestSha256: sha(manifestBytes), expectedRelease: manifest.baseline.release,
    expectedRuntime: { pm2Id: RUNTIME_EVIDENCE.pm2Id, pid: RUNTIME_EVIDENCE.pid, port: RUNTIME_EVIDENCE.port },
    requiredPreflight: 'Fresh runtime/installed-v4 source SHA and trusted shared deployment lock. No reuse of old executed runner.',
    protectedPayloads, untouchedStyles: previous.untouchedStyles,
    files: files.map((file) => ({ path: file.path, baselineSha256: file.baselineSha256, newSha256: file.newSha256,
      bytes: file.bytes, operation: file.newFile ? 'create_if_absent_or_identical' : 'replace_if_baseline_matches',
      existingDifferentBytes: 'reject', payload: 'overlay/' + file.path })) };
  // Check the frozen inputs again before any candidate directory is created.
  for (const [name, digest] of Object.entries(SOURCE_PINS)) readText(path.join(options.local, name), digest);
  for (const [name, digest] of Object.entries(V4_PINS)) readText(path.join(options.baseline, name), digest);
  if (!options.reviewOnly) {
    for (const [name, text] of Object.entries(compiled)) {
      const target = path.join(options.output, 'overlay', PREFIX, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, { flag: 'wx', mode: 0o644 });
    }
    for (const [name, value] of [['manifest.json', manifest], ['patch-spec.json', spec], ['scope-audit.json', audit]]) {
      fs.writeFileSync(path.join(options.output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    }
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
    preservedPromptlabGlobals: result.audit.promptlab.preservedGlobalFunctionCount,
    existingReceiptHelpersByteIdentical: result.audit.packedRuntime.existingReceiptHelpers.length,
    formalGenesisReceiptRouteByteIdentical: result.audit.packedRuntime.formalGenesisReceiptRoute.byteIdentical,
    productionRead: false, productionWrite: false, providerRequests: 0 }, null, 2) + '\n');
}
module.exports = { build, applyEdits, V4_PINS, V5_PINS, V6_PINS, SOURCE_PINS, SELECTED, ADDED, RECEIPT_HELPERS, stripOwnerHook };
if (require.main === module) main();
