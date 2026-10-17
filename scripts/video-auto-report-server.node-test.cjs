"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const { constants: fsConstants } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createAssetService, freshState, AUTOMATIC_LIMIT
} = require("../src/lib/video-assets-r51/asset-service.cjs");
const { createRuntime } = require("../src/lib/video-assets-r51/runtime.cjs");
const {
  credentialFingerprint, createSessionAuthenticator
} = require("../src/lib/video-assets-r51/provider-resolver.cjs");
const { createHttpHandler } = require("../src/lib/video-assets-r51/http-handler.cjs");
const { createTaskService, normalizeBody } = require("../src/lib/video-assets-r51/tasks-service.cjs");
const { createArkProvider, signArkRequest } = require("../src/lib/video-assets-r51/provider-ark.cjs");
const { readConfiguration, readSecret } = require("../src/lib/video-assets-r51/site-adapter.cjs");

// Every transport below is an in-memory stub. No provider request is permitted.
const origin = "https://ark.cn-beijing.volces.com";
const scope = Object.freeze({ tenantId: "tenant-a", userId: "user-a", providerAccountId: "platform-a", projectName: "default" });
const otherTenant = Object.freeze({ ...scope, tenantId: "tenant-b", userId: "user-b" });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFA0AAAAASUVORK5CYII=", "base64");
const image = (number = 0, extra = {}) => ({ bytes: Buffer.concat([png, Buffer.from(String(number))]), mime: "image/png", name: "Fixture product", ...extra });
const copy = value => structuredClone(value);

