import "server-only";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, statfs, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";

const PRIVATE_ROOT = "/opt/sanjie-private/image-receipts";
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const ID_FIELDS = ["version", "receiptId", "jobId", "accountKey", "workspaceKey", "taskId", "shotId", "batchId", "planSignatureHash"] as const;
export type CreativeImageReceiptIdentity = {
  version: 1; receiptId: string; jobId: string; accountKey: string; workspaceKey: string;
  taskId: string; shotId: string; batchId: string; planSignatureHash: string;
};
export type ReceiptOwner = { id: string; tenantId: string; username: string };
type Registration = { schema: "SANJIE_IMAGE_REGISTRATION_V1" | "SANJIE_IMAGE_REGISTRATION_BYOK_V1"; dispatchId?: string; ownerSha256: string; identity: CreativeImageReceiptIdentity;
  identitySha256: string; requestSha256: string; createdAt: number; expiresAt: number;
  process: { pid: number; start: string } };
type Media = { kind: "binary"; name: string; mime: string; bytes: number; sha256: string } |
  { kind: "url"; url: string; sha256: string };
type Completion = { schema: "SANJIE_IMAGE_COMPLETION_V1" | "SANJIE_IMAGE_STAGING_V1" | "SANJIE_IMAGE_COMPLETION_BYOK_V1" | "SANJIE_IMAGE_STAGING_BYOK_V1"; registrationSha256: string; billingEventId?: string; dispatchId?: string;
  resultSha256: string; resultBytes: number; media: Media[] };
