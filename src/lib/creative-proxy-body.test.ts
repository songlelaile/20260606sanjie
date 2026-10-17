import { describe, expect, it, vi } from "vitest";
import { CreativeProxyBodyLimitError, readCreativeProxyBody } from "./creative-proxy-body";

describe("creative proxy bounded bodies", () => {
  it("accepts the exact byte boundary", async () => {
    const response = new Response("汉字");
    const bytes = await readCreativeProxyBody(response, 6);
    expect(new TextDecoder().decode(bytes)).toBe("汉字");
  });

  it("rejects declared oversize without consuming the stream", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { "content-length": "100" } });
    await expect(readCreativeProxyBody(response, 5)).rejects.toBeInstanceOf(CreativeProxyBodyLimitError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a chunked response as soon as actual bytes exceed the limit", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel
    }), { headers: { "content-length": "1" } });
    await expect(readCreativeProxyBody(response, 5)).rejects.toBeInstanceOf(CreativeProxyBodyLimitError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("aborts a stalled stream without waiting for another chunk", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const pending = readCreativeProxyBody(new Response(new ReadableStream({ cancel })), 5, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