function memoryRepository() {
  const states = new Map();
  const tails = new Map();
  return {
    async withLock(key, work) {
      const before = tails.get(key) || Promise.resolve();
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const tail = before.then(() => gate);
      tails.set(key, tail);
      await before;
      try {
        return await work({ async transaction(fn) {
          const next = copy(states.get(key) || freshState());
          const result = await fn(next);
          states.set(key, next);
          return result;
        } });
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
    snapshots() { return [...states.values()].map(copy); }
  };
}

function fixture(options = {}) {
  const repository = memoryRepository();
  const calls = [];
  const remote = new Map();
  let sequence = 0;
  let clock = Date.parse("2026-10-18T00:00:00Z");
  const mutable = {
    createStatus: options.createStatus || "Processing",
    groupType: "LivenessFace",
    groupProject: "default",
    validationResultError: null,
    createValidationError: null,
    groupError: null
  };
  const provider = {
    async create(request) {
      calls.push({ kind: "create", ...request });
      const id = "asset-fixture-" + (++sequence);
      const result = { id, status: mutable.createStatus, groupId: request.groupId || "group-virtual-fixture", groupType: request.groupType || "AIGC", sourceId: "source-fixture-" + sequence };
      remote.set(id, result);
      return copy(result);
    },
    async get(request) {
      calls.push({ kind: "get", ...request });
      const value = remote.get(request.id);
      if (!value) throw new Error("Unknown fixture remote asset");
      return copy(value);
    },
    async delete(request) {
      calls.push({ kind: "delete", ...request });
      remote.delete(request.id);
      return { deleted: true, verified: true };
    },
    async getGroup(request) {
      calls.push({ kind: "getGroup", ...request });
      if (mutable.groupError) throw mutable.groupError;
      return { id: request.id, groupType: request.expectedType === "AIGC" ? "AIGC" : mutable.groupType, projectName: mutable.groupProject };
    },
    async createValidationSession(request) {
      calls.push({ kind: "createValidationSession", ...request });
      if (mutable.createValidationError) throw mutable.createValidationError;
      return { bytedToken: "fixture-secret-byted-token", h5Link: "https://h5-v2.kych5.com/fixture-authorization?token=fixture-h5-token" };
    },
    async getValidationResult(request) {
      calls.push({ kind: "getValidationResult", ...request });
      if (mutable.validationResultError) throw mutable.validationResultError;
      return { groupId: "group-real-server-verified" };
    }
  };
  const binding = {
    enabled: true, mode: "platform", providerAccountId: scope.providerAccountId, projectName: scope.projectName,
    managedGroupId: "group-virtual-fixture", validationCallbackUrl: "https://www.shaozhuangai.com/dashboards/operating-network/video",
    quota: { limit: 1000, externalUsed: 0 }, createQpm: 1000,
    provider, ...(options.binding || {})
  };
  const service = createAssetService({
    repository, providerResolver: { async resolve() { return binding; } },
    now: () => clock, makeId: () => "fixture-" + (++sequence).toString().padStart(8, "0")
  });
  return {
    service, binding, calls, remote, mutable, repository,
    count(kind) { return calls.filter(call => call.kind === kind).length; },
    tick(ms) { clock += ms; }
  };
}

function assertRejected(promise) {
  return assert.rejects(promise, error => {
    assert.equal(typeof error.code, "string", "rejections must carry a typed service error");
    assert.ok(error.code.length > 0);
    return true;
  });
}

async function verifiedSession(runtime) {
  const created = await runtime.service.createValidation(scope, { idempotencyKey: "validation-fixture-0001" });
  assert.ok(created.id);
  const verified = await runtime.service.verifyValidation(scope, created.id);
  assert.equal(verified.status, "verified");
  return created.id;
}

test("ordinary product images do not create a group, an asset, or an automatic-pool record", async () => {
  const runtime = fixture();
  const result = await runtime.service.ingest(scope, image(1, { materialType: "ordinary" }));
  assert.equal(result.requiresRegistration, false);
  assert.equal(runtime.count("create"), 0);
  assert.equal(runtime.count("getGroup"), 0);
  assert.equal((await runtime.service.list(scope)).assets.length, 0);
});

test("virtual portraits reject client group IDs and use the server AIGC group", async () => {
  const runtime = fixture();
  await assertRejected(runtime.service.ingest(scope, image(2, { materialType: "virtual", groupId: "group-client-forged" })));
  assert.equal(runtime.count("create"), 0);
  const result = await runtime.service.ingest(scope, image(2, { materialType: "virtual" }));
  assert.ok(result.asset.id);
  const request = runtime.calls.find(call => call.kind === "create");
  assert.equal(request.groupType, "AIGC");
  assert.notEqual(request.groupId, "group-client-forged");
  assert.equal(runtime.count("create"), 1);
});

test("a client group ID or callback success flag cannot authorize real portrait registration", async () => {
  const runtime = fixture();
  for (const untrusted of [
    { groupId: "group-client-forged" },
    { resultCode: 10000, status: "verified" },
    { validationId: "vv_client-forged", resultCode: 10000 }
  ]) await assertRejected(runtime.service.ingest(scope, image(3, { materialType: "real", ...untrusted })));
  assert.equal(runtime.count("create"), 0);
  assert.equal(runtime.count("getValidationResult"), 0);
});

test("validation creation is idempotent and its public state never exposes the provider token", async () => {
  const runtime = fixture();
  const input = { idempotencyKey: "validation-fixture-0002", groupId: "group-client-forged", resultCode: 10000 };
  const first = await runtime.service.createValidation(scope, input);
  const second = await runtime.service.createValidation(scope, input);
  assert.equal(first.id, second.id);
  assert.equal(runtime.count("createValidationSession"), 1);
  assert.match(first.h5Link, /^https:\/\/h5-v2\.kych5\.com\//);
  assert.notEqual(first.status, "verified");
  const saved = await runtime.service.getValidation(scope, first.id);
  assert.notEqual(saved.status, "verified");
  assert.ok(!JSON.stringify([first, second, saved]).includes("fixture-secret-byted-token"));
  await assertRejected(runtime.service.ingest(scope, image(4, { materialType: "real", validationId: first.id, resultCode: 10000 })));
  assert.equal(runtime.count("create"), 0);
});

test("real registration requires server result plus same-project LivenessFace group verification", async () => {
  const runtime = fixture();
  const id = await verifiedSession(runtime);
  const result = await runtime.service.ingest(scope, image(5, { materialType: "real", validationId: id }));
  assert.ok(result.asset.id);
  const query = runtime.calls.find(call => call.kind === "getValidationResult");
  assert.equal(query.bytedToken, "fixture-secret-byted-token");
  const groups = runtime.calls.filter(call => call.kind === "getGroup");
  assert.ok(groups.some(call => call.id === "group-real-server-verified" && call.expectedType === "LivenessFace"));
  const create = runtime.calls.find(call => call.kind === "create");
  assert.equal(create.groupId, "group-real-server-verified");
  assert.equal(create.groupType, "LivenessFace");
  assert.ok(runtime.calls.indexOf(query) < runtime.calls.indexOf(create));
});

test("validation session IDs cannot be read or verified across tenants sharing a provider account", async () => {
  const runtime = fixture();
  const validation = await runtime.service.createValidation(scope, { idempotencyKey: "validation-fixture-0003" });
  await assertRejected(runtime.service.getValidation(otherTenant, validation.id));
  await assertRejected(runtime.service.verifyValidation(otherTenant, validation.id));
  await assertRejected(runtime.service.ingest(otherTenant, image(6, { materialType: "real", validationId: validation.id })));
  assert.equal(runtime.count("getValidationResult"), 0);
  assert.equal(runtime.count("create"), 0);
});

for (const [name, patch] of [
  ["AIGC group", { groupType: "AIGC" }],
  ["another project", { groupProject: "other-project" }]
]) test("provider validation result cannot authorize a real group from " + name, async () => {
  const runtime = fixture();
  const validation = await runtime.service.createValidation(scope, { idempotencyKey: "validation-fixture-0004" });
  Object.assign(runtime.mutable, patch);
  assert.notEqual((await runtime.service.verifyValidation(scope, validation.id)).status, "verified");
  assert.notEqual((await runtime.service.getValidation(scope, validation.id)).status, "verified");
  await assertRejected(runtime.service.ingest(scope, image(7, { materialType: "real", validationId: validation.id })));
  assert.equal(runtime.count("create"), 0);
});

test("an unavailable or permission-denied validation result never marks a session verified", async () => {
  const runtime = fixture();
  const validation = await runtime.service.createValidation(scope, { idempotencyKey: "validation-fixture-0005" });
  runtime.mutable.validationResultError = Object.assign(new Error("fixture provider entitlement unavailable"), { code: "ARK_PERMISSION_DENIED", accepted: false });
  assert.notEqual((await runtime.service.verifyValidation(scope, validation.id)).status, "verified");
  assert.notEqual((await runtime.service.getValidation(scope, validation.id)).status, "verified");
  await assertRejected(runtime.service.ingest(scope, image(8, { materialType: "real", validationId: validation.id })));
  assert.equal(runtime.count("create"), 0);
});

test("an administrator real-group binding is reverified before uploading a real portrait", async () => {
  const runtime = fixture({ binding: { livenessGroupId: "group-admin-real" } });
  await runtime.service.ingest(scope, image(9, { materialType: "real" }));
  const create = runtime.calls.find(call => call.kind === "create");
  assert.equal(create.groupId, "group-admin-real");
  assert.equal(create.groupType, "LivenessFace");
  assert.ok(runtime.calls.some(call => call.kind === "getGroup" && call.id === "group-admin-real" && call.expectedType === "LivenessFace"));
  assert.equal(runtime.count("createValidationSession"), 0);
});

test("an expired validation session cannot trigger a provider query or authorize real registration", async () => {
  const runtime = fixture();
  const validation = await runtime.service.createValidation(scope, { idempotencyKey: "validation-fixture-0006" });
  runtime.tick(30 * 60 * 1000 + 1);
  assert.equal((await runtime.service.getValidation(scope, validation.id)).status, "expired");
  assert.notEqual((await runtime.service.verifyValidation(scope, validation.id)).status, "verified");
  await assertRejected(runtime.service.ingest(scope, image(13, { materialType: "real", validationId: validation.id })));
  assert.equal(runtime.count("getValidationResult"), 0);
  assert.equal(runtime.count("create"), 0);
});

test("an uncertain validation creation is persisted and never automatically reposted for the same key", async () => {
  const runtime = fixture();
  runtime.mutable.createValidationError = Object.assign(new Error("fixture connection interrupted"), { code: "ARK_REQUEST_UNCERTAIN" });
  const input = { idempotencyKey: "validation-fixture-0007" };
  const first = await runtime.service.createValidation(scope, input);
  const second = await runtime.service.createValidation(scope, input);
  assert.equal(first.id, second.id);
  assert.notEqual(first.status, "verified");
  assert.equal(runtime.count("createValidationSession"), 1);
  await assertRejected(runtime.service.ingest(scope, image(14, { materialType: "real", validationId: first.id })));
  assert.equal(runtime.count("create"), 0);
});

test("refresh exposes canUse only after the provider reports Active", async () => {
  const runtime = fixture();
  const { asset } = await runtime.service.ingest(scope, image(10, { materialType: "virtual" }));
  assert.equal(asset.canUse, false);
  const created = runtime.calls.find(call => call.kind === "create");
  const [remoteId, remote] = [...runtime.remote][0];
  assert.ok(created);
  remote.status = "Active";
  runtime.remote.set(remoteId, remote);
  assert.equal((await runtime.service.refresh(scope, asset.id)).canUse, true);
  remote.status = "Failed";
  runtime.remote.set(remoteId, remote);
  assert.equal((await runtime.service.refresh(scope, asset.id)).canUse, false);
});

test("a cached active asset is rechecked before resolving references or taking a generation lease", async () => {
  for (const operation of ["resolveReferences", "acquireLease"]) {
    const runtime = fixture({ createStatus: "Active" });
    const { asset } = await runtime.service.ingest(scope, image(11, { materialType: "virtual" }));
    const [remoteId, remote] = [...runtime.remote][0];
    remote.status = "Processing";
    runtime.remote.set(remoteId, remote);
    await assertRejected(operation === "resolveReferences" ? runtime.service.resolveReferences(scope, [asset.id])
      : runtime.service.acquireLease(scope, { taskId: "task-fixture-revalidate", assetIds: [asset.id] }));
    assert.equal(runtime.count("get"), 1, operation + " must obtain a fresh provider result");
    assert.equal(Object.values(runtime.repository.snapshots()[0].tasks).length, 0);
  }
});

test("a real portrait group is reverified immediately before generation", async () => {
  const runtime = fixture({ createStatus: "Active", binding: { livenessGroupId: "group-admin-real" } });
  const { asset } = await runtime.service.ingest(scope, image(12, { materialType: "real" }));
  runtime.mutable.groupType = "AIGC";
  await assertRejected(runtime.service.acquireLease(scope, { taskId: "task-fixture-real-revalidate", assetIds: [asset.id] }));
  assert.equal(Object.values(runtime.repository.snapshots()[0].tasks).length, 0);
});

test("freshly active server-owned assets produce provider references and a protected lease", async () => {
  const runtime = fixture({ createStatus: "Active" });
  const { asset } = await runtime.service.ingest(scope, image(15, { materialType: "virtual" }));
  const expected = [{ id: asset.id, url: "asset://" + [...runtime.remote.keys()][0] }];
  assert.deepEqual(await runtime.service.resolveReferences(scope, [asset.id]), expected);
  const lease = await runtime.service.acquireLease(scope, { taskId: "task-fixture-success", assetIds: [asset.id] });
  assert.deepEqual(lease.references, expected);
  assert.equal(runtime.count("get"), 2);
  await assertRejected(runtime.service.remove(scope, asset.id));
  await assertRejected(runtime.service.resolveReferences(otherTenant, [asset.id]));
  assert.equal(runtime.count("delete"), 0);
});

test("processing assets are never FIFO deletion victims when the automatic pool fills", async () => {
  const runtime = fixture();
  for (let index = 0; index < AUTOMATIC_LIMIT; index += 1) {
    await runtime.service.ingest(scope, image(100 + index, { materialType: "virtual" }));
  }
  await assertRejected(runtime.service.ingest(scope, image(100 + AUTOMATIC_LIMIT, { materialType: "virtual" })));
  assert.equal(runtime.count("create"), AUTOMATIC_LIMIT);
  assert.equal(runtime.count("delete"), 0);
  assert.equal((await runtime.service.list(scope)).assets.length, AUTOMATIC_LIMIT);
});

const account = (id = "platform-a", mode = "platform") => ({
  providerAccountId: id, enabled: true, mode, projectName: "default", managedGroupId: "group-virtual-fixture",
  accessKeyIdRef: "FIXTURE_AK", secretAccessKeyRef: "FIXTURE_SK", apiKeyRef: id === "platform-b" ? "FIXTURE_VIDEO_B" : "FIXTURE_VIDEO_A",
  providerModels: { "seedance-2.0": "doubao-seedance-2-0-260128" }, cloudLimit: 1000, externalUsed: 0, createQpm: 3
});
const grant = (extra = {}) => ({
  tenantId: "*", userId: "*", provider: "doubao", providerAccountId: "platform-a", enabled: true, platformGrantEnabled: true, ...extra
});
const identity = Object.freeze({ tenantId: "tenant-a", userId: "user-a", accountKey: "user:alice" });
const secretValues = { FIXTURE_AK: "fixture-ak", FIXTURE_SK: "fixture-sk", FIXTURE_VIDEO_A: "fixture-video-key-a", FIXTURE_VIDEO_B: "fixture-video-key-b", FIXTURE_SOURCE_SIGN: "fixture-source-signing-key-with-more-than-32-characters" };
const selection = (key = secretValues.FIXTURE_VIDEO_A) => ({ provider: "doubao", apiOrigin: origin, credentialFingerprint: credentialFingerprint(origin, key) });

async function configuredRuntime(t, configuration) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "video-auto-report-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return createRuntime({
    configuration: { sourceSigningKeyRef: "FIXTURE_SOURCE_SIGN", ...configuration }, sourceDirectory: directory,
    repository: memoryRepository(), secretValue: async name => secretValues[name],
    verifySessionToken: async () => null, lookupUser: async () => null,
    providerFetch: async () => { throw new Error("Real transport forbidden in fixture"); }
  });
}

