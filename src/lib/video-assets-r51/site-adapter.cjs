/* eslint-disable @typescript-eslint/no-require-imports -- Server-only CommonJS modules loaded by the Node runtime. */
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const { createRuntime } = require('./runtime.cjs');
const { createHttpHandler } = require('./http-handler.cjs');
const { createSessionAuthenticator, createRequestProviderResolver } = require('./provider-resolver.cjs');

const CONFIG_LIMIT = 1024 * 1024;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{2,119}$/;

/** The path and environment names are selected by the deployment, never a request. */
async function readConfiguration(env = process.env) {
  const filename = env.VIDEO_ASSET_CONFIG_FILE;
  if (!filename) return null;
  if (!path.isAbsolute(filename) || path.normalize(filename) !== filename) throw new Error('Invalid server configuration path.');
  // A writable ancestor could replace the file after an otherwise valid 0600
  // check. Deployment configuration must remain in a root-controlled directory.
  let ancestor = path.dirname(filename);
  for (;;) {
    const info = await fs.lstat(ancestor);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error('Unsafe server configuration directory.');
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size > CONFIG_LIMIT) throw new Error('Invalid server configuration file.');
    const configuration = JSON.parse(await handle.readFile('utf8'));
    if (!configuration || !Array.isArray(configuration.accounts) || !Array.isArray(configuration.grants)) throw new Error('Invalid server configuration shape.');
    return configuration;
  } finally { await handle.close(); }
}

function readSecret(name, env = process.env) {
  if (!SECRET_NAME.test(name || '') || name.startsWith('NEXT_PUBLIC_')) throw new Error('Invalid server secret reference.');
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing server secret.');
  return value;
}

/**
 * Keep all authorization in the existing site session verifier and current User
 * table. An absent/bad deployment configuration has no implicit platform grant.
 * Load configuration each request so revocation is not delayed by Next workers.
 */
function createWebsiteHandler(options) {
  const { prisma, verifySessionToken, lookupUser } = options;
  const authenticate = createSessionAuthenticator({ verifySessionToken, lookupUser });
  const unavailable = createHttpHandler({
    assetService: {}, authenticate,
    providerResolver: createRequestProviderResolver({ findBinding: async () => null })
  });
  const brokenConfiguration = createHttpHandler({
    assetService: {}, authenticate,
    providerResolver: { async resolve() { throw new Error('Server configuration unavailable.'); } }
  });
  const load = options.readConfiguration || readConfiguration;
  const secretValue = options.secretValue || readSecret;
  const makeRuntime = options.createRuntime || createRuntime;
  const directory = options.sourceDirectory || (() => process.env.VIDEO_ASSET_SOURCE_DIRECTORY);
  let cachedRevision = '', cachedRuntime = null;
  async function runtime() {
    const configuration = await load();
    if (!configuration || Array.isArray(configuration.accounts) && Array.isArray(configuration.grants) && configuration.accounts.length === 0 && configuration.grants.length === 0) {
      cachedRevision = ''; cachedRuntime = null;
      return null;
    }
    const sourceDirectory = typeof directory === 'function' ? directory() : directory;
    // A secret rotation restarts the process. Configuration and source path
    // changes are detected here without caching client-supplied selectors.
    const revision = createHash('sha256').update(JSON.stringify([configuration, sourceDirectory])).digest('hex');
    if (revision !== cachedRevision || !cachedRuntime) {
      cachedRevision = revision;
      cachedRuntime = Promise.resolve(makeRuntime({ prisma, verifySessionToken, lookupUser, configuration, sourceDirectory, secretValue }));
      cachedRuntime.catch(() => { if (cachedRevision === revision) { cachedRuntime = null; cachedRevision = ''; } });
    }
    return cachedRuntime;
  }
  return async function handleVideoAssets(request) {
    let service;
    try { service = await runtime(); } catch (_) { return brokenConfiguration(request); }
    // This handler still returns 401 for missing/invalid/revoked sessions and
    // 403 for disallowed origins. Signed source reads fail closed with 404.
    return service ? service.handler(request) : unavailable(request);
  };
}

module.exports = { createWebsiteHandler, readConfiguration, readSecret };
