ALTER TABLE "GatewayUsage" ADD COLUMN "billingEventId" TEXT;
CREATE UNIQUE INDEX "GatewayUsage_billingEventId_key" ON "GatewayUsage"("billingEventId");

CREATE TABLE "GatewayBillingRule" (
  "planCode" TEXT NOT NULL PRIMARY KEY,
  "planName" TEXT NOT NULL,
  "multiplierBps" INTEGER NOT NULL DEFAULT 10000 CHECK ("multiplierBps" BETWEEN 100 AND 1000000),
  "version" INTEGER NOT NULL DEFAULT 0 CHECK ("version" >= 0),
  "updatedBy" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "GatewayBillingRuleAudit" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "planCode" TEXT NOT NULL,
  "planName" TEXT NOT NULL,
  "previousMultiplierBps" INTEGER NOT NULL,
  "multiplierBps" INTEGER NOT NULL,
  "previousVersion" INTEGER NOT NULL,
  "version" INTEGER NOT NULL,
  "updatedBy" TEXT NOT NULL,
  "updatedByUsername" TEXT NOT NULL,
  "updatedByName" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "GatewayBillingRuleAudit_planCode_version_key" ON "GatewayBillingRuleAudit"("planCode", "version");
CREATE INDEX "GatewayBillingRuleAudit_createdAt_idx" ON "GatewayBillingRuleAudit"("createdAt");

CREATE TABLE "GatewayBillingLedger" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "billingEventId" TEXT NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('opening', 'recharge', 'debit', 'error')),
  "userId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "tenantName" TEXT NOT NULL DEFAULT '',
  "username" TEXT NOT NULL,
  "userName" TEXT NOT NULL,
  "planCode" TEXT NOT NULL,
  "planName" TEXT NOT NULL,
  "multiplierBps" INTEGER NOT NULL DEFAULT 10000,
  "ruleVersion" INTEGER NOT NULL DEFAULT 0,
  "deltaCents" INTEGER NOT NULL,
  "balanceBeforeCents" INTEGER NOT NULL,
  "balanceAfterCents" INTEGER NOT NULL,
  "baseCostCents" INTEGER NOT NULL DEFAULT 0,
  "chargedCostCents" INTEGER NOT NULL DEFAULT 0,
  "endpoint" TEXT NOT NULL DEFAULT '',
  "provider" TEXT NOT NULL DEFAULT '',
  "model" TEXT NOT NULL DEFAULT '',
  "requestId" TEXT NOT NULL DEFAULT '',
  "apiKeyId" TEXT,
  "keyPrefix" TEXT NOT NULL DEFAULT '',
  "usageId" TEXT,
  "orderId" TEXT,
  "promptTokens" INTEGER NOT NULL DEFAULT 0,
  "completionTokens" INTEGER NOT NULL DEFAULT 0,
  "totalTokens" INTEGER NOT NULL DEFAULT 0,
  "imageCount" INTEGER NOT NULL DEFAULT 0,
  "durationMs" INTEGER,
  "upstreamStatus" INTEGER,
  "status" TEXT NOT NULL,
  "error" TEXT NOT NULL DEFAULT '',
  "actorId" TEXT,
  "actorUsername" TEXT,
  "actorName" TEXT,
  "reason" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GatewayBillingLedger_balance_equation" CHECK ("balanceAfterCents"::BIGINT = "balanceBeforeCents"::BIGINT + "deltaCents"::BIGINT),
  CONSTRAINT "GatewayBillingLedger_cost_nonnegative" CHECK ("baseCostCents" >= 0 AND "chargedCostCents" >= 0),
  CONSTRAINT "GatewayBillingLedger_kind_delta" CHECK (
    ("kind" = 'debit' AND "deltaCents" = -"chargedCostCents") OR
    ("kind" = 'error' AND "deltaCents" = 0 AND "chargedCostCents" = 0) OR
    ("kind" = 'recharge' AND "deltaCents" > 0) OR "kind" = 'opening'
  )
);
CREATE UNIQUE INDEX "GatewayBillingLedger_billingEventId_key" ON "GatewayBillingLedger"("billingEventId");
CREATE UNIQUE INDEX "GatewayBillingLedger_usageId_key" ON "GatewayBillingLedger"("usageId");
CREATE INDEX "GatewayBillingLedger_tenantId_userId_createdAt_idx" ON "GatewayBillingLedger"("tenantId", "userId", "createdAt");
CREATE INDEX "GatewayBillingLedger_userId_createdAt_idx" ON "GatewayBillingLedger"("userId", "createdAt");
CREATE INDEX "GatewayBillingLedger_planCode_createdAt_idx" ON "GatewayBillingLedger"("planCode", "createdAt");
CREATE INDEX "GatewayBillingLedger_kind_createdAt_idx" ON "GatewayBillingLedger"("kind", "createdAt");

-- Open existing wallets at their exact balance. Historical calls are not reconstructed or repriced.
INSERT INTO "GatewayBillingLedger" (
  "id", "billingEventId", "kind", "userId", "tenantId", "tenantName", "username", "userName",
  "planCode", "planName", "deltaCents", "balanceBeforeCents", "balanceAfterCents", "status", "reason"
)
SELECT 'opening-' || w."userId", 'opening:' || w."userId", 'opening', w."userId", u."tenantId", t."name", u."username", u."name",
  w."planCode", w."planName", w."balanceCents", 0, w."balanceCents", 'ok', '账本启用时的历史钱包余额；不重算历史调用'
FROM "GatewayWallet" w JOIN "User" u ON u."id" = w."userId" JOIN "Tenant" t ON t."id" = u."tenantId";

-- Application and database both preserve immutable money/audit history.
CREATE FUNCTION gateway_billing_prevent_history_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Gateway billing history is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "GatewayBillingLedger_immutable" BEFORE UPDATE OR DELETE ON "GatewayBillingLedger"
FOR EACH ROW EXECUTE FUNCTION gateway_billing_prevent_history_change();
CREATE TRIGGER "GatewayBillingRuleAudit_immutable" BEFORE UPDATE OR DELETE ON "GatewayBillingRuleAudit"
FOR EACH ROW EXECUTE FUNCTION gateway_billing_prevent_history_change();
