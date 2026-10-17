import "server-only";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { resolveAiEncryptionKeySource } from "@/lib/ai-encryption-key";

const ROOT = "https://sub.shaozhuangai.com";
const SCHEMA = "SANJIE_SUB2API_PROVISION_CONFIG_V1";
const MAX_FILE_BYTES = 65_536;
const REQUIRED = ["SUB2API_PROVISION_EMAIL", "SUB2API_PROVISION_PASSWORD", "SUB2API_PROVISION_GROUP_ID", "SUB2API_PROVISION_KEY_QUOTA_USD"] as const;

export class Sub2ApiProvisionError extends Error {
  constructor(message: string, readonly status = 503, readonly code = "supply_provisioning_failed") {
    super(message);
    this.name = "Sub2ApiProvisionError";
  }
}

export type Sub2ApiProvisionConfiguration = { baseUrl: string; email: string; password: string; groupId: string; quotaUsd: number | null };
export type Sub2ApiProvisioningView = { configured: boolean; missing: string[]; baseUrl: string; emailMasked: string; groupId: string; quotaUsd: number | null };

function fail(message: string, code: string, status = 503): never { throw new Sub2ApiProvisionError(message, status, code); }
function record(value: unknown): Record<string, unknown> | null { return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }

export function getSub2ApiProvisionConfigPath(): string {
  const configured = process.env.SUB2API_PROVISION_CONFIG_FILE?.trim();
  const file = configured || path.join(homedir(), ".config", "shaozhuangai", "user-supply", "provision.json");
  if (!path.isAbsolute(file) || file.split(path.sep).some((part) => ["public", ".next", "downloads"].includes(part))) {
    fail("上游签发配置必须保存到服务端私有绝对路径", "supply_provisioning_invalid_config_path");
  }
  return path.normalize(file);
}

function encryptionKey(): Buffer {
  const dedicated = process.env.AI_API_ENCRYPTION_KEY?.trim();
  if (!dedicated || dedicated.length < 32) fail("上游签发凭据的独立加密密钥尚未安全配置", "supply_provisioning_encryption_unconfigured");
  let source: string;
  try { source = resolveAiEncryptionKeySource(); }
  catch { fail("上游签发凭据的独立加密密钥尚未安全配置", "supply_provisioning_encryption_unconfigured"); }
  return createHash("sha256").update(SCHEMA + "\0").update(source).digest();
}

function validate(config: Sub2ApiProvisionConfiguration, allowMissing = false): Sub2ApiProvisionConfiguration {
  let url: URL;
  try { url = new URL(config.baseUrl); }
  catch { fail("上游签发地址配置无效", "supply_provisioning_invalid_config", 400); }
  if (url.origin !== ROOT || url.pathname !== "/" || url.username || url.password || url.search || url.hash) fail("上游签发地址必须是已授权的 HTTPS 站点根地址", "supply_provisioning_invalid_config", 400);
  if ((config.email || !allowMissing) && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email) || config.email.length > 320 || /[\u0000-\u001f\u007f]/.test(config.email))) fail("上游签发账号邮箱无效", "supply_provisioning_invalid_config", 400);
  if ((!config.password && !allowMissing) || config.password.length > 4096) fail("请填写上游服务账号密码", "supply_provisioning_invalid_config", 400);
  if ((config.groupId || !allowMissing) && (!/^[1-9]\d*$/.test(config.groupId) || !Number.isSafeInteger(Number(config.groupId)))) fail("上游签发分组 ID 无效", "supply_provisioning_invalid_config", 400);
  if ((config.quotaUsd !== null || !allowMissing) && (typeof config.quotaUsd !== "number" || !Number.isFinite(config.quotaUsd) || config.quotaUsd < 0 || config.quotaUsd > 1_000_000)) fail("密钥额度须为 0 或不超过 1000000 的正数", "supply_provisioning_invalid_config", 400);
  return { ...config, baseUrl: url.origin };
}

function parseQuota(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim())) fail("密钥额度配置无效", "supply_provisioning_invalid_config", 400);
  return Number(value.trim());
}

