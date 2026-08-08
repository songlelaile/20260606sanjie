-- Missing measurements are unknown, not zero. Existing numeric values are preserved;
-- only future imports can write NULL for absent/invalid cells.
ALTER TABLE "DailyProductMetric"
  ALTER COLUMN "visitors" DROP DEFAULT,
  ALTER COLUMN "visitors" DROP NOT NULL,
  ALTER COLUMN "views" DROP DEFAULT,
  ALTER COLUMN "views" DROP NOT NULL,
  ALTER COLUMN "averageStaySeconds" DROP DEFAULT,
  ALTER COLUMN "averageStaySeconds" DROP NOT NULL,
  ALTER COLUMN "bounceRate" DROP DEFAULT,
  ALTER COLUMN "bounceRate" DROP NOT NULL,
  ALTER COLUMN "paymentBuyers" DROP DEFAULT,
  ALTER COLUMN "paymentBuyers" DROP NOT NULL,
  ALTER COLUMN "paymentAmount" DROP DEFAULT,
  ALTER COLUMN "paymentAmount" DROP NOT NULL,
  ALTER COLUMN "productPaymentConversionRate" DROP DEFAULT,
  ALTER COLUMN "productPaymentConversionRate" DROP NOT NULL,
  ALTER COLUMN "refundAmount" DROP DEFAULT,
  ALTER COLUMN "refundAmount" DROP NOT NULL,
  ALTER COLUMN "searchGuidedPaymentConversionRate" DROP DEFAULT,
  ALTER COLUMN "searchGuidedPaymentConversionRate" DROP NOT NULL,
  ALTER COLUMN "searchGuidedVisitors" DROP DEFAULT,
  ALTER COLUMN "searchGuidedVisitors" DROP NOT NULL;

ALTER TABLE "DailyPromotionMetric"
  ALTER COLUMN "impressions" DROP DEFAULT,
  ALTER COLUMN "impressions" DROP NOT NULL,
  ALTER COLUMN "clicks" DROP DEFAULT,
  ALTER COLUMN "clicks" DROP NOT NULL,
  ALTER COLUMN "cost" DROP DEFAULT,
  ALTER COLUMN "cost" DROP NOT NULL,
  ALTER COLUMN "roi" DROP DEFAULT,
  ALTER COLUMN "roi" DROP NOT NULL;

ALTER TABLE "DailyAudienceMetric"
  ALTER COLUMN "clicks" DROP DEFAULT,
  ALTER COLUMN "clicks" DROP NOT NULL,
  ALTER COLUMN "roi" DROP DEFAULT,
  ALTER COLUMN "roi" DROP NOT NULL,
  ALTER COLUMN "guidedPotentialCustomerRatio" DROP DEFAULT,
  ALTER COLUMN "guidedPotentialCustomerRatio" DROP NOT NULL,
  ALTER COLUMN "newCustomerRatio" DROP DEFAULT,
  ALTER COLUMN "newCustomerRatio" DROP NOT NULL;

-- Version split JSON snapshots so old rows can be normalized conservatively on read.
ALTER TABLE "CalcRun" ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ShopCalcRun" ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1;
