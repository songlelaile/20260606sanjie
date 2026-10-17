ALTER TABLE "GatewayOrder"
  ADD COLUMN "paymentReceipt" TEXT,
  ADD COLUMN "confirmedBy" TEXT,
  ADD COLUMN "confirmationNote" TEXT,
  ADD COLUMN "receivedAmountCents" INTEGER;
CREATE UNIQUE INDEX "GatewayOrder_paymentReceipt_key" ON "GatewayOrder"("paymentReceipt");
