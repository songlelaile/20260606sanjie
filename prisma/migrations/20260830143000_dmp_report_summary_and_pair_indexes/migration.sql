ALTER TABLE "DmpBusinessReport"
ADD COLUMN "summary" JSONB;

-- 旧报告先回填列表所需的小投影，不把 tables/rows 带回列表 API。
-- 新写入由应用层从已验证的规范报告生成更完整的摘要。
UPDATE "DmpBusinessReport"
SET "summary" = jsonb_strip_nulls(jsonb_build_object(
  'version', 1,
  'reportType', CASE
    WHEN "report"->>'report_type' IN ('growth', 'competition', 'market')
      THEN "report"->>'report_type'
    ELSE 'growth'
  END,
  'title', COALESCE(NULLIF("report"->>'title', ''), "subjectItemId"),
  'marketScope', "report"->'market_scope',
  'subjectThumbnail', jsonb_build_object(
    'url', COALESCE("report"#>>'{render_data,products,subject,picture_url}', ''),
    'title', COALESCE(NULLIF("report"->>'title', ''), "subjectItemId")
  ),
  'competitorThumbnail', jsonb_build_object(
    'url', COALESCE("report"#>>'{render_data,products,competitor,picture_url}', ''),
    'title', "competitorItemId"
  ),
  'coverageStart', substring("period" FROM '(20[0-9]{2}-[0-9]{2}-[0-9]{2})'),
  'coverageEnd', substring("period" FROM '.*(20[0-9]{2}-[0-9]{2}-[0-9]{2})')
));

CREATE INDEX "DmpBusinessReport_tenantId_userId_shopId_createdAt_id_idx"
ON "DmpBusinessReport"("tenantId", "userId", "shopId", "createdAt", "id");

CREATE INDEX "dmp_report_pair_created_idx"
ON "DmpBusinessReport"("tenantId", "userId", "shopId", "subjectItemId", "competitorItemId", "createdAt");