export type PreparedImageReceipt = { registration: Registration; directory: string };
export type CreativeImageReceiptDescriptor = {
  schema: "SANJIE_IMAGE_RECEIPT_V1" | "SANJIE_IMAGE_RECEIPT_BYOK_V1"; state: "pending" | "unknown" | "interrupted_before_dispatch" | "not-submitted" | "rejected" | "complete"; receipt: CreativeImageReceiptIdentity;
  expiresAt: string; images: string[]; billingEventId?: string; dispatchId?: string; upstreamRejected?: true; httpStatus?: number; resultSha256?: string;
};
const PORTABLE_PROCESS_START = randomUUID();
async function processStart(pid: number) {
  if (process.platform !== "linux") return pid === process.pid ? PORTABLE_PROCESS_START : null;
  try { return (await readFile("/proc/" + pid + "/stat", "utf8")).split(") ").at(-1)!.split(" ")[19]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export class CreativeImageReceiptError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
function need(ok: unknown, code: string, status = 409): asserts ok {
  if (!ok) throw new CreativeImageReceiptError(code, status, "原图片回执需核对，请保留原任务。");
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown) => JSON.stringify(value);
function accountKey(owner: ReceiptOwner) {
  return "user:" + (owner.tenantId + ":" + owner.username).replace(/[^\w@.+:-]/g, "_").slice(0, 120);
}
export function validateCreativeImageReceiptIdentity(value: unknown, owner: ReceiptOwner): CreativeImageReceiptIdentity {
  need(value && typeof value === "object" && !Array.isArray(value), "IMAGE_RECEIPT_IDENTITY_INVALID", 400);
  const raw = value as Record<string, unknown>;
  need(Object.keys(raw).length === ID_FIELDS.length && ID_FIELDS.every(key => Object.hasOwn(raw, key)), "IMAGE_RECEIPT_IDENTITY_INVALID", 400);
  need(raw.version === 1 && typeof raw.receiptId === "string" && UUID.test(raw.receiptId), "IMAGE_RECEIPT_IDENTITY_INVALID", 400);
  const id = {} as Record<string, unknown>;
  for (const key of ID_FIELDS) id[key] = raw[key];
  for (const key of ["jobId", "workspaceKey", "taskId", "shotId", "batchId"] as const) {
    need(typeof id[key] === "string" && (id[key] as string).length <= 240 && /^[A-Za-z0-9_.:@+-]*$/.test(id[key] as string), "IMAGE_RECEIPT_IDENTITY_INVALID", 400);
  }
  need(id.jobId && id.workspaceKey && id.taskId && id.shotId, "IMAGE_RECEIPT_IDENTITY_INVALID", 400);
  need(typeof id.planSignatureHash === "string" && SHA.test(id.planSignatureHash), "IMAGE_RECEIPT_IDENTITY_INVALID", 400);
  need(id.accountKey === accountKey(owner), "IMAGE_RECEIPT_ACCOUNT_CHANGED", 403);
  return id as unknown as CreativeImageReceiptIdentity;
}
export function parseCreativeImageReceiptQuery(request: Request, receiptId: string, owner: ReceiptOwner) {
  const url = new URL(request.url);
  need(UUID.test(receiptId) && url.searchParams.getAll("identity").length === 1 && [...url.searchParams.keys()].every(key => key === "identity"), "IMAGE_RECEIPT_IDENTITY_INVALID", 400);
  const raw = url.searchParams.get("identity")!;
  need(raw.length <= 4096, "IMAGE_RECEIPT_IDENTITY_INVALID", 400);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new CreativeImageReceiptError("IMAGE_RECEIPT_IDENTITY_INVALID", 400, "图片回执身份无效。"); }
  const identity = validateCreativeImageReceiptIdentity(value, owner);
  need(identity.receiptId === receiptId, "IMAGE_RECEIPT_IDENTITY_MISMATCH", 409);
  return identity;
}
export async function creativeImageRequestSha256(endpoint: string, body: BodyInit | undefined) {
  const digest = createHash("sha256").update(endpoint + "\n");
  if (typeof body === "string") digest.update(body);
  else if (body instanceof Uint8Array) digest.update(body);
  else if (typeof FormData !== "undefined" && body instanceof FormData) {
    for (const [name, value] of body.entries()) {
      digest.update(canonical([name, typeof value === "string" ? "text" : "file"]) + "\n");
      if (typeof value === "string") digest.update(canonical(value));
      else digest.update(canonical([value.type, value.size])).update(new Uint8Array(await value.arrayBuffer()));
      digest.update("\n");
    }
  } else throw new CreativeImageReceiptError("IMAGE_RECEIPT_REQUEST_INVALID", 400, "图片回执请求无效。");
  return digest.digest("hex");
}
/** Private binding only: no credential, origin or request body is persisted/exported. */
export async function creativeByokImageRequestSha256(endpoint: string, body: BodyInit | undefined, authorization: string) {
  need(/^Bearer\s+\S+$/i.test(authorization), "IMAGE_RECEIPT_REQUEST_INVALID", 400);
  const request = await creativeImageRequestSha256(new URL(endpoint).href, body);
  return hash(canonical(["SANJIE_BYOK_IMAGE_REQUEST_V1", request, authorization.replace(/^Bearer\s+/i, "")]));
}
/** Reject only recognized pre-acceptance errors; HTTP status alone is not proof. */
export function creativeByokImageDefinitiveRejection(bytes: Uint8Array, status: number) {
  if (bytes.length > 16384 || ![400,401,403,404,413,422,429].includes(status)) return false;
  let value: unknown; try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return false; }
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const acceptedFields = new Set(["id","request_id","task_id","data","choices","video","usage","output","result","results","task","job","image","images"]);
  function accepted(v: unknown): boolean { return Array.isArray(v) ? v.some(accepted) : object(v) && Object.entries(v).some(([key,item]) => acceptedFields.has(key.toLowerCase()) || ["accepted","submitted","providerSubmitted","provider_submitted","success"].includes(key) && item === true || ["status","task_status"].includes(key) && typeof item === "string" && ["accepted","queued","pending","processing","running","completed","succeeded","done"].includes(item.toLowerCase()) || accepted(item)); }
  if (!object(value) || accepted(value)) return false;
  const error = object(value.error) ? value.error : value;
  const code = typeof error.code === "string" ? error.code : typeof error.type === "string" ? error.type : "";
  const allowed = status === 401 || status === 403 ? ["INVALID_API_KEY","API_KEY_DISABLED","API_KEY_EXPIRED","invalid_api_key","invalid_key","api_key_invalid","api_key_expired","api_key_disabled"] : status === 429 ? ["RATE_LIMIT_EXCEEDED","rate_limit_exceeded","RATE_LIMITED","TOO_MANY_REQUESTS","rate_limit_error"] : ["invalid_request_error","model_not_found","MODEL_NOT_FOUND","unsupported_model","INVALID_IMAGE_COUNT","PAYLOAD_TOO_LARGE"];
  return allowed.includes(code);
}
function byok(handle: PreparedImageReceipt) { return handle.registration.schema === "SANJIE_IMAGE_REGISTRATION_BYOK_V1"; }
function binding(handle: PreparedImageReceipt, value: { billingEventId?: string; dispatchId?: string }) {
  return byok(handle) ? typeof value.dispatchId === "string" && UUID.test(value.dispatchId) && value.dispatchId === handle.registration.dispatchId && value.billingEventId === undefined :
    typeof value.billingEventId === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value.billingEventId) && value.dispatchId === undefined;
}
function boundFields(handle: PreparedImageReceipt, token: string) { return byok(handle) ? { dispatchId: token } : { billingEventId: token }; }
function imageMime(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString())) return "image/gif";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
  throw new CreativeImageReceiptError("IMAGE_RECEIPT_MEDIA_INVALID", 502, "原图片结果格式需核对。");
}
function mediaUrl(value: unknown) {
  need(typeof value === "string" && value.length <= 8192, "IMAGE_RECEIPT_MEDIA_INVALID", 502);
  let url: URL;
  try { url = new URL(value); } catch { throw new CreativeImageReceiptError("IMAGE_RECEIPT_MEDIA_INVALID", 502, "原图片地址需核对。"); }
  need(url.protocol === "https:" && !url.username && !url.password && !url.hash && (!url.port || url.port === "443") &&
    url.hostname.includes(".") && !isIP(url.hostname.replace(/^\[|\]$/g, "")) &&
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) && !/\.(?:local|internal)$/.test(url.hostname) &&
    ![...url.searchParams.keys()].some(key => /^(?:api[-_]?key|key|authorization|access[-_]?token)$/i.test(key)), "IMAGE_RECEIPT_MEDIA_INVALID", 502);
  return url.href;
}
/** File-only store. No application/Prisma/provider/billing module is imported. */
export class CreativeImageReceiptStore {
  constructor(private readonly root = PRIVATE_ROOT, private readonly now: () => number = Date.now) {}
  private async directory(ownerId: string, identity: CreativeImageReceiptIdentity, create = false) {
    need(typeof ownerId === "string" && ownerId.length > 0 && ownerId.length <= 160, "IMAGE_RECEIPT_OWNER_INVALID", 403);
    const uid = process.getuid?.();
    need(uid !== undefined, "IMAGE_RECEIPT_PRIVATE_STORE_UNAVAILABLE", 503);
    let cursor = this.root;
    if (create) await mkdir(cursor, { recursive: true, mode: 0o700 });
    const parent = await lstat(path.dirname(cursor));
    need(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === uid && (parent.mode & 0o777) === 0o700, "IMAGE_RECEIPT_PRIVATE_DIRECTORY_REJECTED", 503);
    for (const suffix of ["", hash(ownerId), identity.receiptId]) {
      if (suffix) { cursor = path.join(cursor, suffix); if (create) await mkdir(cursor, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; }); }
      const stat = await lstat(cursor);
      need(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o777) === 0o700, "IMAGE_RECEIPT_PRIVATE_DIRECTORY_REJECTED", 503);
    }
    return cursor;
  }
  private async read(directory: string, name: string, maxBytes: number) {
    const fd = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await fd.stat();
      need(stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.nlink === 1 && stat.size <= maxBytes, "IMAGE_RECEIPT_PRIVATE_FILE_REJECTED", 503);
      const bytes = await fd.readFile();
      need(bytes.length <= maxBytes, "IMAGE_RECEIPT_PRIVATE_FILE_REJECTED", 503);
      return bytes;
    } finally { await fd.close(); }
  }
  private async exclusive(directory: string, name: string, bytes: Uint8Array) {
    const temporary = ".pending-" + randomUUID();
    const fd = await open(path.join(directory, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
    try {
      await link(path.join(directory, temporary), path.join(directory, name));
      await unlink(path.join(directory, temporary));
      const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await dir.sync(); } finally { await dir.close(); }
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    finally { await unlink(path.join(directory, temporary)).catch(() => undefined); }
  }
  private async registration(ownerId: string, identity: CreativeImageReceiptIdentity, requestSha256?: string): Promise<PreparedImageReceipt> {
    let directory: string;
    try { directory = await this.directory(ownerId, identity); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CreativeImageReceiptError("IMAGE_RECEIPT_NOT_FOUND", 404, "原图片回执尚未找到，请保留原任务。"); throw error; }
    let raw: Buffer;
    try { raw = await this.read(directory, "registration.json", 8192); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CreativeImageReceiptError("IMAGE_RECEIPT_NOT_FOUND", 404, "原图片回执尚未找到，请保留原任务。"); throw error; }
    const registration = JSON.parse(raw.toString()) as Registration;
    need(((registration.schema === "SANJIE_IMAGE_REGISTRATION_V1" && registration.dispatchId === undefined) ||
      (registration.schema === "SANJIE_IMAGE_REGISTRATION_BYOK_V1" && typeof registration.dispatchId === "string" && UUID.test(registration.dispatchId))) && registration.ownerSha256 === hash(ownerId) &&
      canonical(registration.identity) === canonical(identity) && registration.identitySha256 === hash(canonical(identity)) &&
      SHA.test(registration.requestSha256) && (!requestSha256 || registration.requestSha256 === requestSha256) &&
      Number.isSafeInteger(registration.createdAt) && Number.isSafeInteger(registration.expiresAt) &&
      registration.expiresAt - registration.createdAt === TTL_MS && Number.isSafeInteger(registration.process?.pid) &&
      registration.process.pid > 0 && typeof registration.process.start === "string" && registration.process.start.length <= 64,
      "IMAGE_RECEIPT_IDENTITY_MISMATCH", 409);
    need(this.now() < registration.expiresAt, "IMAGE_RECEIPT_EXPIRED", 410);
    return { directory, registration };
  }
  async register(owner: ReceiptOwner, value: unknown, idempotencyKey: string | undefined, requestSha256: string) {
    const identity = validateCreativeImageReceiptIdentity(value, owner);
    need(idempotencyKey === identity.receiptId && SHA.test(requestSha256), "IMAGE_RECEIPT_REQUEST_ID_MISMATCH", 400);
    const directory = await this.directory(owner.id, identity, true);
    // Existing immutable registrations must never create another dispatch, even
    // when capacity later becomes low. GET recovery is independent of disk free.
    try {
      const handle = await this.registration(owner.id, identity, requestSha256);
      need(!byok(handle), "IMAGE_RECEIPT_REQUEST_CHANNEL_MISMATCH", 409);
      return { created: false, handle, descriptor: await this.descriptor(owner.id, identity) };
    } catch (error) { if (!(error instanceof CreativeImageReceiptError && error.code === "IMAGE_RECEIPT_NOT_FOUND")) throw error; }
    const capacity = await statfs(this.root);
    need(capacity.bavail * capacity.bsize >= MAX_RESULT_BYTES * 2 + 65536, "IMAGE_RECEIPT_PRIVATE_CAPACITY_UNAVAILABLE", 503);
    const createdAt = this.now();
    const registration: Registration = { schema: "SANJIE_IMAGE_REGISTRATION_V1", ownerSha256: hash(owner.id), identity,
      identitySha256: hash(canonical(identity)), requestSha256, createdAt, expiresAt: createdAt + TTL_MS,
      process: { pid: process.pid, start: (await processStart(process.pid))! } };
    const created = await this.exclusive(directory, "registration.json", Buffer.from(canonical(registration)));
    const handle = await this.registration(owner.id, identity, requestSha256);
    need(!byok(handle), "IMAGE_RECEIPT_REQUEST_CHANNEL_MISMATCH", 409);
    return { created, handle, descriptor: created ? undefined : await this.descriptor(owner.id, identity) };
  }
  async registerByok(owner: ReceiptOwner, value: unknown, idempotencyKey: string | undefined, requestSha256: string) {
    const identity = validateCreativeImageReceiptIdentity(value, owner);
    need(idempotencyKey === identity.receiptId && SHA.test(requestSha256), "IMAGE_RECEIPT_REQUEST_ID_MISMATCH", 400);
    const directory = await this.directory(owner.id, identity, true);
    try {
      const handle = await this.registration(owner.id, identity, requestSha256);
      need(byok(handle), "IMAGE_RECEIPT_REQUEST_CHANNEL_MISMATCH", 409);
      return { created: false, handle, descriptor: await this.descriptor(owner.id, identity) };
    } catch (error) { if (!(error instanceof CreativeImageReceiptError && error.code === "IMAGE_RECEIPT_NOT_FOUND")) throw error; }
    const capacity = await statfs(this.root);
    need(capacity.bavail * capacity.bsize >= MAX_RESULT_BYTES * 2 + 65536, "IMAGE_RECEIPT_PRIVATE_CAPACITY_UNAVAILABLE", 503);
    const createdAt = this.now();
    const registration: Registration = { schema: "SANJIE_IMAGE_REGISTRATION_BYOK_V1", dispatchId: randomUUID(), ownerSha256: hash(owner.id), identity,
      identitySha256: hash(canonical(identity)), requestSha256, createdAt, expiresAt: createdAt + TTL_MS,
      process: { pid: process.pid, start: (await processStart(process.pid))! } };
    const created = await this.exclusive(directory, "registration.json", Buffer.from(canonical(registration)));
    const handle = await this.registration(owner.id, identity, requestSha256);
    need(byok(handle), "IMAGE_RECEIPT_REQUEST_CHANNEL_MISMATCH", 409);
    return { created, handle, descriptor: created ? undefined : await this.descriptor(owner.id, identity) };
  }
  private async completion(handle: PreparedImageReceipt, staging = false) {
    let raw: Buffer;
    try { raw = await this.read(handle.directory, staging ? "staging.json" : "completion.json", 262144); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const value = JSON.parse(raw.toString()) as Completion;
    need(value.schema === (byok(handle) ? staging ? "SANJIE_IMAGE_STAGING_BYOK_V1" : "SANJIE_IMAGE_COMPLETION_BYOK_V1" : staging ? "SANJIE_IMAGE_STAGING_V1" : "SANJIE_IMAGE_COMPLETION_V1") && value.registrationSha256 === hash(canonical(handle.registration)) &&
      binding(handle, value) && SHA.test(value.resultSha256) &&
      Number.isSafeInteger(value.resultBytes) && value.resultBytes > 0 && value.resultBytes <= MAX_RESULT_BYTES &&
      Array.isArray(value.media) && value.media.length > 0 && value.media.length <= 20, "IMAGE_RECEIPT_COMPLETION_INVALID", 503);
    const publicResponse = await this.read(handle.directory, "response.json", MAX_RESULT_BYTES);
    need(publicResponse.length === value.resultBytes && hash(publicResponse) === value.resultSha256, "IMAGE_RECEIPT_RESULT_DIGEST_MISMATCH", 503);
    for (const [index, media] of value.media.entries()) {
      need(SHA.test(media.sha256) && ((media.kind === "binary" && media.name === index + ".bin" && /^image\/(png|jpeg|gif|webp)$/.test(media.mime) && Number.isSafeInteger(media.bytes) && media.bytes > 0 && media.bytes <= MAX_RESULT_BYTES) ||
        (media.kind === "url" && mediaUrl(media.url) === media.url && hash(media.url) === media.sha256)), "IMAGE_RECEIPT_COMPLETION_INVALID", 503);
    }
    return value;
  }
  private contentUrls(identity: CreativeImageReceiptIdentity, media: Media[]) {
    const query = "?identity=" + encodeURIComponent(canonical(identity));
    return media.map((item, index) => item.kind === "url" ? item.url : "/api/creative/image-receipts/" + identity.receiptId + "/content/" + index + query);
  }
  private async phase(handle: PreparedImageReceipt): Promise<{ state: CreativeImageReceiptDescriptor["state"]; billingEventId?: string; dispatchId?: string; upstreamRejected?: true; httpStatus?: number }> {
    if (byok(handle)) {
      let raw: Buffer | null = null;
      try { raw = await this.read(handle.directory, "rejection.json", 4096); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (raw) {
        const rejected = JSON.parse(raw.toString());
        need(rejected.registrationSha256 === hash(canonical(handle.registration)) && binding(handle,rejected) && rejected.upstreamRejected === true && [400,401,403,404,413,422,429].includes(rejected.httpStatus), "IMAGE_RECEIPT_COMPLETION_INVALID",503);
        return { state: "rejected", dispatchId: rejected.dispatchId, upstreamRejected: true, httpStatus: rejected.httpStatus };
      }
    }
    for (const name of ["dispatch.json", "failure.json"] as const) {
      let value: Record<string, unknown>;
      try { value = JSON.parse((await this.read(handle.directory, name, 4096)).toString()); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      need(value.registrationSha256 === hash(canonical(handle.registration)), "IMAGE_RECEIPT_IDENTITY_MISMATCH", 503);
      if (name === "dispatch.json") {
        need(binding(handle,value), "IMAGE_RECEIPT_COMPLETION_INVALID", 503);
        return { state: "unknown" as const, ...(byok(handle) ? {dispatchId: value.dispatchId as string} : {billingEventId:value.billingEventId as string}) };
      }
      need(value.providerSubmitted === false && typeof value.code === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(value.code), "IMAGE_RECEIPT_COMPLETION_INVALID", 503);
      return { state: "not-submitted" as const };
    }
    const alive = await processStart(handle.registration.process.pid) === handle.registration.process.start;
    return { state: alive ? "pending" as const : "interrupted_before_dispatch" as const };
  }
  async markDispatch(handle: PreparedImageReceipt, billingEventId: string) {
    need(/^[A-Za-z0-9_.:-]{1,160}$/.test(billingEventId), "IMAGE_RECEIPT_REQUEST_INVALID", 400);
    const data = { registrationSha256: hash(canonical(handle.registration)), billingEventId };
    if (!await this.exclusive(handle.directory, "dispatch.json", Buffer.from(canonical(data)))) {
      need((await this.phase(handle)).billingEventId === billingEventId, "IMAGE_RECEIPT_IDENTITY_MISMATCH", 409);
    }
  }
  async markByokDispatch(handle: PreparedImageReceipt) {
    need(byok(handle), "IMAGE_RECEIPT_REQUEST_CHANNEL_MISMATCH", 409);
    const data = {registrationSha256:hash(canonical(handle.registration)),dispatchId:handle.registration.dispatchId!};
    if (!await this.exclusive(handle.directory,"dispatch.json",Buffer.from(canonical(data)))) {
      need((await this.phase(handle)).dispatchId === data.dispatchId,"IMAGE_RECEIPT_IDENTITY_MISMATCH",409);
    }
  }
  /** A complete upstream 4xx rejection is distinct from local never-dispatched proof. */
  async markByokRejected(handle: PreparedImageReceipt, httpStatus: number) {
    need(byok(handle) && [400,401,403,404,413,422,429].includes(httpStatus) && (await this.phase(handle)).dispatchId === handle.registration.dispatchId,"IMAGE_RECEIPT_REQUEST_INVALID",409);
    const data = {registrationSha256:hash(canonical(handle.registration)),dispatchId:handle.registration.dispatchId!,upstreamRejected:true,httpStatus};
    if (!await this.exclusive(handle.directory,"rejection.json",Buffer.from(canonical(data)))) {
      const phase = await this.phase(handle); need(phase.state === "rejected" && phase.httpStatus === httpStatus,"IMAGE_RECEIPT_IDENTITY_MISMATCH",409);
    }
  }
  async markNotSubmitted(handle: PreparedImageReceipt, code: string) {
    need(/^[A-Z][A-Z0-9_]{1,80}$/.test(code), "IMAGE_RECEIPT_REQUEST_INVALID", 400);
    const phase = await this.phase(handle);
    need(phase.state !== "unknown", "IMAGE_RECEIPT_DISPATCH_UNCERTAIN", 409);
    await this.exclusive(handle.directory, "failure.json", Buffer.from(canonical({ registrationSha256: hash(canonical(handle.registration)), providerSubmitted: false, code })));
  }
  async descriptor(ownerId: string, identity: CreativeImageReceiptIdentity): Promise<CreativeImageReceiptDescriptor> {
    const handle = await this.registration(ownerId, identity);
    const completion = await this.completion(handle);
    const phase = completion ? null : await this.phase(handle);
    return { schema: byok(handle) ? "SANJIE_IMAGE_RECEIPT_BYOK_V1" : "SANJIE_IMAGE_RECEIPT_V1", state: completion ? "complete" : phase!.state, receipt: identity,
      expiresAt: new Date(handle.registration.expiresAt).toISOString(), images: completion ? this.contentUrls(identity, completion.media) : [],
      ...(completion ? { ...boundFields(handle, byok(handle) ? completion.dispatchId! : completion.billingEventId!), resultSha256: completion.resultSha256 } : phase ? { ...(phase.billingEventId ? {billingEventId:phase.billingEventId} : {}), ...(phase.dispatchId ? {dispatchId:phase.dispatchId} : {}), ...(phase.upstreamRejected ? {upstreamRejected:true,httpStatus:phase.httpStatus} : {}) } : {}) };
  }
  async stage(handle: PreparedImageReceipt, publicBytes: Uint8Array, billingEventId: string): Promise<void> {
    const phase = await this.phase(handle);
    need((byok(handle) ? phase.dispatchId === billingEventId && phase.state === "unknown" : phase.billingEventId === billingEventId), "IMAGE_RECEIPT_IDENTITY_MISMATCH", 409);
    need(publicBytes.length > 0 && publicBytes.length <= MAX_RESULT_BYTES && /^[A-Za-z0-9_.:-]{1,160}$/.test(billingEventId), "IMAGE_RECEIPT_RESULT_INVALID", 502);
    const data: unknown = JSON.parse(new TextDecoder().decode(publicBytes));
    need(data && typeof data === "object" && !Array.isArray(data), "IMAGE_RECEIPT_RESULT_INVALID", 502);
    const raw = data as Record<string, unknown>;
    need(Array.isArray(raw.data) && raw.data.length > 0 && raw.data.length <= 20, "IMAGE_RECEIPT_RESULT_INVALID", 502);
    const media: Media[] = [];
    const results: Record<string, string>[] = [];
    for (const [index, entry] of raw.data.entries()) {
      need(entry && typeof entry === "object" && !Array.isArray(entry), "IMAGE_RECEIPT_MEDIA_INVALID", 502);
      if (typeof entry.b64_json === "string") {
        need(entry.b64_json.length > 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(entry.b64_json), "IMAGE_RECEIPT_MEDIA_INVALID", 502);
        const bytes = Buffer.from(entry.b64_json, "base64");
        need(bytes.length > 0 && bytes.length <= MAX_RESULT_BYTES && bytes.toString("base64") === entry.b64_json, "IMAGE_RECEIPT_MEDIA_INVALID", 502);
        const mime = imageMime(bytes), name = index + ".bin", sha256 = hash(bytes);
        const created = await this.exclusive(handle.directory, name, bytes);
        if (!created) need(hash(await this.read(handle.directory, name, MAX_RESULT_BYTES)) === sha256, "IMAGE_RECEIPT_RESULT_CONFLICT", 409);
        media.push({ kind: "binary", name, mime, bytes: bytes.length, sha256 }); results.push({ b64_json: entry.b64_json });
      } else {
        const url = mediaUrl(entry.url);
        media.push({ kind: "url", url, sha256: hash(url) }); results.push({ url });
      }
    }
    // Deliberate projection: neither prompts/revised_prompt nor API credentials/usage are persisted.
    const response = Buffer.from(canonical({ ...(typeof raw.created === "number" && Number.isSafeInteger(raw.created) ? { created: raw.created } : {}),
      ...(typeof raw.model === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(raw.model) ? { model: raw.model } : {}), data: results }));
    need(response.length <= MAX_RESULT_BYTES, "IMAGE_RECEIPT_RESULT_INVALID", 502);
    const resultSha256 = hash(response);
    if (!await this.exclusive(handle.directory, "response.json", response)) need(hash(await this.read(handle.directory, "response.json", MAX_RESULT_BYTES)) === resultSha256, "IMAGE_RECEIPT_RESULT_CONFLICT", 409);
    const completion: Completion = { schema: byok(handle) ? "SANJIE_IMAGE_STAGING_BYOK_V1" : "SANJIE_IMAGE_STAGING_V1", registrationSha256: hash(canonical(handle.registration)), ...boundFields(handle,billingEventId), resultSha256, resultBytes: response.length, media };
    if (!await this.exclusive(handle.directory, "staging.json", Buffer.from(canonical(completion)))) {
      const old = await this.completion(handle, true);
      need(old && canonical(old) === canonical(completion), "IMAGE_RECEIPT_RESULT_CONFLICT", 409);
    }
  }
  async stageByok(handle: PreparedImageReceipt, publicBytes: Uint8Array) {
    need(byok(handle), "IMAGE_RECEIPT_REQUEST_CHANNEL_MISMATCH", 409);
    return this.stage(handle, publicBytes, handle.registration.dispatchId!);
  }
  async completeByok(handle: PreparedImageReceipt) {
    need(byok(handle), "IMAGE_RECEIPT_REQUEST_CHANNEL_MISMATCH", 409);
    return this.complete(handle, handle.registration.dispatchId!);
  }
  /** Platform callers invoke this only after unchanged settlement confirms success. */
  async complete(handle: PreparedImageReceipt, billingEventId: string): Promise<CreativeImageReceiptDescriptor> {
    const staged = await this.completion(handle, true);
    const phase = await this.phase(handle);
    need(staged && (byok(handle) ? staged.dispatchId === billingEventId && phase.dispatchId === billingEventId && phase.state === "unknown" : staged.billingEventId === billingEventId && phase.billingEventId === billingEventId), "IMAGE_RECEIPT_IDENTITY_MISMATCH", 409);
    // Check the full media digest before the small immutable complete marker is
    // visible. A staging marker alone never exposes a successful result.
    for (const media of staged.media) {
      if (media.kind === "binary") {
        const bytes = await this.read(handle.directory, media.name, MAX_RESULT_BYTES);
        need(bytes.length === media.bytes && hash(bytes) === media.sha256, "IMAGE_RECEIPT_CONTENT_DIGEST_MISMATCH", 503);
      }
    }
    const completion: Completion = { ...staged, schema: byok(handle) ? "SANJIE_IMAGE_COMPLETION_BYOK_V1" : "SANJIE_IMAGE_COMPLETION_V1" };
    if (!await this.exclusive(handle.directory, "completion.json", Buffer.from(canonical(completion)))) {
      const old = await this.completion(handle);
      need(old && canonical(old) === canonical(completion), "IMAGE_RECEIPT_RESULT_CONFLICT", 409);
    }
    return this.descriptorByHandle(handle);
  }
  private async descriptorByHandle(handle: PreparedImageReceipt): Promise<CreativeImageReceiptDescriptor> {
    need(this.now() < handle.registration.expiresAt, "IMAGE_RECEIPT_EXPIRED", 410);
    const completion = await this.completion(handle);
    need(completion, "IMAGE_RECEIPT_COMPLETION_INVALID", 503);
    return { schema: byok(handle) ? "SANJIE_IMAGE_RECEIPT_BYOK_V1" : "SANJIE_IMAGE_RECEIPT_V1", state: "complete", receipt: handle.registration.identity,
      expiresAt: new Date(handle.registration.expiresAt).toISOString(), images: this.contentUrls(handle.registration.identity, completion.media),
      ...boundFields(handle,byok(handle) ? completion.dispatchId! : completion.billingEventId!), resultSha256: completion.resultSha256 };
  }
  async content(ownerId: string, identity: CreativeImageReceiptIdentity, index: number) {
    const handle = await this.registration(ownerId, identity), completion = await this.completion(handle);
    need(completion && Number.isSafeInteger(index) && index >= 0 && index < completion.media.length, "IMAGE_RECEIPT_CONTENT_NOT_FOUND", 404);
    const media = completion.media[index];
    if (media.kind === "url") return { kind: "url" as const, url: media.url };
    const bytes = await this.read(handle.directory, media.name, MAX_RESULT_BYTES);
    need(bytes.length === media.bytes && hash(bytes) === media.sha256, "IMAGE_RECEIPT_CONTENT_DIGEST_MISMATCH", 503);
    return { kind: "binary" as const, bytes, mime: media.mime, sha256: media.sha256 };
  }
}
export const creativeImageReceiptStore = new CreativeImageReceiptStore();
