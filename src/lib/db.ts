import { PrismaClient } from "@prisma/client";

// Prisma 单例：避免 Next.js dev 热重载反复 new PrismaClient 造成连接耗尽。
const globalForPrisma = globalThis as typeof globalThis & {
  __prisma?: PrismaClient;
};

export const prisma: PrismaClient =
  globalForPrisma.__prisma ?? new PrismaClient({ log: ["warn", "error"] });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__prisma = prisma;
}
