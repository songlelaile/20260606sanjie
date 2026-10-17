#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const VERSION = /^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){2,3}$/;
const HASH = /^[a-f0-9]{64}$/;
const PRODUCTS = { "ai-automation": "1.9.84", "dmp-collector": "2.3.61" };
const ZIP_PATHS = {
  "ai-automation": "public/downloads/sycm-keyword-collector-v1.9.84.zip",
  "dmp-collector": "private-assets/dmp/shaozhuang-dmp-unified-automation-v2.3.61.zip"
};
const BOOTSTRAP_VERSIONS = { "ai-automation": "1.9.60.1", "dmp-collector": "2.3.60.1" };
const OFFICIAL_VERSION_NAMES = { "ai-automation": "1.9.84 引导重生按模型选择方案", "dmp-collector": "2.3.61 官网更新版" };
const BOOTSTRAP_REFERENCE = {
  "ai-automation": {
    version: "1.9.61",
    zipPath: "public/downloads/sycm-keyword-collector-v1.9.61.zip",
    packagePath: "private-assets/extension-updates/ai-automation/1.9.61.json"
  }
};
const RETAINED_AI_VERSIONS = ["1.9.61", "1.9.62", "1.9.63", "1.9.71", "1.9.72", "1.9.73", "1.9.74", "1.9.80", "1.9.83"];
const AI_FULL_PACKAGE_PATH = "public/downloads/shaozhuang-ai-v1.9.84-macos-full.zip";
const RETAINED_AI_FULL_PACKAGE_PATHS = ["public/downloads/shaozhuang-ai-v1.9.73-macos-full.zip", "public/downloads/shaozhuang-ai-v1.9.74-macos-full.zip", "public/downloads/shaozhuang-ai-v1.9.80-macos-full.zip", "public/downloads/shaozhuang-ai-v1.9.83-macos-full.zip"];
const RETAINED_AI_PACKAGE_ONLY_VERSIONS = ["1.9.67", "1.9.68", "1.9.69", "1.9.70"];

