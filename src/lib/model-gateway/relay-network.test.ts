import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));

import { assertPublicRelayUrl, isPublicRelayAddress, normalizeRelayBaseUrl, relayFetch } from "./relay-network";

describe("relay URL and pinned network safety", () => {
  beforeEach(() => { mocks.lookup.mockReset().mockResolvedValue([{ address: "1.1.1.1", family: 4 }]); mocks.request.mockReset(); });

  it("normalizes only bare-host API paths and preserves provider paths", () => {
    expect(normalizeRelayBaseUrl("sub.shaozhuangai.com")).toBe("https://sub.shaozhuangai.com/v1");
    expect(normalizeRelayBaseUrl(" https://sub.shaozhuangai.com/ ")).toBe("https://sub.shaozhuangai.com/v1");
    expect(normalizeRelayBaseUrl("https://example.com/compatible-mode/v1/")).toBe("https://example.com/compatible-mode/v1");
    expect(normalizeRelayBaseUrl("https://example.com/api/v3")).toBe("https://example.com/api/v3");
  });

  it.each(["http://example.com", "https://user:secret@example.com", "https://example.com/#secret", "https://127.0.0.1", "https://[::1]", "https://localhost", "https://something.local"])(
    "rejects an unsafe target without making a request: %s", async (target) => {
      await expect(relayFetch(target)).rejects.toThrow();
      expect(mocks.request).not.toHaveBeenCalled();
    }
  );

  it("rejects a query in configuration while allowing validated request query parameters", async () => {
    expect(() => normalizeRelayBaseUrl("https://example.com/v1?key=secret")).toThrow();
    expect((await assertPublicRelayUrl("https://example.com/v1/videos/task/content?variant=thumbnail", true)).url.search).toBe("?variant=thumbnail");
  });

  it("distinguishes a timeout signal from user cancellation", async () => {
    await expect(relayFetch("https://example.com/v1", { signal: AbortSignal.abort(new DOMException("timeout", "TimeoutError")) })).rejects.toMatchObject({ status: 504 });
    await expect(relayFetch("https://example.com/v1", { signal: AbortSignal.abort() })).rejects.toMatchObject({ status: 499 });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("honors cancellation while DNS is still resolving", async () => {
    mocks.lookup.mockImplementationOnce(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = relayFetch("https://example.com/v1", { signal: controller.signal });
    controller.abort(new DOMException("timeout", "TimeoutError"));
    await expect(pending).rejects.toMatchObject({ status: 504 });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each(["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "198.18.1.1", "192.0.2.1", "224.0.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "2001:db8::1", "2001:0000:1234::1", "2002:7f00:1::1"])(
    "classifies reserved/private/translation addresses as unsafe: %s", (address) => expect(isPublicRelayAddress(address)).toBe(false)
  );
  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "accepts a public unicast address: %s", (address) => expect(isPublicRelayAddress(address)).toBe(true)
  );

  it("rejects mixed public and private DNS answers before dispatch", async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: "1.1.1.1", family: 4 }, { address: "10.0.0.1", family: 4 }]);
    await expect(assertPublicRelayUrl("https://relay.example.com/v1")).rejects.toThrow("非公共地址");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("pins the checked DNS address while streaming the upstream body", async () => {
    mocks.request.mockImplementation((_url, options, callback) => {
      const req = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; end: () => void; destroy: () => void };
      req.write = vi.fn();
      req.destroy = () => req.emit("close");
      req.end = () => {
        const response = Readable.from([Buffer.from("streamed-result")]) as Readable & { statusCode: number; headers: Record<string, string> };
        response.statusCode = 200; response.headers = { "content-type": "application/octet-stream" };
        callback(response);
        response.on("end", () => req.emit("close"));
      };
      const resolved = vi.fn();
      options.lookup("relay.example.com", {}, resolved);
      expect(resolved).toHaveBeenCalledExactlyOnceWith(null, "1.1.1.1", 4);
      expect(options.headers).not.toHaveProperty("host");
      return req;
    });
    const response = await relayFetch("https://relay.example.com/v1/videos/task/content", { headers: { host: "private-host" } });
    expect(response.body).toBeTruthy();
    expect(await response.text()).toBe("streamed-result");
    expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith("relay.example.com", { all: true });
  });

  it("does not follow redirects or echo a credential-bearing Location header", async () => {
    mocks.request.mockImplementation((_url, _options, callback) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.destroy = () => req.emit("close");
      req.end = () => {
        const response = Readable.from([]) as Readable & { statusCode: number; headers: Record<string, string> };
        response.statusCode = 302; response.headers = { location: "https://secret@127.0.0.1" };
        callback(response);
      };
      return req;
    });
    await expect(relayFetch("https://relay.example.com/v1/models")).rejects.toThrow("重定向");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
});
