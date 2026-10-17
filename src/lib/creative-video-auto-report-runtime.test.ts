import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

function runtime(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  const fetch = vi.fn(fetchImpl);
  const context = vm.createContext({ URL, Response, TextEncoder, Blob, FormData, AbortController, Uint8Array, ArrayBuffer, setTimeout, clearTimeout,
    crypto: webcrypto, fetch, location: { origin: "https://www.shaozhuangai.com", protocol: "https:" },
    atob: (s: string) => Buffer.from(s, "base64").toString("binary") });
  for (const file of ["labs/ecommerce-video-studio/video-studio-contract.js", "src/ecommerce-video-background.js"]) vm.runInContext(readFileSync(new URL(`../../public/creative/${file}`, import.meta.url), "utf8"), context);
  vm.runInContext(`var records={}; var account='tenant-a:alice'; var controller=SZEcommerceVideoBackground.createController({
    resolveAccountKey:async()=>account,resolveCredentials:async()=>({accountKey:account,config:{apiKey:'fixture-private-key'}}),
    storageGet:async(key)=>({[key]:records[key]}),storageSet:async(values)=>Object.assign(records,values)});`, context);
  const send = (payload: object) => vm.runInContext(`controller.handleMessage(JSON.parse(${JSON.stringify(JSON.stringify(payload))}))`, context);
  return { send, context, fetch };
}
const image = { id: "local-image", name: "fixture.png", registrationKind: "virtual", mimeType: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
const prepare = (asset: object = image) => ({ type: "VIDEO_STUDIO_ASSET_PREPARE", rightsConfirmed: true, assets: [asset] });
const reply = (data: object) => Response.json({ ok: true, data: { accountKey: "tenant-a:alice", ...data } });
describe("automatic reporting real runtime checkpoints", () => {
  it("only forwards a fingerprint, never the BYOK key, and shares a concurrent preparation", async () => {
    const run = runtime(async (_url, init) => {
      const headers = new Headers(init.headers);
      expect(headers.get("x-video-account")).toBe("tenant-a%3Aalice");
      expect(JSON.stringify(init.headers)).not.toContain("fixture-private-key");
      expect(JSON.parse(decodeURIComponent(headers.get("x-video-binding")!)).credentialFingerprint).toMatch(/^[a-f0-9]{64}$/);
      return reply({ asset: { id: "va_fixture", status: "active", canUse: true } });
    });
    const result = await Promise.all([run.send(prepare()), run.send(prepare())]);
    expect(result[0]).toMatchObject({ ok: true, payload: { assets: [{ status: "active", libraryId: "va_fixture" }] } });
    expect(run.fetch).toHaveBeenCalledOnce();
  });
  it("lost upload response is recovered by original hash with no second POST", async () => {
    let hash = "";
    const run = runtime(async (_url, init) => {
      if (init.method === "POST") { hash = JSON.parse(String(init.body)).sha256; throw new Error("fixture disconnect"); }
      return reply({ assets: [{ id: "va_fixture", sha256: hash, materialType: "virtual", status: "active", canUse: true }] });
    });
    expect(await run.send(prepare())).toMatchObject({ ok: false });
    expect(await run.send(prepare({ id: image.id, registrationKind: "virtual" }))).toMatchObject({ ok: true, payload: { assets: [{ status: "active" }] } });
    expect(run.fetch.mock.calls.filter(call => call[1].method === "POST")).toHaveLength(1);
  });
  it("unverified person returns explicit no-upload evidence and sends no bytes", async () => {
    const run = runtime(async () => { throw new Error("must not contact supplier"); });
    expect(await run.send(prepare({ ...image, registrationKind: "real" }))).toMatchObject({ ok: true, payload: { assets: [{ status: "needs_authorization", uploadRequired: true, providerSubmitted: false }] } });
    expect(run.fetch).not.toHaveBeenCalled();
  });
  it("explicit configuration rejection can permit a first upload later, scoped to one asset", async () => {
    const run = runtime(async () => Response.json({ ok: false, error: { code: "ASSET_SERVICE_NOT_CONFIGURED" } }, { status: 503 }));
    expect(await run.send(prepare())).toMatchObject({ ok: false, payload: { error: { details: { uploadRequired: true, providerSubmitted: false, assetId: image.id } } } });
  });
  it("rights and classification are enforced before any upload", async () => {
    const run = runtime(async () => { throw new Error("unexpected"); });
    expect(await run.send({ ...prepare(), rightsConfirmed: false })).toMatchObject({ ok: false });
    expect(await run.send(prepare({ ...image, registrationKind: "unknown" }))).toMatchObject({ ok: false });
    expect(run.fetch).not.toHaveBeenCalled();
  });
});
