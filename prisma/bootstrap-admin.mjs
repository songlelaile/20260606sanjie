import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";

const prisma = new PrismaClient();

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return ["scrypt", "16384", "8", "1", salt.toString("hex"), hash.toString("hex")].join("$");
}

function requiredEnv(name) {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} 必填`);
  return value;
}

async function main() {
  const username = requiredEnv("BOOTSTRAP_ADMIN_USERNAME");
  const password = requiredEnv("BOOTSTRAP_ADMIN_PASSWORD");
  const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || "平台管理员";
  const tenantName = process.env.BOOTSTRAP_ADMIN_TENANT?.trim() || "平台管理组织";
  if (username.length < 3 || username.length > 64) {
    throw new Error("BOOTSTRAP_ADMIN_USERNAME 长度必须为 3–64 个字符");
  }
  if (password.length < 16) {
    throw new Error("BOOTSTRAP_ADMIN_PASSWORD 至少 16 个字符");
  }
  if (["admin123", "tenant123", "password", "12345678"].includes(password.toLowerCase())) {
    throw new Error("禁止使用公开演示口令或常见弱口令");
  }

  await prisma.$transaction(async (tx) => {
    const [existingUsername, adminCount] = await Promise.all([
      tx.user.findUnique({ where: { username }, select: { id: true } }),
      tx.user.count({ where: { authRole: "admin", status: "active" } })
    ]);
    if (existingUsername) throw new Error("该管理员用户名已存在；初始化脚本不会覆盖或重置现有密码");
    if (adminCount > 0) throw new Error("已存在有效管理员；初始化脚本拒绝再次创建，请使用应用内管理员流程");

    const tenant = await tx.tenant.create({
      data: {
        name: tenantName,
        slug: `admin-${randomBytes(8).toString("hex")}`
      }
    });
    const shopId = `shop-${tenant.id}`;
    await tx.shop.create({
      data: {
        id: shopId,
        tenantId: tenant.id,
        name: tenantName,
        platform: "淘宝",
        createdBy: name
      }
    });
    await tx.shopCalcRun.create({
      data: {
        tenantId: tenant.id,
        shopId,
        runId: "",
        cycleId: "",
        createdAt: "",
        investmentResults: [],
        breakthroughResults: [],
        audiencePlans: [],
        managementDashboard: {
          productCount: 0,
          monthlyNetSales: 0,
          monthlyProfitEstimate: 0,
          monthlyGsvOpportunity: 0,
          marketSalesGap: 0,
          historicalMarginRate: 0,
          plannedProfit: 0,
          availableAdBudget: 0,
          plannedMarginRate: 0,
          topProducts: []
        }
      }
    });
    await tx.user.create({
      data: {
        tenantId: tenant.id,
        username,
        password: hashPassword(password),
        name,
        authRole: "admin",
        role: "owner",
        shopName: tenantName,
        email: ""
      }
    });
  });
  console.log("已创建一次性强密码管理员；初始化脚本不会输出或保存明文密码。");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

