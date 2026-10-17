import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, readFile, stat, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPaymentConfig } from './build-scan-payment-config.mjs';

const application = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const provider = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sanjie-material-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await chmod(dir, 0o700);
  const privateFile = path.join(dir, 'private.pem'), publicFile = path.join(dir, 'public.pem');
  await writeFile(privateFile, application.privateKey, { mode: 0o600 });
  await writeFile(publicFile, provider.publicKey, { mode: 0o600 });
  const materials = { providers: ['alipay'],
    values: { ALIPAY_APP_ID: '2026000000000000', ALIPAY_SELLER_ID: '2088000000000000', SCAN_PAYMENT_NOTIFY_BASE_URL: 'https://shaozhuangai.com' },
    files: { ALIPAY_PRIVATE_KEY: privateFile, ALIPAY_PUBLIC_KEY: publicFile } };
  const filename = path.join(dir, 'materials.json'), output = path.join(dir, 'runtime.json');
  const save = () => writeFile(filename, JSON.stringify(materials), { mode: 0o600 });
  await save(); return { dir, materials, filename, output, privateFile, save };
}

test('builds only selected provider config into a new private file without leaking values', async t => {
  const f = await fixture(t);
  const result = await buildPaymentConfig(f.filename, f.output);
  assert.equal(result.written, true); assert.equal(result.report.ok, true);
  const text = JSON.stringify(result);
  for (const secret of [application.privateKey, f.materials.values.ALIPAY_APP_ID, f.materials.values.ALIPAY_SELLER_ID]) assert.equal(text.includes(secret), false);
  const config = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(config.ALIPAY_PRIVATE_KEY, application.privateKey.trim());
  assert.equal(config.ALIPAY_PUBLIC_KEY, provider.publicKey.trim());
  assert.equal(Object.keys(config).length, 5);
  assert.equal((await stat(f.output)).mode & 0o777, 0o600);
});

test('dry run and missing merchant details never write any output', async t => {
  const f = await fixture(t);
  assert.equal((await buildPaymentConfig(f.filename)).written, false);
  f.materials.values.ALIPAY_APP_ID = ''; await f.save();
  const result = await buildPaymentConfig(f.filename, f.output);
  assert.equal(result.report.ok, false); assert.equal(result.written, false);
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('persists the website payment product and rejects unsupported products', async t => {
  const f = await fixture(t);
  f.materials.values.ALIPAY_PAYMENT_PRODUCT = 'page_pay'; await f.save();
  assert.equal((await buildPaymentConfig(f.filename, f.output)).written, true);
  assert.equal(JSON.parse(await readFile(f.output, 'utf8')).ALIPAY_PAYMENT_PRODUCT, 'page_pay');
  f.materials.values.ALIPAY_PAYMENT_PRODUCT = 'arbitrary'; await f.save();
  const result = await buildPaymentConfig(f.filename, path.join(f.dir, 'invalid.json'));
  assert.equal(result.report.ok, false); assert.equal(result.written, false);
});

test('cannot overwrite an existing deployment artifact', async t => {
  const f = await fixture(t);
  await writeFile(f.output, 'existing environment', { mode: 0o600 });
  await assert.rejects(buildPaymentConfig(f.filename, f.output), { code: 'OUTPUT_NOT_WRITTEN' });
  assert.equal(await readFile(f.output, 'utf8'), 'existing environment');
});

test('refuses exposed private keys and symlinked material files', async t => {
  const f = await fixture(t);
  await chmod(f.privateFile, 0o644);
  await assert.rejects(buildPaymentConfig(f.filename, f.output), { code: 'PRIVATE_FILE_MUST_BE_0600' });
  await chmod(f.privateFile, 0o600);
  const link = path.join(f.dir, 'link.pem'); await symlink(f.privateFile, link);
  f.materials.files.ALIPAY_PRIVATE_KEY = link; await f.save();
  await assert.rejects(buildPaymentConfig(f.filename, f.output), { code: 'MATERIAL_FILE_UNREADABLE' });
});

test('rejects unselected providers, unexpected settings, secret values and insecure output directories', async t => {
  const f = await fixture(t);
  for (const key of ['DATABASE_URL', 'ALIPAY_PRIVATE_KEY', 'WECHAT_PAY_APP_ID']) {
    f.materials.values[key] = 'do-not-print'; await f.save();
    await assert.rejects(buildPaymentConfig(f.filename, f.output), { code: 'UNEXPECTED_CONFIG_KEY' });
    delete f.materials.values[key];
  }
  await f.save(); await chmod(f.dir, 0o755);
  await assert.rejects(buildPaymentConfig(f.filename, f.output), { code: 'OUTPUT_DIRECTORY_MUST_BE_PRIVATE' });
});
