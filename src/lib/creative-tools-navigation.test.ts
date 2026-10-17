import { describe, expect, it, vi } from "vitest";
import { ACCOUNT, tools, bootCreativeToolsFixture as boot, createCreativeToolsFixture, flushCreativeToolsFixture as flush, type NavResult, type StoredToolDraft, type StoredMaterialDraft } from "./creative-tools-navigation-fixture";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("real creative tools UI navigation bridge", () => {
  it.each(tools)("%s awaits both draft and material-history commits before allowing idle navigation", async tool => {
    const h = await boot(tool), before = h.ui().getState(); h.holdWrites();
    let settled = false;
    const permission = h.ui().canDeactivate().then((result: NavResult) => { settled = true; return result; });
    await flush(); expect(settled).toBe(false); expect(h.heldWrites).toHaveLength(1);
    await h.releaseOneWrite(); expect(settled).toBe(false); expect(h.heldWrites).toHaveLength(1);
    expect(h.writes.at(-1)?.key).toBe(`${ACCOUNT}:material-history`);
    await h.releaseOneWrite(); expect((await permission).allowed).toBe(true);
    const stored = h.records.get(`${ACCOUNT}:tool:${tool}`) as StoredToolDraft;
    expect(stored.products).toEqual(before.draft.products); expect(stored.config.requirements).toBe("保留要求");
    expect(stored.snapshot.previousResults).toEqual(before.controller.previousResults);
    expect(h.writes.map(write => write.key)).toContain(`${ACCOUNT}:material-history`);
    expect(h.bridge.send).not.toHaveBeenCalled(); expect(h.forbidden).not.toHaveBeenCalled();
  });

  it.each(tools)("%s permits an idle unconfirmed receipt after saving and keeps generation blocked", async tool => {
    const h = await boot(tool, { uncertain: true }), journal = h.journals.get(h.receiptKey), before = h.ui().getState();
    expect(before.busy).toBe(false); expect(before.controller.uncertain).toEqual(h.receipt);
    expect((await h.ui().canDeactivate()).allowed).toBe(true);
    expect(h.journals.get(h.receiptKey)).toBe(journal); expect(h.context.localStorage.removeItem).not.toHaveBeenCalled();
    const stored = h.records.get(`${ACCOUNT}:tool:${tool}`) as StoredToolDraft;
    expect(stored.snapshot.uncertain).toEqual(before.controller.uncertain);
    expect(stored.snapshot.previousResults).toEqual(before.controller.previousResults);
    expect(h.document.control('[data-action="generate"]').disabled).toBe(true);
    h.click('[data-action="generate"]'); await flush(); expect(h.bridge.send).not.toHaveBeenCalled();
  });

  const operations = ["API switch", "internal tool navigation", "upload", "external URL import", "analysis", "main generation", "material generation"] as const;
  for (const tool of tools) it.each(operations.filter(operation => tool !== "refinement" || operation !== "material generation"))(`${tool} blocks navigation during %s through the real operation entry`, async operation => {
    const h = await boot(tool);
    if (operation === "API switch") {
      const select = h.document.control("#ctBoundApi"); select.value = "alternate"; h.document.dispatch("change", select);
    } else if (operation === "internal tool navigation") {
      h.holdWrites(); h.click(`[data-action="switch-tool"][data-tool="${tool === "buyer" ? "clothing" : "buyer"}"]`);
    } else if (operation === "upload") {
      const input = h.document.control('[data-upload="products"]'); input.files = [{ type: "image/png", size: 32, name: "fixture.png" }]; h.document.dispatch("change", input);
    } else if (operation === "external URL import") h.setImporting(true);
    else if (operation === "analysis") h.click('[data-action="analyze"]');
    else if (operation === "main generation") h.click('[data-action="generate"]');
    else {
      h.click('[data-action="material-open"]'); await flush(); h.click('[data-action="material-generate"]');
    }
    await flush(); expect(h.ui().getState().busy).toBe(true);
    expect((await h.ui().canDeactivate()).allowed).toBe(false);
    if (operation === "main generation" || operation === "material generation") {
      expect(h.sends).toHaveLength(1); expect(h.sends[0].type).toBe("GENERATE_IMAGE");
      const current = h.ui().getState();
      expect(operation === "main generation" ? current.controller.busy : current.materialController.busy).toBe(true);
      await h.finishGeneration();
    } else if (operation === "API switch") { h.apiSwitch.complete({ ok: true }); await flush(); }
    else if (operation === "internal tool navigation") await h.releaseWrites();
    else if (operation === "upload") { h.readers[0].complete(); await flush(); }
    else if (operation === "external URL import") h.setImporting(false);
    else { h.analysis.complete("离线分析结果"); await flush(); }
    expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("persists an idle material receipt without clearing or submitting it", async () => {
    const h = await boot("buyer", { modalUncertain: true });
    const key = `sz_creative_pending_v1:${ACCOUNT}:material:model`, receipt = h.journals.get(key);
    h.click('[data-action="material-open"]'); await flush();
    expect(h.ui().getState().materialController.uncertain).not.toBeNull();
    h.holdWrites(); let settled = false;
    const permission = h.ui().canDeactivate().then((result: NavResult) => { settled = true; return result; });
    await flush(); expect(settled).toBe(false);
    await h.releaseOneWrite(); expect(settled).toBe(false);
    await h.releaseOneWrite(); expect(settled).toBe(false); expect(h.writes.at(-1)?.key).toBe(`${ACCOUNT}:material-draft:model`);
    await h.releaseOneWrite(); expect((await permission).allowed).toBe(true);
    expect(h.journals.get(key)).toBe(receipt); expect(h.context.localStorage.removeItem).not.toHaveBeenCalled();
    const stored = h.records.get(`${ACCOUNT}:material-draft:model`) as StoredMaterialDraft;
    expect(stored.snapshot.uncertain).toEqual(h.ui().getState().materialController.uncertain);
    expect(h.document.control('[data-action="material-generate"]').disabled).toBe(true);
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it.each(tools)("%s denies navigation when the current account changes before or during save", async tool => {
    const early = await boot(tool); early.setAccount("different-account");
    expect((await early.ui().canDeactivate()).allowed).toBe(false); expect(early.writes).toEqual([]);
    const h = await boot(tool); h.holdWrites(); const permission = h.ui().canDeactivate();
    await flush(); h.setAccount("different-account"); await h.releaseWrites();
    expect((await permission).allowed).toBe(false);
    expect(h.writes.every(write => write.key.startsWith(`${ACCOUNT}:`))).toBe(true);
    expect(h.records.has("different-account:tool:" + tool)).toBe(false);
  });

  it.each(tools)("%s denies navigation on save failure and retains its receipt and completed work", async tool => {
    const h = await boot(tool, { uncertain: true }), original = clone(h.records.get(`${ACCOUNT}:tool:${tool}`)), receipt = h.journals.get(h.receiptKey);
    h.failWrites(); const permission = await h.ui().canDeactivate();
    expect(permission.allowed).toBe(false); expect(permission.reason).toBe("fixture save quota failure");
    expect(h.records.get(`${ACCOUNT}:tool:${tool}`)).toEqual(original); expect(h.journals.get(h.receiptKey)).toBe(receipt);
    expect(h.context.localStorage.removeItem).not.toHaveBeenCalled(); expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("rechecks a new active URL import after awaited persistence", async () => {
    const h = await boot("buyer"); h.holdWrites(); const permission = h.ui().canDeactivate();
    await flush(); h.setImporting(true); await h.releaseWrites();
    expect((await permission).allowed).toBe(false); expect(h.ui().getState().busy).toBe(true);
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("blocks new real operations while the navigation snapshot is being saved", async () => {
    const h = await boot("clothing"); h.holdWrites(); const permission = h.ui().canDeactivate(); await flush();
    expect(h.ui().getState().busy).toBe(true); h.click('[data-action="analyze"]'); h.click('[data-action="generate"]'); await flush();
    expect(h.bridge.analyze).not.toHaveBeenCalled(); expect(h.bridge.send).not.toHaveBeenCalled();
    await h.releaseWrites(); expect((await permission).allowed).toBe(true);
  });

  it("honors the contract in-flight transport interface even when the snapshot is idle", async () => {
    const h = await boot("buyer", { inFlightInterface: true }); h.setInFlight(true);
    expect(h.ui().getState().controller.busy).toBe(false); expect(h.ui().getState().busy).toBe(true);
    expect((await h.ui().canDeactivate()).allowed).toBe(false);
    h.setInFlight(false); expect((await h.ui().canDeactivate()).allowed).toBe(true);
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it.each(tools)("%s keeps an actually timed-out transport active until its original Promise settles", async tool => {
    const h = await boot(tool); h.click('[data-action="generate"]'); await flush();
    expect(h.sends).toHaveLength(1); await h.fireGenerationTimeout();
    expect(h.ui().getState().controller.busy).toBe(false); expect(h.ui().getState().controller.uncertain).not.toBeNull();
    expect(h.ui().getState().awaitingReceipt).toBe(true); expect((await h.ui().canDeactivate()).allowed).toBe(false);
    const receipt = h.journals.get(h.receiptKey);
    await h.finishGeneration();
    expect(h.ui().getState().awaitingReceipt).toBe(false); expect((await h.ui().canDeactivate()).allowed).toBe(true);
    expect(h.journals.get(h.receiptKey)).toBe(receipt); expect(h.context.localStorage.removeItem).not.toHaveBeenCalled();
    expect(h.document.control('[data-action="generate"]').disabled).toBe(true); expect(h.sends).toHaveLength(1); expect(h.forbidden).not.toHaveBeenCalled();
  });

  it.each(["clothing", "buyer"] as const)("%s protects an actually timed-out material Promise", async tool => {
    const h = await boot(tool); h.click('[data-action="material-open"]'); await flush(); h.click('[data-action="material-generate"]'); await flush();
    await h.fireGenerationTimeout(); expect(h.ui().getState().materialController.busy).toBe(false);
    expect(h.ui().getState().materialController.uncertain).not.toBeNull(); expect(h.ui().getState().awaitingReceipt).toBe(true);
    expect((await h.ui().canDeactivate()).allowed).toBe(false);
    h.click('[data-action="close-material"]'); await flush(); expect(h.ui().getState().materialController).not.toBeNull();
    await h.finishGeneration(); expect((await h.ui().canDeactivate()).allowed).toBe(true);
    expect(h.context.localStorage.removeItem).not.toHaveBeenCalled(); expect(h.sends).toHaveLength(1); expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("retains the material modal on failed save and retries its latest snapshot before closing", async () => {
    const h = await boot("buyer"); h.click('[data-action="material-open"]'); await flush();
    h.failWrites(); const field=h.document.control('[data-material-field="requirements"]');field.value="保留失败的素材要求";h.document.dispatch("input",field);await flush();
    h.click('[data-action="close-material"]');await flush();
    expect(h.ui().getState().materialController).not.toBeNull();expect(h.document.control("#ctMaterialModal").hidden).toBe(false);
    expect((await h.ui().canDeactivate()).allowed).toBe(false);
    h.recoverWrites();h.holdWrites();h.click('[data-action="close-material"]');await flush();
    expect(h.document.control("#ctMaterialModal").hidden).toBe(false);await h.releaseWrites();await flush();
    expect(h.document.control("#ctMaterialModal").hidden).toBe(true);expect(h.ui().getState().materialController).toBeNull();
    expect((h.records.get(`${ACCOUNT}:material-draft:model`) as StoredMaterialDraft).config.requirements).toBe("保留失败的素材要求");
    expect((await h.ui().canDeactivate()).allowed).toBe(true);expect(h.forbidden).not.toHaveBeenCalled();expect(h.sends).toEqual([]);
  });

  it("protects a real retry-archive Promise while the generation controller is idle", async () => {
    const h=await boot("buyer");h.bridge.archive.mockResolvedValue({ok:false});
    h.click('[data-action="generate"]');await flush();await h.finishGeneration({ok:true,images:["data:image/png;base64,iVBORw0KGgo="]});
    expect(h.ui().getState().controller.busy).toBe(false);expect(h.ui().getState().controller.slots[0].archiveOk).toBe(false);
    let complete!: (result:{ok:boolean})=>void;const archive=new Promise<{ok:boolean}>(resolve=>{complete=resolve;});h.bridge.archive.mockImplementation(()=>archive);
    h.click('[data-action="retry-archive"]');await flush();
    expect(h.ui().getState().controller.slots[0].archiveSaving).toBe(true);expect(h.ui().getState().busy).toBe(true);
    expect((await h.ui().canDeactivate()).allowed).toBe(false);
    complete({ok:true});await flush();expect(h.ui().getState().controller.slots[0].archiveOk).toBe(true);
    expect((await h.ui().canDeactivate()).allowed).toBe(true);expect(h.sends).toHaveLength(1);expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("preserves original storage after a partial startup render fails", async () => {
    const first=await boot("buyer"), broken=clone(first.records.get(`${ACCOUNT}:tool:buyer`)) as StoredToolDraft;broken.products=[null];
    const records=new Map(first.records);records.set(`${ACCOUNT}:tool:buyer`,broken);
    const h = createCreativeToolsFixture("buyer",{seedRecords:records});await flush();
    expect(h.context.SZ_LAB_STARTUP.fail).toHaveBeenCalledOnce();expect(h.ui().getState().startupFailed).toBe(true);
    expect(h.ui().getState().busy).toBe(false);expect((await h.ui().canDeactivate()).allowed).toBe(true);
    expect(h.records.get(`${ACCOUNT}:tool:buyer`)).toEqual(broken);expect(h.writes).toEqual([]);
    const event={preventDefault:vi.fn(),returnValue:undefined};
    for(const [name,listener] of h.context.addEventListener.mock.calls)if(name==='beforeunload')listener(event);
    Object.defineProperty(h.document,'visibilityState',{value:'hidden',configurable:true});h.document.dispatch('visibilitychange',h.document.body);await flush();
    expect(event.preventDefault).not.toHaveBeenCalled();expect(h.writes).toEqual([]);expect(h.records.get(`${ACCOUNT}:tool:buyer`)).toEqual(broken);
  });

  it("reloads the exact committed batch, unconfirmed receipt, draft and completed results", async () => {
    const first = await boot("buyer", { uncertain: true }), original = first.ui().getState();
    expect((await first.ui().canDeactivate()).allowed).toBe(true);
    const reloaded = await boot("buyer", { seedRecords: first.records, seedJournals: first.journals }), restored = reloaded.ui().getState();
    expect(restored.controller.batchId).toBe(original.controller.batchId);
    expect(restored.controller.uncertain).toEqual(original.controller.uncertain);
    expect(restored.controller.slots).toEqual(original.controller.slots);
    expect(restored.controller.previousResults).toEqual(original.controller.previousResults);
    expect(restored.draft.products).toEqual(original.draft.products); expect(restored.draft.config).toEqual(original.draft.config);
    expect(reloaded.journals.get(first.receiptKey)).toBe(first.journals.get(first.receiptKey));
    expect(reloaded.context.localStorage.removeItem).not.toHaveBeenCalled();
    expect(reloaded.document.control('[data-action="generate"]').disabled).toBe(true);
    expect(reloaded.bridge.send).not.toHaveBeenCalled(); expect(reloaded.forbidden).not.toHaveBeenCalled();
  });
});
