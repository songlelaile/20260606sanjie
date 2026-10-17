/* eslint-disable @typescript-eslint/no-require-imports -- Server-only CommonJS modules loaded by the Node runtime. */
'use strict';

const { createHash } = require('node:crypto');
const { createSourceStore } = require('./source-store.cjs');
const { createArkProvider } = require('./provider-ark.cjs');
const { createAssetService } = require('./asset-service.cjs');
const { createTaskService } = require('./tasks-service.cjs');
const { createPrismaRepository } = require('./prisma-repository.cjs');
const { createSessionAuthenticator, createRequestProviderResolver } = require('./provider-resolver.cjs');
const { createHttpHandler } = require('./http-handler.cjs');

/** Server-only assembly. Configuration contains secret variable names, never client-supplied credentials. */
async function createRuntime(options) {
  const { prisma, verifySessionToken, lookupUser, configuration, sourceDirectory, secretValue } = options;
  if (!sourceDirectory) throw new Error('An explicit persistent server cache directory is required.');
  if (!configuration || !Array.isArray(configuration.accounts) || !Array.isArray(configuration.grants) || typeof secretValue !== 'function') throw new Error('Explicit server account configuration and secret resolver are required.');
  const repository = options.repository || createPrismaRepository({ prisma });
  const sourceStore = await createSourceStore({ directory: sourceDirectory, publicBaseUrl: 'https://shaozhuangai.com', signingKey: await secretValue(configuration.sourceSigningKeyRef) });
  function accountFor(id) {
    const rows = configuration.accounts.filter(a => a.providerAccountId === id);
    if (rows.length !== 1) throw new Error('The provider account must have one authoritative quota configuration.');
    return rows[0];
  }
  async function rowFor(grant) {
    if (!grant || !grant.enabled) return null;
    const account = accountFor(grant.providerAccountId);
    if (account.enabled !== true || !['tenant','platform'].includes(account.mode)) return null;
    if (!account.managedGroupId || !account.projectName || !account.providerModels) throw new Error('The verified project, managed asset group and model mapping are required.');
    const row = {
      tenantId: grant.tenantId, userId: grant.userId, enabled: true, provider: grant.provider || 'doubao',
      providerAccountId: account.providerAccountId, projectName: account.projectName,
      apiOrigin: 'https://ark.cn-beijing.volces.com', mode: account.mode,
      platformGrantEnabled: grant.platformGrantEnabled === true,
      accessKeyId: await secretValue(account.accessKeyIdRef), secretAccessKey: await secretValue(account.secretAccessKeyRef),
      apiKey: await secretValue(account.apiKeyRef),
      managedGroupId: account.managedGroupId, providerModels: account.providerModels,
      quota: { limit: account.cloudLimit, externalUsed: account.externalUsed }, createQpm: account.createQpm || 3
    };
    if (row.mode === 'platform' && !row.platformGrantEnabled) return null;
    return row;
  }
  function matchingGrants(identity, selection) {
    return configuration.grants.filter(g => g.tenantId === identity.tenantId && g.userId === identity.userId &&
      (g.provider || 'doubao') === selection.provider);
  }
  const requestResolver = createRequestProviderResolver({findBinding: async (identity, selection) => {
    const matches = matchingGrants(identity, selection);
    if (matches.length !== 1) return null;
    return rowFor(matches[0]);
  }});
  const providerResolver = {resolve: async scope => {
    const grants = configuration.grants.filter(g => g.tenantId === scope.tenantId && g.userId === scope.userId && g.providerAccountId === scope.providerAccountId && g.enabled);
    if (grants.length !== 1) return null;
    const row = await rowFor(grants[0]);
    if (!row || row.projectName !== scope.projectName) return null;
    return {...row, provider: createArkProvider({...row, sourceStore, fetchImpl: options.providerFetch})};
  }};
  const assetService = createAssetService({repository,providerResolver});
  const taskService = createTaskService({repository,assetService,providerResolver});
  const authenticate = createSessionAuthenticator({verifySessionToken,lookupUser});
  const handler = createHttpHandler({assetService,taskService,authenticate,providerResolver:requestResolver,sourceStore});
  return Object.freeze({handler,assetService,taskService,sourceStore,
    // A nonsecret revision helps deployments identify which grants were loaded.
    configurationRevision:createHash('sha256').update(JSON.stringify(configuration)).digest('hex')});
}

module.exports = {createRuntime};
