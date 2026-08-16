ALTER TABLE "ai_runs"
  ADD COLUMN "routingDecisionId" UUID,
  ADD COLUMN "providerAttempted" BOOLEAN;

ALTER TABLE "ai_runs" ALTER COLUMN "providerAttempted" SET DEFAULT false;

ALTER TABLE "ai_routing_decisions"
  ADD CONSTRAINT "ai_routing_decisions_run_scope_key"
  UNIQUE ("id", "userMessageId", "conversationId", "workspaceId");

ALTER TABLE "ai_runs"
  ADD CONSTRAINT "ai_runs_routing_decision_scope_fkey"
  FOREIGN KEY ("routingDecisionId", "userMessageId", "conversationId", "workspaceId")
  REFERENCES "ai_routing_decisions"("id", "userMessageId", "conversationId", "workspaceId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "ai_runs_routingDecisionId_orchestrationStep_createdAt_idx"
  ON "ai_runs"("routingDecisionId", "orchestrationStep", "createdAt");

CREATE OR REPLACE FUNCTION protect_ai_run() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AI run history is append-only'; END IF;
  IF OLD."conversationId" <> NEW."conversationId" OR OLD."workspaceId" <> NEW."workspaceId" OR
     OLD."requestedByUserId" <> NEW."requestedByUserId" OR OLD."userMessageId" <> NEW."userMessageId" OR
     OLD."providerKey" <> NEW."providerKey" OR OLD."modelKey" <> NEW."modelKey" OR
     OLD."modelVersion" <> NEW."modelVersion" OR OLD."createdAt" <> NEW."createdAt" OR
     OLD."knowledgeActionType" IS DISTINCT FROM NEW."knowledgeActionType" OR
     OLD."knowledgeDocumentVersionId" IS DISTINCT FROM NEW."knowledgeDocumentVersionId" OR
     OLD."orchestrationId" IS DISTINCT FROM NEW."orchestrationId" OR
     OLD."orchestrationRole" IS DISTINCT FROM NEW."orchestrationRole" OR
     OLD."orchestrationStep" IS DISTINCT FROM NEW."orchestrationStep" OR
     OLD."routingDecisionId" IS DISTINCT FROM NEW."routingDecisionId" OR
     (OLD."groundedContextId" IS NOT NULL AND OLD."groundedContextId" IS DISTINCT FROM NEW."groundedContextId") THEN
    RAISE EXCEPTION 'AI run identity is immutable';
  END IF;
  IF OLD."status" = 'PROCESSING' AND NEW."status" = 'PROCESSING' AND (
    (OLD."groundedContextId" IS NULL AND NEW."groundedContextId" IS NOT NULL AND
      OLD."providerAttempted" IS NOT DISTINCT FROM NEW."providerAttempted")
    OR
    (OLD."groundedContextId" IS NOT DISTINCT FROM NEW."groundedContextId" AND
      OLD."providerAttempted" IS DISTINCT FROM TRUE AND NEW."providerAttempted" IS TRUE)
  ) THEN
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'PROCESSING' OR NEW."status" NOT IN ('SUCCEEDED', 'FAILED') THEN
    RAISE EXCEPTION 'invalid AI run transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION protect_ai_run_budget_accounting() RETURNS trigger AS $$
BEGIN
  IF OLD."routingDecisionId" IS DISTINCT FROM NEW."routingDecisionId" THEN
    RAISE EXCEPTION 'AI run routing decision identity is immutable';
  END IF;
  IF OLD."providerAttempted" IS TRUE AND NEW."providerAttempted" IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'AI run provider attempt state cannot be cleared';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_ai_run_budget_accounting
BEFORE UPDATE ON "ai_runs"
FOR EACH ROW EXECUTE FUNCTION protect_ai_run_budget_accounting();
