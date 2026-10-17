import { describe, expect, it, vi } from "vitest";
import { accountKey, clone, deferred, harness, oldReceipt, ready } from "./test-fixtures/studio-genesis-ui-harness";

// The production UI and controller run with memory-only storage and synthetic
// bridge replies. These tests never request a provider or authenticated website.
type H = ReturnType<typeof harness>;
const click = (h: H, action: string) => h.document.root.dispatch("click", h.document.control(`[data-action=${action}]`));
const boot = async (h: H) => { ready(h); await vi.waitFor(() => expect(h.document.control("[data-setting=model]").disabled).toBe(false)); };

function seedBatch(h: H, statuses: Array<"done" | "unsaved" | "uncertain" | "ready">) {
  const original = clone(h.saved.draft.tasks[0]);
  const receipts: typeof oldReceipt[] = [];
  h.saved.draft.tasks = statuses.map((status, index) => {
    const task = { ...clone(original), id: `qa-product-${index}`, name: `QA 商品 ${index}` };
    task.plan = h.engine.createPlan(task, h.saved.draft.settings);
    return task;
  });
  h.saved.snapshot.tasks = h.saved.draft.tasks.map((task, index) => {
    const status = statuses[index], plan = task.plan as { shots: Array<{ id: string }> };
    return {
      id: task.id, name: task.name, plan: clone(plan),
      slots: plan.shots.map(shot => {
        const receipt = { ...oldReceipt, taskId: task.id, shotId: shot.id, jobId: `qa-request-${index}` };
        if (status === "uncertain") {
          receipts.push(receipt);
          h.storage.set(`sz_studio_genesis_pending_v2:${accountKey}:batch:main:${receipt.jobId}`, JSON.stringify(receipt));
        }
        return {
          shot: clone(shot), status: status === "unsaved" ? "done" : status,
          item: status === "done" || status === "unsaved" ? {
            resultId: `qa-result-${index}`, url: `https://fixture.test/qa-result-${index}.png`, studioTaskId: task.id, studioGenesisPlan: clone(plan)
          } : null,
          archiveOk: status === "done", error: "", ...(status === "uncertain" ? { pendingReceipt: receipt } : {})
        };
      })
    };
  });
  if (receipts.length) { h.saved.snapshot.uncertain = receipts[0]; h.saved.snapshot.pendingReceipts = receipts; }
}

