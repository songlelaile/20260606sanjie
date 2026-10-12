#!/usr/bin/env node
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const releaseRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(releaseRoot, '../..');
const args = process.argv.slice(2);
let dependencyRoot = repoRoot;
if (args[0] === '--node-modules') {
  if (!args[1]) throw new Error('Provide the node_modules directory after --node-modules.');
  dependencyRoot = resolve(args[1], '..');
  args.splice(0, 2);
}
if (args.length) throw new Error('Usage: node run-tests.mjs [--node-modules PATH]');
const requireDependency = createRequire(resolve(dependencyRoot, 'package.json'));
let vitestRoot;
try {
  vitestRoot = dirname(requireDependency.resolve('vitest/package.json'));
} catch {
  throw new Error('Vitest is unavailable. Install the repository dependencies, or pass --node-modules PATH to an existing installation.');
}
const env = {
  ...process.env,
  CREATIVE_ASSET_TEST_ROOT: resolve(releaseRoot, 'assets/public/creative'),
  STUDIO_REQUIRE_NATIVE_RECOVERY: '1',
  STUDIO_STORAGE_TEST_BUNDLE: '1',
  STUDIO_RELEASE_VITEST_ROOT: vitestRoot
};
delete env.STUDIO_CONTRACT_TEST_FILE;
delete env.STUDIO_USE_RECOVERY_FIXTURE;
const result = spawnSync(process.execPath, [resolve(vitestRoot, 'vitest.mjs'), 'run', '--config', resolve(releaseRoot, 'vitest.config.mjs')], {
  cwd: releaseRoot,
  env,
  stdio: 'inherit'
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