// This is a publication exception for one reviewed TEST artifact, not permission
// for the legacy updater to install changed capabilities. Keep future releases strict.
export const AI_R39_MANIFEST_POLICY = "AI_AUTOMATION_1_9_72_TEST_R39";
const AI_R39_MANIFEST_SHA256 = "60b07cfb9e8cf48bea37b9a29a6f98ecde022c6c6c5a91c5666f5ea8c39a44d1";
const AI_R37_MANIFEST_SHA256 = "0582cd970511313097d51b763c1b7d43f703ee6b7955418046400986b0fda128";
const AI_R39_DESCRIPTION = "支持淘宝、天猫和1688详情提取，按平台详情标题开始、价格说明之前停止；保留主图、SKU、风格焕新和官网原目录更新功能。";
const AI_R39_CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'";
export const AI_R42_MANIFEST_POLICY = "AI_AUTOMATION_1_9_73_TEST_R42";
export const AI_R43_MANIFEST_POLICY = "AI_AUTOMATION_1_9_74_TEST_R43";
export const AI_R51_MANIFEST_POLICY = "AI_AUTOMATION_1_9_80_TEST_R51";
export const AI_R53_MANIFEST_POLICY = "AI_AUTOMATION_1_9_83_R53";
export const AI_R56_MANIFEST_POLICY = "AI_AUTOMATION_1_9_84_R56";
const AI_GZIP_PACKAGE_PATH = "private-assets/extension-updates/ai-automation/1.9.84.json.gz";
const RETAINED_AI_GZIP_PACKAGE_PATHS = ["private-assets/extension-updates/ai-automation/1.9.83.json.gz"];
const AI_MANIFEST_RELEASES = new Map([
  [AI_R56_MANIFEST_POLICY, {"label": "R56", "version": "1.9.84", "versionName": "1.9.84 引导重生按模型选择方案", "bytes": 5420, "sha256": "cd63a1d09c8646a2373f19f3e29a7050916f558b5b11b3695cf9f994d988774a", "fileCount": 118, "description": "关键词、市场排行和链接清单保留在插件；主图、详情、SKU、裂变、服装、买家秀与种草、产品精修和视频统一进入官网对应模块。", "requiredFiles": [{"path": "labs/image-prompt-lab/guide-model-profile.js", "size": 9386, "sha256": "7040759b204a896efd07cee8d0edb26a720b794cf041a9e14e122deab5fd9b17"}, {"path": "labs/image-prompt-lab/promptlab.js", "size": 1288869, "sha256": "7ec19f1b3795f51b6144a4c26fe29e518780fbcb8073e52acafcf47703cd5323"}, {"path": "labs/image-prompt-lab/background.js", "size": 951187, "sha256": "cc76f4f7ef6498873fcb1789642a73ef1f5ca9db4e2c2614939030fd4c2da034"}, {"path": "src/official-navigation.js", "size": 5448, "sha256": "fe9e19c17c31675898d2f12d95f4c7e450100d97d0401cfdf0adf51a5c4c5af6"}], "parent": {"label": "R53", "version": "1.9.83", "versionName": "1.9.83 官网模块统一导航", "sha256": "77959cd65b6cde20a7dfe0d48df9af2ed2985360c240fb8641d12872ae865e74"}}],
  [AI_R53_MANIFEST_POLICY, { label: "R53", version: "1.9.83", versionName: "1.9.83 官网模块统一导航", bytes: 5411,
    sha256: "77959cd65b6cde20a7dfe0d48df9af2ed2985360c240fb8641d12872ae865e74", fileCount: 118,
    description: "关键词、市场排行和链接清单保留在插件；主图、详情、SKU、裂变、服装、买家秀与种草、产品精修和视频统一进入官网对应模块。",
    requiredFile: { path: "src/official-navigation.js", size: 5448, sha256: "fe9e19c17c31675898d2f12d95f4c7e450100d97d0401cfdf0adf51a5c4c5af6" },
    parent: { label: "R51", version: "1.9.80", versionName: "1.9.80 TEST R51 租户素材送审与绑定保留", sha256: "f106d4dfec5c3d3d6023433d7e9b5aa134cd3347b025f43edd4c0f39f9d3abcf", description: AI_R39_DESCRIPTION } }],
  [AI_R51_MANIFEST_POLICY, {"label": "R51", "version": "1.9.80", "versionName": "1.9.80 TEST R51 租户素材送审与绑定保留", "bytes": 5421, "sha256": "f106d4dfec5c3d3d6023433d7e9b5aa134cd3347b025f43edd4c0f39f9d3abcf", "fileCount": 114, "requiredFile": {"path": "src/video-asset-bridge.js", "size": 7397, "sha256": "38e558e66667b9747fe662aa5e41183e679daac090e9e8a4b7a79a2ec780e87d"}, "parent": {"label": "R43", "version": "1.9.74", "versionName": "1.9.74 TEST 按模型适配引导重生 R43", "sha256": "8c16ca4b095fca26de101a67b068b5e5efd7ff20b63de83e683d3f795d47c90b"}}],
  [AI_R43_MANIFEST_POLICY, { label: "R43", version: "1.9.74", versionName: "1.9.74 TEST 按模型适配引导重生 R43", bytes: 5415, sha256: "8c16ca4b095fca26de101a67b068b5e5efd7ff20b63de83e683d3f795d47c90b", fileCount: 107,
    requiredFile: { path: "labs/image-prompt-lab/guide-model-profile.js", size: 4329, sha256: "3d436fed40e258e8c3f7912002c29add3b1f0462ecf585a3893962ee4cbcb484" },
    parent: { label: "R42", version: "1.9.73", versionName: "1.9.73 TEST 更新修复与随包安装 R42", sha256: "43c16799200d5fff59b57a5bac0a727684bacca755a658dd6da5900f2c0f2d89" } }],
  [AI_R39_MANIFEST_POLICY, { label: "R39", version: "1.9.72", versionName: "1.9.72 TEST 本机历史连接修复 R39", bytes: 5412, sha256: AI_R39_MANIFEST_SHA256,
    parent: { label: "R37", version: "1.9.71", versionName: "1.9.71 TEST 详情逐屏摘取 R37", sha256: AI_R37_MANIFEST_SHA256 } }],
  [AI_R42_MANIFEST_POLICY, { label: "R42", version: "1.9.73", versionName: "1.9.73 TEST 更新修复与随包安装 R42", bytes: 5415, sha256: "43c16799200d5fff59b57a5bac0a727684bacca755a658dd6da5900f2c0f2d89",
    parent: { label: "R39", version: "1.9.72", versionName: "1.9.72 TEST 本机历史连接修复 R39", sha256: AI_R39_MANIFEST_SHA256 } }]
]);

