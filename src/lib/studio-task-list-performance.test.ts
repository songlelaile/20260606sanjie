import { describe, expect, it, vi } from "vitest";
import { accountKey, clone, harness, ready } from "./test-fixtures/studio-genesis-ui-harness";

type H = ReturnType<typeof harness>;
async function boot(h: H) {
  ready(h);
  await vi.waitFor(() => expect(h.document.control("[data-setting=model]").disabled).toBe(false));
}
async function click(h: H, name: string, page?: string, scope?: string) {
  const button = h.document.root.querySelectorAll(`[data-action=${name}]`).find(button =>
    (page === undefined || button.dataset.page === page) && (scope === undefined || button.dataset.scope === scope));
  expect(button, name).toBeDefined();
  h.document.root.dispatch("click", button!);
  await vi.waitFor(() => expect(h.bridge.getAccountKey).toHaveBeenCalled());
  // Account ownership is checked asynchronously before changing the view.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function batch(count: number) {
  const h = harness("batch"), original = clone(h.saved.draft.tasks[0]);
  h.saved.draft.tasks = Array.from({ length: count }, (_, index) => {
    const entry = { ...clone(original), id: `task-${index}`, name: `商品 ${index}` };
    entry.plan = h.engine.createPlan(entry, h.saved.draft.settings);
    return entry;
  });
  h.saved.snapshot.tasks = h.saved.draft.tasks.map(entry => ({ id: entry.id, name: entry.name, plan: entry.plan,
    slots: (entry.plan as { shots: unknown[] }).shots.map(shot => ({ shot, status: "ready", item: null, error: "", archiveOk: false })) }));
  return h;
}

describe("bounded image task and result views", () => {
  it("renders six batch editors at a time, visits the last page and opens a newly added task", async () => {
    const h = batch(29);await boot(h);
    expect(h.document.root.querySelectorAll("[data-task]")).toHaveLength(6);
    const before = clone(h.controller().snapshot());
    for (let page = 1; page <= 4; page++) await click(h, "batch-page", String(page));
    expect(h.document.root.querySelectorAll("[data-task]")).toHaveLength(5);
    expect(h.document.control("[data-task]").dataset.task).toBe("task-24");
    await click(h, "add-task");
    await vi.waitFor(() => expect(h.document.root.querySelectorAll("[data-task]")).toHaveLength(6));
    expect(h.document.root.querySelectorAll("[data-task-field=name]").at(-1)?.value).toBe("商品任务 30");
    expect(h.controller().snapshot()).toEqual(before);
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("pages a hundred result cards and task rows, unloads images on collapse, and restores originals", async () => {
    const h = harness("main");
    const saved = h.saved, entry = saved.draft.tasks[0], record = saved.snapshot.tasks[0];
    record.slots[0].status = "done";record.slots[0].archiveOk = true;
    record.slots[0].item = { resultId: "first", url: "https://fixture.test/first.png", accountKey, studioTaskId: entry.id, studioGenesisPlan: clone(entry.plan) };
    saved.snapshot.previousResults = Array.from({ length: 99 }, (_, index) => ({ ...clone(record.slots[0]),
      item: { ...clone(record.slots[0].item), resultId: `old-${index}`, url: `https://fixture.test/old-${index}.png` } }));
    // Extra task rows represent independent completed image receipts.
    saved.snapshot.tasks = Array.from({ length: 25 }, (_, index) => ({ ...clone(record), id: index ? `previous-${index}` : entry.id,
      slots: [{ ...clone(record.slots[0]), receiptJobId: `receipt-${index}` }] }));
    await boot(h);
    const all = clone(h.controller().snapshot());
    expect(h.document.root.querySelectorAll("[data-preview]")).toHaveLength(12);
    expect(h.document.root.querySelectorAll("[data-task-row]")).toHaveLength(20);
    expect(h.document.control("[data-preview]").attributes.get("loading")).toBe("lazy");
    await click(h, "task-page", "1");
    expect(h.document.root.querySelectorAll("[data-task-row]")).toHaveLength(5);
    await click(h, "result-page", "1", "single");
    expect(h.document.root.querySelectorAll("[data-preview]")).toHaveLength(12);
    await click(h, "toggle-results", undefined, "single");
    expect(h.document.root.querySelectorAll("[data-preview]")).toHaveLength(0);
    await click(h, "clear-completed");
    expect(h.document.root.querySelectorAll("[data-task-row]")).toHaveLength(0);
    await click(h, "restore-completed");
    expect(h.document.root.querySelectorAll("[data-task-row]")).toHaveLength(20);
    await click(h, "toggle-results", undefined, "single");
    expect(h.document.root.querySelectorAll("[data-preview]")).toHaveLength(12);
    expect(h.controller().snapshot()).toEqual(all);expect(h.bridge.send).not.toHaveBeenCalled();
  });
});