describe("independent image task cleanup preservation", () => {
  it("hides only archived batch completions and retains unsaved originals and unresolved receipt identities", async () => {
    const h = harness("batch"); seedBatch(h, ["done", "unsaved", "uncertain"]); await boot(h);
    const before = clone(h.controller().snapshot()), journal = [...h.storage], writes = h.writes.length;
    expect(h.document.root.querySelectorAll("[data-task]")).toHaveLength(3);
    click(h, "clear-completed");
    await vi.waitFor(() => expect(h.document.root.querySelectorAll("[data-task]")).toHaveLength(2));
    expect(h.document.root.querySelectorAll("[data-task]").map(node => node.dataset.task)).toEqual(["qa-product-1", "qa-product-2"]);
    expect(h.document.root.querySelectorAll("[data-task-row]").map(node => node.dataset.taskRow).join(" ")).not.toContain("qa-product-0");
    expect(h.document.root.textContent).toContain("原件待补存");
    expect(h.document.root.textContent).toContain("qa-request-2");
    expect(h.controller().snapshot()).toEqual(before); expect([...h.storage]).toEqual(journal); expect(h.writes).toHaveLength(writes);
    expect(h.bridge.send).not.toHaveBeenCalled();
    click(h, "restore-completed");
    await vi.waitFor(() => expect(h.document.root.querySelectorAll("[data-task]")).toHaveLength(3));
    expect(h.controller().snapshot()).toEqual(before); expect([...h.storage]).toEqual(journal);
  });

  it("allows completed-list cleanup while another batch request is running and keeps its eventual result", async () => {
    const h = harness("batch"), reply = deferred<unknown>(); seedBatch(h, ["done", "ready"]);
    Object.assign(h.bridge, { archive: vi.fn(async () => ({ ok: true })) }); h.bridge.send.mockImplementation(() => reply.promise);
    await boot(h); click(h, "generate"); await vi.waitFor(() => expect(h.bridge.send).toHaveBeenCalledOnce());
    click(h, "clear-completed");
    await vi.waitFor(() => expect(h.document.root.querySelectorAll("[data-task]").map(node => node.dataset.task)).toEqual(["qa-product-1"]));
    expect(h.controller().state.tasks[1].slots[0].status).toBe("generating");
    expect(h.controller().state.tasks[0].slots[0].item.resultId).toBe("qa-result-0");
    reply.complete({ ok: true, images: ["https://fixture.test/qa-late-original.png"] });
    await vi.waitFor(() => expect(h.controller().state.tasks[1].slots[0].archiveOk).toBe(true));
    expect(h.controller().state.tasks[1].slots[0].item.url).toBe("https://fixture.test/qa-late-original.png");
    expect(h.document.root.querySelectorAll("img").some(node => node.attributes.get("src") === "https://fixture.test/qa-late-original.png")).toBe(true);
    expect(h.bridge.send).toHaveBeenCalledOnce();
  });

  it("omits product, plan and result DOM when batch tasks are collapsed while retaining complete controller state", async () => {
    const h = harness("batch"); seedBatch(h, ["done", "done"]); await boot(h);
    const before = clone(h.controller().snapshot());
    expect(h.document.root.querySelectorAll("[data-product-preview]")).toHaveLength(2);
    click(h, "collapse-all");
    await vi.waitFor(() => expect(h.document.root.querySelectorAll("[data-product-preview]")).toHaveLength(0));
    expect(h.document.root.querySelectorAll("[data-preview]")).toHaveLength(0);
    expect(h.document.root.querySelectorAll("[data-shot]")).toHaveLength(0);
    expect(h.document.root.querySelectorAll("[data-task]")).toHaveLength(2);
    expect(h.controller().snapshot()).toEqual(before); expect(h.bridge.send).not.toHaveBeenCalled();
    click(h, "collapse");
    await vi.waitFor(() => expect(h.document.root.querySelectorAll("[data-product-preview]")).toHaveLength(1));
    expect(h.document.root.querySelectorAll("[data-preview]")).toHaveLength(1);
    expect(h.controller().snapshot()).toEqual(before);
  });

  it("rejects cleanup after an account change without altering originals, receipts or visible tasks", async () => {
    const h = harness("batch"); seedBatch(h, ["done", "uncertain"]); await boot(h);
    const before = clone(h.controller().snapshot()), journal = [...h.storage], writes = h.writes.length;
    h.bridge.getAccountKey.mockResolvedValue("different-account"); click(h, "clear-completed");
    await vi.waitFor(() => expect(h.document.control("[data-message]").textContent).toContain("登录账号已变化"));
    expect(h.document.root.querySelectorAll("[data-task]")).toHaveLength(2);
    expect(h.controller().snapshot()).toEqual(before); expect([...h.storage]).toEqual(journal); expect(h.writes).toHaveLength(writes);
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("does not reuse an old cleanup mark to hide newly completed plans for the same batch task ids", async () => {
    const h = harness("batch"); seedBatch(h, ["done", "done"]);
    Object.assign(h.bridge, { archive: vi.fn(async () => ({ ok: true })) });
    h.bridge.send.mockResolvedValue({ ok: true, images: ["https://fixture.test/qa-new-plan.png"] });
    await boot(h); click(h, "clear-completed");
    await vi.waitFor(() => expect(h.document.root.querySelectorAll("[data-task]")).toHaveLength(0));
    const ratio = h.document.control("[data-setting=ratio]"); ratio.value = "3:4";
    h.document.root.dispatch("change", ratio);
    await vi.waitFor(() => expect(h.document.root.querySelectorAll("[data-task]")).toHaveLength(2));
    click(h, "plan");
    await vi.waitFor(() => expect(h.document.root.querySelectorAll("[data-confirm]")).toHaveLength(2));
    for (const confirm of h.document.root.querySelectorAll("[data-confirm]")) {
      confirm.checked = true; h.document.root.dispatch("change", confirm);
    }
    click(h, "generate");
    await vi.waitFor(() => expect(h.bridge.send).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.controller().state.tasks.every((task: { slots: Array<{ archiveOk: boolean }> }) => task.slots.every(slot => slot.archiveOk))).toBe(true));
    expect(h.document.root.querySelectorAll("[data-task]")).toHaveLength(2);
    expect(h.document.root.querySelectorAll("[data-preview]")).toHaveLength(4);
  });
});