function base64(value, label) {
  assert.equal(typeof value, "string", `${label} must be base64`);
  const decoded = Buffer.from(value, "base64");
  assert.equal(decoded.toString("base64"), value, `${label} must be canonical base64`);
  return decoded;
}

export function verifyEnvelope(bytes, publicKey) {
  const envelope = JSON.parse(bytes.toString("utf8"));
  const payloadBytes = base64(envelope.payloadB64, "payloadB64");
  const signature = base64(envelope.signatureB64, "signatureB64");
  assert.equal(signature.length, 64, "Ed25519 signature must be 64 bytes");
  assert.ok(verify(null, payloadBytes, publicKey, signature), "Ed25519 signature mismatch");
  return { envelope, payload: JSON.parse(payloadBytes.toString("utf8")) };
}

function safePath(filePath) {
  assert.equal(typeof filePath, "string", "file path must be a string");
  assert.ok(filePath.length > 0 && filePath.length <= 512, "invalid path length");
  assert.ok(!/[\\:\u0000-\u001f]/u.test(filePath), "unsafe file path");
  assert.ok(filePath.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "unsafe path component");
  assert.ok(!/(?:^|\/)(?:\.git|\.env(?:\.[^/]*)?|node_modules)(?:\/|$)/iu.test(filePath), "development/private file in update package");
}

export function verifyRelease(latestBytes, packageBytes, publicKey, productId, version) {
  assert.ok(PRODUCTS[productId] && VERSION.test(version), "unsupported product/version");
  const channel = verifyEnvelope(latestBytes, publicKey).payload;
  assert.equal(channel.schema, "SZ_EXTENSION_CHANNEL_V1");
  assert.equal(channel.productId, productId);
  assert.equal(channel.version, version);
  assert.equal(channel.packageUrl, `https://shaozhuangai.com/api/tools/updates/${productId}/package/${version}`);
  assert.equal(channel.packageSize, packageBytes.length, "package size differs from signed channel");
  assert.equal(channel.packageSha256, sha256(packageBytes), "package hash differs from signed channel");
  assert.ok(Number.isFinite(Date.parse(channel.releasedAt)), "invalid release timestamp");
  assert.ok(typeof channel.releaseNotes === "string" || Array.isArray(channel.releaseNotes), "missing release notes");

  return verifyPackage(packageBytes, publicKey, productId, version);
}

function verifyPackage(packageBytes, publicKey, productId, version) {
  const { envelope, payload } = verifyEnvelope(packageBytes, publicKey);
  assert.equal(payload.schema, "SZ_EXTENSION_PACKAGE_V1");
  assert.equal(payload.productId, productId);
  assert.equal(payload.version, version);
  assert.equal(payload.updaterProtocol, 1);
  assert.ok(Array.isArray(payload.files) && payload.files.length > 0 && payload.files.length <= 10000, "invalid file inventory");
  assert.ok(envelope.files && !Array.isArray(envelope.files) && typeof envelope.files === "object", "missing file contents");
  const paths = new Set();
  let totalBytes = 0;
  let manifest;
  for (const file of payload.files) {
    safePath(file.path);
    assert.ok(!paths.has(file.path), `duplicate path: ${file.path}`);
    paths.add(file.path);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0, `invalid size: ${file.path}`);
    assert.ok(HASH.test(file.sha256), `invalid hash: ${file.path}`);
    assert.ok(Object.hasOwn(envelope.files, file.path), `missing file: ${file.path}`);
    const bytes = base64(envelope.files[file.path], file.path);
    assert.equal(bytes.length, file.size, `size mismatch: ${file.path}`);
    assert.equal(sha256(bytes), file.sha256, `hash mismatch: ${file.path}`);
    totalBytes += bytes.length;
    assert.ok(totalBytes <= 128 * 1024 * 1024, "unpacked update exceeds 128 MiB");
    if (file.path === "manifest.json") manifest = JSON.parse(bytes.toString("utf8"));
  }
  assert.deepEqual(Object.keys(envelope.files).sort(), [...paths].sort(), "unsigned extra files present");
  assert.ok(manifest, "missing root manifest.json");
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, version, "manifest/package version mismatch");
  return { productId, version, fileCount: paths.size, unpackedBytes: totalBytes, packageBytes: packageBytes.length, packageSha256: sha256(packageBytes) };
}

