-- CreateTable
CREATE TABLE "GatewayWallet" (
    "userId" TEXT NOT NULL,
    "balanceCents" INTEGER NOT NULL DEFAULT 0,
    "monthlyQuotaCents" INTEGER NOT NULL DEFAULT 0,
    "planCode" TEXT NOT NULL DEFAULT 'free',
    "planName" TEXT NOT NULL DEFAULT '体验版',
    "periodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "periodEnd" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayWallet_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "GatewayApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "GatewayApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayOrder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planCode" TEXT NOT NULL,
    "planName" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "creditCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paymentProvider" TEXT NOT NULL DEFAULT 'manual',
    "paymentUrl" TEXT NOT NULL DEFAULT '',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GatewayOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "requestId" TEXT NOT NULL DEFAULT '',
    "endpoint" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "imageCount" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "GatewayUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GatewayApiKey_keyHash_key" ON "GatewayApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "GatewayApiKey_userId_status_idx" ON "GatewayApiKey"("userId", "status");

-- CreateIndex
CREATE INDEX "GatewayOrder_userId_createdAt_idx" ON "GatewayOrder"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "GatewayOrder_status_idx" ON "GatewayOrder"("status");

-- CreateIndex
CREATE INDEX "GatewayUsage_userId_createdAt_idx" ON "GatewayUsage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "GatewayUsage_apiKeyId_createdAt_idx" ON "GatewayUsage"("apiKeyId", "createdAt");

-- AddForeignKey
ALTER TABLE "GatewayWallet" ADD CONSTRAINT "GatewayWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayApiKey" ADD CONSTRAINT "GatewayApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayOrder" ADD CONSTRAINT "GatewayOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayUsage" ADD CONSTRAINT "GatewayUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayUsage" ADD CONSTRAINT "GatewayUsage_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "GatewayApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;
