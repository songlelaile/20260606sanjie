import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const baseUrl = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const pluginPath =
  process.env.SMOKE_PLUGIN_PATH ?? "/downloads/sycm-keyword-collector-v1.8.58.zip";
const expectedPluginHash = process.env.SMOKE_PLUGIN_SHA256?.trim().toLowerCase() ?? "";
const suffix = `${Date.now()}-${randomBytes(3).toString("hex")}`;

const fixtures = {
  a: {
    tenantId: `smoke-tenant-a-${suffix}`,
    tenantName: `隔离测试租户 A ${suffix}`,
    slug: `smoke-a-${suffix}`,
    username: `smoke_a_${suffix}`,
    password: `SmokeA-${suffix}`,
    shopId: `smoke-shop-a-${suffix}`,
    shopName: `隔离测试店铺 A ${suffix}`,
    productCount: 111,
    sales: 1111
  },
  b: {
    tenantId: `smoke-tenant-b-${suffix}`,
    tenantName: `隔离测试租户 B ${suffix}`,
    slug: `smoke-b-${suffix}`,
    username: `smoke_b_${suffix}`,
    password: `SmokeB-${suffix}`,
    shopId: `smoke-shop-b-${suffix}`,
    shopName: `隔离测试店铺 B ${suffix}`,
    productCount: 222,
    sales: 2222
  }
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function dashboardFor(fixture) {
  return {
    productCount: fixture.productCount,
    monthlyNetSales: fixture.sales,
    monthlyProfitEstimate: fixture.sales / 10,
    monthlyGsvOpportunity: fixture.sales * 2,
    marketSalesGap: fixture.sales,
    historicalMarginRate: 0.2,
    plannedProfit: fixture.sales / 5,
    availableAdBudget: fixture.sales / 6,
    plannedMarginRate: 0.18,
    topProducts: []
  };
}

class CookieJar {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }

  update(response) {
    const lines =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    for (const line of lines) {
      const [pair, ...attributes] = line.split(";");
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const deleted =
        value === "" || attributes.some((part) => /^\s*max-age=0\s*$/i.test(part));
      if (deleted) this.values.delete(name);
      else this.values.set(name, value);
    }
  }

  header() {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  clone() {
    return new CookieJar(Object.fromEntries(this.values));
  }
}

async function request(path, options = {}, jar) {
  const headers = new Headers(options.headers);
  if (jar?.header()) headers.set("cookie", jar.header());
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
    redirect: options.redirect ?? "manual",
    signal: AbortSignal.timeout(20_000)
  });
  jar?.update(response);
  return response;
}

async function json(response) {
  return response.json().catch(() => null);
}

async function login(fixture, jar) {
  const response = await request(
    "/api/auth/login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: fixture.username, password: fixture.password })
    },
    jar
  );
  assert(response.status === 200, `登录 ${fixture.tenantName} 失败：HTTP ${response.status}`);
  assert(
    response.headers.get("cache-control")?.includes("no-store"),
    "登录响应缺少 no-store"
  );
  assert(jar.values.has("sanjie_session"), "登录成功但未写入会话 cookie");
  assert(!jar.values.has("sanjie_active_shop"), "登录后未清除旧店铺 cookie");
}

async function expectDashboard(fixture, jar) {
  const response = await request("/api/dashboards/management", {}, jar);
  const payload = await json(response);
  assert(response.status === 200, `读取 ${fixture.tenantName} 看板失败：HTTP ${response.status}`);
  const dashboard = payload?.data?.dashboard;
  assert(dashboard?.productCount === fixture.productCount, "读取到了其他租户的商品数");
  assert(dashboard?.monthlyNetSales === fixture.sales, "读取到了其他租户的销售额");
}

async function expectIdentity(fixture, jar) {
  const response = await request("/api/auth/me", {}, jar);
  const payload = await json(response);
  assert(response.status === 200, `会话校验失败：HTTP ${response.status}`);
  assert(payload?.data?.tenantId === fixture.tenantId, "会话返回了错误租户");
  assert(payload?.data?.username === fixture.username, "会话返回了错误账号");
}

async function seedFixture(fixture) {
  await prisma.$transaction([
    prisma.tenant.create({
      data: { id: fixture.tenantId, name: fixture.tenantName, slug: fixture.slug }
    }),
    prisma.user.create({
      data: {
        tenantId: fixture.tenantId,
        username: fixture.username,
        password: fixture.password,
        name: fixture.tenantName,
        authRole: "tenant",
        role: "operator",
        shopName: fixture.shopName
      }
    }),
    prisma.shop.create({
      data: {
        id: fixture.shopId,
        tenantId: fixture.tenantId,
        name: fixture.shopName,
        createdBy: "tenant-isolation-smoke"
      }
    }),
    prisma.shopCalcRun.create({
      data: {
        tenantId: fixture.tenantId,
        shopId: fixture.shopId,
        investmentResults: [],
        breakthroughResults: [],
        audiencePlans: [],
        managementDashboard: dashboardFor(fixture)
      }
    })
  ]);
}

async function cleanup() {
  const tenantIds = [fixtures.a.tenantId, fixtures.b.tenantId];
  await prisma.$transaction([
    prisma.dailyAudienceMetric.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    prisma.dailyPromotionMetric.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    prisma.dailyProductMetric.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    prisma.intervention.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
  ]);
}