export function verifyWebsiteUpdates(root, publicKeyPath) {
  const keyBytes = readFileSync(publicKeyPath);
  const receipt = JSON.parse(readFileSync(path.join(root, "frozen", "extension-updates-v1.json"), "utf8"));
  assert.equal(sha256(keyBytes), receipt.publicKeyJwkSha256, "public key differs from frozen release receipt");
  assert.deepEqual(receipt.products, Object.entries(PRODUCTS).map(([productId, version]) => ({
    productId, version, bootstrapVersion: BOOTSTRAP_VERSIONS[productId],
    ...(BOOTSTRAP_REFERENCE[productId] ? { bootstrapReferenceVersion: BOOTSTRAP_REFERENCE[productId].version } : {})
  })), "release receipt product versions differ");
  const expectedPaths = [...Object.entries(PRODUCTS).flatMap(([productId, version]) => [
    ZIP_PATHS[productId], ...["latest.json", `${version}.json`, "bootstrap.zip"].map((file) => `private-assets/extension-updates/${productId}/${file}`)
  ]), ...RETAINED_AI_VERSIONS.flatMap((version) => [
    `public/downloads/sycm-keyword-collector-v${version}.zip`,
    `private-assets/extension-updates/ai-automation/${version}.json`
  ]), ...RETAINED_AI_PACKAGE_ONLY_VERSIONS.map((version) =>
    `private-assets/extension-updates/ai-automation/${version}.json`
  ), AI_FULL_PACKAGE_PATH, AI_GZIP_PACKAGE_PATH, ...RETAINED_AI_FULL_PACKAGE_PATHS, ...RETAINED_AI_GZIP_PACKAGE_PATHS].sort();
  assert.deepEqual(receipt.artifacts.map((file) => file.path).sort(), expectedPaths, "release receipt artifact inventory differs");
  for (const artifact of receipt.artifacts) {
    const bytes = readFileSync(path.join(root, artifact.path));
    assert.equal(bytes.length, artifact.size, `frozen artifact size mismatch: ${artifact.path}`);
    assert.equal(sha256(bytes), artifact.sha256, `frozen artifact hash mismatch: ${artifact.path}`);
  }
  assert.deepEqual(gunzipSync(readFileSync(path.join(root, AI_GZIP_PACKAGE_PATH))),
    readFileSync(path.join(root, "private-assets/extension-updates/ai-automation/1.9.84.json")), "current compressed package differs from signed package");
  for (const compressedPath of RETAINED_AI_GZIP_PACKAGE_PATHS) {
    assert.deepEqual(gunzipSync(readFileSync(path.join(root, compressedPath))),
      readFileSync(path.join(root, compressedPath.slice(0, -3))), "retained compressed package differs from signed package");
  }
  const jwk = JSON.parse(keyBytes.toString("utf8"));
  assert.equal(jwk.kty, "OKP");
  assert.equal(jwk.crv, "Ed25519");
  assert.ok(!Object.hasOwn(jwk, "d"), "only a public signing key belongs in the website release");
  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  // Historical envelopes remain valid recovery artifacts, not alternate latest
  // channels. JSON-only TEST history does not imply a corresponding public ZIP.
  for (const version of [...RETAINED_AI_VERSIONS, ...RETAINED_AI_PACKAGE_ONLY_VERSIONS]) {
    const bytes = readFileSync(path.join(root, "private-assets", "extension-updates", "ai-automation", `${version}.json`));
    verifyPackage(bytes, publicKey, "ai-automation", version);
    if (RETAINED_AI_VERSIONS.includes(version)) {
      const expectedFiles = Object.fromEntries(verifyEnvelope(bytes, publicKey).payload.files.map((file) => [file.path, { size: file.size, sha256: file.sha256 }]));
      assert.deepEqual(zipInventory(path.join(root, `public/downloads/sycm-keyword-collector-v${version}.zip`)).files,
        expectedFiles, `historical AI ${version} ZIP differs from signed package`);
    }
  }
  return Object.entries(PRODUCTS).map(([productId, version]) => {
    const directory = path.join(root, "private-assets", "extension-updates", productId);
    const packageBytes = readFileSync(path.join(directory, `${version}.json`));
    const result = verifyRelease(readFileSync(path.join(directory, "latest.json")), packageBytes, publicKey, productId, version);
    const expectedFiles = Object.fromEntries(verifyEnvelope(packageBytes, publicKey).payload.files.map((file) => [file.path, { size: file.size, sha256: file.sha256 }]));
    const official = zipInventory(path.join(root, ZIP_PATHS[productId]));
    assert.deepEqual(official.files, expectedFiles, `${productId} official ZIP differs from signed package`);
    const bootstrap = zipInventory(path.join(directory, "bootstrap.zip"));
    assert.equal(bootstrap.manifest.version, BOOTSTRAP_VERSIONS[productId], "wrong migration ZIP version");
    assert.equal(bootstrap.manifest.version_name, `${BOOTSTRAP_VERSIONS[productId]} 原目录过渡版`, "migration ZIP display title must be explicit");
    if (Object.hasOwn(official.manifest, "version_name")) {
      assert.equal(official.manifest.version_name, OFFICIAL_VERSION_NAMES[productId], "official ZIP display version differs");
    }
    const historical = BOOTSTRAP_REFERENCE[productId];
    let bootstrapReference = official;
    if (historical) {
      const { payload } = verifyEnvelope(readFileSync(path.join(root, historical.packagePath)), publicKey);
      assert.equal(payload.schema, "SZ_EXTENSION_PACKAGE_V1");
      assert.equal(payload.productId, productId);
      assert.equal(payload.version, historical.version);
      bootstrapReference = zipInventory(path.join(root, historical.zipPath));
      assert.equal(bootstrapReference.manifest.version, historical.version);
      assert.deepEqual(bootstrapReference.files, Object.fromEntries(payload.files.map((file) => [file.path, { size: file.size, sha256: file.sha256 }])), "historical official ZIP differs from signed package");
    }
    const compatibility = verifyBootstrapCompatibility(bootstrap, official, bootstrapReference,
      productId === "ai-automation" && version === "1.9.84" ? AI_R56_MANIFEST_POLICY : null);
    return { ...result, ...compatibility, officialZipMatchesSignedFiles: true, bootstrapVersion: bootstrap.manifest.version, bootstrapReferenceVersion: bootstrapReference.manifest.version };
  });
}

