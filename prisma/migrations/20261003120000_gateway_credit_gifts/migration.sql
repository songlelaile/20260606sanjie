-- This is the unified accounting system's allocatable balance contract, not a gift-only pool.
-- Intentionally no INSERT/activation: only the unified accounting system may establish ready.
CREATE TABLE "GatewayCreditPool" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'total' CHECK ("id" = 'total'),
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'ready')),
  "balanceCents" INTEGER NOT NULL DEFAULT 0 CHECK ("balanceCents" >= 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);

ALTER TABLE "GatewayBillingLedger" DROP CONSTRAINT "GatewayBillingLedger_kind_check";
ALTER TABLE "GatewayBillingLedger" ADD CONSTRAINT "GatewayBillingLedger_kind_check"
  CHECK ("kind" IN ('opening', 'recharge', 'debit', 'error', 'gift'));
ALTER TABLE "GatewayBillingLedger" DROP CONSTRAINT "GatewayBillingLedger_kind_delta";
ALTER TABLE "GatewayBillingLedger" ADD CONSTRAINT "GatewayBillingLedger_kind_delta" CHECK (
  ("kind" = 'debit' AND "deltaCents" = -"chargedCostCents") OR
  ("kind" = 'error' AND "deltaCents" = 0 AND "chargedCostCents" = 0) OR
  ("kind" = 'recharge' AND "deltaCents" > 0) OR
  ("kind" = 'gift' AND "deltaCents" > 0 AND "baseCostCents" = 0 AND "chargedCostCents" = 0 AND "orderId" IS NULL AND "usageId" IS NULL) OR
  "kind" = 'opening'
);

CREATE TABLE "GatewayCreditGift" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "requestKey" TEXT NOT NULL CHECK ("requestKey" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  "billingEventId" TEXT NOT NULL CHECK ("billingEventId" = 'gift:' || "requestKey"),
  "adminId" TEXT NOT NULL,
  "adminUsername" TEXT NOT NULL,
  "adminName" TEXT NOT NULL,
  "adminTenantId" TEXT NOT NULL,
  "adminTenantName" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "userName" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "tenantName" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL CHECK ("amountCents" > 0),
  "poolBeforeCents" INTEGER NOT NULL CHECK ("poolBeforeCents" >= 0),
  "poolAfterCents" INTEGER NOT NULL CHECK ("poolAfterCents" >= 0),
  "walletBeforeCents" INTEGER NOT NULL CHECK ("walletBeforeCents" >= 0),
  "walletAfterCents" INTEGER NOT NULL CHECK ("walletAfterCents" >= 0),
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "GatewayCreditGift_pool_equation" CHECK ("poolAfterCents"::BIGINT = "poolBeforeCents"::BIGINT - "amountCents"::BIGINT),
  CONSTRAINT "GatewayCreditGift_wallet_equation" CHECK ("walletAfterCents"::BIGINT = "walletBeforeCents"::BIGINT + "amountCents"::BIGINT),
  CONSTRAINT "GatewayCreditGift_billingEventId_fkey" FOREIGN KEY ("billingEventId")
    REFERENCES "GatewayBillingLedger"("billingEventId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GatewayCreditGift_requestKey_key" ON "GatewayCreditGift"("requestKey");
CREATE UNIQUE INDEX "GatewayCreditGift_billingEventId_key" ON "GatewayCreditGift"("billingEventId");
CREATE INDEX "GatewayCreditGift_userId_createdAt_idx" ON "GatewayCreditGift"("userId", "createdAt");
CREATE INDEX "GatewayCreditGift_adminId_createdAt_idx" ON "GatewayCreditGift"("adminId", "createdAt");
CREATE INDEX "GatewayCreditGift_createdAt_idx" ON "GatewayCreditGift"("createdAt");

CREATE TRIGGER "GatewayCreditGift_immutable" BEFORE UPDATE OR DELETE ON "GatewayCreditGift"
FOR EACH ROW EXECUTE FUNCTION gateway_billing_prevent_history_change();
