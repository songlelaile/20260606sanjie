import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const lab = resolve("public/creative/labs/image-prompt-lab");
const background = readFileSync(resolve(lab, "background.js"), "utf8");
const contract = readFileSync(resolve(lab, "studio-genesis-contract.js"), "utf8");
const ui = readFileSync(resolve(lab, "studio-genesis-ui.js"), "utf8");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const product = `data:image/png;base64,${Buffer.alloc(32, 1).toString("base64")}`;
const privateDiagnostic = "synthetic-private-provider-diagnostic";

interface FailureMetadata {
  code: string;
  status?: number;
  httpStatus?: number;
  providerSubmitted?: boolean;
  definitiveFailure?: boolean;
  stateUncertain?: boolean;
}
interface ResponseReceipt extends Partial<FailureMetadata> {
  ok: boolean;
  error?: string;
  raw?: unknown;
  images?: string[];
}
interface Slot {
  status: string;
  error: string;
  errorMeta?: FailureMetadata;
  generationFailure?: { code: string };
}
interface Snapshot {
  tasks: Array<{ slots: Slot[] }>;
  uncertain: Record<string, unknown> | null;
}
interface Controller {
  run: (tasks: unknown[], settings: Record<string, unknown>) => Promise<unknown>;
  retryFailed: (tasks: unknown[], settings: Record<string, unknown>) => Promise<unknown>;
  retrySlot: (taskId: string, shotId: string, tasks: unknown[], settings: Record<string, unknown>) => Promise<unknown>;
  snapshot: () => Snapshot;
}
interface StudioContract {
  defaults: (mode: string) => Record<string, unknown>;
  createPlan: (task: unknown, settings: Record<string, unknown>) => { ok: boolean };
  createController: (dependencies: Record<string, unknown>) => Controller;
}
type FetchJson = (url: string, options: Record<string, unknown>, timeout: number) => Promise<ResponseReceipt>;

function sourceBlock(source: string, start: string, end: string) {
  const offset = source.indexOf(start);
  const limit = source.indexOf(end, offset);
  expect(offset).toBeGreaterThanOrEqual(0);
  expect(limit).toBeGreaterThan(offset);
  return source.slice(offset, limit);
}

function display(slot: Partial<Slot>) {
  const context = createContext({});
  runInContext(sourceBlock(ui, "  function historicalSlotError(", "  function resultsMarkup("), context);
  return (context.historicalSlotError as (value: Partial<Slot>) => string)(slot);
}

function fixture(response: ResponseReceipt) {
  const context = createContext({ URL, setTimeout, clearTimeout });
  runInContext(contract, context);
  const api = context.SZ_STUDIO_GENESIS as StudioContract;
  let pending: Record<string, unknown> | null = null;
  let sendCount = 0;
  let reply = async (): Promise<ResponseReceipt> => clone(response);
  const saved: Snapshot[] = [];
  const bridge = {
    getAccountKey: async () => "offline:error-owner",
    config: () => ({ provider: "fixture", imageModel: "fixture-image" }),
    modelInfo: () => ({ ready: true, supportsReference: true }),
    send: async () => { sendCount++; return reply(); },
    archive: async () => ({ ok: true })
  };
  const journal = {
    read: () => pending,
    write: (receipt: Record<string, unknown>) => { pending = clone(receipt); },
    clear: () => { pending = null; }
  };
  const controller = api.createController({
    bridge, journal, lock: async (_name: string, run: () => unknown) => run(),
    onChange: (snapshot: Snapshot) => { saved.push(clone(snapshot)); }
  });
  const settings = { ...api.defaults("detail"), count: 1 };
  const task = { id: "offline-product", name: "离线商品", requirements: "保留同款", products: [{ image: product, name: "原图" }], overrides: null, analysis: "", plan: {} };
  task.plan = api.createPlan(task, settings);
  expect(task.plan).toMatchObject({ ok: true });
  return { controller, task, settings, saved, pending: () => pending, sends: () => sendCount, setReply: (next: () => Promise<ResponseReceipt>) => { reply = next; } };
}

