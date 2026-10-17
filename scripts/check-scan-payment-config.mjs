#!/usr/bin/env node
// Invoke with `node -- scripts/check-scan-payment-config.mjs --env-file PATH`.
// Node itself recognizes --env-file during startup, even after a script path;
// the leading -- keeps permission checks and dotenv parsing inside this tool.
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCHEMA = "SANJIE_SCAN_PAYMENT_CONFIG_CHECK_V1";
const PROVIDERS = ["alipay", "wechat"];
const DEFAULT_NOTIFY_ORIGIN = "https://shaozhuangai.com";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const present = value => typeof value === "string" && value.trim() !== "";
const result = (key, status, code, extra = {}) => ({ key, status, code, ...extra });

function overall(checks) {
  for (const status of ["unsupported", "invalid", "missing"]) {
    if (checks.some(check => check.status === status)) return status;
  }
  return "ready";
}

function textCheck(env, key, pattern, code) {
  if (!present(env[key])) return result(key, "missing", "REQUIRED");
  return pattern.test(env[key].trim()) ? result(key, "ready", "FORMAT_VALID") : result(key, "invalid", code);
}

function rsaCheck(env, key, privateKey) {
  if (!present(env[key])) return result(key, "missing", "REQUIRED");
  const pem = env[key].trim().replace(/\\n/g, "\n");
  if (/-----BEGIN (?:X509 )?CERTIFICATE-----/.test(pem)) return result(key, "unsupported", "CERTIFICATE_MODE_NOT_SUPPORTED");
  if (/ENCRYPTED|Proc-Type:\s*4,ENCRYPTED/.test(pem)) return result(key, "unsupported", "ENCRYPTED_PRIVATE_KEY_NOT_SUPPORTED");
  // createPublicKey also accepts private keys and certificates. Reject those here:
  // the adapter requires the provider's public key, never a merchant private key.
  const expected = privateKey ? /^-----BEGIN (?:RSA )?PRIVATE KEY-----/ : /^-----BEGIN (?:RSA )?PUBLIC KEY-----/;
  if (!expected.test(pem)) return result(key, "invalid", privateKey ? "PRIVATE_KEY_PEM_REQUIRED" : "PROVIDER_PUBLIC_KEY_PEM_REQUIRED");
  try {
    const parsed = privateKey ? createPrivateKey(pem) : createPublicKey(pem);
    if (parsed.asymmetricKeyType !== "rsa") return result(key, "unsupported", "RSA_KEY_REQUIRED");
    if ((parsed.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return result(key, "invalid", "RSA_AT_LEAST_2048_REQUIRED");
    const publicKey = privateKey ? createPublicKey(parsed) : parsed;
    const der = publicKey.export({ type: "spki", format: "der" });
    const publicKeyFingerprint = `SHA256:${createHash("sha256").update(der).digest("base64")}`;
    return result(key, "ready", "RSA_KEY_VALID", { publicKeyFingerprint });
  } catch {
    // OpenSSL errors can include input material. Only fixed diagnostic codes leave this function.
    return result(key, "invalid", "KEY_PARSE_FAILED");
  }
}

function notifyCheck(env) {
  const key = "SCAN_PAYMENT_NOTIFY_BASE_URL";
  const configured = present(env[key]);
  try {
    const origin = new URL(configured ? env[key].trim() : DEFAULT_NOTIFY_ORIGIN);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
      return result(key, "invalid", "HTTPS_ORIGIN_WITHOUT_PATH_QUERY_OR_CREDENTIALS_REQUIRED");
    }
    return result(key, configured ? "ready" : "default", configured ? "HTTPS_ORIGIN_VALID" : "ADAPTER_DEFAULT_ORIGIN");
  } catch { return result(key, "invalid", "HTTPS_ORIGIN_REQUIRED"); }
}

function optionalModeChecks(env, provider) {
  const checks = [];
  if (provider === "alipay") {
    checks.push(!present(env.ALIPAY_PAYMENT_PRODUCT)
      ? result("ALIPAY_PAYMENT_PRODUCT", "default", "DEFAULT_PRECREATE_REQUIRES_FACE_TO_FACE_PAYMENT")
      : ["precreate", "page_pay"].includes(env.ALIPAY_PAYMENT_PRODUCT.trim())
        ? result("ALIPAY_PAYMENT_PRODUCT", "ready", "PAYMENT_PRODUCT_SELECTED")
        : result("ALIPAY_PAYMENT_PRODUCT", "unsupported", "ONLY_PRECREATE_OR_PAGE_PAY_SUPPORTED"));
    if (present(env.ALIPAY_SIGN_TYPE) && env.ALIPAY_SIGN_TYPE.trim() !== "RSA2") checks.push(result("ALIPAY_SIGN_TYPE", "unsupported", "ONLY_RSA2_SUPPORTED"));
    for (const key of ["ALIPAY_APP_CERT_SN", "ALIPAY_ROOT_CERT_SN"]) {
      if (present(env[key])) checks.push(result(key, "unsupported", "CERTIFICATE_MODE_NOT_SUPPORTED"));
    }
  }
  if (provider === "wechat") {
    for (const key of ["WECHAT_PAY_PLATFORM_CERTIFICATE", "WECHAT_PAY_PLATFORM_CERT_SERIAL_NO"]) {
      if (present(env[key])) checks.push(result(key, "unsupported", "PLATFORM_CERTIFICATE_MODE_NOT_SUPPORTED"));
    }
    for (const key of ["WECHAT_PAY_SP_MCH_ID", "WECHAT_PAY_SUB_MCH_ID", "WECHAT_PAY_SUB_APP_ID"]) {
      if (present(env[key])) checks.push(result(key, "unsupported", "SERVICE_PROVIDER_MODE_NOT_SUPPORTED"));
    }
  }
  return checks;
}

/** Pure, offline validation. Returns fixed codes/key names/public-key hashes only.
 * It cannot establish merchant approval, platform registration, certificate serial
 * ownership, private/public correspondence with a merchant certificate, or a real payment.
 * Merchant private keys and platform public keys are intentionally not a matching pair.
 */
export function validateConfig(env, { providers = PROVIDERS } = {}) {
  if (!Array.isArray(providers) || !providers.length || providers.some(provider => !PROVIDERS.includes(provider))) {
    return { schema: SCHEMA, ok: false, providers: [], shared: [result("PROVIDER_SELECTION", "invalid", "ALIPAY_OR_WECHAT_REQUIRED")] };
  }
  env = env && typeof env === "object" ? env : {};
  const shared = [notifyCheck(env)];
  const summaries = [...new Set(providers)].map(provider => {
    const checks = provider === "alipay" ? [
      textCheck(env, "ALIPAY_APP_ID", /^\d{16}$/, "APP_ID_16_DIGITS_REQUIRED"),
      textCheck(env, "ALIPAY_SELLER_ID", /^2088\d{12}$/, "SELLER_ID_2088_AND_12_DIGITS_REQUIRED"),
      rsaCheck(env, "ALIPAY_PRIVATE_KEY", true),
      rsaCheck(env, "ALIPAY_PUBLIC_KEY", false)
    ] : [
      textCheck(env, "WECHAT_PAY_APP_ID", /^wx[A-Za-z0-9]{16}$/, "APP_ID_WX_AND_16_ALPHANUMERIC_REQUIRED"),
      textCheck(env, "WECHAT_PAY_MCH_ID", /^\d{6,32}$/, "MCH_ID_6_TO_32_DIGITS_REQUIRED"),
      textCheck(env, "WECHAT_PAY_SERIAL_NO", /^[0-9A-Fa-f]{16,64}$/, "MERCHANT_CERT_SERIAL_16_TO_64_HEX_REQUIRED"),
      textCheck(env, "WECHAT_PAY_PUBLIC_KEY_ID", /^PUB_KEY_ID_\d+$/, "PLATFORM_PUBLIC_KEY_ID_REQUIRED_CERT_MODE_UNSUPPORTED"),
      !present(env.WECHAT_PAY_API_V3_KEY) ? result("WECHAT_PAY_API_V3_KEY", "missing", "REQUIRED")
        : Buffer.byteLength(env.WECHAT_PAY_API_V3_KEY.trim(), "utf8") === 32 ? result("WECHAT_PAY_API_V3_KEY", "ready", "UTF8_32_BYTES_VALID")
          : result("WECHAT_PAY_API_V3_KEY", "invalid", "UTF8_32_BYTES_REQUIRED"),
      rsaCheck(env, "WECHAT_PAY_PRIVATE_KEY", true),
      rsaCheck(env, "WECHAT_PAY_PUBLIC_KEY", false)
    ];
    const prefix = provider === "alipay" ? "ALIPAY" : "WECHAT_PAY";
    const merchantKey = checks.find(check => check.key === `${prefix}_PRIVATE_KEY`);
    const platformKey = checks.find(check => check.key === `${prefix}_PUBLIC_KEY`);
    // These keys must NOT be a pair: the merchant signs requests and the payment
    // platform signs responses. Equality detects an app-public-key copy/paste error.
    if (merchantKey?.publicKeyFingerprint && merchantKey.publicKeyFingerprint === platformKey?.publicKeyFingerprint) {
      platformKey.status = "invalid";
      platformKey.code = "MERCHANT_PUBLIC_KEY_IS_NOT_PROVIDER_KEY";
    }
    checks.push(...optionalModeChecks(env, provider));
    return { provider, status: overall([...checks, ...shared]), checks };
  });
  return { schema: SCHEMA, ok: summaries.every(provider => provider.status === "ready"), providers: summaries, shared };
}

function safeFailure(code) {
  return { schema: SCHEMA, ok: false, providers: [], shared: [result("ENV_FILE", "invalid", code)] };
}

function protectedContents(file) {
  let fd;
  try {
    // NONBLOCK avoids hanging on a supplied FIFO; symlinks are allowed, but the
    // actual opened target must be a private regular file (release env symlinks are common).
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const metadata = fstatSync(fd);
    if (!metadata.isFile()) return { error: "REGULAR_ENV_FILE_REQUIRED" };
    if ((metadata.mode & 0o077) !== 0) return { error: "OWNER_ONLY_ENV_FILE_PERMISSIONS_REQUIRED" };
    if (typeof process.getuid === "function" && process.getuid() !== 0 && metadata.uid !== process.getuid()) return { error: "ENV_FILE_OWNER_MISMATCH" };
    if (metadata.size > 1024 * 1024) return { error: "ENV_FILE_TOO_LARGE" };
    return { contents: readFileSync(fd, "utf8") };
  } catch (error) {
    return { error: error?.code === "ENOENT" ? "ENV_FILE_NOT_FOUND" : "ENV_FILE_NOT_READABLE" };
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function runCli(argv = process.argv.slice(2)) {
  let envFile;
  let provider = "all";
  const seen = new Set();
  if (argv.length === 1 && argv[0] === "--help") return { help: "node -- scripts/check-scan-payment-config.mjs [--env-file PATH] [--provider alipay|wechat|all]", exitCode: 0 };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!value || value.startsWith("--") || !["--env-file", "--provider"].includes(flag) || seen.has(flag)) {
      return { report: safeFailure("ARGUMENTS_INVALID"), exitCode: 2 };
    }
    seen.add(flag);
    if (flag === "--env-file") envFile = resolve(value);
    else provider = value;
  }
  if (![...PROVIDERS, "all"].includes(provider)) return { report: safeFailure("PROVIDER_ARGUMENT_INVALID"), exitCode: 2 };
  const mode = process.env.NODE_ENV === "test" ? "test" : process.env.NODE_ENV === "development" ? "development" : "production";
  const files = envFile ? [envFile] : [`.env.${mode}.local`, ...(mode !== "test" ? [".env.local"] : []), `.env.${mode}`, ".env"].map(file => resolve(projectRoot, file));
  const loaded = [];
  for (const file of files) {
    const read = protectedContents(file);
    if (read.error === "ENV_FILE_NOT_FOUND" && !envFile) continue;
    if (read.error) return { report: safeFailure(read.error), exitCode: 2 };
    loaded.push({ path: file, contents: read.contents, env: {} });
  }
  let parseFailed = false;
  // Use Next's actual dotenv + dotenv-expand implementation and inherited-env
  // precedence. Never forward its logger: parser errors can contain credentials.
  const { processEnv } = require("@next/env");
  const [env] = processEnv(loaded, projectRoot, { info() {}, error() { parseFailed = true; } }, true);
  if (parseFailed) return { report: safeFailure("ENV_FILE_PARSE_FAILED"), exitCode: 2 };
  const report = validateConfig(env, { providers: provider === "all" ? PROVIDERS : [provider] });
  report.shared.unshift(result("ENV_FILE", "ready", loaded.length ? "PRIVATE_FILES_PARSED_BY_NEXT_ENV" : "INHERITED_ENVIRONMENT_ONLY"));
  return { report, exitCode: report.ok ? 0 : 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const outcome = runCli();
    console.log(outcome.help || JSON.stringify(outcome.report, null, 2));
    process.exitCode = outcome.exitCode;
  } catch {
    console.log(JSON.stringify(safeFailure("CONFIG_CHECK_FAILED"), null, 2));
    process.exitCode = 2;
  }
}
