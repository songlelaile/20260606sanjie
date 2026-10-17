import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const root = resolve(process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative", "labs/image-prompt-lab");
const source = readFileSync(resolve(root, "promptlab.js"), "utf8");
const html = readFileSync(resolve(root, "promptlab.html"), "utf8");
const ownerFingerprint = "a".repeat(64);
const otherOwnerFingerprint = "b".repeat(64);
type EditEvent = { isTrusted: boolean; inputType?: string; preventDefault(): void; prevented: boolean };
class Control {
  value = ""; hidden = false; disabled = false; readOnly = false; autofilled = false;
  listeners = new Map<string, Array<(event: EditEvent) => unknown>>();
  addEventListener(type: string, listener: (event: EditEvent) => unknown) {
    this.listeners.set(type, [...this.listeners.get(type) || [], listener]);
  }
  matches() { return this.autofilled; }
  emit(type: string, trusted = true, inputType?: string) {
    const event: EditEvent = { isTrusted: trusted, inputType, prevented: false, preventDefault() { this.prevented = true; } };
    const results = (this.listeners.get(type) || []).map(listener => listener(event));
    return { event, result: results.at(-1) };
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(config: Record<string, unknown> = {}) {
  const controls = new Map<string, Control>();
  const node = (id: string) => {
    if (!controls.has(id)) controls.set(id, new Control());
    return controls.get(id)!;
  };
  const document = { activeElement: null as Control | null };
  const send = vi.fn(async (_type: string, _payload: unknown): Promise<Record<string, unknown>> => ({ ok: false }));
  const events = vi.fn();
  const defaults = { provider: "openai-compatible", imageAdapter: "generic-json", apiKey: "",
    visionBaseUrl: "https://gateway.fixture.invalid/v1", imageEndpoint: "https://gateway.fixture.invalid/images",
    visionModel: "chatGPT5.5", textModel: "chatGPT5.5", imageModel: "image2" };
  const presets = { "openai-compatible": defaults, openai: { ...defaults, provider: "openai", imageAdapter: "openai-images" },
    doubao: { ...defaults, provider: "doubao", imageAdapter: "doubao-image", imageModel: "seedream-current-default" } };
  const usesWallet = (cfg: Record<string, unknown>) => cfg._supplyChannel !== "external_key" && !cfg.apiKey && cfg.provider === "openai-compatible";
  const context = createContext({ document, $: node, DEFAULT_CFG: defaults, PRESETS: presets,
    VOLC_SEEDREAM_DEFAULT: "seedream-current-default", state: { archiveAccountKey: "tenant-a:alice" },
    creativeUsesPlatformWallet: usesWallet,
    creativeWebProfile: vi.fn(async () => ({ ok: false })),
    creativeHasApiCredential: (cfg: Record<string, unknown>) => !!cfg.apiKey || usesWallet(cfg),
    updateConfigSummary: vi.fn(), setPill: vi.fn(), send, setArchiveAccountKey: vi.fn(),
    referenceDetailBatchNotifySettingsChanged: vi.fn(),
    setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(), URLSearchParams,
    location: { search: "?source=web&studio=1" },
    CustomEvent: class { constructor(public type: string) {} }, dispatchEvent: events });
  context.window = context;
  const start = source.indexOf("function normalizeHostedTextModel("), end = source.indexOf("\nfunction fileToDataUrl(", start);
  const formStart = source.indexOf("function cfgFromForm("), formEnd = source.indexOf("\nfunction isShaozhuangHostedEndpoint(", formStart);
  const busyStart = source.indexOf("var creativeWebBusy = "), busyEnd = source.indexOf("\nfunction creativeWebProfile(", busyStart);
  const pickerStart = source.indexOf("function creativeWebSelectBoundApi("), pickerEnd = source.indexOf("\nvar sceneReadyResolve;", pickerStart);
  if ([start, end, formStart, formEnd, busyStart, busyEnd, pickerStart, pickerEnd].some(index => index < 0)) throw new Error("Production config editor source was not found");
  runInContext(source.slice(start, end) + "\n" + source.slice(formStart, formEnd) + "\n" + source.slice(busyStart, busyEnd) + "\n" + source.slice(pickerStart, pickerEnd), context);
  const modal = node("configModal");
  Object.assign(modal, { querySelectorAll: () => [...controls.values()] });
  context.applyCfg({ ...defaults, apiKey: "fixture-original-key", _ownerFingerprint: ownerFingerprint, _supplyChannel: "external_key", _profileRevision: 7, _accountRevision: 11, ...config });
  const input = node("apiKey");
  context.bindApiKeyEditor(input);
  const edit = (value: string, inputType = "insertText", trusted = true) => {
    document.activeElement = input;
    const before = input.emit("beforeinput", trusted, inputType);
    if (!before.event.prevented) { input.value = value; input.emit("input", trusted, inputType); }
    return before.event;
  };
  const reply = (extra: Record<string, unknown> = {}) => ({ ok: true, accountKey: "tenant-a:alice", provider: node("provider").value,
    config: { ...defaults, provider: node("provider").value, apiKey: "", _ownerFingerprint: ownerFingerprint, _supplyChannel: "external_key", _profileRevision: 8, _accountRevision: 12 }, ...extra });
  return { context, node, input, document, send, events, edit, reply };
}

describe("direct account-scoped API key editing", () => {
  it("ships an editable password field, an explicit unlink control, and matching cache references", () => {
    const input = html.match(/<input\b[^>]*id="apiKey"[^>]*>/)![0];
    expect(input).toContain('type="password"'); expect(input).toContain('autocomplete="new-password"');
    expect(input).toContain('data-lpignore="true"'); expect(input).not.toMatch(/\sreadonly(?:\s|>|=)/i);
    expect(html).not.toContain('id="editApiKeyBtn"'); expect(html).toContain('id="unlinkApiKeyBtn"');
    expect(html).toContain("清空后保存会保留已绑定的 Key");
    const references = [...html.matchAll(/(?:href|src)="(promptlab\.js\?v=[^"]+)"/g)].map(match => match[1]);
    expect(references).toHaveLength(2); expect(references[0]).toBe(references[1]);
  });

  it("focus alone never writes or dirties the profile, and typing needs no modify button", () => {
    const h = harness(); h.document.activeElement = h.input;
    const seq = h.context.configApplySeq;
    h.input.emit("focus");
    expect(h.input.readOnly).toBe(false); expect(h.context.configFormDirty).toBe(false);
    expect(h.context.configApplySeq).toBe(seq); expect(h.send).not.toHaveBeenCalled();
    h.edit("fixture-new-key");
    expect(h.context.cfgFromForm().apiKey).toBe("fixture-new-key");
    expect(h.context.configFormDirty).toBe(true); expect(h.context.configApplySeq).toBeGreaterThan(seq);
  });

  it.each(["insertText", "insertFromPaste", "insertCompositionText", "insertFromComposition", "deleteContentBackward", "deleteByCut"])("accepts a trusted %s pair directly and retains revision/channel metadata", type => {
    const h = harness(); h.edit(type.startsWith("delete") ? "" : "fixture-edited", type);
    expect(h.context.cfgFromForm()).toMatchObject({ apiKey: type.startsWith("delete") ? "" : "fixture-edited",
      _ownerFingerprint: ownerFingerprint, _supplyChannel: "external_key", _profileRevision: 7, _accountRevision: 11, _keyEdited: true });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("preserves manual undo/redo through accepted values", () => {
    const h = harness(); h.edit("fixture-second"); h.edit("fixture-third");
    h.input.emit("beforeinput", true, "historyUndo"); expect(h.context.cfgFromForm().apiKey).toBe("fixture-second");
    h.input.emit("beforeinput", true, "historyRedo"); expect(h.context.cfgFromForm().apiKey).toBe("fixture-third");
  });

  it("model or endpoint edits do not claim that the accepted key was reentered", () => {
    const h = harness(); h.node("imageModel").value = "fixture-model-choice";
    h.node("imageEndpoint").value = "https://different.fixture.invalid/images";
    expect(h.context.cfgFromForm()).toMatchObject({ apiKey: "fixture-original-key", _keyEdited: false,
      imageModel: "fixture-model-choice", imageEndpoint: "https://different.fixture.invalid/images" });
  });

  it.each(["dom-only", "untrusted", "input-only", "replacement", "autofill", "hidden", "busy", "account-changed", "provider-changed"])("rejects %s as a credential replacement", kind => {
    const h = harness(); h.document.activeElement = h.input; h.input.emit("focus");
    if (kind === "hidden") h.node("configModal").hidden = true;
    if (kind === "busy") h.context.creativeWebSetApiBusy("generation", true);
    if (kind === "account-changed") h.context.state.archiveAccountKey = "tenant-b:bob";
    if (kind === "provider-changed") h.node("provider").value = "openai";
    if (kind === "autofill") h.input.autofilled = true;
    if (kind === "dom-only" || kind === "input-only") {
      h.input.value = "fixture-unaccepted";
      if (kind === "input-only") h.input.emit("input", true, "insertText");
    } else h.edit("fixture-unaccepted", kind === "replacement" ? "insertReplacementText" : "insertText", kind !== "untrusted");
    expect(h.context.acceptedConfigApiKey("openai-compatible")).toBe("fixture-original-key");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("first accepted beforeinput invalidates a late profile response before mutation", async () => {
    const h = harness(), profile = deferred<Record<string, unknown>>();
    h.send.mockReturnValue(profile.promise);
    const waiting = h.context.loadProviderProfile("openai");
    h.edit("fixture-user-choice", "insertFromPaste");
    profile.resolve(h.reply({ config: { provider: "openai", apiKey: "fixture-late-profile", _supplyChannel: "external_key" } }));
    await waiting;
    expect(h.context.cfgFromForm()).toMatchObject({ provider: "openai", apiKey: "fixture-user-choice" });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it.each(["saved", "legacy", "failed-read"])("browses a %s provider profile and closes without changing the saved wallet selection", async kind => {
    const h = harness({ _accountKey: "tenant-a:alice", apiKey: "", _supplyChannel: "platform_wallet" });
    const savedSelection = { provider: "openai-compatible", supplyChannel: "platform_wallet" };
    let selection = { ...savedSelection };
    const preview = { ...h.context.cfgFromForm(), provider: "openai", imageAdapter: "openai-images", apiKey: "fixture-preview-key",
      visionModel: "fixture-explicit-vision", textModel: "fixture-explicit-text", imageModel: "fixture-explicit-image",
      _supplyChannel: "external_key", _profileRevision: 4, _accountRevision: 11 };
    h.send.mockImplementation(async (type, payload) => {
      if (type === "GET_CONFIG_PROFILE") return kind === "failed-read" ? { ok: false, code: "CONFIG_READ_FAILED" }
        : h.reply({ saved: true, migrated: kind === "legacy", config: preview });
      selection = { provider: String((payload as Record<string, unknown>).provider), supplyChannel: "external_key" };
      return h.reply();
    });
    await h.context.loadProviderProfile("openai");
    if (kind !== "failed-read") {
      expect(h.context.cfgFromForm()).toMatchObject(preview);
      if (kind === "legacy") expect(h.context.setPill).toHaveBeenLastCalledWith("configState", "已载入旧版配置", "ok");
      h.edit("fixture-unsaved-draft-key");
    }
    h.context.closeConfigModal();
    expect(h.node("configModal").hidden).toBe(true);
    expect(h.send.mock.calls).toEqual([["GET_CONFIG_PROFILE", { provider: "openai" }]]);
    expect(selection).toEqual(savedSelection); expect(h.events).not.toHaveBeenCalled();
    if (kind !== "failed-read") expect(h.context.cfgFromForm()).toMatchObject({ ...preview, apiKey: "fixture-unsaved-draft-key", _keyEdited: true });
  });

  it.each(["CONFIG_READ_FAILED", "CONFIG_SERVICE_UNAVAILABLE", "CONFIG_LEGACY_ALIAS_CONFLICT", "missing-config", "empty-reply"])("reports %s as an incomplete provider read without a save or selection mutation", async kind => {
    const h = harness({ _accountKey: "tenant-a:alice" });
    const response = kind === "missing-config" ? { ok: true, accountKey: "tenant-a:alice", provider: "openai" }
      : kind === "empty-reply" ? {} : { ok: false, code: kind, error: "Bearer fixture-untrusted-key https://private.fixture.invalid" };
    h.send.mockResolvedValue(response);
    await h.context.loadProviderProfile("openai");
    expect(h.context.setPill).toHaveBeenLastCalledWith("configState", kind === "CONFIG_LEGACY_ALIAS_CONFLICT"
      ? "旧版服务商别名存在不同绑定，请先明确选择并核对原配置，再重新载入。"
      : "API 配置未能载入，请重新选择服务商或刷新后核对绑定。", "warn");
    expect(h.context.cfgFromForm()).toMatchObject({ provider: "openai", apiKey: "" });
    expect(h.context.cfgFromForm()._ownerFingerprint).toBeUndefined();
    expect(h.context.pendingProviderProfile).toBe(0); expect(h.node("unlinkApiKeyBtn").disabled).toBe(true);
    expect(h.send.mock.calls).toEqual([["GET_CONFIG_PROFILE", { provider: "openai" }]]);
    expect(h.events).not.toHaveBeenCalled();
    expect(JSON.stringify(h.context.setPill.mock.calls)).not.toMatch(/新服务商预设|Bearer|fixture-untrusted-key|private\.fixture/);
  });

  it("keeps a rejected provider read visibly unconfirmed without reflecting its error", async () => {
    const h = harness(); h.send.mockRejectedValue(new Error("Bearer fixture-untrusted-key"));
    await h.context.loadProviderProfile("openai");
    expect(h.context.setPill).toHaveBeenLastCalledWith("configState", "API 配置未能载入，请重新选择服务商或刷新后核对绑定。", "warn");
    expect(h.context.cfgFromForm()).toMatchObject({ provider: "openai", apiKey: "" });
    expect(h.send.mock.calls).toEqual([["GET_CONFIG_PROFILE", { provider: "openai" }]]);
    expect(h.context.pendingProviderProfile).toBe(0); expect(h.events).not.toHaveBeenCalled();
  });

  it("persists a previewed provider only when explicitly saving its model and Key draft", async () => {
    const h = harness({ _accountKey: "tenant-a:alice", apiKey: "", _supplyChannel: "platform_wallet" });
    let savedProvider = "openai-compatible";
    const preview = { ...h.context.cfgFromForm(), provider: "openai", imageAdapter: "openai-images", apiKey: "fixture-preview-key",
      _supplyChannel: "external_key", _profileRevision: 4, _accountRevision: 11 };
    h.send.mockImplementation(async (type, payload) => {
      if (type === "GET_CONFIG_PROFILE") return h.reply({ saved: true, config: preview });
      if (type !== "SAVE_CONFIG") throw new Error("Unexpected provider mutation");
      const config = (payload as { config: Record<string, unknown> }).config;
      savedProvider = String(config.provider);
      return h.reply({ config: { ...config, _profileRevision: 5, _accountRevision: 12 } });
    });
    await h.context.loadProviderProfile("openai");
    expect(savedProvider).toBe("openai-compatible");
    h.edit("fixture-explicit-save-key"); h.node("imageModel").value = "fixture-explicit-save-model";
    await h.context.saveCfg();
    expect(h.send.mock.calls.map(call => call[0])).toEqual(["GET_CONFIG_PROFILE", "SAVE_CONFIG"]);
    expect(h.send).toHaveBeenLastCalledWith("SAVE_CONFIG", { config: expect.objectContaining({ provider: "openai",
      apiKey: "fixture-explicit-save-key", imageModel: "fixture-explicit-save-model", _keyEdited: true,
      _accountKey: "tenant-a:alice", _ownerFingerprint: ownerFingerprint, _profileRevision: 4, _accountRevision: 11, _supplyChannel: "external_key" }) });
    expect(savedProvider).toBe("openai");
    expect(h.context.cfgFromForm()).toMatchObject({ provider: "openai", apiKey: "fixture-explicit-save-key",
      imageModel: "fixture-explicit-save-model", _profileRevision: 5, _accountRevision: 12, _keyEdited: false });
  });

  it("ordinary empty save preserves the server binding, revisions and external route", async () => {
    const h = harness(); h.edit("", "deleteByCut");
    expect(h.node("unlinkApiKeyBtn").disabled).toBe(false);
    h.send.mockResolvedValue(h.reply({ config: { ...h.context.cfgFromForm(), apiKey: "fixture-original-key", _profileRevision: 8, _accountRevision: 12 } }));
    await h.context.saveCfg();
    expect(h.send).toHaveBeenCalledExactlyOnceWith("SAVE_CONFIG", { config: expect.objectContaining({ apiKey: "", _supplyChannel: "external_key", _profileRevision: 7, _accountRevision: 11 }) });
    expect(h.context.cfgFromForm()).toMatchObject({ apiKey: "fixture-original-key", _supplyChannel: "external_key", _profileRevision: 8, _accountRevision: 12 });
    expect(h.context.setTimeout).toHaveBeenCalledExactlyOnceWith(h.context.closeConfigModal, 180);
  });

  it("accepts a server-saved replacement Key with a cache warning and keeps the modal open", async () => {
    const h = harness({ _accountKey: "tenant-a:alice" }); h.edit("fixture-server-saved-key");
    const response = h.reply({ cacheSaved: false, cacheWarning: "账号配置已保存，本机缓存未更新，请刷新后恢复。",
      config: { ...h.context.cfgFromForm(), _profileRevision: 8, _accountRevision: 12 } });
    h.send.mockResolvedValue(response);
    expect(await h.context.saveCfg()).toEqual(response);
    expect(h.context.cfgFromForm()).toMatchObject({ apiKey: "fixture-server-saved-key", _accountKey: "tenant-a:alice",
      _profileRevision: 8, _accountRevision: 12, _keyEdited: false, _supplyChannel: "external_key" });
    expect(h.context.configFormDirty).toBe(false); expect(h.context.configSavePending).toBe(false);
    expect(h.context.setPill).toHaveBeenLastCalledWith("configState", "已保存到账号配置；本机缓存未更新，请刷新后恢复。", "warn");
    expect(h.context.setTimeout).not.toHaveBeenCalled(); expect(h.node("configModal").hidden).toBe(false);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "sz-bound-api-changed" }));
  });

  it("a failed empty save retains the known binding and never switches to wallet", async () => {
    const h = harness(); h.edit("", "deleteByCut");
    h.send.mockResolvedValue({ ok: false, code: "CONFIG_CONFLICT" });
    await h.context.saveCfg();
    expect(h.context.configApiKey.hasBoundKey).toBe(true); expect(h.node("unlinkApiKeyBtn").disabled).toBe(false);
    expect(h.context.cfgFromForm()._supplyChannel).toBe("external_key");
    expect(h.send.mock.calls.map(call => call[0])).toEqual(["SAVE_CONFIG"]);
  });

  it.each([
    ["CONFIG_CREDENTIAL_SCOPE_CHANGED", "接口地址已变化，请直接输入对应 API Key 后再保存。"],
    ["KEY_SCOPE_CHANGED", "接口地址已变化，请直接输入对应 API Key 后再保存。"],
    ["CONFIG_BUSY", "账号配置正在保存，请稍后重试。"],
    ["ACCOUNT_CHANGED", "登录账号已变化，请重新载入工作台后再保存。"],
    ["UNRECOGNIZED_CONFIG_ERROR", "保存结果暂无法确认，请重新载入核对绑定。"]
  ])("shows the safe actionable %s message while keeping the manual Key draft", async (code, message) => {
    const h = harness({ _accountKey: "tenant-a:alice" }); h.edit("fixture-manual-draft-key");
    const response = { ok: false, code, error: "Bearer fixture-untrusted-key https://private.fixture.invalid" };
    h.send.mockResolvedValue(response);
    expect(await h.context.saveCfg()).toEqual(response);
    expect(h.context.setPill).toHaveBeenLastCalledWith("configState", message, "warn");
    expect(h.context.cfgFromForm()).toMatchObject({ apiKey: "fixture-manual-draft-key", _keyEdited: true,
      _accountKey: "tenant-a:alice", _ownerFingerprint: ownerFingerprint, _profileRevision: 7, _accountRevision: 11 });
    expect(h.context.configFormDirty).toBe(true); expect(h.context.configSavePending).toBe(false);
    expect(h.send).toHaveBeenCalledTimes(1); expect(h.events).not.toHaveBeenCalled();
    expect(h.context.setTimeout).not.toHaveBeenCalled(); expect(h.node("configModal").hidden).toBe(false);
    expect(JSON.stringify(h.context.setPill.mock.calls)).not.toMatch(/Bearer|fixture-untrusted-key|private\.fixture/);
  });

  it.each(["rejected", "network-error"])("retries a nonempty manual Key after a %s save without requiring new input", async failure => {
    const h = harness({ _accountKey: "tenant-a:alice" }); h.edit("fixture-manual-replacement");
    if (failure === "rejected") h.send.mockResolvedValueOnce({ ok: false, code: "CONFIG_WRITE_FAILED" });
    else h.send.mockRejectedValueOnce(new Error("Synthetic network interruption"));
    await h.context.saveCfg();
    expect(h.context.cfgFromForm()).toMatchObject({ apiKey: "fixture-manual-replacement", _keyEdited: true,
      _accountKey: "tenant-a:alice", _ownerFingerprint: ownerFingerprint, _profileRevision: 7, _accountRevision: 11, _supplyChannel: "external_key" });
    expect(h.context.configFormDirty).toBe(true); expect(h.context.configSavePending).toBe(false);
    expect(h.context.configApiKey.hasBoundKey).toBe(true); expect(h.events).not.toHaveBeenCalled();
    h.document.activeElement = h.input; h.input.emit("focus");
    h.send.mockResolvedValueOnce(h.reply({ config: { ...h.context.cfgFromForm(), _profileRevision: 8, _accountRevision: 12 } }));
    await h.context.saveCfg();
    expect(h.send).toHaveBeenCalledTimes(2);
    for (const call of h.send.mock.calls) expect(call).toEqual(["SAVE_CONFIG", { config: expect.objectContaining({
      apiKey: "fixture-manual-replacement", _keyEdited: true, _accountKey: "tenant-a:alice", _ownerFingerprint: ownerFingerprint,
      _profileRevision: 7, _accountRevision: 11, _supplyChannel: "external_key"
    }) }]);
    expect(h.context.cfgFromForm()).toMatchObject({ apiKey: "fixture-manual-replacement", _keyEdited: false,
      _profileRevision: 8, _accountRevision: 12 });
    expect(h.context.configFormDirty).toBe(false);
    expect(h.events).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "sz-bound-api-changed" }));
  });
});

describe("explicit key unlink", () => {
  it("keeps standalone local profiles compatible when no server revision exists", async () => {
    const h = harness(); h.context.state.archiveAccountKey = "local";
    h.context.applyCfg({ provider: "openai", apiKey: "fixture-local-key", _supplyChannel: "external_key" });
    h.send.mockResolvedValue(h.reply({ accountKey: "local", config: { ...h.context.cfgFromForm(), apiKey: "" } }));
    await h.node("unlinkApiKeyBtn").emit("click").result;
    expect(h.send).toHaveBeenCalledExactlyOnceWith("UNLINK_CONFIG_KEY", { accountKey: "local", provider: "openai" });
    expect(h.context.cfgFromForm().apiKey).toBe(""); expect(h.context.cfgFromForm()._ownerFingerprint).toBeUndefined();
  });

  it("sends only owner/provider/revision, applies the empty external profile, and announces the boundary change", async () => {
    const h = harness(), response = deferred<Record<string, unknown>>(); h.send.mockReturnValue(response.promise);
    const pending = h.node("unlinkApiKeyBtn").emit("click").result;
    expect(h.send).toHaveBeenCalledExactlyOnceWith("UNLINK_CONFIG_KEY", { accountKey: "tenant-a:alice", provider: "openai-compatible", ownerFingerprint, revision: 7 });
    expect(h.input.disabled).toBe(true); expect(h.node("unlinkApiKeyBtn").disabled).toBe(true);
    response.resolve(h.reply()); await pending;
    expect(h.context.cfgFromForm()).toMatchObject({ apiKey: "", _supplyChannel: "external_key", _profileRevision: 8, _accountRevision: 12 });
    expect(h.context.creativeUsesPlatformWallet(h.context.cfgFromForm())).toBe(false);
    expect(h.input.disabled).toBe(false); expect(h.node("unlinkApiKeyBtn").disabled).toBe(true);
    expect(h.events).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "sz-bound-api-changed" }));
  });

  it("accepts a server-confirmed unlink despite a failed local cache update", async () => {
    const h = harness({ _accountKey: "tenant-a:alice" });
    const response = h.reply({ cacheSaved: false, cacheWarning: "账号配置已保存，本机缓存未更新，请刷新后恢复。" });
    h.send.mockResolvedValue(response);
    expect(await h.node("unlinkApiKeyBtn").emit("click").result).toEqual(response);
    expect(h.context.cfgFromForm()).toMatchObject({ apiKey: "", _accountKey: "tenant-a:alice", _supplyChannel: "external_key",
      _profileRevision: 8, _accountRevision: 12, _keyEdited: false });
    expect(h.context.configApiKey.hasBoundKey).toBe(false); expect(h.node("unlinkApiKeyBtn").disabled).toBe(true);
    expect(h.context.configFormDirty).toBe(false); expect(h.context.configKeyUnlinkPending).toBe(false);
    expect(h.context.setPill).toHaveBeenLastCalledWith("configState", "账号中的 Key 绑定已解除；本机缓存未更新，请刷新后恢复。", "warn");
    expect(h.node("configModal").hidden).toBe(false); expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "sz-bound-api-changed" }));
  });

  it("reports an unconfirmed unlink without claiming the original server binding survived", async () => {
    const h = harness(); h.send.mockRejectedValue(new Error("Synthetic reply loss after dispatch"));
    expect(await h.node("unlinkApiKeyBtn").emit("click").result).toMatchObject({ ok: false, code: "CONFIG_UNLINK_FAILED" });
    expect(h.context.setPill).toHaveBeenLastCalledWith("configState", "解除绑定结果暂无法确认，请重新载入核对绑定。", "warn");
    expect(h.context.cfgFromForm()).toMatchObject({ apiKey: "fixture-original-key", _profileRevision: 7, _accountRevision: 11 });
    expect(h.context.configKeyUnlinkPending).toBe(false); expect(h.events).not.toHaveBeenCalled();
  });

  it.each(["untrusted", "busy", "profile-loading", "provider-loading", "wallet-loading", "save-loading"])("does not unlink while %s", async kind => {
    const h = harness();
    if (kind === "busy") h.context.creativeWebSetApiBusy("generation", true);
    if (kind === "profile-loading") h.context.pendingProviderProfile = 1;
    if (kind === "provider-loading") h.context.pendingProviderSelection = 1;
    if (kind === "wallet-loading") h.context.configWalletSwitchPending = true;
    if (kind === "save-loading") h.context.configSavePending = true;
    await h.node("unlinkApiKeyBtn").emit("click", kind !== "untrusted").result;
    expect(h.send).not.toHaveBeenCalled(); expect(h.context.cfgFromForm()._supplyChannel).toBe("external_key");
  });

  it.each(["wrong-owner", "wrong-provider", "nonempty-key", "wallet-profile", "missing-config"])("rejects a successful-looking %s response", async kind => {
    const h = harness(), response = h.reply();
    if (kind === "wrong-owner") response.accountKey = "tenant-b:bob";
    if (kind === "wrong-provider") response.provider = "openai";
    if (kind === "nonempty-key") response.config.apiKey = "fixture-unexpected";
    if (kind === "wallet-profile") response.config._supplyChannel = "platform_wallet";
    h.send.mockResolvedValue(kind === "missing-config" ? { ok: true, accountKey: response.accountKey, provider: response.provider } : response);
    await h.node("unlinkApiKeyBtn").emit("click").result;
    expect(h.context.cfgFromForm().apiKey).toBe("fixture-original-key"); expect(h.events).not.toHaveBeenCalled();
  });

  it("does not apply an unlink receipt after an account switch", async () => {
    const h = harness(), response = deferred<Record<string, unknown>>(); h.send.mockReturnValue(response.promise);
    const pending = h.node("unlinkApiKeyBtn").emit("click").result;
    expect(h.send).toHaveBeenCalledWith("UNLINK_CONFIG_KEY", expect.objectContaining({ ownerFingerprint }));
    h.context.state.archiveAccountKey = "tenant-b:bob";
    response.resolve(h.reply()); await pending;
    expect(h.context.acceptedConfigApiKey("openai-compatible")).toBe("fixture-original-key"); expect(h.events).not.toHaveBeenCalled();
    expect(h.context.cfgFromForm()._ownerFingerprint).toBe(ownerFingerprint);
  });

  it.each(["unlink", "wallet"])("blocks %s from an unedited A form after switching to B with equal numeric revisions", async action => {
    const h = harness({ _accountKey: "tenant-a:alice" });
    const accountB = { accountKey: "tenant-b:bob", ownerFingerprint: otherOwnerFingerprint, profileRevision: 7, accountRevision: 11 };
    expect(h.context.configApiKey.editing).toBe(false);
    expect(h.context.cfgFromForm()).toMatchObject({ _profileRevision: accountB.profileRevision, _accountRevision: accountB.accountRevision });
    const sequence = h.context.configApplySeq, epoch = h.context.configReadEpoch;
    h.context.state.archiveAccountKey = accountB.accountKey;
    h.context.syncApiKeyControls();
    expect(h.node("unlinkApiKeyBtn").disabled).toBe(true);
    if (action === "unlink") await h.node("unlinkApiKeyBtn").emit("click").result;
    else await h.context.usePlatformWallet();
    expect(h.send).not.toHaveBeenCalled(); expect(h.events).not.toHaveBeenCalled();
    expect(h.context.configApplySeq).toBe(sequence); expect(h.context.configReadEpoch).toBe(epoch);
    expect(h.context.cfgFromForm()).toMatchObject({ _accountKey: "tenant-a:alice", _ownerFingerprint: ownerFingerprint, apiKey: "fixture-original-key", _supplyChannel: "external_key" });
    expect(h.context.configWalletSwitchPending).toBe(false); expect(h.context.configKeyUnlinkPending).toBe(false);
  });

  it("explicit wallet selection carries platform_wallet instead of inheriting external_key", async () => {
    const h = harness(); h.send.mockResolvedValue(h.reply({ config: { provider: "openai-compatible", apiKey: "", _supplyChannel: "platform_wallet" } }));
    await h.context.usePlatformWallet();
    expect(h.send).toHaveBeenCalledExactlyOnceWith("USE_PLATFORM_WALLET", expect.objectContaining({
      accountKey: "tenant-a:alice", ownerFingerprint, config: expect.objectContaining({ _supplyChannel: "platform_wallet", _ownerFingerprint: ownerFingerprint })
    }));
    expect(h.context.cfgFromForm()._supplyChannel).toBe("platform_wallet");
    expect(h.node("configModal").hidden).toBe(true);
  });

  it("accepts a server-confirmed wallet selection with a cache warning and keeps the modal open", async () => {
    const h = harness({ _accountKey: "tenant-a:alice" });
    const response = h.reply({ cacheSaved: false, cacheWarning: "账号配置已保存，本机缓存未更新，请刷新后恢复。",
      config: { ...h.context.cfgFromForm(), apiKey: "", _supplyChannel: "platform_wallet", _profileRevision: 8, _accountRevision: 12 } });
    h.send.mockResolvedValue(response);
    expect(await h.context.usePlatformWallet()).toEqual(response);
    expect(h.context.cfgFromForm()).toMatchObject({ apiKey: "", _accountKey: "tenant-a:alice", _supplyChannel: "platform_wallet",
      _profileRevision: 8, _accountRevision: 12, _keyEdited: false });
    expect(h.context.configFormDirty).toBe(false); expect(h.context.configWalletSwitchPending).toBe(false);
    expect(h.context.setPill).toHaveBeenLastCalledWith("configState", "账号已切换为本站积分；本机缓存未更新，请刷新后恢复。", "warn");
    expect(h.node("configModal").hidden).toBe(false); expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "sz-bound-api-changed" }));
  });
});