test("an explicit platform wildcard grant resolves a fresh authenticated identity without leaking credentials", async t => {
  const runtime = await configuredRuntime(t, { accounts: [account()], grants: [grant()] });
  assert.equal(typeof runtime.requestResolver?.resolve, "function");
  const result = await runtime.requestResolver.resolve(identity, selection());
  assert.deepEqual(result, { ...scope });
  assert.ok(!JSON.stringify(result).includes(secretValues.FIXTURE_VIDEO_A));
});

test("an exact platform grant takes precedence over a platform wildcard", async t => {
  const runtime = await configuredRuntime(t, { accounts: [account(), account("platform-b")], grants: [
    grant(), grant({ tenantId: identity.tenantId, userId: identity.userId, providerAccountId: "platform-b" })
  ] });
  const result = await runtime.requestResolver.resolve(identity, selection(secretValues.FIXTURE_VIDEO_B));
  assert.equal(result.providerAccountId, "platform-b");
});

test("a platform-binding flag cannot select an exact BYOK grant even with its matching fingerprint", async t => {
  const runtime = await configuredRuntime(t, { accounts: [account("platform-a", "tenant")], grants: [
    grant({ tenantId: identity.tenantId, userId: identity.userId, platformGrantEnabled: false })
  ] });
  assert.equal((await runtime.requestResolver.resolve(identity, selection())).providerAccountId, "platform-a");
  await assertRejected(runtime.requestResolver.resolve(identity, selection(), { requirePlatform: true }));
  let lists = 0;
  const handler = createHttpHandler({
    authenticate: async () => identity, providerResolver: runtime.requestResolver,
    assetService: { async list() { lists += 1; throw new Error("A flagged BYOK request must never reach the asset service"); } }
  });
  const response = await handler(new Request("https://www.shaozhuangai.com/api/video-assets", { headers: {
    origin: "https://www.shaozhuangai.com", "x-video-account": encodeURIComponent(identity.accountKey),
    "x-video-binding": encodeURIComponent(JSON.stringify(selection())), "x-video-platform-binding": "1"
  } }));
  assert.equal((await response.json()).ok, false);
  assert.equal(lists, 0);
  assert.match(response.headers.get("Vary"), /x-video-platform-binding/i);
});

