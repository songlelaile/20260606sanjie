import { describe, expect, it, vi } from "vitest";
import { accountKey, harness, oldReceipt, ready } from "./test-fixtures/studio-genesis-ui-harness";

type H = ReturnType<typeof harness>;
async function boot(h: H) {
  ready(h);
  await vi.waitFor(() => expect(h.document.control("[data-setting=model]").disabled).toBe(false));
}
function frameScheduler(h: H) {
  const callbacks: Array<() => void> = [];
  h.context.requestAnimationFrame = vi.fn((callback: () => void) => callbacks.push(callback));
  h.context.cancelAnimationFrame = vi.fn();
  return callbacks;
}
function completed(h: H) {
  Object.assign(h.saved.snapshot.tasks[0].slots[0], {
    status: "done", archiveOk: true,
    item: { resultId: "kept-result", url: "https://fixture.test/result.png", accountKey, studioTaskId: h.saved.draft.tasks[0].id },
  });
}
function pressKey(h: H, key: string, target: H["document"]["body"]) {
  const event = { type: "keydown", key, target, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
  for (const listener of h.document.listeners.get("keydown") || []) listener(event);
  return event;
}

describe("Studio rendering performance without dropping receipt saves", () => {
  it("coalesces a burst of controller notifications into one frame while awaiting every save", async () => {
    const h = harness("main");
    await boot(h);
    const callbacks = frameScheduler(h), renders = h.document.renders.length, writes = h.writes.length;
    const snapshot = vi.spyOn(h.controller(), "snapshot");
    await Promise.all(Array.from({ length: 100 }, () => h.controller().stop()));
    expect(h.writes.length - writes).toBe(100);
    expect(snapshot).toHaveBeenCalledTimes(100);
    expect(h.context.requestAnimationFrame).toHaveBeenCalledOnce();
    expect(h.document.renders).toHaveLength(renders);
    callbacks[0]();
    expect(h.document.renders).toHaveLength(renders + 1);
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("cancels an obsolete frame when a direct user interaction already paints the latest state", async () => {
    const h = harness("main");
    await boot(h);
    const callbacks = frameScheduler(h);
    await h.controller().stop();
    const confirmation = h.document.control("[data-confirm]");
    confirmation.checked = !confirmation.checked;
    h.document.root.dispatch("change", confirmation);
    expect(h.context.cancelAnimationFrame).toHaveBeenCalledOnce();
    const renders = h.document.renders.length;
    callbacks[0]();
    expect(h.document.renders).toHaveLength(renders);
    expect(h.document.control("[data-confirm]").checked).toBe(false);
  });

  it("synchronizes busy metadata when a hidden frame is queued but never paints", async () => {
    const h = harness("main");
    await boot(h);
    let importing = true;
    h.context.SZ_IMAGE_UPLOAD = { ...h.context.SZ_IMAGE_UPLOAD, isImporting: () => importing };
    h.document.visibilityState = "hidden";
    const callbacks = frameScheduler(h), renders = h.document.renders.length;
    h.bridge.setApiBusy.mockClear();
    // The controller itself reports idle here, while the workspace import still
    // protects configuration. That UI safety metadata must not wait for rAF.
    await h.controller().stop();
    expect(h.bridge.setApiBusy).toHaveBeenLastCalledWith("studio-genesis", true);
    importing = false;
    await h.controller().stop();
    expect(h.bridge.setApiBusy).toHaveBeenLastCalledWith("studio-genesis", false);
    expect(callbacks).toHaveLength(1);
    expect(h.document.renders).toHaveLength(renders);
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("selects and deselects results in place so preview images are not recreated", async () => {
    const h = harness("main");
    completed(h);
    await boot(h);
    const image = h.document.control("[data-preview]"), renders = h.document.renders.length;
    const checkbox = h.document.control("[data-result-select]");
    checkbox.checked = true;
    h.document.root.dispatch("change", checkbox);
    expect(h.document.control("[data-action=download-selected]").textContent).toBe("下载已选 (1)");
    expect(h.document.control("[data-action=download-selected]").disabled).toBe(false);
    h.document.root.dispatch("click", h.document.control("[data-action=select-results]"));
    await vi.waitFor(() => expect(checkbox.checked).toBe(false));
    expect(h.document.control("[data-action=download-selected]").disabled).toBe(true);
    expect(h.document.control("[data-preview]")).toBe(image);
    expect(h.document.renders).toHaveLength(renders);
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it.each(["button", "backdrop", "keyboard"] as const)("releases the full size preview and restores focus after %s close", async close => {
    const h = harness("main");
    completed(h);
    await boot(h);
    const image = h.document.control("[data-preview]"), focus = vi.spyOn(image, "focus");
    expect(image.attributes.get("role")).toBe("button");
    expect(image.attributes.get("tabindex")).toBe("0");
    if (close === "keyboard") expect(pressKey(h, "Enter", image).preventDefault).toHaveBeenCalledOnce();
    else h.document.root.dispatch("click", image);
    const modal = h.document.getElementById("sgPreview")!;
    expect(modal.querySelector("img")?.attributes.get("src")).toBe("https://fixture.test/result.png");
    if (close === "keyboard") expect(pressKey(h, "Escape", modal.querySelector("button")!).stopImmediatePropagation).toHaveBeenCalledOnce();
    else modal.dispatch("click", close === "button" ? modal.querySelector("[data-action=close-preview]")! : modal);
    expect(modal.hidden).toBe(true);
    expect(modal.querySelector("img")).toBeNull();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    h.document.root.dispatch("click", image);
    expect(modal.hidden).toBe(false);
    expect(modal.querySelector("img")?.attributes.get("src")).toBe("https://fixture.test/result.png");
    expect(h.controller().state.tasks[0].slots[0].item.resultId).toBe("kept-result");
  });

  it("returns focus to the current result trigger if a receipt repainted it during preview", async () => {
    const h = harness("main");
    completed(h);
    await boot(h);
    const callbacks = frameScheduler(h), original = h.document.control("[data-preview]");
    const oldFocus = vi.spyOn(original, "focus");
    h.document.root.dispatch("click", original);
    const modal = h.document.getElementById("sgPreview")!;
    await h.controller().stop();callbacks[0]();
    const replacement = h.document.control("[data-preview]"), currentFocus = vi.spyOn(replacement, "focus");
    expect(replacement).not.toBe(original);
    modal.dispatch("click", modal);
    expect(oldFocus).not.toHaveBeenCalled();
    expect(currentFocus).toHaveBeenCalledWith({ preventScroll: true });
    expect(modal.querySelector("img")).toBeNull();
  });

  it("supports Space to preview a product and returns focus on Escape", async () => {
    const h = harness("main");
    await boot(h);
    const product = h.document.control("[data-product-preview]"), focus = vi.spyOn(product, "focus");
    expect(pressKey(h, " ", product).preventDefault).toHaveBeenCalledOnce();
    const modal = h.document.getElementById("sgPreview")!;
    expect(modal.querySelector("img")?.attributes.get("src")).toBe("https://fixture.test/product.png");
    pressKey(h, "Escape", modal.querySelector("button")!);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(modal.querySelector("img")).toBeNull();
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("suspends elapsed timers while hidden and resumes without changing receipt identity", async () => {
    const h = harness("main"), record = h.saved.snapshot.tasks[0];
    const receipt = { ...oldReceipt, taskId: record.id, shotId: record.slots[0].shot.id, createdAt: Date.now() - 62_000 };
    Object.assign(record.slots[0], { status: "uncertain", pendingReceipt: receipt });
    h.saved.snapshot.pendingReceipts = [receipt];h.saved.snapshot.uncertain = receipt;
    const key = `sz_studio_genesis_pending_v2:${accountKey}:single:main:${receipt.jobId}`;
    h.storage.set(key, JSON.stringify(receipt));
    h.context.clearInterval = vi.fn();
    await boot(h);
    expect(h.context.setInterval).toHaveBeenCalledOnce();
    const tick = (h.context.setInterval as ReturnType<typeof vi.fn>).mock.calls[0][0] as () => void;
    const elapsed = h.document.control("[data-task-elapsed]"), before = elapsed.textContent;
    h.document.visibilityState = "hidden";h.document.dispatch("visibilitychange");
    expect(h.context.clearInterval).toHaveBeenCalledOnce();
    tick();
    expect(elapsed.textContent).toBe(before);
    h.document.visibilityState = "visible";h.document.dispatch("visibilitychange");
    expect(h.context.setInterval).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(h.document.control("[data-setting=model]").disabled).toBe(false));
    expect(JSON.parse(h.storage.get(key)!)).toEqual(receipt);
    expect(h.bridge.send).not.toHaveBeenCalled();
  });
});
