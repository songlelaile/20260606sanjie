import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfig } from "./check-scan-payment-config.mjs";

// Only tests generate ephemeral, synthetic key fixtures. The checker never does.
const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
const shortKey = generateKeyPairSync("rsa", { modulusLength: 1024 });
const ecKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = (key, privateKey = false, type = privateKey ? "pkcs8" : "spki") => key.export({ type, format: "pem" }).toString();
const fixture = {
  ALIPAY_APP_ID: "2026100200000123", ALIPAY_SELLER_ID: "2088000000000123",
  ALIPAY_PRIVATE_KEY: pem(merchant.privateKey, true), ALIPAY_PUBLIC_KEY: pem(platform.publicKey),
  WECHAT_PAY_APP_ID: "wx00112233445566ab", WECHAT_PAY_MCH_ID: "1900000123",
  WECHAT_PAY_SERIAL_NO: "1122334455667788AABBCCDDEEFF0011223344556",
  WECHAT_PAY_PUBLIC_KEY_ID: "PUB_KEY_ID_0123456789012345",
  WECHAT_PAY_API_V3_KEY: "synthetic-v3-fixture".padEnd(32, "0"),
  WECHAT_PAY_PRIVATE_KEY: pem(merchant.privateKey, true), WECHAT_PAY_PUBLIC_KEY: pem(platform.publicKey),
  SCAN_PAYMENT_NOTIFY_BASE_URL: "https://synthetic-payments.example"
};
assert.equal(Buffer.byteLength(fixture.WECHAT_PAY_API_V3_KEY), 32);
const find = (report, key) => [...report.shared, ...report.providers.flatMap(provider => provider.checks)].find(item => item.key === key);
const outputSafe = output => {
  for (const value of Object.values(fixture)) assert(!output.includes(value), "credential value escaped into report");
  assert(!output.includes("BEGIN "));
  assert(!output.includes(pem(merchant.privateKey, true).split("\n")[1]));
  assert(!output.includes(pem(platform.publicKey).split("\n")[1]));
};
const directory = mkdtempSync(join(tmpdir(), "scan-config-check-test-"));
chmodSync(directory, 0o700);
after(() => rmSync(directory, { recursive: true, force: true }));
const checker = resolve(dirname(fileURLToPath(import.meta.url)), "check-scan-payment-config.mjs");
const cleanEnv = overrides => ({ PATH: process.env.PATH || "/usr/bin:/bin", ...overrides });
const run = (args, overrides = {}) => spawnSync(process.execPath, ["--", checker, ...args], { env: cleanEnv(overrides), encoding: "utf8" });
const envContents = values => Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n";
const envFile = join(directory, "synthetic.env");
writeFileSync(envFile, envContents(fixture), { mode: 0o600 });

test("valid independent merchant and platform RSA keys produce only safe readiness and public fingerprints", () => {
  const env = { ...fixture };
  const report = validateConfig(env);
  assert.equal(report.ok, true);
  assert(report.providers.every(provider => provider.status === "ready"));
  const expected = `SHA256:${createHash("sha256").update(merchant.publicKey.export({ type: "spki", format: "der" })).digest("base64")}`;
  assert.equal(find(report, "ALIPAY_PRIVATE_KEY").publicKeyFingerprint, expected);
  assert.notEqual(find(report, "ALIPAY_PRIVATE_KEY").publicKeyFingerprint, find(report, "ALIPAY_PUBLIC_KEY").publicKeyFingerprint);
  outputSafe(JSON.stringify(report));
  assert.deepEqual(env, fixture);
});

test("selected-provider checks, missing keys and adapter default notification origin are explicit", () => {
  const report = validateConfig({}, { providers: ["alipay"] });
  assert.equal(report.ok, false);
  assert.equal(report.providers.length, 1);
  assert.equal(report.providers[0].status, "missing");
  assert.equal(report.providers[0].checks.filter(check => check.status === "missing").length, 4);
  assert.equal(find(report, "ALIPAY_PAYMENT_PRODUCT").code, "DEFAULT_PRECREATE_REQUIRES_FACE_TO_FACE_PAYMENT");
  assert.equal(find(report, "SCAN_PAYMENT_NOTIFY_BASE_URL").status, "default");
  assert.equal(validateConfig(fixture, { providers: ["attacker-secret-value"] }).shared[0].code, "ALIPAY_OR_WECHAT_REQUIRED");
});

