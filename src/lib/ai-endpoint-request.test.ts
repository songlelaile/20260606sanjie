import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  httpsRequest: vi.fn(),
  checkServerIdentity: vi.fn()
}));

vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.httpsRequest }));
vi.mock("node:tls", () => ({ checkServerIdentity: mocks.checkServerIdentity }));

import { postJsonToSafeAiEndpoint } from "@/lib/ai-endpoint";

describe("pinned AI HTTPS request", () => {
  beforeEach(() => {
    mocks.lookup.mockReset();
    mocks.httpsRequest.mockReset();
    mocks.checkServerIdentity.mockReset();
    mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    mocks.httpsRequest.mockImplementation((options, onResponse) => {
      const request = new EventEmitter() as EventEmitter & { end: (body: Buffer) => void };
      request.end = vi.fn(() => {
        const response = new EventEmitter() as EventEmitter & { statusCode: number; destroy: (error: Error) => void };
        response.statusCode = 200;
        response.destroy = (error) => response.emit("error", error);
        onResponse(response);
        response.emit("data", Buffer.from('{"choices":[]}'));
        response.emit("end");
      });
      return request;
    });
  });

  it("connects to the validated IP while preserving the original Host and SNI", async () => {
    const response = await postJsonToSafeAiEndpoint<{ choices: unknown[] }>(
      "https://api.example.com/v1/chat/completions",
      { body: "{}", headers: { authorization: "Bearer secret" } }
    );

    const options = mocks.httpsRequest.mock.calls[0][0];
    expect(response).toMatchObject({ ok: true, status: 200, payload: { choices: [] } });
    expect(options.hostname).toBe("93.184.216.34");
    expect(options.servername).toBe("api.example.com");
    expect(options.headers.host).toBe("api.example.com");
  });

  it("does not connect when any resolved address is private", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 }
    ]);

    await expect(postJsonToSafeAiEndpoint("https://api.example.com/v1", { body: "{}" }))
      .rejects.toThrow(/不允许访问/);
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });
});
