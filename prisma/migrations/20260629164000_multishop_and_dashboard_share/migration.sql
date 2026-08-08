-- Multi-shop workspace scope + fixed dashboard share snapshots.
-- Existing tenant-level data is copied into the tenant's default shop so current deployments keep working.

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT '淘宝',
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopWorkspace" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopWorkspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopCalcRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "runId" TEXT NOT NULL DEFAULT '',
    "cycleId" TEXT NOT NULL DEFAULT '',
    "createdAt" TEXT NOT NULL DEFAULT '',
    "investmentResults" JSONB NOT NULL DEFAULT '[]',
    "breakthroughResults" JSONB NOT NULL DEFAULT '[]',
    "audiencePlans" JSONB NOT NULL DEFAULT '[]',
    "managementDashboard" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopCalcRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DashboardShare" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DashboardShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Shop_tenantId_idx" ON "Shop"("tenantId");
CREATE UNIQUE INDEX "ShopWorkspace_shopId_key" ON "ShopWorkspace"("shopId");
CREATE INDEX "ShopWorkspace_tenantId_idx" ON "ShopWorkspace"("tenantId");
CREATE UNIQUE INDEX "ShopCalcRun_shopId_key" ON "ShopCalcRun"("shopId");
CREATE INDEX "ShopCalcRun_tenantId_idx" ON "ShopCalcRun"("tenantId");
CREATE UNIQUE INDEX "DashboardShare_tokenHash_key" ON "DashboardShare"("tokenHash");
CREATE INDEX "DashboardShare_tenantId_shopId_idx" ON "DashboardShare"("tenantId", "shopId");

