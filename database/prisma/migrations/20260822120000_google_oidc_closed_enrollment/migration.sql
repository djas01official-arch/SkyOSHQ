-- Global append-only authentication evidence. Tenant-scoped audit_events cannot
-- represent pre-provisioning or rejected identities without inventing a tenant.
CREATE TABLE "identity_audit_events" (
    "id" UUID NOT NULL,
    "actorUserId" UUID,
    "targetUserId" UUID,
    "provider" TEXT NOT NULL,
    "subjectFingerprint" CHAR(64) NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "identity_audit_events_provider_subjectFingerprint_createdAt_idx"
    ON "identity_audit_events"("provider", "subjectFingerprint", "createdAt");
CREATE INDEX "identity_audit_events_actorUserId_createdAt_idx"
    ON "identity_audit_events"("actorUserId", "createdAt");
CREATE INDEX "identity_audit_events_targetUserId_createdAt_idx"
    ON "identity_audit_events"("targetUserId", "createdAt");

ALTER TABLE "identity_audit_events"
    ADD CONSTRAINT "identity_audit_events_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "identity_audit_events"
    ADD CONSTRAINT "identity_audit_events_targetUserId_fkey"
    FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "prevent_identity_audit_event_mutation"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Identity audit events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "identity_audit_events_reject_updates"
BEFORE UPDATE ON "identity_audit_events"
FOR EACH ROW EXECUTE FUNCTION "prevent_identity_audit_event_mutation"();

CREATE TRIGGER "identity_audit_events_reject_deletes"
BEFORE DELETE ON "identity_audit_events"
FOR EACH ROW EXECUTE FUNCTION "prevent_identity_audit_event_mutation"();
