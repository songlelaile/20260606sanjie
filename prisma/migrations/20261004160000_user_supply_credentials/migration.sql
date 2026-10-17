-- Apply only this migration for user supply keys; do not apply unrelated pending migrations.
CREATE TABLE IF NOT EXISTS "GatewaySupplyCredential" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "slot" TEXT NOT NULL CHECK ("slot" IN ('primary', 'backup')),
  "name" TEXT NOT NULL,
  "sealedKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'provisioning', 'ready', 'failed')),
  "providerKeyId" TEXT,
  "providerOwnerId" TEXT,
  "providerGroupId" TEXT,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "retryAfter" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastErrorCode" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readyAt" TIMESTAMP(3),
  CONSTRAINT "GatewaySupplyCredential_user_slot_key" UNIQUE ("userId", "slot")
);
CREATE INDEX IF NOT EXISTS "GatewaySupplyCredential_status_idx" ON "GatewaySupplyCredential"("status", "retryAfter");
CREATE UNIQUE INDEX IF NOT EXISTS "GatewaySupplyCredential_provider_key_idx" ON "GatewaySupplyCredential"("providerOwnerId", "providerKeyId") WHERE "providerKeyId" IS NOT NULL;

-- Durable supplier binding for in-flight billing holds and native video jobs.
ALTER TABLE "GatewayBillingHold" ADD COLUMN IF NOT EXISTS "credentialId" TEXT;
ALTER TABLE "GatewayNativeVideoJob" ADD COLUMN IF NOT EXISTS "credentialId" TEXT;