for (const [name, accounts, grants] of [
  ["no grant", [account()], []],
  ["disabled wildcard", [account()], [grant({ enabled: false })]],
  ["no platform permission", [account()], [grant({ platformGrantEnabled: false })]],
  ["disabled account", [{ ...account(), enabled: false }], [grant()]],
  ["BYOK wildcard", [account("platform-a", "tenant")], [grant()]],
  ["ambiguous wildcard", [account()], [grant(), grant()]],
  ["revoked exact grant masks wildcard", [account()], [grant(), grant({ tenantId: identity.tenantId, userId: identity.userId, enabled: false })]]
]) test("platform wildcard resolution fails closed: " + name, async t => {
  const runtime = await configuredRuntime(t, { accounts, grants });
  await assertRejected(runtime.requestResolver.resolve(identity, selection()));
});

function authenticatedHandler() {
  let listCalls = 0;
  const authenticate = createSessionAuthenticator({
    verifySessionToken: async token => token === "fixture-signed-session" ? { username: "alice", tenantId: "tenant-a", role: "tenant" } : null,
    lookupUser: async username => username === "alice" ? { id: "user-a", tenantId: "tenant-a", username: "alice", status: "active", authRole: "tenant" } : null
  });
  const handler = createHttpHandler({
    authenticate, providerResolver: { async resolve(value) { assert.equal(value.tenantId, "tenant-a"); assert.equal(value.userId, "user-a"); return scope; } },
    assetService: { async list() { listCalls += 1; return { assets: [], limits: { automatic: 50, bound: 50, cloudTotal: 1000, automaticUsed: 0, boundUsed: 0 } }; } }
  });
  return { handler, listCalls: () => listCalls };
}

for (const accountKey of ["user:alice", "tenant-a:alice"]) test("www website origin accepts the established account representation: " + accountKey, async () => {
  const runtime = authenticatedHandler();
  const response = await runtime.handler(new Request("https://www.shaozhuangai.com/api/video-assets", { headers: {
    origin: "https://www.shaozhuangai.com", "x-sanjie-session": "fixture-signed-session",
    "x-video-account": encodeURIComponent(accountKey), "x-video-binding": encodeURIComponent(JSON.stringify(selection()))
  } }));
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.ok, true);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://www.shaozhuangai.com");
  assert.equal(runtime.listCalls(), 1);
});

