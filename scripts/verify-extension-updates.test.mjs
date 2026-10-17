import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AI_R39_MANIFEST_POLICY, AI_R42_MANIFEST_POLICY, AI_R43_MANIFEST_POLICY, verifyBootstrapCompatibility, verifyRelease } from "./verify-extension-updates.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function signed(payload, extra = {}) {
  const bytes = Buffer.from(JSON.stringify(payload));
  return Buffer.from(JSON.stringify({ payloadB64: bytes.toString("base64"), signatureB64: sign(null, bytes, privateKey).toString("base64"), ...extra }));
}
function fixture({ filePath = "app.js", actualBytes = Buffer.from("export const safe = true;"), extraFiles = {}, manifestVersion = "1.9.73" } = {}) {
  const manifest = Buffer.from(JSON.stringify({ manifest_version: 3, version: manifestVersion }));
  const expectedBytes = Buffer.from("export const safe = true;");
  const entries = [{ path: "manifest.json", size: manifest.length, sha256: hash(manifest) }, { path: filePath, size: expectedBytes.length, sha256: hash(expectedBytes) }];
  const packageBytes = signed({ schema: "SZ_EXTENSION_PACKAGE_V1", productId: "ai-automation", version: "1.9.73", updaterProtocol: 1, files: entries }, { files: { "manifest.json": manifest.toString("base64"), [filePath]: actualBytes.toString("base64"), ...extraFiles } });
  const channel = { schema: "SZ_EXTENSION_CHANNEL_V1", productId: "ai-automation", version: "1.9.73", packageUrl: "https://shaozhuangai.com/api/tools/updates/ai-automation/package/1.9.73", packageSha256: hash(packageBytes), packageSize: packageBytes.length, releasedAt: "2026-09-08T00:00:00.000Z", releaseNotes: ["Test only"] };
  return { packageBytes, latestBytes: signed(channel), channel };
}
const verifyFixture = ({ latestBytes, packageBytes }) => verifyRelease(latestBytes, packageBytes, publicKey, "ai-automation", "1.9.73");

test("accepts a valid Ed25519 channel and complete package", () => { assert.equal(verifyFixture(fixture()).fileCount, 2); });
test("rejects a tampered channel payload even if its envelope is well formed", () => {
  const data = fixture();
  const parsed = JSON.parse(data.latestBytes);
  parsed.payloadB64 = Buffer.from(JSON.stringify({ ...data.channel, version: "1.9.74" })).toString("base64");
  data.latestBytes = Buffer.from(JSON.stringify(parsed));
  assert.throws(() => verifyFixture(data), /signature mismatch/);
});
test("rejects package byte/hash mismatch against the signed channel", () => {
  const data = fixture();
  data.packageBytes = Buffer.concat([data.packageBytes, Buffer.from("\n")]);
  assert.throws(() => verifyFixture(data), /package size differs/);
});
test("rejects altered file contents even when the channel hashes the altered envelope", () => {
  assert.throws(() => verifyFixture(fixture({ actualBytes: Buffer.from("export const evil = true;") })), /hash mismatch|size mismatch/);
});
test("rejects unsigned extra files", () => {
  assert.throws(() => verifyFixture(fixture({ extraFiles: { "extra.js": "YWJj" } })), /unsigned extra files/);
});
test("rejects traversal and private/development file paths before writing", () => {
  for (const filePath of ["../app.js", "/app.js", "a//b.js", "a\\b.js", "a/./b.js", ".env", ".git/config", "node_modules/a.js"]) {
    assert.throws(() => verifyFixture(fixture({ filePath })), /unsafe|private file/);
  }
});
test("rejects a root manifest from a different version", () => {
  assert.throws(() => verifyFixture(fixture({ manifestVersion: "1.9.60" })), /manifest\/package version mismatch/);
});
test("rejects cross-product or off-site update links", () => {
  const data = fixture();
  for (const packageUrl of ["https://example.com/package/1.9.73", "https://shaozhuangai.com/api/tools/updates/dmp-collector/package/1.9.73"]) {
    assert.throws(() => verifyFixture({ ...data, latestBytes: signed({ ...data.channel, packageUrl }) }));
  }
});

