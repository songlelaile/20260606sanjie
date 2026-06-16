-- CreateTable
CREATE TABLE "DailyProductMetric" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "productName" TEXT NOT NULL DEFAULT '',
    "visitors" INTEGER NOT NULL DEFAULT 0,
    "views" INTEGER NOT NULL DEFAULT 0,
    "averageStaySeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bounceRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paymentBuyers" INTEGER NOT NULL DEFAULT 0,
    "paymentAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "productPaymentConversionRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "refundAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "searchGuidedPaymentConversionRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "searchGuidedVisitors" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyProductMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyProductMetric_tenantId_date_idx" ON "DailyProductMetric"("tenantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyProductMetric_tenantId_productId_date_key" ON "DailyProductMetric"("tenantId", "productId", "date");
