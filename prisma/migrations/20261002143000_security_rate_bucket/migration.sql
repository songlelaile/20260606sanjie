-- Apply and verify only this isolated SQL before publishing callers.
-- The shared workspace contains other, independently managed migrations.
CREATE TABLE "SecurityRateBucket" (
  "bucketKey" CHAR(64) NOT NULL,
  "windowStart" TIMESTAMPTZ NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "hits" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "SecurityRateBucket_pkey" PRIMARY KEY ("bucketKey", "windowStart"),
  CONSTRAINT "SecurityRateBucket_key_check" CHECK ("bucketKey" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "SecurityRateBucket_hits_check" CHECK ("hits" > 0),
  CONSTRAINT "SecurityRateBucket_window_check" CHECK ("expiresAt" > "windowStart")
);
CREATE INDEX "SecurityRateBucket_expiresAt_idx" ON "SecurityRateBucket" ("expiresAt");
