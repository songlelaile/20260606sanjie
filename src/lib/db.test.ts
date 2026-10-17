import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ constructed: vi.fn() }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { constructor() { mocks.constructed(); } } }));
afterEach(() => { delete (globalThis as typeof globalThis & { __prisma?: unknown }).__prisma; vi.unstubAllEnvs(); vi.resetModules(); });
it("reuses the production database client across independent module evaluations", async () => {
  vi.stubEnv("NODE_ENV", "production");
  delete (globalThis as typeof globalThis & { __prisma?: unknown }).__prisma;
  vi.resetModules(); const first = await import("./db");
  vi.resetModules(); const second = await import("./db");
  expect(second.prisma).toBe(first.prisma);
  expect(mocks.constructed).toHaveBeenCalledTimes(1);
});
