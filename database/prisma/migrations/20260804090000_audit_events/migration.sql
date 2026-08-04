-- Immutable attribution for privileged organization and workspace operations.
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_events_organizationId_createdAt_idx" ON "audit_events"("organizationId", "createdAt");
CREATE INDEX "audit_events_workspaceId_createdAt_idx" ON "audit_events"("workspaceId", "createdAt");
CREATE INDEX "audit_events_actorUserId_createdAt_idx" ON "audit_events"("actorUserId", "createdAt");
CREATE INDEX "audit_events_targetType_targetId_createdAt_idx" ON "audit_events"("targetType", "targetId", "createdAt");

ALTER TABLE "audit_events"
    ADD CONSTRAINT "audit_events_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "audit_events"
    ADD CONSTRAINT "audit_events_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "audit_events"
    ADD CONSTRAINT "audit_events_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Application services only append events. The database provides the durable
-- final guard against accidental or malicious history rewrites.
CREATE FUNCTION "prevent_audit_event_mutation"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_events_reject_updates"
BEFORE UPDATE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION "prevent_audit_event_mutation"();

CREATE TRIGGER "audit_events_reject_deletes"
BEFORE DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION "prevent_audit_event_mutation"();
