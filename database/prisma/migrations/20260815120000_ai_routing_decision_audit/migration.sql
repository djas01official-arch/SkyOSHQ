CREATE TYPE "AiRoutingConfiguredMode" AS ENUM ('AUTO', 'FAST', 'BALANCED', 'DEEP', 'CRITICAL');
CREATE TYPE "AiTaskComplexity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH');
CREATE TYPE "AiTaskRisk" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "AiTaskAmbiguity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "AiTaskVerificationNeed" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "AiTaskExpectedEffort" AS ENUM ('SMALL', 'MEDIUM', 'LARGE');
CREATE TYPE "AiTaskRoutingReason" AS ENUM (
  'CRITICAL_RISK',
  'HIGH_RISK',
  'HIGH_VERIFICATION_NEED',
  'VERY_HIGH_COMPLEXITY',
  'HIGH_COMPLEXITY',
  'HIGH_AMBIGUITY',
  'LARGE_EXPECTED_EFFORT',
  'MODERATE_RISK',
  'MODERATE_COMPLEXITY',
  'MODERATE_AMBIGUITY',
  'MODERATE_VERIFICATION_NEED',
  'MODERATE_EXPECTED_EFFORT',
  'LOW_COMPLEXITY'
);
CREATE TYPE "AiTaskAnalysisSignal" AS ENUM (
  'SHORT_REQUEST',
  'LONG_REQUEST',
  'LARGE_INPUT',
  'MULTI_STEP_REQUEST',
  'MULTIPLE_DELIVERABLES',
  'STRUCTURED_INPUT',
  'COMPARISON_REQUEST',
  'CHECK_REQUEST',
  'REVIEW_REQUEST',
  'VERIFICATION_REQUEST',
  'AUDIT_REQUEST',
  'EXPLICIT_DEEP_ANALYSIS',
  'AMBIGUITY_SIGNAL',
  'OPERATIONAL_RISK_REQUEST',
  'HIGH_STAKES_REQUEST',
  'CRITICAL_STAKES_REQUEST',
  'EMBEDDED_UNTRUSTED_CONTENT'
);

CREATE UNIQUE INDEX "ai_messages_id_conversationId_workspaceId_key"
  ON "ai_messages"("id", "conversationId", "workspaceId");

CREATE TABLE "ai_routing_decisions" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" uuid NOT NULL,
  "conversationId" uuid NOT NULL,
  "userMessageId" uuid NOT NULL,
  "configuredMode" "AiRoutingConfiguredMode" NOT NULL,
  "resolvedMode" "AiOrchestrationMode" NOT NULL,
  "reason" "AiTaskRoutingReason" NOT NULL,
  "signals" "AiTaskAnalysisSignal"[] NOT NULL,
  "complexity" "AiTaskComplexity" NOT NULL,
  "risk" "AiTaskRisk" NOT NULL,
  "ambiguity" "AiTaskAmbiguity" NOT NULL,
  "verificationNeed" "AiTaskVerificationNeed" NOT NULL,
  "expectedEffort" "AiTaskExpectedEffort" NOT NULL,
  "createdAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_routing_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_routing_decisions_configured_resolved_mode_check" CHECK (
    "configuredMode" = 'AUTO' OR "configuredMode"::text = "resolvedMode"::text
  )
);

CREATE UNIQUE INDEX "ai_routing_decisions_userMessageId_key"
  ON "ai_routing_decisions"("userMessageId");
CREATE UNIQUE INDEX "ai_routing_decisions_userMessageId_conversationId_workspaceId_key"
  ON "ai_routing_decisions"("userMessageId", "conversationId", "workspaceId");
CREATE INDEX "ai_routing_decisions_workspaceId_createdAt_idx"
  ON "ai_routing_decisions"("workspaceId", "createdAt");
CREATE INDEX "ai_routing_decisions_conversationId_createdAt_idx"
  ON "ai_routing_decisions"("conversationId", "createdAt");
CREATE INDEX "ai_routing_decisions_resolvedMode_createdAt_idx"
  ON "ai_routing_decisions"("resolvedMode", "createdAt");

ALTER TABLE "ai_routing_decisions"
  ADD CONSTRAINT "ai_routing_decisions_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_routing_decisions"
  ADD CONSTRAINT "ai_routing_decisions_conversation_workspace_fkey"
  FOREIGN KEY ("conversationId", "workspaceId")
  REFERENCES "ai_conversations"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_routing_decisions"
  ADD CONSTRAINT "ai_routing_decisions_message_conversation_workspace_fkey"
  FOREIGN KEY ("userMessageId", "conversationId", "workspaceId")
  REFERENCES "ai_messages"("id", "conversationId", "workspaceId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION validate_ai_routing_decision() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "ai_messages" message
    JOIN "ai_conversations" conversation
      ON conversation."id" = message."conversationId"
     AND conversation."workspaceId" = message."workspaceId"
    WHERE message."id" = NEW."userMessageId"
      AND message."conversationId" = NEW."conversationId"
      AND message."workspaceId" = NEW."workspaceId"
      AND message."role" = 'USER'
      AND message."authorUserId" IS NOT NULL
      AND conversation."ownerUserId" = message."authorUserId"
  ) THEN
    RAISE EXCEPTION 'AI routing decision requires its conversation owner user message';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION protect_ai_routing_decision() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AI routing decision history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_ai_routing_decision
BEFORE INSERT ON "ai_routing_decisions"
FOR EACH ROW EXECUTE FUNCTION validate_ai_routing_decision();

CREATE TRIGGER protect_ai_routing_decisions_update_delete
BEFORE UPDATE OR DELETE ON "ai_routing_decisions"
FOR EACH ROW EXECUTE FUNCTION protect_ai_routing_decision();