test("account compatibility never admits a sibling user's account key", async () => {
  const runtime = authenticatedHandler();
  const response = await runtime.handler(new Request("https://www.shaozhuangai.com/api/video-assets", { headers: {
    origin: "https://www.shaozhuangai.com", "x-sanjie-session": "fixture-signed-session",
    "x-video-account": encodeURIComponent("tenant-a:bob"), "x-video-binding": encodeURIComponent(JSON.stringify(selection()))
  } }));
  assert.equal((await response.json()).ok, false);
  assert.equal(runtime.listCalls(), 0);
});

const modelMap = {
  "seedance-2.0": "doubao-seedance-2-0-260128",
  "seedance-2.0-mini": "doubao-seedance-2-0-mini-260128"
};
const ordinaryUrl = "https://images.fixture.invalid/product.jpg?variant=one";
const ordinaryData = "data:image/png;base64," + png.toString("base64");
const imageContent = url => ({ type: "image_url", image_url: { url }, role: "reference_image" });
const videoBody = (content = [imageContent(ordinaryUrl)], extra = {}) => ({
  model: modelMap["seedance-2.0"], content: [{ type: "text", text: "Fixture product demo" }, ...content],
  duration: 5, resolution: "720p", ratio: "16:9", generate_audio: false, ...extra
});

test("mixed ordinary and library images require an explicit ordinary-image grant", () => {
  const body = videoBody([imageContent(ordinaryUrl), imageContent("library://va_fixture-library"), imageContent(ordinaryData)]);
  for (const allowOrdinaryImages of [false, undefined]) {
    assert.throws(() => normalizeBody(body, { providerModels: modelMap, allowOrdinaryImages }), error => error.code === "VIDEO_IMAGE_LIBRARY_REQUIRED");
  }
  const normalized = normalizeBody(body, { providerModels: modelMap, allowOrdinaryImages: true });
  assert.deepEqual(normalized.assetIds, ["va_fixture-library"]);
  assert.equal(normalized.body.content[1].image_url.url, ordinaryUrl);
  assert.equal(normalized.body.content[2].image_url.url, "library://va_fixture-library");
  assert.equal(normalized.body.content[3].image_url.url, ordinaryData);
});

for (const type of ["image_url", "video_url", "audio_url"]) test("raw asset URI is never accepted from client " + type + " content", () => {
  const role = type === "image_url" ? "reference_image" : type === "video_url" ? "reference_video" : "reference_audio";
  const entry = { type, [type]: { url: "asset://asset-client-forged" }, role };
  assert.throws(() => normalizeBody(videoBody([entry]), { providerModels: modelMap, allowOrdinaryImages: true }));
});

test("Mini retains the shipped 480p and 720p capabilities without inferring 1080p", () => {
  const binding = { providerModels: modelMap, allowOrdinaryImages: true };
  for (const resolution of ["480p", "720p"]) {
    const normalized = normalizeBody(videoBody(undefined, { model: modelMap["seedance-2.0-mini"], resolution }), binding);
    assert.equal(normalized.productKey, "seedance-2.0-mini");
    assert.equal(normalized.body.resolution, resolution);
  }
  assert.throws(() => normalizeBody(videoBody(undefined, { model: modelMap["seedance-2.0-mini"], resolution: "1080p" }), binding),
    error => error.code === "VIDEO_SPECIFICATION_INVALID");
});

function taskFixture(options = {}) {
  const runtime = fixture({ createStatus: "Active" });
  const submissions = [];
  Object.assign(runtime.binding, { providerModels: modelMap, allowOrdinaryImages: true });
  Object.assign(runtime.binding.provider, {
    async videoCreate(request) {
      submissions.push(copy(request));
      if (options.providerError) throw options.providerError;
      return { id: "cgt-fixture-task", status: "queued" };
    },
    async videoGet() { return { id: "cgt-fixture-task", status: "queued" }; },
    async videoCancel() { return { cancelled: false, verified: false }; }
  });
  const tasks = createTaskService({
    repository: runtime.repository, assetService: runtime.service,
    providerResolver: { async resolve() { return runtime.binding; } },
    makeId: () => "fixture-task-0001"
  });
  return { ...runtime, tasks, submissions };
}

test("task creation replaces only library references and preserves every ordinary image in order", async () => {
  const runtime = taskFixture();
  const first = (await runtime.service.ingest(scope, image(201, { materialType: "virtual" }))).asset;
  const second = (await runtime.service.ingest(scope, image(202, { materialType: "virtual" }))).asset;
  const upstreamIds = [...runtime.remote.keys()];
  const body = videoBody([
    imageContent(ordinaryUrl), imageContent("library://" + first.id), imageContent(ordinaryData), imageContent("library://" + second.id)
  ]);
  const result = await runtime.tasks.create(scope, { idempotencyKey: "task-mixed-fixture-0001", body });
  assert.equal(result.task.status, "processing");
  assert.equal(runtime.submissions.length, 1);
  const sent = runtime.submissions[0].body.content;
  assert.equal(sent.length, body.content.length);
  assert.deepEqual(sent.map(entry => entry.type === "text" ? entry.text : entry.image_url.url), [
    "Fixture product demo", ordinaryUrl, "asset://" + upstreamIds[0], ordinaryData, "asset://" + upstreamIds[1]
  ]);
  assert.ok(!JSON.stringify(runtime.submissions[0].body).includes("library://"));
  const duplicate = await runtime.tasks.create(scope, { idempotencyKey: "task-mixed-fixture-0001", body });
  assert.equal(duplicate.idempotent, true);
  assert.equal(runtime.submissions.length, 1);
});

