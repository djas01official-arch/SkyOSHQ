ALTER TABLE "ai_retrieval_snapshots"
  ADD COLUMN "routingDecisionId" uuid;

ALTER TABLE "ai_retrieval_snapshots"
  ADD CONSTRAINT "ai_retrieval_snapshots_routingDecisionId_key" UNIQUE ("routingDecisionId"),
  ADD CONSTRAINT "ai_retrieval_snapshots_routing_workspace_key" UNIQUE ("routingDecisionId", "workspaceId"),
  ADD CONSTRAINT "ai_retrieval_snapshots_routing_decision_workspace_fkey"
    FOREIGN KEY ("routingDecisionId", "workspaceId")
    REFERENCES "ai_routing_decisions"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION validate_ai_snapshot() RETURNS trigger AS $$
BEGIN
  IF NEW."runId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ai_runs" run
    WHERE run."id" = NEW."runId"
      AND run."workspaceId" = NEW."workspaceId"
      AND run."requestedByUserId" = NEW."createdByUserId"
      AND run."status" = 'PROCESSING'
  ) THEN
    RAISE EXCEPTION 'AI GroundedContext does not match an active run';
  END IF;

  IF NEW."routingDecisionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "ai_routing_decisions" decision
    JOIN "ai_messages" message
      ON message."id" = decision."userMessageId"
     AND message."conversationId" = decision."conversationId"
     AND message."workspaceId" = decision."workspaceId"
    JOIN "ai_conversations" conversation
      ON conversation."id" = decision."conversationId"
     AND conversation."workspaceId" = decision."workspaceId"
    WHERE decision."id" = NEW."routingDecisionId"
      AND decision."workspaceId" = NEW."workspaceId"
      AND message."role" = 'USER'
      AND message."authorUserId" = NEW."createdByUserId"
      AND conversation."ownerUserId" = NEW."createdByUserId"
      AND NEW."sourceType" = 'WORKSPACE_RETRIEVAL'
      AND NEW."queryChecksum" = encode(digest(message."content", 'sha256'), 'hex')
  ) THEN
    RAISE EXCEPTION 'AI GroundedContext routing decision identity is invalid';
  END IF;

  IF NEW."sourceType" = 'KNOWLEDGE_DOCUMENT_VERSION' AND NOT EXISTS (
    SELECT 1 FROM "knowledge_document_versions" version
    JOIN "knowledge_documents" document ON document."id" = version."documentId"
    WHERE version."id" = NEW."knowledgeDocumentVersionId"
      AND document."workspaceId" = NEW."workspaceId"
  ) THEN
    RAISE EXCEPTION 'AI GroundedContext document version does not match its workspace';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