test("Alipay payment product must match an explicitly supported integration", () => {
  for (const product of ["page_pay", "precreate"]) {
    const report = validateConfig({ ...fixture, ALIPAY_PAYMENT_PRODUCT: product }, { providers: ["alipay"] });
    assert.equal(report.ok, true);
    assert.equal(find(report, "ALIPAY_PAYMENT_PRODUCT").status, "ready");
  }
  const report = validateConfig({ ...fixture, ALIPAY_PAYMENT_PRODUCT: "unsupported-product" });
  assert.equal(report.ok, false);
  assert.equal(find(report, "ALIPAY_PAYMENT_PRODUCT").code, "ONLY_PRECREATE_OR_PAGE_PAY_SUPPORTED");
});

test("merchant public keys cannot be mistaken for the payment platform public keys", () => {
  for (const key of ["ALIPAY_PUBLIC_KEY", "WECHAT_PAY_PUBLIC_KEY"]) {
    const report = validateConfig({ ...fixture, [key]: pem(merchant.publicKey) });
    assert.equal(report.ok, false);
    assert.equal(find(report, key).status, "invalid");
    assert.equal(find(report, key).code, "MERCHANT_PUBLIC_KEY_IS_NOT_PROVIDER_KEY");
    outputSafe(JSON.stringify(report));
  }
});

test("PKCS1 and literal escaped PEM newlines match adapter parsing", () => {
  const report = validateConfig({ ...fixture,
    ALIPAY_PRIVATE_KEY: pem(merchant.privateKey, true, "pkcs1").replaceAll("\n", "\\n"),
    ALIPAY_PUBLIC_KEY: pem(platform.publicKey, false, "pkcs1").replaceAll("\n", "\\n")
  }, { providers: ["alipay"] });
  assert.equal(report.ok, true);
});

test("wrong ID formats, certificate-mode key IDs and APIv3 byte lengths are rejected without echo", () => {
  for (const [key, value] of [
    ["ALIPAY_APP_ID", "bad-app-secret"], ["ALIPAY_SELLER_ID", "1234567890123456"],
    ["WECHAT_PAY_APP_ID", "bad-app-secret"], ["WECHAT_PAY_MCH_ID", "bad-mch-secret"],
    ["WECHAT_PAY_SERIAL_NO", "PUB_KEY_ID_123"], ["WECHAT_PAY_PUBLIC_KEY_ID", "ABCDEF0123456789"],
    ["WECHAT_PAY_API_V3_KEY", "密".repeat(32)], ["WECHAT_PAY_API_V3_KEY", "short-secret"]
  ]) {
    const report = validateConfig({ ...fixture, [key]: value });
    assert.equal(find(report, key).status, "invalid");
    assert(!JSON.stringify(report).includes(value));
  }
  assert.equal(validateConfig({ ...fixture, WECHAT_PAY_API_V3_KEY: "密".repeat(10) + "ab" }).ok, true);
});

test("RSA below 2048 bits, EC keys, malformed PEM, and private material in public fields are rejected", () => {
  for (const [key, value, code] of [
    ["ALIPAY_PRIVATE_KEY", pem(shortKey.privateKey, true), "RSA_AT_LEAST_2048_REQUIRED"],
    ["ALIPAY_PUBLIC_KEY", pem(shortKey.publicKey), "RSA_AT_LEAST_2048_REQUIRED"],
    ["WECHAT_PAY_PRIVATE_KEY", pem(ecKey.privateKey, true), "RSA_KEY_REQUIRED"],
    ["WECHAT_PAY_PUBLIC_KEY", pem(ecKey.publicKey), "RSA_KEY_REQUIRED"],
    ["ALIPAY_PUBLIC_KEY", pem(merchant.privateKey, true), "PROVIDER_PUBLIC_KEY_PEM_REQUIRED"],
    ["WECHAT_PAY_PRIVATE_KEY", pem(merchant.publicKey), "PRIVATE_KEY_PEM_REQUIRED"],
    ["ALIPAY_PRIVATE_KEY", "-----BEGIN PRIVATE KEY-----\nprivate-invalid-material\n-----END PRIVATE KEY-----", "KEY_PARSE_FAILED"]
  ]) {
    const report = validateConfig({ ...fixture, [key]: value });
    assert.equal(find(report, key).code, code);
    outputSafe(JSON.stringify(report));
    assert(!JSON.stringify(report).includes("private-invalid-material"));
  }
});

