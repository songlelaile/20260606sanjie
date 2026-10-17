'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('/Users/shaozhuang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root = path.resolve(__dirname, '..');
const candidate = path.join(root, '.codex-deploy/reference-detail-screenshot-20261012/rerun/live195/generation/candidate');
const output = path.join(root, '.codex-deploy/reference-detail-screenshot-20261012/rerun/live195/authenticated-browser-ready');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function main() {
  const rawManifest = fs.readFileSync(path.join(candidate, 'manifest.json')), manifest = JSON.parse(rawManifest);
  const previous = JSON.parse(fs.readFileSync(path.join(candidate, 'browser-acceptance/report.json')));
  const runSuffix = 'SZ-REF-AUTH-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8);
  fs.mkdirSync(path.join(output, 'fixtures'), { recursive: true });
  const fixtures = [];
  for (const [index, label, color, width, height] of [[1, 'A', '#f59e0b', 600, 900], [2, 'B', '#0ea5e9', 600, 900], [3, 'C', '#22c55e', 1200, 3200]]) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/><rect width="100%" height="${height * .3}" fill="${color}"/><text x="24" y="70" font-family="sans-serif" font-size="40" font-weight="bold" fill="#111827">Reference ${label}</text><text x="24" y="${height * .43}" font-family="sans-serif" font-size="26" fill="#111827">Authenticated intake acceptance</text><text x="24" y="${height * .48}" font-family="sans-serif" font-size="16" fill="#111827">${runSuffix}</text><rect x="30" y="${height * .56}" width="${width - 60}" height="${height * .34}" fill="none" stroke="${color}" stroke-width="4"/></svg>`;
    const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
    const filename = `${index}-${runSuffix}-${label}.png`, destination = path.join(output, 'fixtures', filename); fs.writeFileSync(destination, bytes);
    fixtures.push({ label, filename, path: destination, width, height, bytes: bytes.length, sha256: sha(bytes) });
  }
  const assets = Object.entries(manifest.files).map(([file, entry]) => ({ path: file.replace(/^public/, ''), sha256: entry.afterSha256, role: 'six_file_overlay' }));
  for (const dependency of previous.loadedScripts.filter(file => !assets.some(asset => asset.path === file))) assets.push({ path: dependency, sha256: previous.assetFingerprints[dependency].sha256, role: 'preserved_dependency' });
  const config = { runSuffix, origin: 'https://shaozhuangai.com', pathname: '/creative/labs/image-prompt-lab/promptlab.html',
    targetUrl: `https://shaozhuangai.com/creative/labs/image-prompt-lab/promptlab.html?mode=detail&detailMode=reference&source=detail-reference&layout=1&auto=0&sz_ref_acceptance=${encodeURIComponent(runSuffix)}`,
    manifestSha256: sha(rawManifest), assets, fixtures };
  fs.writeFileSync(path.join(output, 'fixture-manifest.json'), JSON.stringify(config, null, 2) + '\n');
  const template = fs.readFileSync(path.join(__dirname, 'reference-detail-authenticated-console.template.js'), 'utf8');
  fs.writeFileSync(path.join(output, '01-console-install-and-before.js'), template.replace('__REFERENCE_AUTH_CONFIG_JSON__', JSON.stringify(config)));
  fs.writeFileSync(path.join(output, '02-console-after-upload.js'), "await __szRefAuthUat.capture('upload3');\n");
  fs.writeFileSync(path.join(output, '03-console-export.js'), 'await __szRefAuthUat.export();\n');
  fs.writeFileSync(path.join(output, 'target-url.txt'), config.targetUrl + '\n');
  process.stdout.write(JSON.stringify({ output, runSuffix, targetUrl: config.targetUrl, fixtures: fixtures.map(({ path, sha256 }) => ({ path, sha256 })), assetCount: assets.length }, null, 2) + '\n');
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
