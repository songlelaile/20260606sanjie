-- CreateTable
CREATE TABLE "ToolEntitlement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "toolCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "grantedBy" TEXT NOT NULL DEFAULT '',
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ToolEntitlement_userId_toolCode_key" ON "ToolEntitlement"("userId", "toolCode");

-- CreateIndex
CREATE INDEX "ToolEntitlement_toolCode_status_idx" ON "ToolEntitlement"("toolCode", "status");

-- AddForeignKey
ALTER TABLE "ToolEntitlement" ADD CONSTRAINT "ToolEntitlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
