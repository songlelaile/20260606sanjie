-- CreateIndex
CREATE INDEX "DailyAudienceMetric_tenantId_subjectId_date_idx" ON "DailyAudienceMetric"("tenantId", "subjectId", "date");