for (const unsafeDiagnostics of [false, true]) test("privacy rejection retains only safe provider diagnostics: " + (unsafeDiagnostics ? "unsafe IDs discarded" : "safe IDs retained"), async () => {
  const marker = "FIXTURE_ARBITRARY_PROVIDER_BODY_SHOULD_NEVER_ESCAPE";
  const providerError = Object.assign(new Error(marker + " https://fixture.invalid/private?token=secret"), {
    accepted: false, code: unsafeDiagnostics ? "Bad code\n" + marker : "InputImageSensitiveContentDetected.PrivacyInformation",
    requestId: unsafeDiagnostics ? "https://fixture.invalid/" + marker : "req-fixture-safe-123"
  });
  const runtime = taskFixture({ providerError });
  const result = await runtime.tasks.create(scope, { idempotencyKey: "task-privacy-fixture-0001", body: videoBody() });
  assert.equal(result.task.status, "failed");
  assert.equal(result.task.providerCode, unsafeDiagnostics ? "" : providerError.code);
  assert.equal(result.task.requestId, unsafeDiagnostics ? "" : providerError.requestId);
  if (!unsafeDiagnostics) assert.match(result.task.message, /真人/);
  assert.ok(!JSON.stringify([result, runtime.repository.snapshots()]).includes(marker));
  assert.equal(runtime.submissions.length, 1);
});

