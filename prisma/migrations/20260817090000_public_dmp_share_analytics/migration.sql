ALTER TABLE "DmpReportShare"
ADD COLUMN "revokedAt" TIMESTAMP(3);

CREATE INDEX "DmpReportShare_revokedAt_createdAt_idx"
ON "DmpReportShare"("revokedAt", "createdAt");

CREATE TABLE "DmpReportShareSession" (
    "id" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "visitorHash" TEXT NOT NULL,
    "sessionHash" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "medium" TEXT NOT NULL DEFAULT '',
    "campaign" TEXT NOT NULL DEFAULT '',
    "referrerHost" TEXT NOT NULL DEFAULT '',
    "pageViews" INTEGER NOT NULL DEFAULT 0,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "activeSeconds" INTEGER NOT NULL DEFAULT 0,
    "maxScrollDepth" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmpReportShareSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DmpReportShareSession_shareId_sessionHash_key"
ON "DmpReportShareSession"("shareId", "sessionHash");

CREATE INDEX "DmpReportShareSession_shareId_firstSeenAt_idx"
ON "DmpReportShareSession"("shareId", "firstSeenAt");

CREATE INDEX "DmpReportShareSession_shareId_visitorHash_idx"
ON "DmpReportShareSession"("shareId", "visitorHash");

CREATE INDEX "DmpReportShareSession_firstSeenAt_idx"
ON "DmpReportShareSession"("firstSeenAt");

ALTER TABLE "DmpReportShareSession"
ADD CONSTRAINT "DmpReportShareSession_shareId_fkey"
FOREIGN KEY ("shareId") REFERENCES "DmpReportShare"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DmpReportShareEvent" (
    "id" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "eventHash" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "visitorHash" TEXT NOT NULL,
    "sessionHash" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "medium" TEXT NOT NULL DEFAULT '',
    "campaign" TEXT NOT NULL DEFAULT '',
    "referrerHost" TEXT NOT NULL DEFAULT '',
    "count" INTEGER NOT NULL DEFAULT 0,
    "activeSeconds" INTEGER NOT NULL DEFAULT 0,
    "maxScrollDepth" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmpReportShareEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DmpReportShareEvent_shareId_eventHash_key"
ON "DmpReportShareEvent"("shareId", "eventHash");

CREATE INDEX "DmpReportShareEvent_createdAt_eventType_idx"
ON "DmpReportShareEvent"("createdAt", "eventType");

CREATE INDEX "DmpReportShareEvent_shareId_sessionHash_createdAt_idx"
ON "DmpReportShareEvent"("shareId", "sessionHash", "createdAt");

ALTER TABLE "DmpReportShareEvent"
ADD CONSTRAINT "DmpReportShareEvent_shareId_fkey"
FOREIGN KEY ("shareId") REFERENCES "DmpReportShare"("id") ON DELETE CASCADE ON UPDATE CASCADE;
