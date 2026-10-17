#!/usr/bin/env node
// Build a private server configuration artifact. Never changes an environment,
// merchant account, database, running process, or payment channel.
import { constants } from 'node:fs';
import { open, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from './check-scan-payment-config.mjs';

const VALUES = new Set(['SCAN_PAYMENT_NOTIFY_BASE_URL', 'ALIPAY_APP_ID', 'ALIPAY_SELLER_ID', 'ALIPAY_PAYMENT_PRODUCT',
  'WECHAT_PAY_APP_ID', 'WECHAT_PAY_MCH_ID', 'WECHAT_PAY_SERIAL_NO', 'WECHAT_PAY_PUBLIC_KEY_ID']);
const FILES = new Set(['ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY', 'WECHAT_PAY_PRIVATE_KEY',
  'WECHAT_PAY_PUBLIC_KEY', 'WECHAT_PAY_API_V3_KEY']);
const PRIVATE = new Set(['ALIPAY_PRIVATE_KEY', 'WECHAT_PAY_PRIVATE_KEY', 'WECHAT_PAY_API_V3_KEY']);
const MAX_BYTES = 32 * 1024;

class MaterialError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function readRegularFile(filename, privateFile = false) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new MaterialError('ABSOLUTE_FILE_PATH_REQUIRED');
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new MaterialError('INVALID_MATERIAL_FILE');
    if (privateFile && (stat.mode & 0o077)) throw new MaterialError('PRIVATE_FILE_MUST_BE_0600');
    if (privateFile && typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new MaterialError('PRIVATE_FILE_OWNER_MISMATCH');
    const contents = await file.readFile('utf8');
    if (Buffer.byteLength(contents) > MAX_BYTES) throw new MaterialError('INVALID_MATERIAL_FILE');
    return contents;
  } catch (error) {
    if (error instanceof MaterialError) throw error;
    throw new MaterialError('MATERIAL_FILE_UNREADABLE');
  } finally { await file?.close(); }
}

/** Errors and result summaries contain no credentials or raw file contents. */
export async function buildPaymentConfig(materialsFile, outputFile) {
  let materials;
  try { materials = JSON.parse(await readRegularFile(materialsFile, true)); }
  catch (error) { if (error instanceof MaterialError) throw error; throw new MaterialError('INVALID_MATERIALS_JSON'); }
  if (!materials || typeof materials !== 'object' || Array.isArray(materials) ||
    !Array.isArray(materials.providers) || !materials.providers.length ||
    materials.providers.some(p => !['alipay', 'wechat'].includes(p)) ||
    new Set(materials.providers).size !== materials.providers.length) throw new MaterialError('INVALID_PROVIDERS');
  const values = materials.values ?? {}, files = materials.files ?? {};
  if (!values || typeof values !== 'object' || Array.isArray(values) ||
    !files || typeof files !== 'object' || Array.isArray(files)) throw new MaterialError('INVALID_MATERIALS');
  const selectedKey = key => key === 'SCAN_PAYMENT_NOTIFY_BASE_URL' ||
    materials.providers.some(provider => key.startsWith(provider === 'alipay' ? 'ALIPAY_' : 'WECHAT_PAY_'));
  const env = {};
  for (const [key, value] of Object.entries(values)) {
    if (!VALUES.has(key) || !selectedKey(key) || typeof value !== 'string') throw new MaterialError('UNEXPECTED_CONFIG_KEY');
    env[key] = value.trim();
  }
  for (const [key, filename] of Object.entries(files)) {
    if (!FILES.has(key) || !selectedKey(key) || typeof filename !== 'string') throw new MaterialError('UNEXPECTED_CONFIG_KEY');
    env[key] = filename ? (await readRegularFile(filename, PRIVATE.has(key))).trim() : '';
  }
  const report = validateConfig(env, { providers: materials.providers });
  if (!report.ok || !outputFile) return { written: false, report };
  if (!path.isAbsolute(outputFile)) throw new MaterialError('ABSOLUTE_OUTPUT_PATH_REQUIRED');
  const parent = await lstat(path.dirname(outputFile)).catch(() => null);
  if (!parent?.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) ||
    (typeof process.getuid === 'function' && parent.uid !== process.getuid())) throw new MaterialError('OUTPUT_DIRECTORY_MUST_BE_PRIVATE');
  let file;
  try {
    // Exclusive creation prevents replacing either a deployed configuration or a symlink.
    file = await open(outputFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(JSON.stringify(env, null, 2) + '\n', 'utf8');
    await file.sync();
  } catch {
    // Only clean up the file we exclusively created, never an existing target.
    if (file) { await file.close(); file = undefined; await unlink(outputFile).catch(() => undefined); }
    throw new MaterialError('OUTPUT_NOT_WRITTEN');
  }
  finally { await file?.close(); }
  return { written: true, report };
}

async function main() {
  try {
    const args = process.argv.slice(2);
    let materials, output;
    for (let i = 0; i < args.length; i += 2) {
      if (args[i] === '--materials' && !materials) materials = args[i + 1];
      else if (args[i] === '--output' && !output) output = args[i + 1];
      else throw new MaterialError('INVALID_ARGUMENTS');
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new MaterialError('INVALID_ARGUMENTS');
    }
    if (!materials) throw new MaterialError('MATERIALS_FILE_REQUIRED');
    const result = await buildPaymentConfig(materials, output);
    console.log(JSON.stringify(result, null, 2));
    if (!result.report.ok) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error instanceof MaterialError ? error.code : 'CONFIG_BUILD_FAILED' }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
