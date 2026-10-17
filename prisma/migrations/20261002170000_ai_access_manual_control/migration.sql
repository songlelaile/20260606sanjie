-- Add manual controls without changing existing grant deadlines or secrets.
-- The original expiresAt column remains intact for old-version safe rollback.
ALTER TABLE "AIAccessGrant" ADD COLUMN "manualControl" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "AIAccessGrant" ADD COLUMN "disabledAt" TIMESTAMPTZ;
ALTER TABLE "AIAccessGrant" ADD CONSTRAINT "AIAccessGrant_disabled_check"
  CHECK ("disabledAt" IS NULL OR ("revokedAt" IS NOT NULL AND "revokedAt" = "disabledAt"));
ALTER TABLE "AIAccessEvent" DROP CONSTRAINT "AIAccessEvent_type_check";
ALTER TABLE "AIAccessEvent" ADD CONSTRAINT "AIAccessEvent_type_check"
  CHECK ("type" IN ('create', 'list', 'revoke', 'authorize', 'context', 'request', 'events', 'enable', 'disable'));
