import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // 演示租户
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo-hoka" },
    update: {},
    create: { name: "霍卡工具管理组织", slug: "demo-hoka" }
  });

  // 演示账号：admin（管理版）/ tenant（租户版），均属演示租户
  await prisma.user.upsert({
    where: { username: "admin" },
    update: { tenantId: tenant.id, password: "admin123", authRole: "admin", role: "owner", name: "平台管理员" },
    create: {
      tenantId: tenant.id,
      username: "admin",
      password: "admin123",
      name: "平台管理员",
      authRole: "admin",
      role: "owner",
      email: "admin@demo.local"
    }
  });
  await prisma.user.upsert({
    where: { username: "tenant" },
    update: { tenantId: tenant.id, password: "tenant123", authRole: "tenant", role: "operator", name: "店铺运营" },
    create: {
      tenantId: tenant.id,
      username: "tenant",
      password: "tenant123",
      name: "店铺运营",
      authRole: "tenant",
      role: "operator",
      email: "tenant@demo.local"
    }
  });

  console.log(`Seeded tenant ${tenant.slug} (${tenant.id}) + demo accounts admin/tenant`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
