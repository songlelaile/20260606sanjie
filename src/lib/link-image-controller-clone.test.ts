import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(resolve(process.env.SANJIE_LINK_CORE_SOURCE || "public/creative/labs/image-prompt-lab/creative-tools-contract.js"), "utf8");
type Shot = { id: string; label: string; prompt: string };
type Plan = { ok: boolean; sourceSignature: string; signature: string; shots: Shot[]; images: { products: Array<{ image: string; name: string }> }; extra?: unknown };
type ResultSlot = { shot: Shot; status: string; item: { image: string; label: string } | null; archiveOk?: boolean; archiveSaving?: boolean };
type State = { plan: Plan | null; slots: ResultSlot[]; previousResults: ResultSlot[]; busy: boolean; uncertain: unknown; accountKey: string };
type Controller = { state: State; setPlan(plan: Plan): unknown; snapshot(): State; restore(saved: State): { ok: boolean } };
type Core = { createController(deps: Record<string, unknown>): Controller };

// Strings are immutable leaves. Repeated large image strings do not need a
// second aggregate string in order to copy independently mutable containers.
function clonePlain<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => clonePlain(item)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clonePlain(item)])) as T;
  return value;
}
function harness(clone?: unknown) {
  const stringify = vi.fn(JSON.stringify);
  const context = createContext({ URL, console, JSON: { parse: JSON.parse, stringify } });
  runInContext(source, context);
  const api = context.SZ_CREATIVE_TOOLS_CONTRACT as Core;
  const controller = api.createController({
    ...(clone === undefined ? {} : { clonePlain: clone }),
    // Isolate controller copying from the plan contract's own fingerprinting.
    contract: { verifyPlan: () => ({ ok: true }) },
    archiveContext: () => ({ accountKey: "link-owner" })
  });
  return { controller, stringify };
}
function plan(image = "data:image/png;base64,AAAA"): Plan {
  return { ok: true, sourceSignature: "source-1", signature: "signed-1", shots: [{ id: "shot-1", label: "产品细节", prompt: "保留原款商品" }], images: { products: [{ image, name: "当前原图" }] } };
}
const isShotIdentity = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === "id,label,prompt";

describe("optional link controller plain-data copying", () => {
  it("uses the opted-in clone for setPlan, snapshot and restore while keeping containers independent", () => {
    const copy = vi.fn(clonePlain), { controller, stringify } = harness(copy), original = plan();
    stringify.mockImplementation(value => {
      // The live core additionally compares bounded shot metadata on restore.
      // That guard must stay active; aggregate state/plan copying must not run.
      if (!isShotIdentity(value)) throw new Error("whole-controller JSON serialization must not run");
      return JSON.stringify(value);
    });
    controller.setPlan(original);
    expect(controller.state.plan).not.toBe(original);
    expect(controller.state.plan!.images.products).not.toBe(original.images.products);
    expect(controller.state.plan!.images.products[0].image).toBe(original.images.products[0].image);
    original.shots[0].label = "只修改输入方案";
    expect(controller.state.plan!.shots[0].label).toBe("产品细节");

    const saved = controller.snapshot();
    expect(saved).not.toBe(controller.state);
    expect(saved.plan).not.toBe(controller.state.plan);
    expect(saved.slots[0].shot).not.toBe(controller.state.slots[0].shot);
    expect(controller.restore(saved)).toEqual({ ok: true });
    saved.plan!.images.products[0].name = "只修改调用方快照";
    saved.slots[0].shot.prompt = "只修改调用方镜头";
    expect(controller.state.plan!.images.products[0].name).toBe("当前原图");
    expect(controller.state.slots[0].shot.prompt).toBe("保留原款商品");
    expect(copy.mock.calls.some(([value]) => value === original)).toBe(true);
    expect(copy.mock.calls.some(([value]) => value === saved)).toBe(true);
    expect(stringify.mock.calls.every(([value]) => isShotIdentity(value))).toBe(true);
  });

  it("copies retained original results beyond one browser string without serializing the controller", () => {
    const image = "data:image/png;base64," + "A".repeat(4 * 1024 * 1024);
    const { controller, stringify } = harness(clonePlain);
    stringify.mockImplementation(value => {
      if (!isShotIdentity(value)) throw new Error("whole-controller JSON serialization must not run");
      return JSON.stringify(value);
    });
    controller.setPlan(plan(image));
    controller.state.previousResults = Array.from({ length: 160 }, (_, index) => ({ shot: { id: `old-${index}`, label: `原件 ${index}`, prompt: "旧提示词" }, status: "done", item: { image, label: `旧结果 ${index}` }, archiveOk: true }));
    expect(controller.state.previousResults.length * image.length).toBeGreaterThan(600 * 1024 * 1024);
    const saved = controller.snapshot();
    expect(saved.previousResults).toHaveLength(160);
    expect(saved.previousResults[159].item!.image).toBe(image);
    expect(saved.previousResults[0]).not.toBe(controller.state.previousResults[0]);
    expect(saved.previousResults[0].item).not.toBe(controller.state.previousResults[0].item);
    expect(controller.restore(saved)).toEqual({ ok: true });
    saved.previousResults[0].item!.label = "修改快照";
    expect(controller.state.previousResults[0].item!.label).toBe("旧结果 0");
    expect(controller.state.previousResults[159].archiveOk).toBe(true);
    expect(stringify.mock.calls.every(([value]) => isShotIdentity(value))).toBe(true);
  });

  it.each([undefined, "not-a-function"])("keeps default JSON copy behavior when clonePlain is %s", clone => {
    const { controller, stringify } = harness(clone), original = plan();
    original.extra = { omitted: undefined, array: [undefined, Number.NaN] };
    controller.setPlan(original);
    expect(controller.state.plan!.extra).toEqual({ array: [null, null] });
    const saved = controller.snapshot();
    expect(controller.restore(saved)).toEqual({ ok: true });
    expect(stringify).toHaveBeenCalled();
    expect(controller.state.plan).not.toBe(saved.plan);
    expect(controller.state.plan!.signature).toBe("signed-1");
    expect(controller.state.accountKey).toBe("link-owner");
  });
});
