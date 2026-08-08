import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";

const prisma = new PrismaClient();

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1
  });
  return ["scrypt", "16384", "8", "1", salt.toString("hex"), hash.toString("hex")].join("$");
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境禁止执行演示 seed；请使用 npm run db:bootstrap-admin 一次性初始化强密码管理员。");
  }
  if (process.env.ALLOW_DEMO_SEED !== "true") {
    throw new Error("演示 seed 默认关闭；仅本地演示可显式执行 ALLOW_DEMO_SEED=true npm run db:seed。");
  }
  // 演示管理租户
  const adminTenant = await prisma.tenant.upsert({
    where: { slug: "demo-admin" },
    update: {},
    create: { name: "三阶引擎管理组织", slug: "demo-admin" }
  });

  // 演示租户账号独立租户，默认无业务数据
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo-tenant-empty" },
    update: {},
    create: { name: "演示空白店铺", slug: "demo-tenant-empty" }
  });

  // 演示账号：admin（管理版）/ tenant（租户版）
  await prisma.user.upsert({
    where: { username: "admin" },
    update: {
      tenantId: adminTenant.id,
      password: hashPassword("admin123"),
      authRole: "admin",
      role: "owner",
      name: "平台管理员"
    },
    create: {
      tenantId: adminTenant.id,
      username: "admin",
      password: hashPassword("admin123"),
      name: "平台管理员",
      authRole: "admin",
      role: "owner",
      email: "admin@demo.local"
    }
  });
  await prisma.user.upsert({
    where: { username: "tenant" },
    update: {
      tenantId: tenant.id,
      password: hashPassword("tenant123"),
      authRole: "tenant",
      role: "operator",
      name: "店铺运营"
    },
    create: {
      tenantId: tenant.id,
      username: "tenant",
      password: hashPassword("tenant123"),
      name: "店铺运营",
      authRole: "tenant",
      role: "operator",
      email: "tenant@demo.local"
    }
  });

  console.log(`Seeded demo accounts admin (${adminTenant.slug}) / tenant (${tenant.slug})`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