describe("studio image error regression", () => {
  it("classifies the real HTTP 400 image-model rejection without returning provider text", async () => {
    let calls = 0;
    const context = createContext({
      AbortController, setTimeout, clearTimeout,
      isShaozhuangHostedEndpoint: () => true,
      consumeModelRequestBudget: () => true,
      fetch: async () => {
        calls++;
        return { status: 400, text: async () => JSON.stringify({ error: { message: 'images endpoint requires an image model, got "image2"', config: privateDiagnostic } }) };
      }
    });
    runInContext(sourceBlock(background, "function modelRequestErrorBody(", "\nfunction createDashScopeImageTask("), context);
    const response = await (context.fetchJson as FetchJson)("https://offline.test/images", { method: "POST" }, 1000);
    expect(response).toMatchObject({ ok: false, code: "image_model_invalid", httpStatus: 400, definitiveFailure: true, stateUncertain: false });
    expect(response.error).toContain("重新选择模型");
    expect(JSON.stringify(response)).not.toMatch(/synthetic-private|image2|endpoint|raw/);
    expect(calls).toBe(1);
  });

  it("reads safe error metadata and never infers broken materials from a generic legacy message", () => {
    const error = "请求暂时无法完成，请检查素材和模型设置。";
    expect(display({ status: "failed", error })).toContain("这张图片暂时未完成");
    const model = display({ status: "failed", error, errorMeta: { code: "image_model_invalid", httpStatus: 400 } });
    expect(model).toContain("重新选择模型");
    expect(model).not.toContain("素材");
    expect(display({ status: "failed", error, errorMeta: { code: "image_input_preparation_failed" } })).toContain("产品图或素材暂时无法读取");
    const pending = display({ status: "uncertain", error, errorMeta: { code: "image_model_invalid" } });
    expect(pending).toContain("原请求的结果待确认");
    expect(pending).toContain("其他任务可继续");
    expect(pending).not.toMatch(/素材|重新选择模型|重新生成|重新提交/);
  });

  it("persists only safe metadata and clears the old category before an explicit retry", async () => {
    const f = fixture({ ok: false, code: "IMAGE_MODEL_INVALID", error: "所选模型不适用于生图，请重新选择模型并核对设置。", httpStatus: 400, providerSubmitted: false, definitiveFailure: true, stateUncertain: false, raw: privateDiagnostic });
    await f.controller.run([f.task], f.settings);
    expect(f.saved.some(snapshot => snapshot.tasks[0]?.slots[0].errorMeta?.code === "image_model_invalid")).toBe(true);
    expect(JSON.stringify(f.controller.snapshot())).not.toContain(privateDiagnostic);
    f.setReply(async () => {
      expect(f.controller.snapshot().tasks[0].slots[0].errorMeta).toBeUndefined();
      return { ok: false, code: privateDiagnostic, error: "安全失败文案", providerSubmitted: false, definitiveFailure: true, stateUncertain: false };
    });
    await f.controller.retrySlot(f.task.id, "shot-1", [f.task], f.settings);
    const slot = f.controller.snapshot().tasks[0].slots[0];
    expect(slot.errorMeta?.code).toBe("request_invalid");
    expect(slot.generationFailure?.code).toBe("request_invalid");
    expect(JSON.stringify(f.controller.snapshot())).not.toContain(privateDiagnostic);
    expect(f.sends()).toBe(2);
  });

  it("retains an unknown result and prevents another request through both retry paths", async () => {
    const f = fixture({ ok: false, code: "image_model_invalid", error: "请求结果尚未确认，请查看原任务进度，避免重复生成。", providerSubmitted: true, definitiveFailure: false, stateUncertain: true });
    await f.controller.run([f.task], f.settings);
    const slot = f.controller.snapshot().tasks[0].slots[0];
    expect(slot.status).toBe("uncertain");
    expect(slot.errorMeta).toMatchObject({ providerSubmitted: true, stateUncertain: true });
    expect(f.pending()).not.toBeNull();
    await f.controller.retryFailed([f.task], f.settings);
    await f.controller.retrySlot(f.task.id, "shot-1", [f.task], f.settings);
    expect(f.sends()).toBe(1);
    expect(f.controller.snapshot().uncertain).not.toBeNull();
  });
});