describe("UI configuration round trips keep explicit model namespaces", () => {
  it.each([
    { provider: "openai-compatible", visionModel: "gpt-4o", textModel: "gpt-4o-mini", imageModel: "gpt-image-1" },
    { provider: "openai-compatible", visionBaseUrl: "https://api.example.com/v1", imageEndpoint: "https://api.example.com/v1/images/generations", visionModel: "vision-model", textModel: "chat-model", imageModel: "image-model" },
    { provider: "doubao", visionModel: "doubao-1.5-vision", textModel: "doubao-1.5-pro", imageModel: "doubao-seedream-3-0-t2i" }
  ])("keeps all explicit models/endpoints for $provider", values => {
    const h = harness(values);
    expect(h.context.cfgFromForm()).toMatchObject(values);
  });
});

describe("bound API picker owner and authoritative selection metadata", () => {
  it.each([false, true])("uses the fresh snapshot owner token and the server's accepted config (wallet=%s)", async wallet => {
    const h = harness({ _accountKey: "tenant-a:alice" }), provider = wallet ? "openai-compatible" : "openai";
    const snapshot = { ...h.context.cfgFromForm(), provider, apiKey: wallet ? "" : "fixture-profile-key",
      _ownerFingerprint: otherOwnerFingerprint, _supplyChannel: "external_key", _profileRevision: 4, _accountRevision: 11 };
    const accepted = { ...snapshot, _supplyChannel: wallet ? "platform_wallet" : "external_key", _accountRevision: 12,
      imageModel: "fixture-server-selected-model" };
    h.context.creativeWebProfile.mockResolvedValue({ ok: true, accountKey: "tenant-a:alice", saved: !wallet, config: snapshot,
      boundApis: { providers: [{ provider, platformWallet: wallet }] } });
    h.send.mockImplementation(async (type, payload) => {
      if (type !== "SAVE_CONFIG") return { ok: true, accountKey: "tenant-a:alice", provider, config: accepted };
      const config = (payload as { config: Record<string, unknown> }).config;
      return { ok: true, accountKey: "tenant-a:alice", provider, config: { ...config, _profileRevision: 5, _accountRevision: 13 } };
    });
    expect(await h.context.creativeWebSelectBoundApi(provider)).toMatchObject({ ok: true, provider });
    expect(h.context.creativeWebProfile).toHaveBeenCalledExactlyOnceWith(provider, true, false);
    expect(h.send).toHaveBeenCalledExactlyOnceWith(wallet ? "USE_PLATFORM_WALLET" : "SET_ACTIVE_PROVIDER", {
      provider, accountKey: "tenant-a:alice", ownerFingerprint: otherOwnerFingerprint,
      config: wallet ? expect.objectContaining({ _ownerFingerprint: otherOwnerFingerprint, _supplyChannel: "platform_wallet" }) : undefined
    });
    expect(h.context.cfgFromForm()).toMatchObject({ provider, _ownerFingerprint: otherOwnerFingerprint,
      _profileRevision: 4, _accountRevision: 12, imageModel: "fixture-server-selected-model", _supplyChannel: accepted._supplyChannel });
    if (!wallet) {
      h.edit("fixture-followup-key");
      await h.context.saveCfg();
      expect(h.send).toHaveBeenLastCalledWith("SAVE_CONFIG", { config: expect.objectContaining({ provider,
        _accountKey: "tenant-a:alice", _ownerFingerprint: otherOwnerFingerprint, _profileRevision: 4, _accountRevision: 12,
        apiKey: "fixture-followup-key", imageModel: "fixture-server-selected-model", _keyEdited: true }) });
      expect(h.context.cfgFromForm()).toMatchObject({ _ownerFingerprint: otherOwnerFingerprint, _profileRevision: 5, _accountRevision: 13 });
    }
  });

  it.each(["provider", "config-provider", "config-owner"])("rejects a mismatched picker %s response before accepting it", async mismatch => {
    const h = harness({ _accountKey: "tenant-a:alice" });
    const snapshot = { ...h.context.cfgFromForm(), provider: "openai", _ownerFingerprint: otherOwnerFingerprint };
    h.context.creativeWebProfile.mockResolvedValue({ ok: true, accountKey: "tenant-a:alice", saved: true, config: snapshot });
    const response = { ok: true, accountKey: "tenant-a:alice", provider: "openai", config: { ...snapshot } };
    if (mismatch === "provider") response.provider = "doubao";
    if (mismatch === "config-provider") response.config.provider = "doubao";
    if (mismatch === "config-owner") response.config._accountKey = "tenant-b:bob";
    h.send.mockResolvedValue(response);
    expect(await h.context.creativeWebSelectBoundApi("openai")).toMatchObject({ ok: false });
    expect(h.context.cfgFromForm()).toMatchObject({ provider: "openai-compatible", _accountKey: "tenant-a:alice",
      _ownerFingerprint: ownerFingerprint, apiKey: "fixture-original-key", _accountRevision: 11 });
  });

  it("does not dispatch a late picker snapshot after the account changes", async () => {
    const h = harness({ _accountKey: "tenant-a:alice" }), snapshot = deferred<Record<string, unknown>>();
    h.context.creativeWebProfile.mockReturnValue(snapshot.promise);
    const pending = h.context.creativeWebSelectBoundApi("openai");
    h.context.state.archiveAccountKey = "tenant-b:bob";
    snapshot.resolve({ ok: true, accountKey: "tenant-a:alice", saved: true,
      config: { ...h.context.cfgFromForm(), provider: "openai", _ownerFingerprint: otherOwnerFingerprint } });
    expect(await pending).toMatchObject({ ok: false, code: "CONFIG_STALE" });
    expect(h.send).not.toHaveBeenCalled(); expect(h.context.cfgFromForm()._ownerFingerprint).toBe(ownerFingerprint);
  });

  it("keeps a legacy picker snapshot when its successful mutation has no config DTO", async () => {
    const h = harness({ _accountKey: "tenant-a:alice", _ownerFingerprint: undefined });
    const config = { ...h.context.cfgFromForm(), provider: "openai" };
    h.context.creativeWebProfile.mockResolvedValue({ ok: true, accountKey: "tenant-a:alice", saved: true, config });
    h.send.mockResolvedValue({ ok: true, accountKey: "tenant-a:alice", provider: "openai" });
    expect(await h.context.creativeWebSelectBoundApi("openai")).toMatchObject({ ok: true });
    expect(h.send).toHaveBeenCalledExactlyOnceWith("SET_ACTIVE_PROVIDER", {
      provider: "openai", accountKey: "tenant-a:alice", ownerFingerprint: undefined, config: undefined
    });
    expect(h.context.cfgFromForm()).toMatchObject({ provider: "openai", apiKey: "fixture-original-key" });
    expect(h.context.cfgFromForm()._ownerFingerprint).toBeUndefined();
  });

  it("does not invent an owner token for a legacy wallet action", async () => {
    const h = harness({ _accountKey: "tenant-a:alice", _ownerFingerprint: undefined });
    const config = { ...h.context.cfgFromForm(), apiKey: "", _supplyChannel: "platform_wallet" };
    h.send.mockResolvedValue(h.reply({ config }));
    expect(await h.context.usePlatformWallet()).toMatchObject({ ok: true });
    expect(h.send).toHaveBeenCalledExactlyOnceWith("USE_PLATFORM_WALLET", {
      accountKey: "tenant-a:alice", ownerFingerprint: undefined,
      config: expect.objectContaining({ _ownerFingerprint: undefined, _supplyChannel: "platform_wallet" })
    });
    expect(h.context.cfgFromForm()._ownerFingerprint).toBeUndefined();
  });
});
