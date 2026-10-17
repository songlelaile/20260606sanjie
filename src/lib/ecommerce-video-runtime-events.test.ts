import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const script = (path: string) => readFileSync(resolve("public/creative", path), "utf8");

class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  textContent = ""; value = ""; hidden = false; disabled = false; replacements = 0;
  style = { setProperty() {} };
  classList = { add() {}, remove() {}, toggle() {} };
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  getAttribute(key: string) { return this.attributes[key]; }
  append(...items: Element[]) { this.children.push(...items); }
  appendChild(item: Element) { this.children.push(item); return item; }
  replaceChildren(...items: Element[]) { this.children = items; this.replacements++; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  closest() { return this; }
  addEventListener() {} showModal() {} remove() {}
}

interface Run { id: string; taskId?: string; status: string; purpose: string; resultUrls: string[]; progress?: number }
interface Message { type: string; payload: Record<string, unknown> }
type Listener = (message: Message, sender: Record<string, unknown>, response: (value: unknown) => void) => boolean | void;
interface Runtime { sendMessage: (message: Message, callback?: (value: unknown) => void) => void; onMessage: { addListener: (listener: Listener) => void } }
interface Studio { cacheDom(): void; bindRuntimeEvents(): void; fetchResult(run: Run, open: boolean): Promise<unknown>; state: { history: Run[]; legacySingle: boolean } }

function harness() {
  const nodes = new Map<string, Element>();
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id)!; };
  const saveRun = vi.fn(async (run: Run) => run);
  const network = vi.fn(() => { throw new Error("This regression fixture must not use the network"); });
  const context = createContext({ console, URL, URLSearchParams, Blob, Promise, Map, Set, Date,
    crypto: { randomUUID: () => "offline-id" }, __SZ_VIDEO_STUDIO_EXPOSE_TESTING__: true,
    location: { href: "https://fixture.test/creative/labs/ecommerce-video-studio/video-studio.html", origin: "https://fixture.test" },
    setTimeout: () => 0, clearTimeout() {}, fetch: network,
    document: { readyState: "loading", addEventListener() {}, getElementById: get, createElement: () => new Element(), querySelectorAll: () => [] },
    SZEcommerceVideoStore: { saveRun }
  });
  runInContext(script("web-chrome.js"), context);
  runInContext(script("labs/ecommerce-video-studio/video-studio-contract.js"), context);
  const runtime = context.chrome.runtime as Runtime;
  runtime.onMessage.addListener((message, _sender, respond) => {
    if (!["VIDEO_STUDIO_RESULT", "VIDEO_STUDIO_STATUS"].includes(message.type)) return false;
    Promise.resolve().then(() => respond({ ok: true, payload: { task: {
      taskId: "completed-history", status: "succeeded", resultUrls: ["https://fixture.test/completed.mp4"]
    } } }));
    return true;
  });
  const send = runtime.sendMessage;
  const messages: Message[] = [];
  runtime.sendMessage = (message, callback) => {
    messages.push(message);
    // Bound the old feedback loop so a failing regression cannot hang the suite.
    if (messages.length > 12) { callback?.({ ok: false, error: { message: "OFFLINE_FEEDBACK_LIMIT" } }); return; }
    send(message, callback);
  };
  const pushedListeners: Listener[] = [];
  const addListener = runtime.onMessage.addListener;
  runtime.onMessage.addListener = listener => { pushedListeners.push(listener); addListener(listener); };
  runInContext(script("labs/ecommerce-video-studio/video-studio.js"), context);
  const api = context.SZEcommerceVideoStudioTesting as Studio;
  api.cacheDom(); api.state.legacySingle = true; get("history-filter").value = "all";
  api.state.history = [{ id: "completed-history", status: "succeeded", purpose: "generation", resultUrls: [] }];
  api.bindRuntimeEvents();
  const push = (message: Message) => pushedListeners.forEach(listener => listener(message, {}, () => {}));
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  return { api, messages, network, saveRun, get, push, settle };
}

describe("video history commands cannot masquerade as pushed task receipts", () => {
  it("performs one completed-history result lookup through the real website runtime shim", async () => {
    const h = harness();
    await h.api.fetchResult(h.api.state.history[0], false); await h.settle();
    expect(h.messages.map(message => message.type)).toEqual(["VIDEO_STUDIO_RESULT"]);
    expect(h.saveRun).toHaveBeenCalledTimes(2);
    expect(h.get("history-list").replacements).toBe(1);
    expect(h.api.state.history[0]).toMatchObject({ status: "succeeded", resultUrls: ["https://fixture.test/completed.mp4"] });
    expect(h.network).not.toHaveBeenCalled();
  });

  it.each(["VIDEO_STUDIO_STATUS", "VIDEO_STUDIO_RESULT"])("ignores the taskId-only %s command even for an existing completed task", async type => {
    const h = harness();
    h.push({ type, payload: { taskId: "completed-history", schemaVersion: 1 } }); await h.settle();
    expect(h.messages).toHaveLength(0); expect(h.saveRun).not.toHaveBeenCalled();
    expect(h.get("history-list").replacements).toBe(0);
  });

  it("preserves a real pushed processing receipt without fetching a completed result", async () => {
    const h = harness();
    h.push({ type: "VIDEO_STUDIO_STATUS", payload: { task: { taskId: "completed-history", status: "processing", progress: 40 } } }); await h.settle();
    expect(h.api.state.history[0]).toMatchObject({ status: "processing", progress: 40 });
    expect(h.saveRun).toHaveBeenCalledTimes(1); expect(h.messages).toHaveLength(0);
  });

  it("preserves a genuine completed push and queries its result once without feeding back", async () => {
    const h = harness();
    h.push({ type: "VIDEO_STUDIO_RESULT", payload: { taskId: "completed-history", state: "completed" } }); await h.settle();
    expect(h.messages.map(message => message.type)).toEqual(["VIDEO_STUDIO_RESULT"]);
    expect(h.saveRun).toHaveBeenCalledTimes(3);
    expect(h.api.state.history[0].resultUrls).toEqual(["https://fixture.test/completed.mp4"]);
    expect(h.network).not.toHaveBeenCalled();
  });

  it("ignores an unknown task receipt instead of contaminating another history row", async () => {
    const h = harness();
    h.push({ type: "VIDEO_STUDIO_STATUS", payload: { taskId: "other-account-task", status: "succeeded" } }); await h.settle();
    expect(h.saveRun).not.toHaveBeenCalled(); expect(h.messages).toHaveLength(0);
    expect(h.api.state.history).toHaveLength(1);
  });
});