// A published migration ZIP is immutable. Functional updates may change current files,
// but the original bootstrap must still match its signed release and extension identity.
export function verifyBootstrapCompatibility(bootstrap, official, reference = official, policy = null) {
  const reviewed = AI_MANIFEST_RELEASES.get(policy);
  assert.ok(policy === null || reviewed, "unknown manifest publication policy");
  // Always verify the immutable bootstrap against its signed historical reference.
  // A publication policy must never exempt either its capabilities or its files.
  for (const [release, current] of [[reference, false], ...(!policy ? [[official, true]] : [])]) {
    const bootstrapIdentity = { ...bootstrap.manifest, version: release.manifest.version };
    delete bootstrapIdentity.version_name;
    const releaseIdentity = { ...release.manifest };
    delete releaseIdentity.version_name;
    if (current) {
      delete bootstrapIdentity.description;
      delete releaseIdentity.description;
    }
    assert.deepEqual(bootstrapIdentity, releaseIdentity, "migration ZIP changes extension identity or capabilities");
  }
  assert.deepEqual(Object.keys(bootstrap.files).sort(), Object.keys(reference.files).sort(), "migration ZIP file inventory differs");
  const changedPaths = Object.keys(reference.files).filter((file) => bootstrap.files[file].sha256 !== reference.files[file].sha256).sort();
  assert.deepEqual(changedPaths, ["manifest.json", "self-update/inventory.json"], "migration ZIP changes functional files");
  for (const file of Object.keys(reference.files).filter((file) => !changedPaths.includes(file))) {
    assert.deepEqual(bootstrap.files[file], reference.files[file], `migration ZIP changes functional file metadata: ${file}`);
  }
  if (!policy) return { legacyAutoUpdateCompatible: true };

  assert.equal(bootstrap.manifest.version, "1.9.60.1", `${reviewed.label} policy requires the original AI migration version`);
  assert.equal(reference.manifest.version, "1.9.61", `${reviewed.label} policy requires the signed AI 1.9.61 reference`);
  assert.equal(official.manifest.version, reviewed.version, `${reviewed.label} policy only permits AI ${reviewed.version}`);
  const expectedManifest = {
    ...reference.manifest,
    version: reviewed.version,
    version_name: reviewed.versionName,
    description: reviewed.description ?? AI_R39_DESCRIPTION,
    permissions: [...reference.manifest.permissions, "nativeMessaging"],
    content_security_policy: { extension_pages: AI_R39_CSP }
  };
  assert.deepEqual(official.manifest, expectedManifest, `${reviewed.label} manifest exceeds the reviewed capability changes`);
  // Pin every field, including absent keys and unchanged routes, to the reviewed
  // manifest. The raw inventory hash also forbids repacking rewritten JSON bytes.
  assert.equal(sha256(Buffer.from(`${JSON.stringify(official.manifest, null, 2)}\n`)), reviewed.sha256,
    `${reviewed.label} manifest differs from the reviewed frozen manifest`);
  assert.deepEqual(official.files["manifest.json"], { size: reviewed.bytes, sha256: reviewed.sha256 },
    `${reviewed.label} manifest bytes differ from the reviewed frozen manifest`);
  // Historical policies keep their original version-only capability pins. R53
  // also permits its exact reviewed navigation description; all capability fields stay frozen.
  const parentIdentity = { ...official.manifest, version: reviewed.parent.version, version_name: reviewed.parent.versionName,
    ...(reviewed.parent.description ? { description: reviewed.parent.description } : {}) };
  assert.equal(sha256(Buffer.from(`${JSON.stringify(parentIdentity, null, 2)}\n`)), reviewed.parent.sha256,
    `${reviewed.label} manifest changes frozen ${reviewed.parent.label} outside version fields`);
  const expectedFileCount = reviewed.fileCount ?? 106;
  assert.equal(Object.keys(official.files).length, expectedFileCount, `${reviewed.label} file inventory must contain exactly ${expectedFileCount} files`);
  if (reviewed.requiredFile) {
    const { path: filePath, ...metadata } = reviewed.requiredFile;
    assert.deepEqual(official.files[filePath], metadata, `${reviewed.label} required guide module differs`);
  }
  if (reviewed.requiredFiles) {
    for (const { path: filePath, ...metadata } of reviewed.requiredFiles) {
      assert.deepEqual(official.files[filePath], metadata, `${reviewed.label} required runtime module differs: ${filePath}`);
    }
  }
  return { legacyAutoUpdateCompatible: false, manifestPublicationPolicy: policy };
}

function zipInventory(zipPath) {
  const script = `import json,sys,zipfile,hashlib
with zipfile.ZipFile(sys.argv[1]) as z:
 names=[i.filename for i in z.infolist() if not i.is_dir()]
 assert len(names)==len(set(names)), 'duplicate ZIP path'
 assert z.testzip() is None, 'invalid ZIP checksum'
 files={n:{'size':len(z.read(n)),'sha256':hashlib.sha256(z.read(n)).hexdigest()} for n in names}
 print(json.dumps({'files':files,'manifest':json.loads(z.read('manifest.json'))}))`;
  return JSON.parse(execFileSync("python3", ["-c", script, zipPath], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const result = verifyWebsiteUpdates(root, path.join(root, "frozen", "extension-update-public-key.json"));
    process.stdout.write(`${JSON.stringify({ passed: true, products: result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Extension update release verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
