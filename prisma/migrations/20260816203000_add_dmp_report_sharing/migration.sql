CREATE TABLE "DmpReportShare" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "lastClickedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmpReportShare_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DmpReportHeatBucket" (
    "id" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "elementKey" TEXT NOT NULL,
    "xBucket" INTEGER NOT NULL,
    "yBucket" INTEGER NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DmpReportHeatBucket_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DmpReportShare_tokenHash_key" ON "DmpReportShare"("tokenHash");
CREATE INDEX "DmpReportShare_reportId_createdAt_idx" ON "DmpReportShare"("reportId", "createdAt");
CREATE UNIQUE INDEX "DmpReportHeatBucket_shareId_sectionKey_elementKey_xBucket_yBucket_key"
ON "DmpReportHeatBucket"("shareId", "sectionKey", "elementKey", "xBucket", "yBucket");
CREATE INDEX "DmpReportHeatBucket_shareId_sectionKey_count_idx"
ON "DmpReportHeatBucket"("shareId", "sectionKey", "count");

ALTER TABLE "DmpReportShare"
ADD CONSTRAINT "DmpReportShare_reportId_fkey"
FOREIGN KEY ("reportId") REFERENCES "DmpBusinessReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DmpReportHeatBucket"
ADD CONSTRAINT "DmpReportHeatBucket_shareId_fkey"
FOREIGN KEY ("shareId") REFERENCES "DmpReportShare"("id") ON DELETE CASCADE ON UPDATE CASCADE;