-- AddForeignKey
ALTER TABLE "Shop" ADD CONSTRAINT "Shop_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShopWorkspace" ADD CONSTRAINT "ShopWorkspace_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShopCalcRun" ADD CONSTRAINT "ShopCalcRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DashboardShare" ADD CONSTRAINT "DashboardShare_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill one default shop per tenant. Existing Workspace.context.shop wins; otherwise use deterministic shop-<tenantId>.
INSERT INTO "Shop" ("id", "tenantId", "name", "platform", "createdBy", "createdAt", "updatedAt")
SELECT
  COALESCE(NULLIF(w.data #>> '{context,shop,id}', ''), 'shop-' || t."id"),
  t."id",
  COALESCE(NULLIF(w.data #>> '{context,shop,name}', ''), t."name"),
  COALESCE(NULLIF(w.data #>> '{context,shop,platform}', ''), '淘宝'),
  COALESCE(NULLIF(w.data #>> '{context,user,name}', ''), ''),
  t."createdAt",
  now()
FROM "Tenant" t
LEFT JOIN "Workspace" w ON w."tenantId" = t."id"
ON CONFLICT ("id") DO NOTHING;

-- Copy legacy tenant workspace into the default shop workspace.
INSERT INTO "ShopWorkspace" ("id", "tenantId", "shopId", "data", "updatedAt")
SELECT
  'shopws-' || s."id",
  s."tenantId",
  s."id",
  w."data",
  w."updatedAt"
FROM "Shop" s
JOIN "Workspace" w ON w."tenantId" = s."tenantId"
ON CONFLICT ("shopId") DO NOTHING;

-- Copy legacy calc run into the default shop calc run.
INSERT INTO "ShopCalcRun" (
  "id","tenantId","shopId","runId","cycleId","createdAt",
  "investmentResults","breakthroughResults","audiencePlans","managementDashboard","updatedAt"
)
SELECT
  'shopcalc-' || s."id",
  c."tenantId",
  s."id",
  c."runId",
  c."cycleId",
  c."createdAt",
  c."investmentResults",
  c."breakthroughResults",
  c."audiencePlans",
  c."managementDashboard",
  c."updatedAt"
FROM "Shop" s
JOIN "CalcRun" c ON c."tenantId" = s."tenantId"
ON CONFLICT ("shopId") DO NOTHING;

-- Scope existing daily/intervention rows to the default shop.
ALTER TABLE "DailyProductMetric" ADD COLUMN "shopId" TEXT NOT NULL DEFAULT '';
UPDATE "DailyProductMetric" d
SET "shopId" = COALESCE(
  (SELECT s."id" FROM "Shop" s WHERE s."tenantId" = d."tenantId" ORDER BY s."createdAt" ASC LIMIT 1),
  'shop-' || d."tenantId"
)
WHERE d."shopId" = '';

DROP INDEX IF EXISTS "DailyProductMetric_tenantId_productId_date_key";
DROP INDEX IF EXISTS "DailyProductMetric_tenantId_date_idx";
CREATE UNIQUE INDEX "DailyProductMetric_tenantId_shopId_productId_date_key" ON "DailyProductMetric"("tenantId", "shopId", "productId", "date");
CREATE INDEX "DailyProductMetric_tenantId_shopId_date_idx" ON "DailyProductMetric"("tenantId", "shopId", "date");

ALTER TABLE "DailyPromotionMetric" ADD COLUMN "shopId" TEXT NOT NULL DEFAULT '';
UPDATE "DailyPromotionMetric" d
SET "shopId" = COALESCE(
  (SELECT s."id" FROM "Shop" s WHERE s."tenantId" = d."tenantId" ORDER BY s."createdAt" ASC LIMIT 1),
  'shop-' || d."tenantId"
)
WHERE d."shopId" = '';

DROP INDEX IF EXISTS "DailyPromotionMetric_tenantId_subjectId_date_key";
DROP INDEX IF EXISTS "DailyPromotionMetric_tenantId_date_idx";
CREATE UNIQUE INDEX "DailyPromotionMetric_tenantId_shopId_subjectId_date_key" ON "DailyPromotionMetric"("tenantId", "shopId", "subjectId", "date");
CREATE INDEX "DailyPromotionMetric_tenantId_shopId_date_idx" ON "DailyPromotionMetric"("tenantId", "shopId", "date");

ALTER TABLE "DailyAudienceMetric" ADD COLUMN "shopId" TEXT NOT NULL DEFAULT '';
UPDATE "DailyAudienceMetric" d
SET "shopId" = COALESCE(
  (SELECT s."id" FROM "Shop" s WHERE s."tenantId" = d."tenantId" ORDER BY s."createdAt" ASC LIMIT 1),
  'shop-' || d."tenantId"
)
WHERE d."shopId" = '';

DROP INDEX IF EXISTS "DailyAudienceMetric_tenantId_date_planId_audienceName_subje_key";
DROP INDEX IF EXISTS "DailyAudienceMetric_tenantId_date_idx";
DROP INDEX IF EXISTS "DailyAudienceMetric_tenantId_subjectId_date_idx";
CREATE UNIQUE INDEX "DailyAudienceMetric_tenantId_shopId_date_planId_audience_key" ON "DailyAudienceMetric"("tenantId", "shopId", "date", "planId", "audienceName", "subjectId");
CREATE INDEX "DailyAudienceMetric_tenantId_shopId_date_idx" ON "DailyAudienceMetric"("tenantId", "shopId", "date");
CREATE INDEX "DailyAudienceMetric_tenantId_shopId_subjectId_date_idx" ON "DailyAudienceMetric"("tenantId", "shopId", "subjectId", "date");

ALTER TABLE "Intervention" ADD COLUMN "shopId" TEXT NOT NULL DEFAULT '';
UPDATE "Intervention" i
SET "shopId" = COALESCE(
  (SELECT s."id" FROM "Shop" s WHERE s."tenantId" = i."tenantId" ORDER BY s."createdAt" ASC LIMIT 1),
  'shop-' || i."tenantId"
)
WHERE i."shopId" = '';

DROP INDEX IF EXISTS "Intervention_tenantId_date_idx";
CREATE INDEX "Intervention_tenantId_shopId_date_idx" ON "Intervention"("tenantId", "shopId", "date");