test("HTTP validation sessions ignore callback success and group IDs until the server verifies provider state", async () => {
  const runtime = fixture();
  const handler = createHttpHandler({
    assetService: runtime.service, authenticate: async () => identity,
    providerResolver: { async resolve() { return scope; } }
  });
  async function request(resource, method = "GET", body) {
    const response = await handler(new Request("https://www.shaozhuangai.com/api/video-assets" + resource, {
      method, headers: { origin: "https://www.shaozhuangai.com", "x-video-account": encodeURIComponent(identity.accountKey),
        "x-video-binding": encodeURIComponent(JSON.stringify(selection())), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    }));
    return { response, payload: await response.json() };
  }
  const created = await request("/validation-sessions", "POST", {
    idempotencyKey: "validation-http-fixture-0001", groupId: "group-client-forged", success: true, resultCode: 10000
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.payload));
  const id = created.payload.data.validation.id;
  const callback = await request("/validation-sessions/" + id + "?groupId=group-client-forged&resultCode=10000&success=true");
  assert.notEqual(callback.payload.data.validation.status, "verified");
  assert.equal(runtime.count("getValidationResult"), 0);
  runtime.mutable.validationResultError = Object.assign(new Error("fixture permission unavailable"), { code: "PermissionDenied", accepted: false });
  const forged = await request("/validation-sessions/" + id + "/verify", "POST", { groupId: "group-client-forged", success: true, resultCode: 10000 });
  assert.notEqual(forged.payload.data.validation.status, "verified");
  const denied = await request("", "POST", { dataUrl: ordinaryData, materialType: "real", validationId: id, groupId: "group-client-forged", success: true });
  assert.equal(denied.payload.ok, false);
  assert.equal(runtime.count("create"), 0);
  runtime.mutable.validationResultError = null;
  const verified = await request("/validation-sessions/" + id + "/verify", "POST", {});
  assert.equal(verified.payload.data.validation.status, "verified");
  const uploaded = await request("", "POST", { dataUrl: ordinaryData, materialType: "real", validationId: id });
  assert.equal(uploaded.payload.ok, true, JSON.stringify(uploaded.payload));
  assert.equal(runtime.calls.find(call => call.kind === "create").groupId, "group-real-server-verified");
  assert.ok(!JSON.stringify([created.payload, callback.payload, forged.payload, verified.payload]).includes("fixture-secret-byted-token"));
});

function arkFixture(replyOverride) {
  const calls = [];
  const callbackUrl = "https://www.shaozhuangai.com/dashboards/operating-network/video?videoValidation=vv_fixture-server";
  const provider = createArkProvider({
    accessKeyId: "fixture-access-key", secretAccessKey: "fixture-secret-key", apiKey: "fixture-video-key",
    providerAccountId: scope.providerAccountId, projectName: scope.projectName, managedGroupId: "group-virtual-fixture",
    now: () => new Date("2026-10-18T00:00:00Z"),
    sourceStore: { async put() { throw new Error("Not expected in this protocol test"); }, async urlFor() { throw new Error("Not expected in this protocol test"); } },
    async fetchImpl(url, init) {
      const action = new URL(url).searchParams.get("Action");
      const body = JSON.parse(init.body);
      calls.push({ action, url, init, body });
      const result = action === "CreateVisualValidateSession" ? { BytedToken: "fixture-provider-token", H5Link: "https://h5-v2.kych5.com/fixture-auth", CallbackURL: body.CallbackURL }
        : action === "GetVisualValidateResult" ? { GroupId: "group-real-fixture" }
          : action === "GetAssetGroup" ? { Id: body.Id, Name: "Fixture portrait", Description: "Fixture", GroupType: "LivenessFace", ProjectName: "default", CreateTime: "2026-10-18T00:00:00Z", UpdateTime: "2026-10-18T00:00:00Z" } : null;
      assert.ok(result, "Unexpected provider action: " + action);
      const payload = { ResponseMetadata: { RequestId: "req-fixture-ark", Action: action, Version: "2024-01-01", Service: "ark", Region: "cn-beijing" }, Result: result };
      if (replyOverride) replyOverride({ action, body, payload });
      return Response.json(payload);
    }
  });
  return { provider, calls, callbackUrl };
}

for (const action of ["CreateVisualValidateSession", "GetVisualValidateResult", "GetAssetGroup"]) test("Ark action signer accepts the documented operation: " + action, () => {
  const signed = signArkRequest({ action, body: { ProjectName: "default" }, accessKeyId: "fixture-ak", secretAccessKey: "fixture-sk", now: new Date("2026-10-18T00:00:00Z") });
  const url = new URL(signed.url);
  assert.equal(url.origin, "https://ark.cn-beijing.volcengineapi.com");
  assert.equal(url.searchParams.get("Action"), action);
  assert.equal(url.searchParams.get("Version"), "2024-01-01");
  assert.equal(signed.method, "POST");
  assert.match(signed.headers.Authorization, /^HMAC-SHA256 Credential=fixture-ak\/20261018\/cn-beijing\/ark\/request,/);
  assert.match(signed.headers["X-Content-Sha256"], /^[a-f0-9]{64}$/);
});

test("Ark signer rejects an undocumented asset-list action", () => {
  assert.throws(() => signArkRequest({ action: "GetAssetList", body: {}, accessKeyId: "fixture-ak", secretAccessKey: "fixture-sk" }),
    error => error.code === "ARK_ACTION_INVALID");
});

test("Ark adapter reads Result wrappers and formal GetAssetGroup fields through signed requests", async () => {
  const runtime = arkFixture();
  const validation = await runtime.provider.createValidationSession({ scope, callbackUrl: runtime.callbackUrl });
  assert.deepEqual(validation, { bytedToken: "fixture-provider-token", h5Link: "https://h5-v2.kych5.com/fixture-auth" });
  const result = await runtime.provider.getValidationResult({ scope, bytedToken: validation.bytedToken });
  assert.deepEqual(result, { groupId: "group-real-fixture" });
  assert.deepEqual(await runtime.provider.getGroup({ scope, id: result.groupId, expectedType: "LivenessFace" }), {
    id: "group-real-fixture", groupType: "LivenessFace", projectName: "default"
  });
  assert.deepEqual(runtime.calls.map(call => call.action), ["CreateVisualValidateSession", "GetVisualValidateResult", "GetAssetGroup"]);
  assert.deepEqual(runtime.calls[0].body, { CallbackURL: runtime.callbackUrl, ProjectName: "default" });
  assert.deepEqual(runtime.calls[1].body, { BytedToken: "fixture-provider-token", ProjectName: "default" });
  assert.deepEqual(runtime.calls[2].body, { Id: "group-real-fixture", ProjectName: "default" });
  for (const call of runtime.calls) assert.match(call.init.headers.Authorization, /^HMAC-SHA256 /);
});

for (const [name, change] of [
  ["wrong ID", payload => { payload.Result.Id = "group-other"; }],
  ["wrong project", payload => { payload.Result.ProjectName = "other-project"; }],
  ["wrong group type", payload => { payload.Result.GroupType = "AIGC"; }],
  ["legacy lower-case fields", payload => { payload.Result = { id: "group-real-fixture", groupType: "LivenessFace", projectName: "default" }; }],
  ["mismatched response action", payload => { payload.ResponseMetadata.Action = "GetAsset"; }]
]) test("Ark GetAssetGroup fails closed for " + name, async () => {
  const runtime = arkFixture(({ payload }) => change(payload));
  await assertRejected(runtime.provider.getGroup({ scope, id: "group-real-fixture", expectedType: "LivenessFace" }));
});

test("portrait capabilities expose only availability for approved callbacks and complete provider methods", async () => {
  for (const callback of [
    "https://shaozhuangai.com/dashboards/operating-network/video",
    "https://www.shaozhuangai.com/dashboards/operating-network/video", undefined
  ]) {
    const runtime = fixture({ binding: { validationCallbackUrl: callback } });
    assert.deepEqual(await runtime.service.capabilities(scope), { portraitAvailable: true });
    assert.equal(runtime.calls.length, 0);
  }
});

test("portrait capabilities fail closed for an unsafe callback", async () => {
  for (const callback of ["not a URL", "http://www.shaozhuangai.com/video", "https://fixture.invalid/video",
    "https://www.shaozhuangai.com/video?preexisting=1", "https://www.shaozhuangai.com/video#fragment",
    "https://user:pass@www.shaozhuangai.com/video"]) {
    const runtime = fixture({ binding: { validationCallbackUrl: callback } });
    assert.deepEqual(await runtime.service.capabilities(scope), { portraitAvailable: false }, callback);
    assert.equal(runtime.calls.length, 0);
  }
});

test("portrait capabilities require every authentication provider method", async () => {
  for (const missing of ["createValidationSession", "getValidationResult", "getGroup"]) {
    const runtime = fixture();
    delete runtime.binding.provider[missing];
    assert.deepEqual(await runtime.service.capabilities(scope), { portraitAvailable: false }, missing);
  }
});

test("HTTP asset listing returns portrait capabilities without provider configuration or secrets", async () => {
  const runtime = fixture({ binding: { apiKey: "fixture-capability-api-secret", accessKeyId: "fixture-capability-ak-secret", secretAccessKey: "fixture-capability-sk-secret" } });
  const handler = createHttpHandler({ assetService: runtime.service, authenticate: async () => identity, providerResolver: { async resolve() { return scope; } } });
  async function read() {
    const response = await handler(new Request("https://www.shaozhuangai.com/api/video-assets", { headers: {
      origin: "https://www.shaozhuangai.com", "x-video-account": encodeURIComponent(identity.accountKey),
      "x-video-binding": encodeURIComponent(JSON.stringify(selection()))
    } }));
    assert.equal(response.status, 200);
    return response.json();
  }
  const available = await read();
  assert.deepEqual(available.data.capabilities, { portraitAvailable: true });
  delete runtime.binding.provider.getGroup;
  const unavailable = await read();
  assert.deepEqual(unavailable.data.capabilities, { portraitAvailable: false });
  const serialized = JSON.stringify([available, unavailable]);
  for (const hidden of ["fixture-capability-api-secret", "fixture-capability-ak-secret", "fixture-capability-sk-secret", "secretAccessKey", "bytedToken", "validationCallbackUrl", "managedGroupId"]) {
    assert.ok(!serialized.includes(hidden), hidden + " must not be returned");
  }
  assert.equal(runtime.calls.length, 0);
});

const safeConfigPath = "/opt/fixture-video-config/asset-bindings.json";
const safeConfiguration = {
  sourceSigningKeyRef: "FIXTURE_SOURCE_SIGN",
  accounts: [{ providerAccountId: "fixture-platform", apiKeyRef: "FIXTURE_VIDEO_A", accessKeyIdRef: "FIXTURE_AK", secretAccessKeyRef: "FIXTURE_SK" }],
  grants: []
};

function configurationFilesystem(t, options = {}) {
  const calls = { directories: [], opened: [], stat: 0, read: 0, close: 0 };
  const source = JSON.stringify(safeConfiguration);
  const directory = { uid: 0, mode: 0o40755, isDirectory: () => true, isSymbolicLink: () => false };
  const file = { uid: 0, mode: 0o100600, nlink: 1, size: Buffer.byteLength(source), isFile: () => true, ...(options.file || {}) };
  t.mock.method(fs, "lstat", async filename => {
    calls.directories.push(filename);
    return { ...directory, ...(filename === (options.unsafeDirectory || "/opt") ? options.directory : {}) };
  });
  t.mock.method(fs, "open", async (filename, flags) => {
    calls.opened.push({ filename, flags });
    assert.equal(filename, safeConfigPath);
    assert.equal(flags & fsConstants.O_NOFOLLOW, fsConstants.O_NOFOLLOW, "configuration open must reject symlinks atomically");
    if (options.fileSymlink) throw Object.assign(new Error("fixture symlink rejected"), { code: "ELOOP" });
    return {
      async stat() { calls.stat += 1; return file; },
      async readFile(encoding) { calls.read += 1; assert.equal(encoding, "utf8"); return source; },
      async close() { calls.close += 1; }
    };
  });
  return calls;
}

test("missing configuration returns null without touching the filesystem", async t => {
  const calls = configurationFilesystem(t);
  assert.equal(await readConfiguration({}), null);
  assert.equal(calls.directories.length, 0);
  assert.equal(calls.opened.length, 0);
});

test("root-owned 0600 configuration with protected ancestors loads only server reference names", async t => {
  const calls = configurationFilesystem(t);
  const result = await readConfiguration({ VIDEO_ASSET_CONFIG_FILE: safeConfigPath });
  assert.deepEqual(result, safeConfiguration);
  assert.deepEqual(calls.directories, ["/opt/fixture-video-config", "/opt", "/"]);
  assert.equal(calls.opened.length, 1);
  assert.equal(calls.stat, 1);
  assert.equal(calls.read, 1);
  assert.equal(calls.close, 1);
  assert.ok(!JSON.stringify(result).includes("fixture-secret-value-not-in-configuration"));
});

for (const filename of ["relative/config.json", "/opt/fixture-video-config/../asset-bindings.json", "/opt/./fixture-video-config/asset-bindings.json"]) {
  test("configuration rejects a non-absolute or non-normalized path: " + filename, async t => {
    const calls = configurationFilesystem(t);
    await assert.rejects(readConfiguration({ VIDEO_ASSET_CONFIG_FILE: filename }));
    assert.equal(calls.directories.length, 0);
    assert.equal(calls.opened.length, 0);
  });
}

for (const [name, file] of [
  ["non-root owner", { uid: 501 }],
  ["world-readable mode", { mode: 0o100644 }],
  ["group-writable mode", { mode: 0o100620 }],
  ["owner-read-only mode", { mode: 0o100400 }],
  ["hard link", { nlink: 2 }],
  ["directory instead of file", { isFile: () => false }]
]) test("configuration rejects unsafe file metadata before reading JSON: " + name, async t => {
  const calls = configurationFilesystem(t, { file });
  await assert.rejects(readConfiguration({ VIDEO_ASSET_CONFIG_FILE: safeConfigPath }));
  assert.equal(calls.read, 0);
  assert.equal(calls.close, 1);
});

for (const [name, directory] of [
  ["non-root ancestor", { uid: 501 }],
  ["group-writable ancestor", { mode: 0o40775 }],
  ["world-writable ancestor", { mode: 0o40757 }],
  ["symlink ancestor", { isSymbolicLink: () => true }],
  ["non-directory ancestor", { isDirectory: () => false }]
]) test("configuration rejects an unsafe ancestor before opening the file: " + name, async t => {
  const calls = configurationFilesystem(t, { directory, unsafeDirectory: "/opt" });
  await assert.rejects(readConfiguration({ VIDEO_ASSET_CONFIG_FILE: safeConfigPath }));
  assert.deepEqual(calls.directories, ["/opt/fixture-video-config", "/opt"]);
  assert.equal(calls.opened.length, 0);
  assert.equal(calls.read, 0);
});

test("configuration opens with no-follow and rejects a final symlink without reading its target", async t => {
  const calls = configurationFilesystem(t, { fileSymlink: true });
  await assert.rejects(readConfiguration({ VIDEO_ASSET_CONFIG_FILE: safeConfigPath }), error => error.code === "ELOOP");
  assert.equal(calls.opened.length, 1);
  assert.equal(calls.stat, 0);
  assert.equal(calls.read, 0);
});

test("secret references accept only server environment names and never public or malformed names", () => {
  const env = { FIXTURE_SERVER_SECRET: "fixture-only-secret-value", NEXT_PUBLIC_FIXTURE_SECRET: "fixture-public-value" };
  assert.equal(readSecret("FIXTURE_SERVER_SECRET", env), "fixture-only-secret-value");
  for (const name of ["NEXT_PUBLIC_FIXTURE_SECRET", "fixture_server_secret", "FIXTURE_SERVER_SECRET;echo", "../FIXTURE_SERVER_SECRET", "MISSING_SECRET"]) {
    assert.throws(() => readSecret(name, env));
  }
});
