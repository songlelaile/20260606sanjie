import "server-only";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, readlink, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { resolveAiEncryptionKeySource } from "@/lib/ai-encryption-key";
import { isSafeAiEndpointUrl } from "@/lib/ai-endpoint";

const SCHEMA = "SANJIE_CREATIVE_CONFIG_PROFILES_V1";
const PROVIDERS = new Set(["openai-compatible", "openai", "nano-banana", "doubao", "deepseek-v4", "minimax", "zhipu", "dashscope"]);
const CONFIG_FIELDS = new Set(["provider", "imageAdapter", "visionBaseUrl", "visionModel", "textModel", "imageEndpoint", "imageModel", "apiKey"]);
const MAX_FILE_BYTES = 256 * 1024;
export type CreativeConfigOwner = { id: string; tenantId: string; username: string };
type Config = Record<string, string>;
type Selection = { activeProvider: string; activeSupplyChannel: "external_key" | "platform_wallet"; platformWalletConfig?: Config };
type Profile = { revision: number; tombstone: boolean; config: Config };
type Document = { version: 1; accountRevision: number; selection: Selection; profiles: Record<string, Profile> };

export class CreativeConfigProfileError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = "CreativeConfigProfileError"; }
}
function fail(code: string, message: string, status = 400): never { throw new CreativeConfigProfileError(code, message, status); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function provider(value: unknown): string {
  if (typeof value !== "string" || !PROVIDERS.has(value)) fail("CONFIG_PROVIDER_INVALID", "请选择有效的模型服务商。");
  return value;
}
function checkedOwner(owner: CreativeConfigOwner) {
  if (![owner.id, owner.tenantId, owner.username].every(value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value))) {
    fail("ACCOUNT_UNAVAILABLE", "当前账号身份无法确认。", 401);
  }
  return owner;
}
export function creativeConfigAccountKey(owner: CreativeConfigOwner) {
  checkedOwner(owner);
  return "user:" + (owner.tenantId + ":" + owner.username).replace(/[^\w@.+:-]/g, "_").slice(0, 120);
}
export function creativeConfigOwnerFingerprint(owner: CreativeConfigOwner) {
  checkedOwner(owner);
  return createHash("sha256").update(JSON.stringify([SCHEMA, owner.tenantId, owner.id])).digest("hex");
}
export function getCreativeConfigProfileRoot() {
  const root = process.env.SANJIE_CREATIVE_CONFIG_ROOT?.trim() || path.join(homedir(), ".config", "shaozhuangai", "creative-config-profiles");
  if (!path.isAbsolute(root)) fail("CONFIG_STORE_UNAVAILABLE", "账号配置存储路径不可用。", 503);
  return path.resolve(root);
}
function ownerFile(owner: CreativeConfigOwner, root: string) {
  checkedOwner(owner);
  return path.join(root, creativeConfigOwnerFingerprint(owner) + ".json");
}
function key() { return createHash("sha256").update("sanjie:creative-config:v1\0").update(resolveAiEncryptionKeySource()).digest(); }
function aad(owner: CreativeConfigOwner) { return Buffer.from(JSON.stringify([SCHEMA, owner.tenantId, owner.id])); }
function ownedPrivate(info: Stats, directory: boolean) {
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile()) || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) fail("CONFIG_STORE_UNAVAILABLE", "账号配置存储权限不可用。", 503);
}
async function privateRoot() {
  const root = getCreativeConfigProfileRoot();
  let current = path.parse(root).root;
  for (const component of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("CONFIG_STORE_UNAVAILABLE", "账号配置存储路径不可用。", 503);
  }
  ownedPrivate(await lstat(root), true);
  if (await realpath(root) !== root) fail("CONFIG_STORE_UNAVAILABLE", "账号配置存储路径不可用。", 503);
  return root;
}
function normalizeConfig(value: unknown, expectedProvider: string, previous: Config = {}): Config {
  if (!record(value)) fail("CONFIG_INVALID", "模型配置格式无效。");
  const result: Config = { ...previous, provider: expectedProvider };
  for (const [name, raw] of Object.entries(value)) {
    if (!CONFIG_FIELDS.has(name) || typeof raw !== "string" || raw.length > (name === "apiKey" ? 4096 : 2048) || /[\u0000-\u001f\u007f]/.test(raw)) {
      fail("CONFIG_INVALID", "模型配置字段无效。");
    }
    if (name === "provider" && raw !== expectedProvider) fail("CONFIG_PROVIDER_INVALID", "模型服务商与保存目标不一致。");
    result[name] = raw.trim();
  }
  for (const field of ["visionBaseUrl", "imageEndpoint"]) {
    if (result[field]) {
      let url: URL;
      try { url = new URL(result[field]); } catch { fail("CONFIG_ENDPOINT_INVALID", "模型接口地址无效。"); }
      if (!isSafeAiEndpointUrl(result[field]) || url.search || url.hash) fail("CONFIG_ENDPOINT_INVALID", "模型接口必须是公开 HTTPS 地址且不含凭据或查询参数。");
      result[field] = url.toString().replace(/\/+$/, "");
    }
  }
  return result;
}
function normalizeSelection(raw: unknown, previous: Selection): Selection {
  if (!record(raw) || Object.keys(raw).some(name => !["activeProvider", "activeSupplyChannel", "platformWalletConfig"].includes(name))) fail("CONFIG_SELECTION_INVALID", "模型选择无效。");
  const result = { ...previous };
  if (raw.activeProvider !== undefined) result.activeProvider = raw.activeProvider === "" ? "" : provider(raw.activeProvider);
  if (raw.activeSupplyChannel !== undefined) {
    if (raw.activeSupplyChannel !== "external_key" && raw.activeSupplyChannel !== "platform_wallet") fail("CONFIG_SELECTION_INVALID", "模型使用方式无效。");
    result.activeSupplyChannel = raw.activeSupplyChannel;
  }
  if (raw.platformWalletConfig !== undefined) {
    const config = normalizeConfig(raw.platformWalletConfig, "openai-compatible");
    if (config.apiKey) fail("CONFIG_SELECTION_INVALID", "平台积分选择不能保存个人 API Key。");
    delete config.apiKey;
    result.platformWalletConfig = config;
  }
  return result;
}
function emptyDocument(): Document { return { version: 1, accountRevision: 0, selection: { activeProvider: "", activeSupplyChannel: "external_key" }, profiles: {} }; }
function checkedDocument(value: unknown): Document {
  if (!record(value) || value.version !== 1 || !revision(value.accountRevision) || !record(value.profiles) || Object.keys(value.profiles).length > PROVIDERS.size) throw new Error("Invalid document");
  const selection = normalizeSelection(value.selection, emptyDocument().selection);
  const profiles: Record<string, Profile> = {};
  for (const [name, raw] of Object.entries(value.profiles)) {
    provider(name);
    if (!record(raw) || !revision(raw.revision) || raw.revision < 1 || typeof raw.tombstone !== "boolean") throw new Error("Invalid profile");
    const config = normalizeConfig(raw.config, name);
    if (raw.tombstone && config.apiKey) throw new Error("Invalid tombstone");
    profiles[name] = { revision: raw.revision, tombstone: raw.tombstone, config };
  }
  return { version: 1, accountRevision: value.accountRevision, selection, profiles };
}
async function readDocument(owner: CreativeConfigOwner, file: string): Promise<Document> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument(); throw error; }
  try {
    const info = await handle.stat(); ownedPrivate(info, false);
    if (info.size > MAX_FILE_BYTES) throw new Error("Oversized document");
    const envelope: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!record(envelope) || envelope.schema !== SCHEMA || !["iv", "tag", "ciphertext"].every(name => typeof envelope[name] === "string")) throw new Error("Invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(String(envelope.iv), "base64"));
    decipher.setAAD(aad(owner)); decipher.setAuthTag(Buffer.from(String(envelope.tag), "base64"));
    const decoded = Buffer.concat([decipher.update(Buffer.from(String(envelope.ciphertext), "base64")), decipher.final()]);
    try { return checkedDocument(JSON.parse(decoded.toString("utf8"))); }
    catch { fail("CONFIG_STORE_UNAVAILABLE", "账号模型配置暂不可读取，原绑定仍保留。", 503); }
  } finally { await handle.close(); }
}
type LinuxProcessIdentity = { bootId: string; pidNamespace: string; startTicks: string };
type LockOwner = { version: 1; pid: number; nonce: string; linux: LinuxProcessIdentity | null };
type LockSnapshot = { info: Stats; owner: LockOwner; raw: string };
const LOCK_OWNER = "owner.json";
function sameInode(left: Stats, right: Stats) { return left.dev === right.dev && left.ino === right.ino; }
function processStartTicks(stat: string, pid: number) {
  // /proc/<pid>/stat's command can contain spaces and parentheses; field 22 follows the last ')'.
  if (!stat.startsWith(`${pid} (`) || stat.lastIndexOf(")") < String(pid).length + 2) return null;
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  return /^[A-Za-z]$/.test(fields[0] || "") && /^\d+$/.test(fields[19] || "") ? fields[19] : null;
}
async function linuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity | null> {
  try {
    const [boot, namespace, stat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"), readlink(`/proc/${pid}/ns/pid`), readFile(`/proc/${pid}/stat`, "utf8")
    ]);
    const bootId = boot.trim(), startTicks = processStartTicks(stat, pid);
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(bootId) || !/^pid:\[\d+\]$/.test(namespace) || !startTicks) return null;
    return { bootId, pidNamespace: namespace, startTicks };
  } catch { return null; }
}
function checkedLockOwner(value: unknown): LockOwner | null {
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 ||
      typeof value.nonce !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(value.nonce)) return null;
  if (value.linux !== null && (!record(value.linux) || typeof value.linux.bootId !== "string" ||
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(value.linux.bootId) || typeof value.linux.pidNamespace !== "string" ||
      !/^pid:\[\d+\]$/.test(value.linux.pidNamespace) || typeof value.linux.startTicks !== "string" || !/^\d+$/.test(value.linux.startTicks))) return null;
  return value as LockOwner;
}
async function lockSnapshot(lock: string): Promise<LockSnapshot | null> {
  let directory, metadata;
  try {
    directory = await open(lock, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const info = await directory.stat(); ownedPrivate(info, true);
    metadata = await open(path.join(lock, LOCK_OWNER), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadataInfo = await metadata.stat(); ownedPrivate(metadataInfo, false);
    if (metadataInfo.size > 4096) return null;
    const raw = await metadata.readFile("utf8"), owner = checkedLockOwner(JSON.parse(raw));
    const current = await lstat(lock);
    if (!owner || !sameInode(info, current) || !current.isDirectory() || current.isSymbolicLink()) return null;
    return { info, owner, raw };
  } catch { return null; }
  finally { await metadata?.close(); await directory?.close(); }
}
async function ownerIsProvenDead(owner: LockOwner) {
  const current = await linuxProcessIdentity(process.pid);
  // Different boots/namespaces, non-Linux hosts, EPERM and malformed/absent metadata stay busy.
  // There is deliberately no age/lease timeout: a live writer may be paused for arbitrarily long.
  if (!owner.linux || !current || owner.linux.bootId !== current.bootId || owner.linux.pidNamespace !== current.pidNamespace) return false;
  try {
    const startTicks = processStartTicks(await readFile(`/proc/${owner.pid}/stat`, "utf8"), owner.pid);
    return startTicks !== null && startTicks !== owner.linux.startTicks;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }
}
async function recoverDeadLock(lock: string) {
  const observed = await lockSnapshot(lock);
  if (!observed || !await ownerIsProvenDead(observed.owner)) return;
  const current = await lockSnapshot(lock);
  if (!current || !sameInode(observed.info, current.info) || observed.raw !== current.raw || !await ownerIsProvenDead(current.owner)) return;
  // A deterministic, permanently nonempty destination makes concurrent stale recoverers harmless:
  // after the first rename, another rename cannot overwrite this directory with a newer live lock.
  // Keep the small private owner record; deleting this tombstone would reintroduce that race.
  const recovered = lock + ".recovered-" + observed.owner.nonce;
  try { await rename(lock, recovered); }
  catch (error) {
    if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
  }
}
async function releaseLock(lock: string, expected: LockSnapshot) {
  const current = await lockSnapshot(lock);
  if (!current || !sameInode(expected.info, current.info) || expected.raw !== current.raw) throw new Error("Configuration lock ownership changed");
  await unlink(path.join(lock, LOCK_OWNER));
  await rmdir(lock);
}
async function locked<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = file + ".lock", deadline = Date.now() + 5000;
  let acquired: LockSnapshot;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      // A crash before metadata is complete cannot be proved safe to reclaim and stays fail-closed.
      const owner: LockOwner = { version: 1, pid: process.pid, nonce: randomUUID(), linux: await linuxProcessIdentity(process.pid) };
      const metadata = await open(path.join(lock, LOCK_OWNER), "wx", 0o600);
      try { await metadata.writeFile(JSON.stringify(owner) + "\n"); await metadata.sync(); } finally { await metadata.close(); }
      const snapshot = await lockSnapshot(lock);
      if (!snapshot || snapshot.owner.nonce !== owner.nonce) throw new Error("Configuration lock ownership changed");
      acquired = snapshot;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await recoverDeadLock(lock);
      if (Date.now() >= deadline) fail("CONFIG_BUSY", "账号配置正在保存，请稍后重试。", 409);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { return await work(); } finally { await releaseLock(lock, acquired); }
}
async function saveDocument(owner: CreativeConfigOwner, file: string, document: Document) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(aad(owner));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(document), "utf8"), cipher.final()]);
  const raw = JSON.stringify({ schema: SCHEMA, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }) + "\n";
  if (Buffer.byteLength(raw) > MAX_FILE_BYTES) fail("CONFIG_TOO_LARGE", "账号配置超过保存上限。", 413);
  const temporary = path.join(path.dirname(file), ".config-" + randomUUID() + ".tmp");
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    const directory = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}
function profileView(name: string, profile: Profile | undefined, hydrate: boolean) {
  const config = { ...(profile?.config || { provider: name }) };
  if (hydrate) config.apiKey = profile?.tombstone ? "" : config.apiKey || "";
  else delete config.apiKey;
  return { provider: name, revision: profile?.revision || 0, linked: !!profile?.config.apiKey && !profile.tombstone, tombstone: !!profile?.tombstone, config };
}
function view(owner: CreativeConfigOwner, document: Document, hydrate: boolean) {
  return { accountKey: creativeConfigAccountKey(owner), ownerFingerprint: creativeConfigOwnerFingerprint(owner), accountRevision: document.accountRevision, selection: document.selection,
    profiles: Object.entries(document.profiles).map(([name, profile]) => profileView(name, profile, hydrate)) };
}
async function access<T>(owner: CreativeConfigOwner, work: (file: string) => Promise<T>) {
  checkedOwner(owner);
  try { const root = await privateRoot(); return await work(ownerFile(owner, root)); }
  catch (error) {
    if (error instanceof CreativeConfigProfileError) throw error;
    fail("CONFIG_STORE_UNAVAILABLE", "账号模型配置暂不可读取或保存，请稍后重新载入核对绑定。", 503);
  }
}
export async function getCreativeConfigProfiles(owner: CreativeConfigOwner, hydrate = false) {
  return access(owner, async file => view(owner, await readDocument(owner, file), hydrate));
}
export async function resolveCreativeConfigProfile(owner: CreativeConfigOwner, requestedProvider: unknown) {
  const name = provider(requestedProvider);
  return access(owner, async file => ({ accountKey: creativeConfigAccountKey(owner), ownerFingerprint: creativeConfigOwnerFingerprint(owner), ...profileView(name, (await readDocument(owner, file)).profiles[name], true) }));
}
export async function putCreativeConfigProfile(owner: CreativeConfigOwner, input: unknown) {
  if (!record(input)) fail("CONFIG_INVALID", "模型配置请求格式无效。");
  const name = input.provider === undefined ? undefined : provider(input.provider);
  if (!name && (input.config !== undefined || input.revision !== undefined || input.importOnly !== undefined)) fail("CONFIG_INVALID", "模型配置缺少服务商。");
  if (!name && input.selection === undefined) fail("CONFIG_INVALID", "没有可保存的模型配置。");
  if (input.importOnly !== undefined && typeof input.importOnly !== "boolean") fail("CONFIG_INVALID", "导入方式无效。");
  return access(owner, file => locked(file, async () => {
    const document = await readDocument(owner, file), previous = name ? document.profiles[name] : undefined;
    if (name && input.importOnly && previous) return { ...view(owner, document, false), profile: profileView(name, previous, false), imported: false };
    if (name && input.importOnly && !normalizeConfig(input.config, name).apiKey) return { ...view(owner, document, false), profile: profileView(name, previous, false), imported: false };
    if (name && (!revision(input.revision) || input.revision !== (previous?.revision || 0))) fail("CONFIG_REVISION_CONFLICT", "该 API 绑定已在其他页面更新，请重新载入后重试。", 409);
    if (input.selection !== undefined) {
      if (!revision(input.accountRevision) || input.accountRevision !== document.accountRevision) fail("CONFIG_REVISION_CONFLICT", "模型选择已在其他页面更新，请重新载入后重试。", 409);
      document.selection = normalizeSelection(input.selection, document.selection);
    }
    if (name) {
      const config = normalizeConfig(input.config, name, previous?.config);
      const suppliedKey = record(input.config) && typeof input.config.apiKey === "string" ? input.config.apiKey.trim() : "";
      if (!suppliedKey) {
        if (previous?.config.apiKey) {
          if (["visionBaseUrl", "imageEndpoint"].some(field => config[field] !== previous.config[field])) fail("CONFIG_CREDENTIAL_SCOPE_CHANGED", "接口地址已变化，请填写对应 API Key；原接口绑定仍保留。", 409);
          config.apiKey = previous.config.apiKey;
        } else config.apiKey = "";
      }
      document.profiles[name] = { revision: (previous?.revision || 0) + 1, tombstone: !!previous?.tombstone && !config.apiKey, config };
    }
    document.accountRevision++;
    await saveDocument(owner, file, document);
    return { ...view(owner, document, false), ...(name ? { profile: profileView(name, document.profiles[name], false), imported: !!input.importOnly } : {}) };
  }));
}
export async function unlinkCreativeConfigProfile(owner: CreativeConfigOwner, input: unknown) {
  if (!record(input)) fail("CONFIG_INVALID", "解绑请求格式无效。");
  const name = provider(input.provider);
  return access(owner, file => locked(file, async () => {
    const document = await readDocument(owner, file), previous = document.profiles[name];
    if (!revision(input.revision) || input.revision !== (previous?.revision || 0)) fail("CONFIG_REVISION_CONFLICT", "该 API 绑定已变化，请重新载入后确认解绑。", 409);
    document.profiles[name] = { revision: (previous?.revision || 0) + 1, tombstone: true, config: { ...(previous?.config || { provider: name }), apiKey: "" } };
    document.accountRevision++;
    await saveDocument(owner, file, document);
    return { ...view(owner, document, false), profile: profileView(name, document.profiles[name], false) };
  }));
}
