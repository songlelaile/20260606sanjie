ALTER TABLE "DmpBusinessReport"
ADD COLUMN "shopId" TEXT,
ADD COLUMN "fingerprint" TEXT;

CREATE INDEX "DmpBusinessReport_tenantId_userId_shopId_createdAt_idx"
ON "DmpBusinessReport"("tenantId", "userId", "shopId", "createdAt");

CREATE UNIQUE INDEX "DmpBusinessReport_tenantId_userId_fingerprint_key"
ON "DmpBusinessReport"("tenantId", "userId", "fingerprint");

ALTER TABLE "DmpBusinessReport"
ADD CONSTRAINT "DmpBusinessReport_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "Shop"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