function migrationFixture() {
  const identity = { manifest_version: 3, name: "AI", description: "Original feature description", permissions: ["storage"], key: "same-extension-id" };
  const reference = { manifest: { ...structuredClone(identity), version: "1.9.61" }, files: {
    "manifest.json": { sha256: "reference-manifest" },
    "self-update/inventory.json": { sha256: "reference-inventory" },
    "content.js": { sha256: "reference-content" }
  } };
  const bootstrap = { manifest: { ...structuredClone(identity), version: "1.9.60.1", version_name: "1.9.60.1 原目录过渡版" }, files: {
    ...reference.files, "manifest.json": { sha256: "bootstrap-manifest" },
    "self-update/inventory.json": { sha256: "bootstrap-inventory" }
  } };
  const official = { manifest: { ...structuredClone(identity), description: "New detail extraction feature", version: "1.9.63", version_name: "1.9.63 官网更新版" }, files: {
    "manifest.json": { sha256: "latest-manifest" },
    "self-update/inventory.json": { sha256: "latest-inventory" },
    "content.js": { sha256: "latest-content" }, "detail-boundaries.js": { sha256: "new-file" }
  } };
  return { bootstrap, reference, official };
}

test("preserves the original migration ZIP while allowing a later functional release", () => {
  const { bootstrap, reference, official } = migrationFixture();
  assert.deepEqual(verifyBootstrapCompatibility(bootstrap, official, reference), { legacyAutoUpdateCompatible: true });
});

test("rejects a rewritten migration functional file even when current files have changed", () => {
  const { bootstrap, reference, official } = migrationFixture();
  bootstrap.files["content.js"] = { sha256: "latest-content" };
  assert.throws(() => verifyBootstrapCompatibility(bootstrap, official, reference), /changes functional files/);
});

test("rejects a latest release that changes the original extension identity or capabilities", () => {
  for (const change of [{ key: "different-id" }, { permissions: ["storage", "debugger"] }]) {
    const { bootstrap, reference, official } = migrationFixture();
    Object.assign(official.manifest, change);
    assert.throws(() => verifyBootstrapCompatibility(bootstrap, official, reference), /changes extension identity or capabilities/);
  }
});

test("rejects missing migration files against the original signed release", () => {
  const { bootstrap, reference, official } = migrationFixture();
  delete bootstrap.files["content.js"];
  assert.throws(() => verifyBootstrapCompatibility(bootstrap, official, reference), /file inventory differs/);
});