async function main() {
  await seedFixture(fixtures.a);
  await seedFixture(fixtures.b);

  const anonymous = await request("/api/dashboards/management");
  assert(anonymous.status === 401, `未登录请求应为 401，实际 ${anonymous.status}`);
  assert(
    anonymous.headers.get("cache-control")?.includes("no-store"),
    "未登录响应缺少 no-store"
  );

  const jar = new CookieJar({ sanjie_active_shop: fixtures.b.shopId });
  await login(fixtures.a, jar);
  await expectIdentity(fixtures.a, jar);
  await expectDashboard(fixtures.a, jar);

  const pageA = await request("/dashboards/management", {}, jar);
  assert(pageA.status === 200, `租户 A 看板页面不可访问：HTTP ${pageA.status}`);

  const crossShopA = await request(
    "/api/shops/active",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shopId: fixtures.b.shopId })
    },
    jar
  );
  assert(crossShopA.status === 404, `租户 A 可切换到租户 B 店铺：HTTP ${crossShopA.status}`);

  const staleTenantJar = jar.clone();
  await prisma.user.update({
    where: { username: fixtures.a.username },
    data: { tenantId: fixtures.b.tenantId }
  });
  const staleTenant = await request("/api/auth/me", {}, staleTenantJar);
  assert(staleTenant.status === 401, "账号迁租后旧会话仍被接受");
  const staleTenantLogin = await request("/login", {}, staleTenantJar);
  assert(staleTenantLogin.status === 200, "账号迁租后旧会话导致登录页不可访问");
  await prisma.user.update({
    where: { username: fixtures.a.username },
    data: { tenantId: fixtures.a.tenantId }
  });

  const logout = await request("/api/auth/logout", { method: "POST" }, jar);
  assert(logout.status === 200, `退出失败：HTTP ${logout.status}`);
  assert(!jar.values.has("sanjie_session"), "退出后会话 cookie 未清除");
  assert(!jar.values.has("sanjie_active_shop"), "退出后店铺 cookie 未清除");

  await login(fixtures.b, jar);
  await expectIdentity(fixtures.b, jar);
  await expectDashboard(fixtures.b, jar);

  const crossShopB = await request(
    "/api/shops/active",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shopId: fixtures.a.shopId })
    },
    jar
  );
  assert(crossShopB.status === 404, `租户 B 可切换到租户 A 店铺：HTTP ${crossShopB.status}`);

  const roleChangedJar = jar.clone();
  await prisma.user.update({
    where: { username: fixtures.b.username },
    data: { authRole: "admin" }
  });
  const roleChanged = await request("/api/auth/me", {}, roleChangedJar);
  assert(roleChanged.status === 401, "角色变更后旧会话仍被接受");
  await prisma.user.update({
    where: { username: fixtures.b.username },
    data: { authRole: "tenant" }
  });

  const disabledJar = jar.clone();
  await prisma.user.update({
    where: { username: fixtures.b.username },
    data: { status: "disabled" }
  });
  const disabledMe = await request("/api/auth/me", {}, disabledJar);
  assert(disabledMe.status === 401, "账号禁用后旧会话仍被接受");
  const disabledLogin = await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: fixtures.b.username, password: fixtures.b.password })
  });
  assert(disabledLogin.status === 403, `禁用账号登录应为 403，实际 ${disabledLogin.status}`);
  const recoveryLogin = await request("/login", {}, disabledJar);
  assert(recoveryLogin.status === 200, "账号禁用后旧会话导致登录页不可访问");

  const tamperedJar = jar.clone();
  const token = tamperedJar.values.get("sanjie_session");
  assert(token, "缺少用于篡改测试的会话 token");
  tamperedJar.values.set(
    "sanjie_session",
    `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`
  );
  const tampered = await request("/api/dashboards/management", {}, tamperedJar);
  assert(tampered.status === 401, "篡改后的签名会话未被拒绝");

  await prisma.user.update({
    where: { username: fixtures.b.username },
    data: { status: "active" }
  });
  await login(fixtures.a, jar);
  await expectDashboard(fixtures.a, jar);

  const plugin = await request(pluginPath);
  assert(plugin.status === 200, `AI 插件下载失败：HTTP ${plugin.status}`);
  assert(
    plugin.headers.get("content-type")?.includes("application/zip"),
    `AI 插件 MIME 异常：${plugin.headers.get("content-type")}`
  );
  const pluginBytes = Buffer.from(await plugin.arrayBuffer());
  assert(pluginBytes.length > 100_000, `AI 插件文件异常偏小：${pluginBytes.length} bytes`);
  const pluginHash = createHash("sha256").update(pluginBytes).digest("hex");
  if (expectedPluginHash) {
    assert(pluginHash === expectedPluginHash, "AI 插件哈希发生变化");
  }

  console.log(
    JSON.stringify({
      ok: true,
      baseUrl,
      checks: 22,
      plugin: { path: pluginPath, bytes: pluginBytes.length, sha256: pluginHash }
    })
  );
}

try {
  await main();
} finally {
  await cleanup().catch((error) => {
    console.error(`清理临时租户失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
  await prisma.$disconnect();
}
