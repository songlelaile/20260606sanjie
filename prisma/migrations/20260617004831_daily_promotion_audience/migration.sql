-- CreateTable
CREATE TABLE "DailyPromotionMetric" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "subjectName" TEXT NOT NULL DEFAULT '',
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "roi" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyPromotionMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyAudienceMetric" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL DEFAULT '',
    "sceneName" TEXT NOT NULL DEFAULT '',
    "planId" TEXT NOT NULL,
    "planName" TEXT NOT NULL DEFAULT '',
    "audienceName" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectName" TEXT NOT NULL DEFAULT '',
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "roi" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "guidedPotentialCustomerRatio" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "newCustomerRatio" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyAudienceMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyPromotionMetric_tenantId_date_idx" ON "DailyPromotionMetric"("tenantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyPromotionMetric_tenantId_subjectId_date_key" ON "DailyPromotionMetric"("tenantId", "subjectId", "date");

-- CreateIndex
CREATE INDEX "DailyAudienceMetric_tenantId_date_idx" ON "DailyAudienceMetric"("tenantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyAudienceMetric_tenantId_date_planId_audienceName_subje_key" ON "DailyAudienceMetric"("tenantId", "date", "planId", "audienceName", "subjectId");
