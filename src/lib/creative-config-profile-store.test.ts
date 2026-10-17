import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

vi.mock("server-only", () => ({}));
const lockFixture = vi.hoisted(() => ({
  proc: new Map<string, string | NodeJS.ErrnoException>(),
  beforeProcRead: undefined as ((file: string) => Promise<void>) | undefined,
  beforeRename: undefined as ((from: string, to: string) => Promise<void>) | undefined
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (typeof args[0] === "string" && args[0].startsWith("/proc/")) {
        await lockFixture.beforeProcRead?.(args[0]);
        const value = lockFixture.proc.get(args[0]);
        if (value instanceof Error) throw value;
        if (typeof value === "string") return value;
      }
      return actual.readFile(...args);
    },
    readlink: async (...args: Parameters<typeof actual.readlink>) => {
      const value = typeof args[0] === "string" ? lockFixture.proc.get(args[0]) : undefined;
      if (value instanceof Error) throw value;
      if (typeof value === "string") return value;
      return actual.readlink(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await lockFixture.beforeRename?.(String(args[0]), String(args[1]));
      return actual.rename(...args);
    }
  };
});
import { creativeConfigAccountKey, creativeConfigOwnerFingerprint, getCreativeConfigProfileRoot, getCreativeConfigProfiles, putCreativeConfigProfile,
  resolveCreativeConfigProfile, unlinkCreativeConfigProfile } from "./creative-config-profile-store";

const alice = { id: "immutable-alice", tenantId: "tenant-a", username: "alice" };
const bob = { id: "immutable-bob", tenantId: "tenant-b", username: "bob" };
const apiKey = "synthetic-only-private-image-key";
const config = { provider: "openai", apiKey, visionBaseUrl: "https://api.openai.com/v1", imageEndpoint: "https://api.openai.com/v1/images/generations", imageModel: "gpt-image-1" };