test("encrypted keys and unsupported certificate or service-provider modes are explicit", () => {
  const encrypted = merchant.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "test-secret-passphrase" }).toString();
  assert.equal(find(validateConfig({ ...fixture, ALIPAY_PRIVATE_KEY: encrypted }), "ALIPAY_PRIVATE_KEY").code, "ENCRYPTED_PRIVATE_KEY_NOT_SUPPORTED");
  for (const key of ["ALIPAY_PUBLIC_KEY", "WECHAT_PAY_PUBLIC_KEY"]) {
    assert.equal(find(validateConfig({ ...fixture, [key]: "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----" }), key).status, "unsupported");
  }
  for (const key of ["ALIPAY_APP_CERT_SN", "ALIPAY_ROOT_CERT_SN", "WECHAT_PAY_PLATFORM_CERTIFICATE", "WECHAT_PAY_SP_MCH_ID"]) {
    assert.equal(find(validateConfig({ ...fixture, [key]: "unsupported-sensitive-value" }), key).status, "unsupported");
  }
  assert.equal(find(validateConfig({ ...fixture, ALIPAY_SIGN_TYPE: "RSA" }), "ALIPAY_SIGN_TYPE").code, "ONLY_RSA2_SUPPORTED");
});

test("notification setting accepts an HTTPS origin only", () => {
  for (const value of ["http://example.test", "https://example.test/notify", "https://u:secret@example.test", "https://example.test?token=secret", "https://example.test#secret", "not-a-url-secret"]) {
    const report = validateConfig({ ...fixture, SCAN_PAYMENT_NOTIFY_BASE_URL: value });
    assert.equal(find(report, "SCAN_PAYMENT_NOTIFY_BASE_URL").status, "invalid");
    assert(report.providers.every(provider => provider.status === "invalid"));
    assert(!JSON.stringify(report).includes(value));
  }
});

test("CLI reads private fixtures via Next dotenv and dotenv-expand with inherited env precedence", () => {
  const interpolated = join(directory, "interpolated.env");
  const values = { ...fixture };
  delete values.ALIPAY_APP_ID;
  writeFileSync(interpolated, `SYNTHETIC_APP_ID=${fixture.ALIPAY_APP_ID}\nALIPAY_APP_ID=$SYNTHETIC_APP_ID\n` + envContents(values), { mode: 0o600 });
  const success = run(["--env-file", interpolated]);
  assert.equal(success.status, 0);
  assert.equal(JSON.parse(success.stdout).ok, true);
  outputSafe(success.stdout + success.stderr);
  const overridden = run(["--env-file", interpolated, "--provider", "alipay"], { ALIPAY_APP_ID: "inherited-invalid-secret" });
  assert.equal(overridden.status, 1);
  assert.equal(find(JSON.parse(overridden.stdout), "ALIPAY_APP_ID").status, "invalid");
  assert(!(overridden.stdout + overridden.stderr).includes("inherited-invalid-secret"));
});

test("CLI rejects readable-by-others files and nonfiles before parsing; accepts a private symlink target", () => {
  const insecure = join(directory, "contains-secret-in-path.env");
  writeFileSync(insecure, envContents(fixture), { mode: 0o644 });
  for (const [file, code] of [[insecure, "OWNER_ONLY_ENV_FILE_PERMISSIONS_REQUIRED"], [directory, "REGULAR_ENV_FILE_REQUIRED"], [join(directory, "absent-secret.env"), "ENV_FILE_NOT_FOUND"]]) {
    const denied = run(["--env-file", file]);
    assert.equal(denied.status, 2);
    assert.equal(JSON.parse(denied.stdout).shared[0].code, code);
    assert(!denied.stdout.includes(file));
    outputSafe(denied.stdout + denied.stderr);
  }
  const link = join(directory, "release.env");
  symlinkSync(envFile, link);
  assert.equal(run(["--env-file", link, "--provider", "wechat"]).status, 0);
});

test("CLI missing values and malformed arguments produce only safe reports", () => {
  const empty = join(directory, "empty.env");
  writeFileSync(empty, "# no payment configuration\n", { mode: 0o600 });
  assert.equal(run(["--env-file", empty]).status, 1);
  for (const args of [["--private-key", "secret-do-not-print"], ["--env-file"], ["--provider", "all", "--provider", "all"], ["--provider", "secret-provider"]]) {
    const denied = run(args);
    assert.equal(denied.status, 2);
    assert(!denied.stdout.includes("secret-do-not-print"));
    assert(!denied.stdout.includes("secret-provider"));
    assert.equal(JSON.parse(denied.stdout).ok, false);
  }
});

test("checker implementation has no network, child-process or key-generation capability", () => {
  const source = readFileSync(checker, "utf8");
  assert(!/\b(?:fetch|generateKeyPairSync|generateKeyPair|spawn|execFile)\s*\(/.test(source));
  assert(!/node:(?:https?|net|tls|child_process)/.test(source));
});