async function readSaved(file: string): Promise<Sub2ApiProvisionConfiguration | null> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    fail("无法读取上游签发私有配置", "supply_provisioning_config_unreadable");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) fail("上游签发配置文件权限或大小无效", "supply_provisioning_config_permissions");
    const raw = record(JSON.parse(await handle.readFile("utf8")));
    if (raw?.schema !== SCHEMA || typeof raw.iv !== "string" || typeof raw.tag !== "string" || typeof raw.ciphertext !== "string") fail("上游签发加密配置格式无效", "supply_provisioning_config_corrupt");
    const iv = Buffer.from(raw.iv, "base64");
    const tag = Buffer.from(raw.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) fail("上游签发加密配置格式无效", "supply_provisioning_config_corrupt");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAAD(Buffer.from(SCHEMA));
    decipher.setAuthTag(tag);
    const value = record(JSON.parse(Buffer.concat([decipher.update(Buffer.from(raw.ciphertext, "base64")), decipher.final()]).toString("utf8")));
    if (!value || typeof value.baseUrl !== "string" || typeof value.email !== "string" || typeof value.password !== "string" || typeof value.groupId !== "string") fail("上游签发加密配置内容无效", "supply_provisioning_config_corrupt");
    return validate({ baseUrl: value.baseUrl, email: value.email, password: value.password, groupId: value.groupId, quotaUsd: parseQuota(value.quotaUsd) });
  } catch (error) {
    if (error instanceof Sub2ApiProvisionError) throw error;
    fail("上游签发加密配置校验失败", "supply_provisioning_config_corrupt");
  } finally { await handle.close(); }
}

export async function readSub2ApiProvisionConfig(): Promise<Sub2ApiProvisionConfiguration> {
  const saved = await readSaved(getSub2ApiProvisionConfigPath());
  if (saved) return saved;
  return validate({
    baseUrl: process.env.SUB2API_PROVISION_BASE_URL?.trim() || ROOT,
    email: process.env.SUB2API_PROVISION_EMAIL?.trim() || "",
    password: process.env.SUB2API_PROVISION_PASSWORD || "",
    groupId: process.env.SUB2API_PROVISION_GROUP_ID?.trim() || "",
    quotaUsd: parseQuota(process.env.SUB2API_PROVISION_KEY_QUOTA_USD?.trim())
  }, true);
}

function view(config: Sub2ApiProvisionConfiguration): Sub2ApiProvisioningView {
  const values = [config.email, config.password.trim(), config.groupId, config.quotaUsd];
  const missing = REQUIRED.filter((_name, index) => values[index] === "" || values[index] === null);
  const at = config.email.indexOf("@");
  const emailMasked = at > 0 ? config.email.slice(0, 1) + "***" + config.email.slice(at) : "";
  return { configured: missing.length === 0, missing, baseUrl: config.baseUrl, emailMasked, groupId: config.groupId, quotaUsd: config.quotaUsd };
}

export async function getSub2ApiProvisioningView(): Promise<Sub2ApiProvisioningView> {
  return view(await readSub2ApiProvisionConfig());
}

async function ensurePrivateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) fail("签发配置目录须为当前服务账号的私有目录", "supply_provisioning_config_permissions");
}

async function acquireLock(file: string): Promise<() => Promise<void>> {
  const lock = file + ".lock";
  const deadline = Date.now() + 5000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); return async () => { await rm(lock, { recursive: true, force: false }); }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") fail("无法锁定上游签发配置", "supply_provisioning_config_unwritable");
      if (Date.now() >= deadline) fail("上游签发配置正在保存，请稍后重试", "supply_provisioning_config_busy", 409);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export async function saveSub2ApiProvisionConfig(input: unknown): Promise<Sub2ApiProvisioningView> {
  const raw = record(input);
  if (!raw) fail("上游签发配置必须是对象", "supply_provisioning_invalid_config", 400);
  const file = getSub2ApiProvisionConfigPath();
  const directory = path.dirname(file);
  const key = encryptionKey();
  await ensurePrivateDirectory(directory);
  const release = await acquireLock(file);
  let temporary: string | null = null;
  try {
    const current = await readSub2ApiProvisionConfig();
    for (const field of ["baseUrl", "email", "password"] as const) {
      if (raw[field] !== undefined && typeof raw[field] !== "string") fail("上游签发文本配置无效", "supply_provisioning_invalid_config", 400);
    }
    const config = validate({
      baseUrl: typeof raw.baseUrl === "string" && raw.baseUrl.trim() ? raw.baseUrl.trim() : current.baseUrl,
      email: typeof raw.email === "string" && raw.email.trim() ? raw.email.trim() : current.email,
      password: typeof raw.password === "string" && raw.password.trim() ? raw.password : current.password,
      groupId: raw.groupId === undefined || raw.groupId === "" ? current.groupId : String(raw.groupId),
      quotaUsd: raw.quotaUsd === undefined || raw.quotaUsd === "" ? current.quotaUsd : parseQuota(raw.quotaUsd)
    });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(SCHEMA));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
    const content = JSON.stringify({ schema: SCHEMA, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }) + "\n";
    temporary = path.join(directory, `.provision-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    temporary = null;
    await chmod(file, 0o600);
    const parent = await open(directory, constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
    return view(config);
  } catch (error) {
    if (error instanceof Sub2ApiProvisionError) throw error;
    return fail("上游签发配置保存失败", "supply_provisioning_config_unwritable");
  } finally {
    if (temporary) await unlink(temporary).catch(() => undefined);
    await release();
  }
}
