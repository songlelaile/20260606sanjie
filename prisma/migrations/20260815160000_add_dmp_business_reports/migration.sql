CREATE TABLE "DmpBusinessReport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subjectItemId" TEXT NOT NULL,
    "competitorItemId" TEXT NOT NULL,
    "period" TEXT NOT NULL DEFAULT '',
    "quality" TEXT NOT NULL DEFAULT 'complete',
    "sourceVersion" TEXT NOT NULL DEFAULT '',
    "report" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmpBusinessReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DmpBusinessReport_tenantId_userId_createdAt_idx"
ON "DmpBusinessReport"("tenantId", "userId", "createdAt");

ALTER TABLE "DmpBusinessReport"
ADD CONSTRAINT "DmpBusinessReport_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DmpBusinessReport"
ADD CONSTRAINT "DmpBusinessReport_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