// Derive the realistic manifest from the retained historical package. Its signed
// bytes and corresponding ZIP are independently checked by verifyWebsiteUpdates.
// No developer-machine paths or new R39 assets are needed for these unit tests.
function r39MigrationFixture() {
  const fixture = migrationFixture();
  const historical = JSON.parse(readFileSync(new URL("../private-assets/extension-updates/ai-automation/1.9.61.json", import.meta.url)));
  fixture.reference.manifest = JSON.parse(Buffer.from(historical.files["manifest.json"], "base64"));
  fixture.bootstrap.manifest = { ...structuredClone(fixture.reference.manifest), version: "1.9.60.1", version_name: "1.9.60.1 原目录过渡版" };
  fixture.official.manifest = {
    ...structuredClone(fixture.reference.manifest),
    version: "1.9.72",
    version_name: "1.9.72 TEST 本机历史连接修复 R39",
    description: "支持淘宝、天猫和1688详情提取，按平台详情标题开始、价格说明之前停止；保留主图、SKU、风格焕新和官网原目录更新功能。",
    permissions: [...fixture.reference.manifest.permissions, "nativeMessaging"],
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'" }
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(fixture.official.manifest, null, 2)}\n`);
  fixture.official.files["manifest.json"] = { size: manifestBytes.length, sha256: hash(manifestBytes) };
  for (let index = Object.keys(fixture.official.files).length; index < 106; index++) {
    fixture.official.files[`reviewed-file-${index}.js`] = { size: 0, sha256: hash(Buffer.alloc(0)) };
  }
  return fixture;
}
const verifyR39Fixture = ({ bootstrap, official, reference }) => verifyBootstrapCompatibility(bootstrap, official, reference, AI_R39_MANIFEST_POLICY);

test("accepts only the explicit R39 policy and reports legacy auto-update incompatibility", () => {
  assert.deepEqual(verifyR39Fixture(r39MigrationFixture()), {
    legacyAutoUpdateCompatible: false,
    manifestPublicationPolicy: AI_R39_MANIFEST_POLICY
  });
});

test("default compatibility remains strict for R39 and unknown policies are refused", () => {
  const { bootstrap, official, reference } = r39MigrationFixture();
  assert.throws(() => verifyBootstrapCompatibility(bootstrap, official, reference), /changes extension identity or capabilities/);
  for (const policy of ["allow-new-permissions", {}, true, "AI_AUTOMATION_1_9_71_TEST_R37", "AI_AUTOMATION_1_9_72_TEST_R38"]) {
    assert.throws(() => verifyBootstrapCompatibility(bootstrap, official, reference, policy), /unknown manifest publication policy/);
  }
});

test("R39 policy cannot authorize other release, reference, or migration versions", () => {
  for (const [release, version] of [["official", "1.9.71"], ["official", "1.9.73"], ["reference", "1.9.62"], ["bootstrap", "1.9.60.2"]]) {
    const data = r39MigrationFixture();
    data[release].manifest.version = version;
    assert.throws(() => verifyR39Fixture(data), /R39 policy/);
  }
});

test("R39 policy preserves the exact TEST title and frozen description", () => {
  for (const change of [{ version_name: "1.9.72 官网正式版" }, { description: "Rewritten description" }]) {
    const data = r39MigrationFixture();
    Object.assign(data.official.manifest, change);
    assert.throws(() => verifyR39Fixture(data), /reviewed capability changes/);
  }
});

test("R39 policy rejects added, missing, or reordered permissions", () => {
  for (const mutate of [
    (manifest) => manifest.permissions.push("tabs"),
    (manifest) => manifest.permissions.pop(),
    (manifest) => manifest.permissions.reverse(),
    (manifest) => manifest.optional_permissions.push("tabs"),
    (manifest) => manifest.host_permissions.push("https://example.com/*"),
    (manifest) => manifest.optional_host_permissions.push("file:///*")
  ]) {
    const data = r39MigrationFixture();
    mutate(data.official.manifest);
    assert.throws(() => verifyR39Fixture(data), /reviewed capability changes/);
  }
});

test("R39 policy rejects any CSP value beyond the reviewed exact value", () => {
  for (const csp of [undefined, { extension_pages: "script-src 'self' 'unsafe-eval'; object-src 'self'" },
    { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'", sandbox: "allow-scripts" }]) {
    const data = r39MigrationFixture();
    if (csp) data.official.manifest.content_security_policy = csp;
    else delete data.official.manifest.content_security_policy;
    assert.throws(() => verifyR39Fixture(data), /reviewed capability changes/);
  }
});

test("R39 policy rejects changed identity, routes, or previously absent manifest fields", () => {
  for (const mutate of [
    (manifest) => { manifest.key = "new-extension-id"; },
    (manifest) => { manifest.name = "Different extension"; },
    (manifest) => { manifest.background.service_worker = "replacement-worker.js"; },
    (manifest) => { manifest.action.default_popup = "replacement-popup.html"; },
    (manifest) => manifest.content_scripts[0].matches.push("https://example.com/*"),
    (manifest) => manifest.content_scripts[0].js.push("extra-script.js"),
    (manifest) => { manifest.web_accessible_resources = [{ resources: ["*"], matches: ["<all_urls>"] }]; },
    (manifest) => { manifest.update_url = "https://example.com/updates"; }
  ]) {
    const data = r39MigrationFixture();
    mutate(data.official.manifest);
    assert.throws(() => verifyR39Fixture(data), /reviewed capability changes/);
  }
});

test("R39 pinned manifest prevents a jointly altered reference, bootstrap, and release", () => {
  const data = r39MigrationFixture();
  for (const release of [data.reference, data.bootstrap, data.official]) release.manifest.key = "jointly-altered-id";
  assert.throws(() => verifyR39Fixture(data), /differs from the reviewed frozen manifest/);
});

test("R39 policy rejects rewritten manifest bytes and incorrect file counts", () => {
  for (const mutate of [
    (official) => { official.files["manifest.json"].sha256 = hash(Buffer.from("rewritten manifest")); },
    (official) => { official.files["manifest.json"].size++; },
    (official) => { delete official.files["reviewed-file-105.js"]; },
    (official) => { official.files["extra.js"] = { size: 0, sha256: hash(Buffer.alloc(0)) }; }
  ]) {
    const data = r39MigrationFixture();
    mutate(data.official);
    assert.throws(() => verifyR39Fixture(data), /manifest bytes differ|exactly 106 files/);
  }
});

test("R39 policy still rejects any bootstrap capability or functional-file change", () => {
  for (const mutate of [
    (bootstrap) => bootstrap.manifest.permissions.push("nativeMessaging"),
    (bootstrap) => { bootstrap.manifest.description = "Rewritten bootstrap"; },
    (bootstrap) => { bootstrap.files["content.js"] = { sha256: "altered-content" }; },
    (bootstrap) => { bootstrap.files["content.js"] = { ...bootstrap.files["content.js"], size: 99 }; },
    (bootstrap) => { delete bootstrap.files["content.js"]; },
    (bootstrap) => { bootstrap.files["new.js"] = { sha256: "extra-file" }; }
  ]) {
    const data = r39MigrationFixture();
    mutate(data.bootstrap);
    assert.throws(() => verifyR39Fixture(data), /changes extension identity or capabilities|changes functional|file inventory differs/);
  }
});

test("DMP compatibility retains the default exact-capability policy", () => {
  const data = migrationFixture();
  data.bootstrap.manifest.version = "2.3.60.1";
  data.reference.manifest.version = "2.3.61";
  data.official.manifest.version = "2.3.61";
  assert.deepEqual(verifyBootstrapCompatibility(data.bootstrap, data.official, data.reference), { legacyAutoUpdateCompatible: true });
  data.official.manifest.permissions.push("nativeMessaging");
  assert.throws(() => verifyBootstrapCompatibility(data.bootstrap, data.official, data.reference), /changes extension identity or capabilities/);
  assert.throws(() => verifyBootstrapCompatibility(data.bootstrap, data.official, data.reference, AI_R39_MANIFEST_POLICY), /R39 policy/);
});

function r42MigrationFixture() {
  const fixture = r39MigrationFixture();
  fixture.official.manifest.version = "1.9.73";
  fixture.official.manifest.version_name = "1.9.73 TEST 更新修复与随包安装 R42";
  const bytes = Buffer.from(`${JSON.stringify(fixture.official.manifest, null, 2)}\n`);
  fixture.official.files["manifest.json"] = { size: bytes.length, sha256: hash(bytes) };
  return fixture;
}
const verifyR42Fixture = ({ bootstrap, official, reference }) => verifyBootstrapCompatibility(bootstrap, official, reference, AI_R42_MANIFEST_POLICY);

test("R42 accepts the exact frozen 1.9.73 manifest while retaining the historical R39 policy", () => {
  assert.deepEqual(verifyR42Fixture(r42MigrationFixture()), { legacyAutoUpdateCompatible: false, manifestPublicationPolicy: AI_R42_MANIFEST_POLICY });
  assert.deepEqual(verifyR39Fixture(r39MigrationFixture()), { legacyAutoUpdateCompatible: false, manifestPublicationPolicy: AI_R39_MANIFEST_POLICY });
});

test("R42 does not authorize historical, future, migration, or cross-policy releases", () => {
  for (const [release, version] of [["official", "1.9.72"], ["official", "1.9.74"], ["reference", "1.9.62"], ["bootstrap", "1.9.60.2"]]) {
    const data = r42MigrationFixture();
    data[release].manifest.version = version;
    assert.throws(() => verifyR42Fixture(data), /R42 policy/);
  }
  assert.throws(() => verifyR39Fixture(r42MigrationFixture()), /R39 policy/);
  const { bootstrap, official, reference } = r42MigrationFixture();
  assert.throws(() => verifyBootstrapCompatibility(bootstrap, official, reference), /changes extension identity or capabilities/);
  assert.throws(() => verifyBootstrapCompatibility(bootstrap, official, reference, "AI_AUTOMATION_1_9_75_UNREVIEWED"), /unknown manifest publication policy/);
});

test("R42 permits no additional capabilities, identity, routes, or title changes", () => {
  for (const mutate of [
    (manifest) => { manifest.version_name = "1.9.73 官网正式版"; },
    (manifest) => { manifest.description = "changed"; },
    (manifest) => { manifest.key = "different-id"; },
    (manifest) => manifest.permissions.push("debugger"),
    (manifest) => manifest.optional_permissions.push("tabs"),
    (manifest) => manifest.host_permissions.push("https://example.com/*"),
    (manifest) => { manifest.content_security_policy.extension_pages += "; connect-src *"; },
    (manifest) => { manifest.background.service_worker = "replacement.js"; },
    (manifest) => { manifest.update_url = "https://example.com/updates"; }
  ]) {
    const data = r42MigrationFixture(); mutate(data.official.manifest);
    assert.throws(() => verifyR42Fixture(data), /reviewed capability changes/);
  }
});

test("R42 pins raw manifest bytes, exact file count, and jointly altered identity", () => {
  for (const mutate of [
    (data) => { data.official.files["manifest.json"].sha256 = "0".repeat(64); },
    (data) => { data.official.files["manifest.json"].size++; },
    (data) => { delete data.official.files["reviewed-file-105.js"]; },
    (data) => { for (const release of [data.bootstrap, data.reference, data.official]) release.manifest.key = "jointly-changed"; }
  ]) {
    const data = r42MigrationFixture(); mutate(data);
    assert.throws(() => verifyR42Fixture(data), /manifest bytes differ|exactly 106 files|differs from the reviewed frozen manifest/);
  }
});

test("R42 never exempts bootstrap functional files or authorizes DMP", () => {
  const changed = r42MigrationFixture(); changed.bootstrap.files["content.js"] = { sha256: "changed" };
  assert.throws(() => verifyR42Fixture(changed), /changes functional files/);
  const dmp = migrationFixture(); dmp.bootstrap.manifest.version = "2.3.60.1";
  assert.throws(() => verifyR42Fixture(dmp), /R42 policy/);
});

function r43MigrationFixture() {
  const data = r42MigrationFixture();
  data.official.manifest.version = "1.9.74";
  data.official.manifest.version_name = "1.9.74 TEST 按模型适配引导重生 R43";
  const bytes = Buffer.from(`${JSON.stringify(data.official.manifest, null, 2)}\n`);
  data.official.files["manifest.json"] = { size: bytes.length, sha256: hash(bytes) };
  data.official.files["labs/image-prompt-lab/guide-model-profile.js"] = {"size": 4329, "sha256": "3d436fed40e258e8c3f7912002c29add3b1f0462ecf585a3893962ee4cbcb484"};
  return data;
}
const verifyR43Fixture = ({ bootstrap, official, reference }) => verifyBootstrapCompatibility(bootstrap, official, reference, AI_R43_MANIFEST_POLICY);
test("R43 accepts the 107-file model-aware release and preserves R42", () => {
  assert.deepEqual(verifyR43Fixture(r43MigrationFixture()), { legacyAutoUpdateCompatible: false, manifestPublicationPolicy: AI_R43_MANIFEST_POLICY });
  assert.deepEqual(verifyR42Fixture(r42MigrationFixture()), { legacyAutoUpdateCompatible: false, manifestPublicationPolicy: AI_R42_MANIFEST_POLICY });
});
test("R43 rejects a missing, renamed, or modified guide model module", () => {
  for (const mutate of [
    d => { delete d.official.files["labs/image-prompt-lab/guide-model-profile.js"]; },
    d => { d.official.files["other.js"] = d.official.files["labs/image-prompt-lab/guide-model-profile.js"]; delete d.official.files["labs/image-prompt-lab/guide-model-profile.js"]; },
    d => { d.official.files["labs/image-prompt-lab/guide-model-profile.js"].sha256 = "0".repeat(64); },
    d => { d.official.files["labs/image-prompt-lab/guide-model-profile.js"].size++; },
  ]) { const data = r43MigrationFixture(); mutate(data); assert.throws(() => verifyR43Fixture(data), /exactly 107 files|required guide module differs/); }
});
test("R43 rejects added permissions, cross-policy versions, and bootstrap changes", () => {
  const changed = r43MigrationFixture(); changed.official.manifest.permissions.push("debugger");
  assert.throws(() => verifyR43Fixture(changed), /reviewed capability changes/);
  assert.throws(() => verifyR43Fixture(r42MigrationFixture()), /R43 policy/);
  assert.throws(() => verifyR42Fixture(r43MigrationFixture()), /R42 policy/);
  const bootstrap = r43MigrationFixture(); bootstrap.bootstrap.files["content.js"] = { sha256: "changed" };
  assert.throws(() => verifyR43Fixture(bootstrap), /changes functional files/);
});
