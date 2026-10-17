/* Offline region boundary regressions. This script never requests a provider. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..', 'public', 'creative', 'labs', 'image-prompt-lab');
const listener = { addListener() {} };
let providerCalls = 0;
const context = vm.createContext({
  console, URL, URLSearchParams, AbortController, TextEncoder, TextDecoder,
  setTimeout() {}, clearTimeout() {},
  fetch() { providerCalls++; throw new Error('No provider calls are permitted in region tests.'); },
  __SZ_PROMPTLAB_BACKGROUND_TEST_MODE__: true,
  chrome: { runtime: { onMessage: listener, onInstalled: listener, onStartup: listener, getManifest: () => ({}), getURL: value => 'chrome-extension://fixture/' + value },
    action: { onClicked: listener }, contextMenus: { onClicked: listener }, alarms: { onAlarm: listener }, storage: { local: {} } }
});
for (const name of ['viral-series-contract.js', 'style-refresh-contract.js', 'background.js', 'sku-region-ui.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context, { filename: name, timeout: 3000 });
}
function fingerprint(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return value.length + ':' + (hash >>> 0).toString(16);
}
function payload(region) {
  const base = 'data:image/jpeg;base64,YmFzZQ==', product = 'data:image/jpeg;base64,c3ViamVjdA==';
  return {
    promptSource: 'sku', labMode: 'sku', detailMode: 'sku', assetRightsConfirmed: true,
    editBaseImage: base, productImage: product, productImages: [product],
    inputRoleOrder: ['IMMUTABLE_SKU_BASE', 'REPLACEMENT_SUBJECT'],
    size: '1024*1024', ratio: '1:1', resolution: '1K', outputSize: '1024*1024', outputRatio: '1:1', outputResolution: '1K',
    skuVisualLockSignature: 'region-test',
    skuVisualLock: {
      version: 'SKU_SUBJECT_REPLACE_V2', contractFingerprint: 'region-test', coordinateSpace: 'source-image',
      baseImageFingerprint: fingerprint(base), replacementSubjectFingerprint: fingerprint(product), generatedSkuBadge: false,
      canvas: { width: 1024, height: 1024, ratio: '1:1' },
      typography: { renderMode: 'preserve-base', addText: false, alterText: false },
      subject: { renderMode: 'provider-localized-replacement', replacementOnly: true, preservePlacement: true, preserveScale: true,
        preservePerspective: true, preserveLightingAndShadow: true, authorizedRegion: region,
        identityVerification: { required: true, version: 'SKU_SUBJECT_IDENTITY_V2', foregroundExtraction: 'client-fail-closed-v1',
          colorHistogram: 'rgb-4x4x4', edgeHistogram: 'orientation-8', contourDescriptor: 'projection-16',
          microTextGuard: 'candidate-reference-microtext-v1', minColorSimilarity: .34, minEdgeSimilarity: .34, minContourSimilarity: .46 } },
      variableWhitelist: { subjectIdentity: true, backgroundChanges: false, textChanges: false, layoutChanges: false, newProps: false, generatedLabels: false }
    }
  };
}
const validate = context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.validateSkuVisualLockPayload;
const cases = [
  ['default central contract remains accepted', { x: .12, y: .18, w: .76, h: .72 }, true],
  ['user-confirmed real reference subject', { x: .032, y: .245, w: .627, h: .541, confirmed: true }, true],
  ['same offset region must be explicitly confirmed', { x: .032, y: .245, w: .627, h: .541 }, false],
  ['confirmation must be boolean true', { x: .032, y: .245, w: .627, h: .541, confirmed: 'true' }, false],
  ['1 percent margin boundary', { x: .01, y: .01, w: .98, h: .7, confirmed: true }, true],
  ['minimum 20 percent width and height', { x: .01, y: .01, w: .2, h: .2, confirmed: true }, true],
  ['left margin below 1 percent', { x: .009, y: .2, w: .4, h: .4, confirmed: true }, false],
  ['top margin below 1 percent', { x: .2, y: .009, w: .4, h: .4, confirmed: true }, false],
  ['right margin below 1 percent', { x: .6, y: .2, w: .4, h: .4, confirmed: true }, false],
  ['bottom margin below 1 percent', { x: .2, y: .6, w: .4, h: .4, confirmed: true }, false],
  ['region below minimum width', { x: .2, y: .2, w: .199, h: .4, confirmed: true }, false],
  ['region below minimum height', { x: .2, y: .2, w: .4, h: .199, confirmed: true }, false],
  ['region exceeding 70 percent area', { x: .01, y: .01, w: .98, h: .8, confirmed: true }, false],
  ['nonfinite coordinate', { x: NaN, y: .2, w: .4, h: .4, confirmed: true }, false],
  ['numeric strings rejected', { x: '.2', y: .2, w: .4, h: .4, confirmed: true }, false]
];
for (const [name, region, expected] of cases) {
  assert.equal(validate(payload(region)).ok, expected, name);
  if (region.confirmed === true) assert.equal(context.SZ_SKU_REGION.valid(region), expected, name + ' UI boundary');
}
assert.equal(providerCalls, 0);
console.log(JSON.stringify({ passed: cases.length, providerCalls }));
