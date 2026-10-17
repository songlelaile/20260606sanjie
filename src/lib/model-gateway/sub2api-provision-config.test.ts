import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("server-only", () => ({}));
import { getSub2ApiProvisionConfigPath, getSub2ApiProvisioningView, readSub2ApiProvisionConfig, saveSub2ApiProvisionConfig } from "./sub2api-provision-config";

const password = "test-only-issuer-password-do-not-output";
const complete = { email: "service@example.test", password, groupId: "8", quotaUsd: 0 };

describe("encrypted Sub2API issuer configuration", () => {
  let directory: string;
  let file: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "sub2api-config-test-"));
    file = path.join(directory, "private", "provision.json");
    vi.stubEnv("SUB2API_PROVISION_CONFIG_FILE", file);
    vi.stubEnv("AI_API_ENCRYPTION_KEY", "test-only-independent-ai-key-0123456789abcdef");
    for (const name of ["SUB2API_PROVISION_BASE_URL", "SUB2API_PROVISION_EMAIL", "SUB2API_PROVISION_PASSWORD", "SUB2API_PROVISION_GROUP_ID", "SUB2API_PROVISION_KEY_QUOTA_USD"]) vi.stubEnv(name, "");
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

  it("reports missing issuer fields without guessing credentials, a group, or a quota", async () => {
    expect(await getSub2ApiProvisioningView()).toEqual({ configured: false, baseUrl: "https://sub.shaozhuangai.com", emailMasked: "", groupId: "", quotaUsd: null,
      missing: ["SUB2API_PROVISION_EMAIL", "SUB2API_PROVISION_PASSWORD", "SUB2API_PROVISION_GROUP_ID", "SUB2API_PROVISION_KEY_QUOTA_USD"] });
  });

  it("stores the whole private payload with AES-GCM and private filesystem permissions", async () => {
    const result = await saveSub2ApiProvisionConfig(complete);
    expect(result).toMatchObject({ configured: true, emailMasked: "s***@example.test", groupId: "8", quotaUsd: 0, missing: [] });
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain(password);
    expect(raw).not.toContain(complete.email);
    expect(JSON.parse(raw)).toMatchObject({ schema: "SANJIE_SUB2API_PROVISION_CONFIG_V1", iv: expect.any(String), tag: expect.any(String), ciphertext: expect.any(String) });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(await readSub2ApiProvisionConfig()).toEqual({ ...complete, baseUrl: "https://sub.shaozhuangai.com" });
    expect(JSON.stringify(result)).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain(complete.email);
  });

  it("preserves an existing password when omitted or empty and does not return it", async () => {
    await saveSub2ApiProvisionConfig(complete);
    const result = await saveSub2ApiProvisionConfig({ email: "", password: "", groupId: "9", quotaUsd: "123.45" });
    expect(await readSub2ApiProvisionConfig()).toMatchObject({ password, email: complete.email, groupId: "9", quotaUsd: 123.45 });
    expect(result).toMatchObject({ configured: true, groupId: "9", quotaUsd: 123.45 });
    expect(result).not.toHaveProperty("password");
  });

  it("merges concurrent field updates under the shared filesystem lock", async () => {
    await saveSub2ApiProvisionConfig(complete);
    await Promise.all([saveSub2ApiProvisionConfig({ groupId: "9" }), saveSub2ApiProvisionConfig({ quotaUsd: 200 })]);
    expect(await readSub2ApiProvisionConfig()).toMatchObject({ groupId: "9", quotaUsd: 200, password });
    expect(await readdir(path.dirname(file))).toEqual(["provision.json"]);
  });

  it("prefers the explicitly saved issuer over environment fallback", async () => {
    await saveSub2ApiProvisionConfig(complete);
    vi.stubEnv("SUB2API_PROVISION_EMAIL", "different@example.test");
    vi.stubEnv("SUB2API_PROVISION_PASSWORD", "different-password");
    vi.stubEnv("SUB2API_PROVISION_GROUP_ID", "10");
    vi.stubEnv("SUB2API_PROVISION_KEY_QUOTA_USD", "500");
    expect(await readSub2ApiProvisionConfig()).toMatchObject(complete);
  });

  it("supports existing environment configuration without writing or changing the upstream account", async () => {
    vi.stubEnv("SUB2API_PROVISION_EMAIL", complete.email);
    vi.stubEnv("SUB2API_PROVISION_PASSWORD", password);
    vi.stubEnv("SUB2API_PROVISION_GROUP_ID", "8");
    vi.stubEnv("SUB2API_PROVISION_KEY_QUOTA_USD", "0");
    expect(await getSub2ApiProvisioningView()).toMatchObject({ configured: true, quotaUsd: 0, emailMasked: "s***@example.test" });
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to persist a password without the dedicated encryption key", async () => {
    vi.stubEnv("AI_API_ENCRYPTION_KEY", "");
    await expect(saveSub2ApiProvisionConfig(complete)).rejects.toMatchObject({ code: "supply_provisioning_encryption_unconfigured" });
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([{ groupId: "0" }, { groupId: "1.5" }, { groupId: true }, { quotaUsd: -1 }, { quotaUsd: 1_000_001 }, { quotaUsd: Number.NaN }, { quotaUsd: "1e3" }, { email: "invalid-email" }, { baseUrl: "https://evil.example" }, { baseUrl: "https://sub.shaozhuangai.com/v1" }])("rejects invalid setup without leaving a partial file or lock: %j", async (patch) => {
    await expect(saveSub2ApiProvisionConfig({ ...complete, ...patch })).rejects.toMatchObject({ code: "supply_provisioning_invalid_config", status: 400 });
    expect(await readdir(path.dirname(file))).toEqual([]);
  });

  it("requires group and quota to be explicit on first setup", async () => {
    await expect(saveSub2ApiProvisionConfig({ email: complete.email, password })).rejects.toMatchObject({ code: "supply_provisioning_invalid_config" });
  });

  it("detects ciphertext tampering and never includes the original payload in errors", async () => {
    await saveSub2ApiProvisionConfig(complete);
    const data = JSON.parse(await readFile(file, "utf8"));
    data.ciphertext = Buffer.from(password).toString("base64");
    await writeFile(file, JSON.stringify(data));
    const error = await readSub2ApiProvisionConfig().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "supply_provisioning_config_corrupt" });
    expect(String(error) + JSON.stringify(error)).not.toContain(password);
  });

  it("fails closed if the encryption key changes", async () => {
    await saveSub2ApiProvisionConfig(complete);
    vi.stubEnv("AI_API_ENCRYPTION_KEY", "a-different-independent-encryption-key-0123456789");
    await expect(getSub2ApiProvisioningView()).rejects.toMatchObject({ code: "supply_provisioning_config_corrupt" });
  });

  it("refuses a world-readable configuration file", async () => {
    await saveSub2ApiProvisionConfig(complete);
    await chmod(file, 0o644);
    await expect(readSub2ApiProvisionConfig()).rejects.toMatchObject({ code: "supply_provisioning_config_permissions" });
  });

  it("refuses a configuration symlink", async () => {
    const target = path.join(directory, "original.json");
    await writeFile(target, password, { mode: 0o600 });
    vi.stubEnv("SUB2API_PROVISION_CONFIG_FILE", path.join(directory, "linked.json"));
    await symlink(target, getSub2ApiProvisionConfigPath());
    await expect(readSub2ApiProvisionConfig()).rejects.toMatchObject({ code: "supply_provisioning_config_unreadable" });
    expect(await readFile(target, "utf8")).toBe(password);
  });

  it("uses a stable home-based default path across release checkouts", () => {
    vi.stubEnv("SUB2API_PROVISION_CONFIG_FILE", "");
    const original = getSub2ApiProvisionConfigPath();
    vi.spyOn(process, "cwd").mockReturnValue("/opt/sanjie-releases/different-release");
    expect(getSub2ApiProvisionConfigPath()).toBe(original);
    expect(original).toContain(path.join(".config", "shaozhuangai", "user-supply", "provision.json"));
  });

  it.each(["relative/path.json", "/tmp/public/provision.json", "/tmp/.next/provision.json"])("rejects unsafe persistence path %s", async (unsafePath) => {
    vi.stubEnv("SUB2API_PROVISION_CONFIG_FILE", unsafePath);
    await expect(saveSub2ApiProvisionConfig(complete)).rejects.toMatchObject({ code: "supply_provisioning_invalid_config_path" });
  });
});
