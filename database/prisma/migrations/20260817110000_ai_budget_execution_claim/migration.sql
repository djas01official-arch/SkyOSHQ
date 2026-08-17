CREATE TYPE "AiBudgetExecutionClaimStatus" AS ENUM ('READY', 'STARTED', 'FINISHED');

ALTER TABLE "ai_budget_reservations"
  ADD CONSTRAINT "ai_budget_reservation_id_workspace_key" UNIQUE ("id", "workspaceId");

CREATE TABLE "ai_budget_execution_claims" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL,
  "confirmationId" UUID NOT NULL,
  "routingDecisionId" UUID NOT NULL,
  "reservationId" UUID NOT NULL,
  "claimedByUserId" UUID NOT NULL,
  "status" "AiBudgetExecutionClaimStatus" NOT NULL DEFAULT 'READY',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMPTZ(6),
  "finishedAt" TIMESTAMPTZ(6),
  CONSTRAINT "ai_budget_execution_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_budget_execution_claims_confirmationId_key" UNIQUE ("confirmationId"),
  CONSTRAINT "ai_budget_execution_claims_routingDecisionId_key" UNIQUE ("routingDecisionId"),
  CONSTRAINT "ai_budget_execution_claims_reservationId_key" UNIQUE ("reservationId"),
  CONSTRAINT "ai_budget_execution_claims_id_workspaceId_key" UNIQUE ("id", "workspaceId"),
  CONSTRAINT "ai_budget_execution_claim_confirmation_scope_key" UNIQUE ("confirmationId", "workspaceId"),
  CONSTRAINT "ai_budget_execution_claim_routing_scope_key" UNIQUE ("routingDecisionId", "workspaceId"),
  CONSTRAINT "ai_budget_execution_claim_reservation_scope_key" UNIQUE ("reservationId", "workspaceId"),
  CONSTRAINT "ai_budget_execution_claims_state_check" CHECK (
    ("status" = 'READY' AND "startedAt" IS NULL AND "finishedAt" IS NULL)
    OR ("status" = 'STARTED' AND "startedAt" IS NOT NULL AND "finishedAt" IS NULL)
    OR ("status" = 'FINISHED' AND "startedAt" IS NOT NULL AND "finishedAt" IS NOT NULL)
  ),
  CONSTRAINT "ai_budget_execution_claims_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ai_budget_execution_claims_confirmation_workspace_fkey"
    FOREIGN KEY ("confirmationId", "workspaceId") REFERENCES "ai_budget_confirmations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ai_budget_execution_claims_routing_workspace_fkey"
    FOREIGN KEY ("routingDecisionId", "workspaceId") REFERENCES "ai_routing_decisions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ai_budget_execution_claims_reservation_workspace_fkey"
    FOREIGN KEY ("reservationId", "workspaceId") REFERENCES "ai_budget_reservations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ai_budget_execution_claims_claimed_by_user_fkey"
    FOREIGN KEY ("claimedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "ai_budget_execution_claims_workspaceId_status_createdAt_idx"
  ON "ai_budget_execution_claims"("workspaceId", "status", "createdAt");
CREATE INDEX "ai_budget_execution_claims_claimedByUserId_createdAt_idx"
  ON "ai_budget_execution_claims"("claimedByUserId", "createdAt");

CREATE FUNCTION protect_ai_budget_execution_claim() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AI budget execution claims cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'READY' OR NEW."startedAt" IS NOT NULL OR NEW."finishedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'AI budget execution claims must begin ready';
    END IF;
  ELSE
    IF OLD."workspaceId" <> NEW."workspaceId"
      OR OLD."confirmationId" <> NEW."confirmationId"
      OR OLD."routingDecisionId" <> NEW."routingDecisionId"
      OR OLD."reservationId" <> NEW."reservationId"
      OR OLD."claimedByUserId" <> NEW."claimedByUserId"
      OR OLD."createdAt" <> NEW."createdAt" THEN
      RAISE EXCEPTION 'AI budget execution claim identity is immutable';
    END IF;

    IF OLD."status" = 'READY' AND NEW."status" = 'STARTED'
      AND OLD."startedAt" IS NULL AND OLD."finishedAt" IS NULL
      AND NEW."startedAt" IS NOT NULL AND NEW."finishedAt" IS NULL THEN
      RETURN NEW;
    END IF;
    IF OLD."status" = 'STARTED' AND NEW."status" = 'FINISHED'
      AND OLD."startedAt" IS NOT NULL AND OLD."finishedAt" IS NULL
      AND NEW."startedAt" IS NOT NULL AND NEW."finishedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Invalid AI budget execution claim lifecycle transition';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "ai_budget_confirmations" confirmation
    JOIN "ai_budget_reservations" reservation
      ON reservation."id" = NEW."reservationId"
     AND reservation."workspaceId" = NEW."workspaceId"
    JOIN "ai_routing_decisions" decision
      ON decision."id" = NEW."routingDecisionId"
     AND decision."workspaceId" = NEW."workspaceId"
    JOIN "ai_messages" message
      ON message."id" = decision."userMessageId"
     AND message."workspaceId" = decision."workspaceId"
    JOIN "ai_conversations" conversation
      ON conversation."id" = message."conversationId"
     AND conversation."workspaceId" = message."workspaceId"
    WHERE confirmation."id" = NEW."confirmationId"
      AND confirmation."workspaceId" = NEW."workspaceId"
      AND confirmation."status" = 'APPROVED'
      AND confirmation."routingDecisionId" = NEW."routingDecisionId"
      AND confirmation."requestedByUserId" = NEW."claimedByUserId"
      AND reservation."status" = 'RESERVED'
      AND reservation."routingDecisionId" = NEW."routingDecisionId"
      AND message."role" = 'USER'
      AND message."authorUserId" = NEW."claimedByUserId"
      AND conversation."ownerUserId" = NEW."claimedByUserId"
  ) THEN
    RAISE EXCEPTION 'AI budget execution claim requires approved owned confirmation and reserved routing reservation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ai_budget_execution_claims_controlled_lifecycle"
BEFORE INSERT OR UPDATE OR DELETE ON "ai_budget_execution_claims"
FOR EACH ROW EXECUTE FUNCTION protect_ai_budget_execution_claim();
