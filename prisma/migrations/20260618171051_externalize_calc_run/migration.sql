-- CreateTable
CREATE TABLE "CalcRun" (
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL DEFAULT '',
    "cycleId" TEXT NOT NULL DEFAULT '',
    "createdAt" TEXT NOT NULL DEFAULT '',
    "investmentResults" JSONB NOT NULL DEFAULT '[]',
    "breakthroughResults" JSONB NOT NULL DEFAULT '[]',
    "audiencePlans" JSONB NOT NULL DEFAULT '[]',
    "managementDashboard" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalcRun_pkey" PRIMARY KEY ("tenantId")
);

-- AddForeignKey
ALTER TABLE "CalcRun" ADD CONSTRAINT "CalcRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: 把现有 Workspace.data.calcRun 拆进 CalcRun 表
INSERT INTO "CalcRun" ("tenantId","runId","cycleId","createdAt","investmentResults","breakthroughResults","audiencePlans","managementDashboard","updatedAt")
SELECT
  w."tenantId",
  COALESCE(w.data->'calcRun'->>'id',''),
  COALESCE(w.data->'calcRun'->>'cycleId',''),
  COALESCE(w.data->'calcRun'->>'createdAt',''),
  COALESCE(w.data->'calcRun'->'investmentResults','[]'::jsonb),
  COALESCE(w.data->'calcRun'->'breakthroughResults','[]'::jsonb),
  COALESCE(w.data->'calcRun'->'audiencePlans','[]'::jsonb),
  COALESCE(w.data->'calcRun'->'managementDashboard','{}'::jsonb),
  now()
FROM "Workspace" w
WHERE w.data ? 'calcRun'
ON CONFLICT ("tenantId") DO NOTHING;

-- 从 blob 里移除 calcRun（瘦身：~3.4MB → ~60KB）
UPDATE "Workspace" SET data = data - 'calcRun' WHERE data ? 'calcRun';