describe("durable account-owned creative API profiles", () => {
  let temporary: string, root: string;
  beforeEach(async () => {
    lockFixture.proc.clear(); lockFixture.beforeProcRead = undefined; lockFixture.beforeRename = undefined;
    temporary = await realpath(await mkdtemp(path.join(tmpdir(), "creative-config-store-")));
    root = path.join(temporary, "profiles");
    vi.stubEnv("SANJIE_CREATIVE_CONFIG_ROOT", root);
    vi.stubEnv("AI_API_ENCRYPTION_KEY", "synthetic-independent-ai-key-0123456789abcdef");
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(temporary, { recursive: true, force: true }); });
  const save = (revision = 0, patch: object = {}) => putCreativeConfigProfile(alice, { provider: "openai", revision, config, ...patch });
  async function files() { return (await readdir(root)).filter(name => name.endsWith(".json")); }
  async function onlyFile() { return path.join(root, (await files())[0]); }
  const bootId = "11111111-1111-4111-8111-111111111111", pidNamespace = "pid:[4026531836]", deadPid = 2147480000;
  const ownerNonce = "22222222-2222-4222-8222-222222222222";
  function procStat(pid: number, ticks: string) { return `${pid} (synthetic (worker)) S ${Array(18).fill("0").join(" ")} ${ticks} 0`; }
  function mockLinuxOwner(pid = deadPid, startTicks = "123") {
    lockFixture.proc.set("/proc/sys/kernel/random/boot_id", bootId);
    lockFixture.proc.set(`/proc/${process.pid}/ns/pid`, pidNamespace);
    lockFixture.proc.set(`/proc/${process.pid}/stat`, procStat(process.pid, "456"));
    return { version: 1, pid, nonce: ownerNonce, linux: { bootId, pidNamespace, startTicks } };
  }
  function busyImmediately() { let calls = 0; vi.spyOn(Date, "now").mockImplementation(() => ++calls * 5001); }
  async function createLock(file: string, owner: unknown) {
    const lock = file + ".lock"; await mkdir(lock, { mode: 0o700 });
    if (owner !== undefined) await writeFile(path.join(lock, "owner.json"), typeof owner === "string" ? owner : JSON.stringify(owner), { mode: 0o600 });
    return lock;
  }

  it("uses a stable home root without cwd and preserves the published expected-account spelling", () => {
    vi.stubEnv("SANJIE_CREATIVE_CONFIG_ROOT", "");
    expect(getCreativeConfigProfileRoot()).toBe(path.join(homedir(), ".config", "shaozhuangai", "creative-config-profiles"));
    expect(creativeConfigAccountKey({ ...alice, tenantId: "tenant/a", username: "a+b@example.test" })).toBe("user:tenant_a:a+b@example.test");
  });

  it("encrypts the complete document with private permissions and returns plaintext only on explicit hydration", async () => {
    const saved = await save();
    expect(saved).toMatchObject({ accountKey: "user:tenant-a:alice", ownerFingerprint: creativeConfigOwnerFingerprint(alice), accountRevision: 1, profile: { revision: 1, linked: true, tombstone: false } });
    expect(JSON.stringify(saved)).not.toContain(apiKey);
    expect(saved.profiles[0].config).not.toHaveProperty("apiKey");
    const file = await onlyFile(), raw = await readFile(file, "utf8");
    expect(raw).not.toContain(apiKey); expect(raw).not.toContain(config.imageEndpoint);
    expect(JSON.parse(raw)).toMatchObject({ schema: "SANJIE_CREATIVE_CONFIG_PROFILES_V1", iv: expect.any(String), tag: expect.any(String), ciphertext: expect.any(String) });
    expect((await lstat(root)).mode & 0o777).toBe(0o700); expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect(await resolveCreativeConfigProfile(alice, "openai")).toMatchObject({ revision: 1, config });
    expect((await getCreativeConfigProfiles(alice, true)).profiles[0].config.apiKey).toBe(apiKey);
    expect(await readdir(root)).toHaveLength(1);
  });

  it.each([undefined, "", "   "])("retains the saved Key when saving an omitted/empty Key %j", async value => {
    await save();
    const patch = { imageModel: "edited-model", ...(value === undefined ? {} : { apiKey: value }) };
    await save(1, { config: patch });
    expect(await resolveCreativeConfigProfile(alice, "openai")).toMatchObject({ revision: 2, config: { apiKey, imageModel: "edited-model" } });
  });

  it("rejects an endpoint change with an omitted Key instead of moving or deleting the binding", async () => {
    await save(); const file = await onlyFile(), before = await readFile(file);
    await expect(save(1, { config: { imageEndpoint: "https://other.example.test/v1/images/generations" } })).rejects.toMatchObject({ code: "CONFIG_CREDENTIAL_SCOPE_CHANGED", status: 409 });
    expect(await readFile(file)).toEqual(before);
    expect((await resolveCreativeConfigProfile(alice, "openai")).config).toMatchObject(config);
  });

  it("allows an explicitly supplied replacement Key for a newly confirmed endpoint", async () => {
    await save();
    await save(1, { config: { imageEndpoint: "https://other.example.test/v1/images/generations", apiKey: "synthetic-new-binding" } });
    expect((await resolveCreativeConfigProfile(alice, "openai")).config).toMatchObject({ apiKey: "synthetic-new-binding", imageEndpoint: "https://other.example.test/v1/images/generations" });
  });

  it("preserves both providers through provider, wallet and model selection changes without an expiry", async () => {
    await save();
    await putCreativeConfigProfile(alice, { provider: "doubao", revision: 0, config: { apiKey: "synthetic-doubao", imageModel: "seedream" } });
    await putCreativeConfigProfile(alice, { accountRevision: 2, selection: { activeProvider: "openai-compatible", activeSupplyChannel: "platform_wallet", platformWalletConfig: { provider: "openai-compatible", imageModel: "image2" } } });
    await putCreativeConfigProfile(alice, { accountRevision: 3, selection: { activeProvider: "doubao", activeSupplyChannel: "external_key" } });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000 * 60 * 60 * 24 * 365 * 20);
    const hydrated = await getCreativeConfigProfiles(alice, true);
    expect(hydrated.profiles.map(profile => profile.config.apiKey).sort()).toEqual([apiKey, "synthetic-doubao"].sort());
    expect(hydrated.selection).toMatchObject({ activeProvider: "doubao", activeSupplyChannel: "external_key" });
  });

  it("scopes ciphertext to immutable user and tenant identities even when the visible username is the same", async () => {
    await save(); const fileA = await onlyFile();
    expect((await getCreativeConfigProfiles({ ...bob, username: alice.username }, true)).profiles).toEqual([]);
    await putCreativeConfigProfile({ ...bob, username: alice.username }, { provider: "openai", revision: 0, config: { ...config, apiKey: "synthetic-bob" } });
    const fileB = path.join(root, (await files()).find(name => path.join(root, name) !== fileA)!);
    await copyFile(fileA, fileB); const copied = await readFile(fileB);
    await expect(getCreativeConfigProfiles({ ...bob, username: alice.username }, true)).rejects.toMatchObject({ status: 503 });
    expect(await readFile(fileB)).toEqual(copied);
    expect((await resolveCreativeConfigProfile(alice, "openai")).config.apiKey).toBe(apiKey);
  });

  it("keeps the same immutable user's binding after a username change", async () => {
    await save();
    expect((await resolveCreativeConfigProfile({ ...alice, username: "alice-renamed" }, "openai")).config.apiKey).toBe(apiKey);
    expect(await files()).toHaveLength(1);
    expect(creativeConfigOwnerFingerprint({ ...alice, username: "alice-renamed" })).toBe(creativeConfigOwnerFingerprint(alice));
  });

  it("keeps replacement users with the same tenant and visible username separate by immutable owner fingerprint", async () => {
    await save(); const replacement = { ...alice, id: "immutable-replacement-alice" };
    expect(creativeConfigAccountKey(replacement)).toBe(creativeConfigAccountKey(alice));
    expect(creativeConfigOwnerFingerprint(replacement)).not.toBe(creativeConfigOwnerFingerprint(alice));
    expect(await getCreativeConfigProfiles(replacement, true)).toMatchObject({ ownerFingerprint: creativeConfigOwnerFingerprint(replacement), profiles: [] });
    await putCreativeConfigProfile(replacement, { provider: "openai", revision: 0, config: { ...config, apiKey: "synthetic-new-user-binding" } });
    expect(await resolveCreativeConfigProfile(alice, "openai")).toMatchObject({ ownerFingerprint: creativeConfigOwnerFingerprint(alice), config: { apiKey } });
    expect(await resolveCreativeConfigProfile(replacement, "openai")).toMatchObject({ ownerFingerprint: creativeConfigOwnerFingerprint(replacement), config: { apiKey: "synthetic-new-user-binding" } });
    expect(await files()).toHaveLength(2);
  });

  it("serializes concurrent provider writes without losing either binding", async () => {
    await Promise.all([save(), putCreativeConfigProfile(alice, { provider: "doubao", revision: 0, config: { apiKey: "synthetic-doubao" } })]);
    const current = await getCreativeConfigProfiles(alice, true);
    expect(current.accountRevision).toBe(2); expect(current.profiles).toHaveLength(2);
    expect(current.profiles.find(profile => profile.provider === "openai")?.config.apiKey).toBe(apiKey);
  });

  it("permits exactly one same-revision writer and rejects the stale writer without changing the Key", async () => {
    await save();
    const results = await Promise.allSettled([save(1, { config: { imageModel: "first" } }), save(1, { config: { imageModel: "second" } })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ code: "CONFIG_REVISION_CONFLICT", status: 409 });
    expect(await resolveCreativeConfigProfile(alice, "openai")).toMatchObject({ revision: 2, config: { apiKey } });
  });

  it("recovers a proven-dead owner without expiring the account binding and retains a private recovery tombstone", async () => {
    await save(); const file = await onlyFile(), owner = mockLinuxOwner();
    lockFixture.proc.set(`/proc/${deadPid}/stat`, Object.assign(new Error("gone"), { code: "ENOENT" }));
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    const lock = await createLock(file, owner), ownerRaw = await readFile(path.join(lock, "owner.json"));
    await save(1, { config: { imageModel: "after-process-crash" } });
    expect(await resolveCreativeConfigProfile(alice, "openai")).toMatchObject({ revision: 2, config: { apiKey, imageModel: "after-process-crash" } });
    const recovered = lock + ".recovered-" + ownerNonce;
    expect(await readFile(path.join(recovered, "owner.json"))).toEqual(ownerRaw);
    expect((await lstat(recovered)).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(recovered, "owner.json"))).mode & 0o777).toBe(0o600);
    await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recognizes a reused PID only through a different Linux process start identity", async () => {
    await save(); const file = await onlyFile(), owner = mockLinuxOwner();
    lockFixture.proc.set(`/proc/${deadPid}/stat`, procStat(deadPid, "999"));
    const kill = vi.spyOn(process, "kill"); await createLock(file, owner);
    await save(1, { config: { imageModel: "pid-was-reused" } });
    expect(kill).not.toHaveBeenCalled();
    expect(await resolveCreativeConfigProfile(alice, "openai")).toMatchObject({ revision: 2, config: { apiKey, imageModel: "pid-was-reused" } });
  });

  it("keeps cross-writer CAS intact when concurrent callers recover the same dead owner", async () => {
    await save(); const file = await onlyFile(), owner = mockLinuxOwner();
    lockFixture.proc.set(`/proc/${deadPid}/stat`, Object.assign(new Error("gone"), { code: "ENOENT" }));
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    const lock = await createLock(file, owner);
    const results = await Promise.allSettled([save(1, { config: { imageModel: "recovered-first" } }), save(1, { config: { imageModel: "recovered-second" } })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ code: "CONFIG_REVISION_CONFLICT" });
    expect(await resolveCreativeConfigProfile(alice, "openai")).toMatchObject({ revision: 2, config: { apiKey } });
    expect((await readdir(root)).filter(name => name.includes(".recovered-"))).toEqual([path.basename(lock) + ".recovered-" + ownerNonce]);
  });

  it("never steals a live owner even after the wait deadline", async () => {
    await save(); const file = await onlyFile(), before = await readFile(file), owner = mockLinuxOwner();
    lockFixture.proc.set(`/proc/${deadPid}/stat`, procStat(deadPid, "123"));
    const lock = await createLock(file, owner), ownerRaw = await readFile(path.join(lock, "owner.json")); busyImmediately();
    await expect(save(1)).rejects.toMatchObject({ code: "CONFIG_BUSY", status: 409 });
    expect(await readFile(file)).toEqual(before); expect(await readFile(path.join(lock, "owner.json"))).toEqual(ownerRaw);
    expect(await readdir(root)).toEqual(expect.arrayContaining([path.basename(file), path.basename(lock)]));
    expect((await readdir(root)).some(name => name.includes(".recovered-"))).toBe(false);
  });

  it.each(["missing", "malformed", "different-boot", "different-namespace", "unverifiable"])("keeps %s lock ownership fail-closed without changing ciphertext", async state => {
    await save(); const file = await onlyFile(), before = await readFile(file), owner = mockLinuxOwner();
    if (state === "different-boot") owner.linux.bootId = "33333333-3333-4333-8333-333333333333";
    if (state === "different-namespace") owner.linux.pidNamespace = "pid:[7]";
    if (state === "unverifiable") lockFixture.proc.set(`/proc/${deadPid}/stat`, Object.assign(new Error("denied"), { code: "EACCES" }));
    const lock = await createLock(file, state === "missing" ? undefined : state === "malformed" ? "{unfinished" : owner);
    const beforeEntries = await readdir(lock); busyImmediately();
    await expect(save(1)).rejects.toMatchObject({ code: "CONFIG_BUSY", status: 409 });
    expect(await readFile(file)).toEqual(before); expect(await readdir(lock)).toEqual(beforeEntries);
    expect((await readdir(root)).some(name => name.includes(".recovered-"))).toBe(false);
  });

  it("does not reclaim a replacement lock observed while proving the previous owner dead", async () => {
    await save(); const file = await onlyFile(), before = await readFile(file), oldOwner = mockLinuxOwner();
    lockFixture.proc.set(`/proc/${deadPid}/stat`, Object.assign(new Error("gone"), { code: "ENOENT" }));
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    const lock = await createLock(file, oldOwner), replacement = { ...mockLinuxOwner(process.pid, "456"), nonce: "44444444-4444-4444-8444-444444444444" };
    lockFixture.beforeProcRead = async source => {
      if (source !== `/proc/${deadPid}/stat`) return;
      lockFixture.beforeProcRead = undefined;
      await rename(lock, lock + ".previous"); await createLock(file, replacement);
    };
    busyImmediately(); await expect(save(1)).rejects.toMatchObject({ code: "CONFIG_BUSY" });
    expect(JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"))).toEqual(replacement);
    expect(await readFile(file)).toEqual(before);
    await expect(lstat(lock + ".recovered-" + ownerNonce)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cannot move a newer live lock when another recovery wins immediately before rename", async () => {
    await save(); const file = await onlyFile(), before = await readFile(file), oldOwner = mockLinuxOwner();
    lockFixture.proc.set(`/proc/${deadPid}/stat`, Object.assign(new Error("gone"), { code: "ENOENT" }));
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    const lock = await createLock(file, oldOwner), recovered = lock + ".recovered-" + ownerNonce;
    const replacement = { ...mockLinuxOwner(process.pid, "456"), nonce: "44444444-4444-4444-8444-444444444444" };
    lockFixture.beforeRename = async (from, to) => {
      if (from !== lock || to !== recovered) return;
      lockFixture.beforeRename = undefined;
      await rename(lock, recovered); await createLock(file, replacement);
    };
    busyImmediately(); await expect(save(1)).rejects.toMatchObject({ code: "CONFIG_BUSY" });
    expect(JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"))).toEqual(replacement);
    expect(JSON.parse(await readFile(path.join(recovered, "owner.json"), "utf8"))).toEqual(oldOwner);
    expect(await readFile(file)).toEqual(before);
  });

  it("requires account CAS only for selection and makes selection+profile changes atomic", async () => {
    await save(); const file = await onlyFile(), before = await readFile(file);
    await expect(save(1, { config: { imageModel: "must-not-save" }, accountRevision: 0, selection: { activeProvider: "doubao" } })).rejects.toMatchObject({ code: "CONFIG_REVISION_CONFLICT" });
    expect(await readFile(file)).toEqual(before);
    await expect(putCreativeConfigProfile(alice, { selection: { activeProvider: "openai" } })).rejects.toMatchObject({ code: "CONFIG_REVISION_CONFLICT" });
    await save(1, { config: { imageModel: "saved-with-selection" }, accountRevision: 1, selection: { activeProvider: "openai" } });
    expect(await getCreativeConfigProfiles(alice)).toMatchObject({ accountRevision: 2, selection: { activeProvider: "openai" } });
  });

  it("leaves a durable unlink tombstone that stale import cannot revive, including after a fresh read", async () => {
    await save();
    await unlinkCreativeConfigProfile(alice, { provider: "openai", revision: 1 });
    const file = await onlyFile(), before = await readFile(file);
    const imported = await save(0, { importOnly: true, config });
    expect(imported).toMatchObject({ imported: false, accountRevision: 2, profile: { revision: 2, tombstone: true, linked: false } });
    expect(await readFile(file)).toEqual(before);
    expect(await resolveCreativeConfigProfile(alice, "openai")).toMatchObject({ config: { apiKey: "", imageModel: config.imageModel }, tombstone: true });
    await expect(unlinkCreativeConfigProfile(alice, { provider: "openai", revision: 1 })).rejects.toMatchObject({ status: 409 });
  });

  it("imports once, never overwrites a server binding, and does not create a binding from an empty preset", async () => {
    const empty = await save(0, { config: { apiKey: "" }, importOnly: true });
    expect(empty).toMatchObject({ imported: false, accountRevision: 0 }); expect(await files()).toHaveLength(0);
    expect(await save(0, { importOnly: true })).toMatchObject({ imported: true });
    const file = await onlyFile(), before = await readFile(file);
    expect(await save(0, { importOnly: true, config: { apiKey: "synthetic-stale-local" }, selection: { activeProvider: "doubao" } })).toMatchObject({ imported: false });
    expect(await readFile(file)).toEqual(before);
  });

  it("creates an unlink tombstone even if an old browser is the only place still holding the Key", async () => {
    await unlinkCreativeConfigProfile(alice, { provider: "openai", revision: 0 });
    expect(await save(0, { importOnly: true })).toMatchObject({ imported: false, profile: { tombstone: true } });
  });

  it("fails closed on damaged ciphertext or unavailable encryption without replacing the existing file", async () => {
    await save(); const file = await onlyFile(), original = await readFile(file);
    vi.stubEnv("AI_API_ENCRYPTION_KEY", "synthetic-different-key-0123456789abcdef");
    await expect(save(1, { config: { apiKey: "" } })).rejects.toMatchObject({ status: 503 });
    expect(await readFile(file)).toEqual(original);
    vi.stubEnv("AI_API_ENCRYPTION_KEY", "synthetic-independent-ai-key-0123456789abcdef");
    const envelope = JSON.parse(original.toString()) as { ciphertext: string };
    envelope.ciphertext = Buffer.from("damaged").toString("base64"); await writeFile(file, JSON.stringify(envelope));
    const damaged = await readFile(file);
    await expect(getCreativeConfigProfiles(alice, true)).rejects.toMatchObject({ status: 503 });
    expect(await readFile(file)).toEqual(damaged);
  });

  it("preserves the original ciphertext after a real filesystem write failure", async () => {
    await save(); const file = await onlyFile(), before = await readFile(file);
    await chmod(root, 0o500);
    try { await expect(save(1, { config: { imageModel: "must-not-be-published", apiKey: "" } })).rejects.toMatchObject({ status: 503 }); }
    finally { await chmod(root, 0o700); }
    expect(await readFile(file)).toEqual(before);
    expect(await resolveCreativeConfigProfile(alice, "openai")).toMatchObject({ revision: 1, config: { apiKey, imageModel: config.imageModel } });
  });

  it("rejects linked roots, linked profile files and relaxed file permissions", async () => {
    await save(); const file = await onlyFile(), before = await readFile(file);
    await chmod(file, 0o644);
    await expect(getCreativeConfigProfiles(alice)).rejects.toMatchObject({ status: 503 }); await chmod(file, 0o600);
    const external = path.join(temporary, "external.json"); await writeFile(external, before, { mode: 0o600 });
    await rm(file); await symlink(external, file);
    await expect(getCreativeConfigProfiles(alice, true)).rejects.toMatchObject({ status: 503 });
    expect(await readFile(external)).toEqual(before);
    const linkedRoot = path.join(temporary, "linked-root"); await symlink(root, linkedRoot); vi.stubEnv("SANJIE_CREATIVE_CONFIG_ROOT", linkedRoot);
    await expect(getCreativeConfigProfiles(alice)).rejects.toMatchObject({ status: 503 });
  });

  it.each(["http://example.com/v1", "https://127.0.0.1/v1", "https://api.example.com/v1?key=forbidden", "not a URL"])("rejects unsafe credential destinations %s without a write", async endpoint => {
    await expect(save(0, { config: { ...config, imageEndpoint: endpoint } })).rejects.toMatchObject({ code: "CONFIG_ENDPOINT_INVALID", status: 400 });
    expect(await files()).toEqual([]);
  });
});
