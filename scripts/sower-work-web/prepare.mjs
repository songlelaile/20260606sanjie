import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const source = args.get('--source'), renderer = args.get('--renderer'), output = args.get('--output');
if (![source, renderer, output].every((value) => value && path.isAbsolute(value))) throw new Error('Use absolute --source, --renderer and new --output paths');
if (fs.existsSync(output)) throw new Error('Output already exists; use a new release directory');
if (!fs.existsSync(path.join(renderer, 'index.html'))) throw new Error('Verified renderer index.html is required');
const here = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(output, { recursive: true });
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true }); };
for (const name of ['src', 'migrations']) copy(path.join(source, 'packages/sower-control', name), path.join(output, 'vendor/packages/sower-control', name));
fs.writeFileSync(path.join(output, 'vendor/packages/sower-control/package.json'), JSON.stringify({ name: '@sower-work/control', type: 'module', private: true }));
copy(path.join(source, 'packages/desktop/src/common/types/office/preview.ts'), path.join(output, 'vendor/packages/desktop/src/common/types/office/preview.ts'));
fs.writeFileSync(path.join(output, 'vendor/packages/desktop/package.json'), JSON.stringify({ type: 'module' }));
copy(renderer, path.join(output, 'renderer'));
copy(path.join(source, 'resources/builtin-assistants'), path.join(output, 'resources/builtin-assistants'));
for (const name of ['runtime.mjs', 'bridge.mjs', 'identity.mjs', 'filesystem.mjs', 'browser-prefix.js']) copy(path.join(here, name), path.join(output, 'runtime', name));
for (const name of ['cloud-detail', 'cloud-workbench']) copy(path.join(here, name), path.join(output, 'runtime', name));
if (args.get('--bundle')) copy(args.get('--bundle'), path.join(output, 'resources/bundled-aioncore/linux-x64'));
const dependencies = { tsx: '4.21.0', sharp: '0.34.5', zod: '3.25.76' };
fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify({ name: 'sower-work-web-runtime', version: '0.2.0', private: true, type: 'module', engines: { node: '>=24 <25' }, scripts: { start: 'node --import tsx runtime/runtime.mjs' }, dependencies }, null, 2));
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const evidence = { createdAt: new Date().toISOString(), source, renderer, desktopStateImported: false, rendererIndexSha256: digest(path.join(renderer, 'index.html')), controlIndexSha256: digest(path.join(source, 'packages/sower-control/src/index.ts')), cloudDetailVersion: 'SW_CLOUD_DETAIL_EDITOR_V1', cloudDetailSourceSha256: digest(path.join(here, 'cloud-detail/index.mjs')), engineVersionRequired: 'v0.2.2', nodeMajorRequired: 24 };
evidence.cloudWorkbenchSourceSha256 = digest(path.join(here, 'cloud-workbench/index.mjs'));
evidence.cloudRuntimeVersion = '0.2.0';
evidence.testedDirectDependencies = dependencies;
const files = {};
function inventory(directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('Release must not contain symlinks');
    if (stat.isDirectory()) inventory(file);
    else if (stat.isFile()) files[path.relative(output, file)] = { size: stat.size, sha256: digest(file) };
    else throw new Error('Release contains a non-ordinary file');
  }
}
inventory(output);
fs.writeFileSync(path.join(output, 'integrity-manifest.json'), JSON.stringify({ schema: 'SOWER_CLOUD_RELEASE_INTEGRITY_V1', files }, null, 2));
evidence.integrityManifestSha256 = digest(path.join(output, 'integrity-manifest.json'));
fs.writeFileSync(path.join(output, 'package-evidence.json'), JSON.stringify(evidence, null, 2));
console.info(JSON.stringify({ output, ...evidence }, null, 2));
