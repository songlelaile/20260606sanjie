-- Apply only this isolated migration after the corresponding User/Shop tables.
CREATE TABLE "AIAccessGrant" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "username" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "scope" TEXT NOT NULL CHECK ("scope" IN ('read', 'action')),
  "tokenHash" CHAR(64) NOT NULL UNIQUE CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  "activeShopId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "revokedAt" TIMESTAMPTZ,
  "lastUsedAt" TIMESTAMPTZ,
  CONSTRAINT "AIAccessGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AIAccessGrant_lifetime_check" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '60 minutes')
);
CREATE INDEX "AIAccessGrant_userId_createdAt_idx" ON "AIAccessGrant" ("userId", "createdAt" DESC);
CREATE INDEX "AIAccessGrant_expiresAt_idx" ON "AIAccessGrant" ("expiresAt");

CREATE TABLE "AIAccessEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "grantId" UUID REFERENCES "AIAccessGrant"("id") ON DELETE SET NULL,
  "type" TEXT NOT NULL CHECK ("type" IN ('create', 'list', 'revoke', 'authorize', 'context', 'request', 'events')),
  "method" VARCHAR(10),
  "path" TEXT,
  "status" INTEGER CHECK ("status" IS NULL OR "status" BETWEEN 100 AND 599),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AIAccessEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AIAccessEvent_path_check" CHECK ("path" IS NULL OR ("path" LIKE '/%' AND "path" NOT LIKE '%?%' AND "path" NOT LIKE '%#%' AND length("path") <= 200))
);
CREATE INDEX "AIAccessEvent_userId_createdAt_idx" ON "AIAccessEvent" ("userId", "createdAt" DESC);
CREATE INDEX "AIAccessEvent_grantId_createdAt_idx" ON "AIAccessEvent" ("grantId", "createdAt" DESC);
