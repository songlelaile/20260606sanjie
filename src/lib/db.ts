import { PrismaClient } from "@prisma/client";

// Cache in production too: middleware and route bundles share a process, but
// can evaluate this module separately and otherwise open independent pools.
const globalForPrisma = globalThis as typeof globalThis & {
  __prisma?: PrismaClient;
};

export const prisma: PrismaClient =
  globalForPrisma.__prisma ?? new PrismaClient({ log: ["warn", "error"] });

globalForPrisma.__prisma = prisma;
