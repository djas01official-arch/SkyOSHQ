CREATE TYPE "AiBudgetConfirmationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "ai_budget_confirmations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL,
  "routingDecisionId" UUID NOT NULL,
  "requestedByUserId" UUID NOT NULL,
  "status" "AiBudgetConfirmationStatus" NOT NULL DEFAULT 'PENDING',
  "proposedReserveUsd" NUMERIC(65,12) NOT NULL,
  "pricingAt" TIMESTAMPTZ(6) NOT NULL,
  "executionPlanFingerprint" VARCHAR(64) NOT NULL,
  "estimateFingerprint" VARCHAR(64) NOT NULL,
  "requestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMPTZ(6),
  "decidedByUserId" UUID,
  CONSTRAINT "ai_budget_confirmations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_budget_confirmations_routingDecisionId_key" UNIQUE ("routingDecisionId"),
  CONSTRAINT "ai_budget_confirmations_id_workspaceId_key" UNIQUE ("id", "workspaceId"),
  CONSTRAINT "ai_budget_confirmation_routing_scope_key" UNIQUE ("routingDecisionId", "workspaceId"),
  CONSTRAINT "ai_budget_confirmations_amount_check" CHECK ("proposedReserveUsd" >= 0),
  CONSTRAINT "ai_budget_confirmations_execution_plan_fingerprint_check"
    CHECK ("executionPlanFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ai_budget_confirmations_estimate_fingerprint_check"
    CHECK ("estimateFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ai_budget_confirmations_state_check" CHECK (
    ("status" = 'PENDING' AND "decidedAt" IS NULL AND "decidedByUserId" IS NULL)
    OR
    ("status" IN ('APPROVED', 'REJECTED') AND "decidedAt" IS NOT NULL AND "decidedByUserId" IS NOT NULL)
  ),
  CONSTRAINT "ai_budget_confirmations_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ai_budget_confirmations_routing_decision_workspace_fkey"
    FOREIGN KEY ("routingDecisionId", "workspaceId")
    REFERENCES "ai_routing_decisions"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ai_budget_confirmations_requested_by_user_fkey"
    FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ai_budget_confirmations_decided_by_user_fkey"
    FOREIGN KEY ("decidedByUserId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "ai_budget_confirmations_workspaceId_status_requestedAt_idx"
  ON "ai_budget_confirmations"("workspaceId", "status", "requestedAt");
CREATE INDEX "ai_budget_confirmations_requestedByUserId_requestedAt_idx"
  ON "ai_budget_confirmations"("requestedByUserId", "requestedAt");
CREATE INDEX "ai_budget_confirmations_decidedByUserId_idx"
  ON "ai_budget_confirmations"("decidedByUserId");

CREATE FUNCTION protect_ai_budget_confirmation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AI budget confirmations cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING'
      OR NEW."decidedAt" IS NOT NULL
      OR NEW."decidedByUserId" IS NOT NULL THEN
      RAISE EXCEPTION 'AI budget confirmations must begin pending';
    END IF;
  ELSE
    IF OLD."workspaceId" <> NEW."workspaceId"
      OR OLD."routingDecisionId" <> NEW."routingDecisionId"
      OR OLD."requestedByUserId" <> NEW."requestedByUserId"
      OR OLD."proposedReserveUsd" <> NEW."proposedReserveUsd"
      OR OLD."pricingAt" <> NEW."pricingAt"
      OR OLD."executionPlanFingerprint" <> NEW."executionPlanFingerprint"
      OR OLD."estimateFingerprint" <> NEW."estimateFingerprint"
      OR OLD."requestedAt" <> NEW."requestedAt" THEN
      RAISE EXCEPTION 'AI budget confirmation proposal identity is immutable';
    END IF;

    IF OLD."status" <> 'PENDING'
      OR NEW."status" NOT IN ('APPROVED', 'REJECTED')
      OR NEW."decidedAt" IS NULL
      OR NEW."decidedByUserId" IS NULL THEN
      RAISE EXCEPTION 'Invalid AI budget confirmation lifecycle transition';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "ai_routing_decisions" decision
    JOIN "ai_messages" message
      ON message."id" = decision."userMessageId"
     AND message."conversationId" = decision."conversationId"
     AND message."workspaceId" = decision."workspaceId"
    JOIN "ai_conversations" conversation
      ON conversation."id" = message."conversationId"
     AND conversation."workspaceId" = message."workspaceId"
    WHERE decision."id" = NEW."routingDecisionId"
      AND decision."workspaceId" = NEW."workspaceId"
      AND message."role" = 'USER'
      AND message."authorUserId" = NEW."requestedByUserId"
      AND conversation."ownerUserId" = NEW."requestedByUserId"
  ) THEN
    RAISE EXCEPTION 'AI budget confirmation requires its routing decision owner';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."decidedByUserId" <> NEW."requestedByUserId" THEN
    RAISE EXCEPTION 'AI budget confirmation must be decided by its requesting user';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ai_budget_confirmations_controlled_lifecycle"
BEFORE INSERT OR UPDATE OR DELETE ON "ai_budget_confirmations"
FOR EACH ROW EXECUTE FUNCTION protect_ai_budget_confirmation();
