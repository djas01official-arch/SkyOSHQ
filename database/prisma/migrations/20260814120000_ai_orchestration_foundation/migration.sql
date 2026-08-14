CREATE TYPE "AiGroundedContextSourceType" AS ENUM (
  'WORKSPACE_RETRIEVAL',
  'KNOWLEDGE_DOCUMENT_VERSION'
);
CREATE TYPE "AiOrchestrationMode" AS ENUM ('FAST', 'BALANCED', 'DEEP', 'CRITICAL');
CREATE TYPE "AiOrchestrationRole" AS ENUM ('CANDIDATE', 'CRITIC', 'VERIFIER', 'SYNTHESIZER');
CREATE TYPE "AiOrchestrationStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'PARTIALLY_SUCCEEDED',
  'FAILED',
  'CANCELLED'
);

DROP TRIGGER "protect_ai_snapshots_update_delete" ON "ai_retrieval_snapshots";
DROP TRIGGER "protect_ai_runs_update_delete" ON "ai_runs";

ALTER TABLE "ai_retrieval_snapshots"
  ALTER COLUMN "runId" DROP NOT NULL,
  ADD COLUMN "createdByUserId" uuid,
  ADD COLUMN "sourceType" "AiGroundedContextSourceType",
  ADD COLUMN "knowledgeDocumentVersionId" uuid,
  ADD COLUMN "contextVersion" text,
  ADD COLUMN "evidenceChecksum" char(64);

UPDATE "ai_retrieval_snapshots" snapshot
SET
  "createdByUserId" = run."requestedByUserId",
  "sourceType" = CASE
    WHEN run."knowledgeDocumentVersionId" IS NULL
      THEN 'WORKSPACE_RETRIEVAL'::"AiGroundedContextSourceType"
    ELSE 'KNOWLEDGE_DOCUMENT_VERSION'::"AiGroundedContextSourceType"
  END,
  "knowledgeDocumentVersionId" = run."knowledgeDocumentVersionId",
  "contextVersion" = 'skyos-grounded-context-v1',
  "evidenceChecksum" = snapshot."contextChecksum"
FROM "ai_runs" run
WHERE run."id" = snapshot."runId";

ALTER TABLE "ai_retrieval_snapshots"
  ALTER COLUMN "createdByUserId" SET NOT NULL,
  ALTER COLUMN "sourceType" SET NOT NULL,
  ALTER COLUMN "contextVersion" SET NOT NULL,
  ALTER COLUMN "evidenceChecksum" SET NOT NULL,
  ADD CONSTRAINT "ai_retrieval_snapshots_grounded_source_check" CHECK (
    ("sourceType" = 'WORKSPACE_RETRIEVAL' AND "knowledgeDocumentVersionId" IS NULL) OR
    ("sourceType" = 'KNOWLEDGE_DOCUMENT_VERSION' AND "knowledgeDocumentVersionId" IS NOT NULL)
  ),
  ADD CONSTRAINT "ai_retrieval_snapshots_context_identity_check" CHECK (
    "contextVersion" ~ '^[a-z0-9][a-z0-9._-]{0,119}$' AND
    "evidenceChecksum" ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE "ai_runs"
  ADD COLUMN "orchestrationId" uuid,
  ADD COLUMN "orchestrationRole" "AiOrchestrationRole",
  ADD COLUMN "orchestrationStep" integer,
  ADD COLUMN "groundedContextId" uuid,
  ADD CONSTRAINT "ai_runs_orchestration_identity_check" CHECK (
    ("orchestrationId" IS NULL AND "orchestrationRole" IS NULL AND "orchestrationStep" IS NULL) OR
    ("orchestrationId" IS NOT NULL AND "orchestrationRole" IS NOT NULL AND
      "orchestrationStep" IS NOT NULL AND "orchestrationStep" >= 0 AND
      "groundedContextId" IS NOT NULL)
  );

UPDATE "ai_runs" run
SET "groundedContextId" = snapshot."id"
FROM "ai_retrieval_snapshots" snapshot
WHERE snapshot."runId" = run."id";

CREATE TABLE "ai_orchestrations" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL,
  "workspaceId" uuid NOT NULL,
  "createdByUserId" uuid NOT NULL,
  "conversationId" uuid,
  "userMessageId" uuid,
  "groundedContextId" uuid NOT NULL,
  "mode" "AiOrchestrationMode" NOT NULL,
  "policyKey" text NOT NULL,
  "policyVersion" text NOT NULL,
  "orchestrationVersion" text NOT NULL,
  "status" "AiOrchestrationStatus" NOT NULL DEFAULT 'PENDING',
  "finalRunId" uuid,
  "failureCode" text,
  "createdAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" timestamptz(6),
  "completedAt" timestamptz(6),
  CONSTRAINT "ai_orchestrations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_orchestrations_policy_identity_check" CHECK (
    "policyKey" ~ '^[a-z0-9][a-z0-9._-]{0,119}$' AND
    "policyVersion" ~ '^[a-z0-9][a-z0-9._-]{0,119}$' AND
    "orchestrationVersion" ~ '^[a-z0-9][a-z0-9._-]{0,119}$'
  ),
  CONSTRAINT "ai_orchestrations_conversation_identity_check" CHECK (
    ("conversationId" IS NULL) = ("userMessageId" IS NULL)
  ),
  CONSTRAINT "ai_orchestrations_state_check" CHECK (
    ("status" = 'PENDING' AND "startedAt" IS NULL AND "completedAt" IS NULL AND
      "failureCode" IS NULL AND "finalRunId" IS NULL) OR
    ("status" = 'RUNNING' AND "startedAt" IS NOT NULL AND "completedAt" IS NULL AND
      "failureCode" IS NULL AND "finalRunId" IS NULL) OR
    ("status" = 'SUCCEEDED' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND
      "failureCode" IS NULL AND "finalRunId" IS NOT NULL) OR
    ("status" = 'PARTIALLY_SUCCEEDED' AND "startedAt" IS NOT NULL AND
      "completedAt" IS NOT NULL AND "failureCode" IS NULL) OR
    ("status" = 'FAILED' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND
      "failureCode" IS NOT NULL AND "finalRunId" IS NULL) OR
    ("status" = 'CANCELLED' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND
      "failureCode" IS NULL AND "finalRunId" IS NULL)
  )
);

DROP INDEX "ai_runs_active_user_message_key";
CREATE UNIQUE INDEX "ai_runs_active_user_message_key"
  ON "ai_runs"("userMessageId")
  WHERE "status" = 'PROCESSING' AND "orchestrationId" IS NULL;
CREATE UNIQUE INDEX "ai_runs_orchestrationId_orchestrationStep_key"
  ON "ai_runs"("orchestrationId", "orchestrationStep");
CREATE INDEX "ai_runs_orchestrationId_orchestrationRole_createdAt_idx"
  ON "ai_runs"("orchestrationId", "orchestrationRole", "createdAt");
CREATE INDEX "ai_runs_groundedContextId_createdAt_idx"
  ON "ai_runs"("groundedContextId", "createdAt");
CREATE INDEX "ai_retrieval_snapshots_createdByUserId_createdAt_idx"
  ON "ai_retrieval_snapshots"("createdByUserId", "createdAt");
CREATE INDEX "ai_retrieval_snapshots_knowledgeDocumentVersionId_createdAt_idx"
  ON "ai_retrieval_snapshots"("knowledgeDocumentVersionId", "createdAt");
CREATE UNIQUE INDEX "ai_orchestrations_finalRunId_key" ON "ai_orchestrations"("finalRunId");
CREATE INDEX "ai_orchestrations_workspaceId_status_createdAt_idx"
  ON "ai_orchestrations"("workspaceId", "status", "createdAt");
CREATE INDEX "ai_orchestrations_organizationId_status_createdAt_idx"
  ON "ai_orchestrations"("organizationId", "status", "createdAt");
CREATE INDEX "ai_orchestrations_createdByUserId_createdAt_idx"
  ON "ai_orchestrations"("createdByUserId", "createdAt");
CREATE INDEX "ai_orchestrations_groundedContextId_idx"
  ON "ai_orchestrations"("groundedContextId");
CREATE INDEX "ai_orchestrations_conversationId_createdAt_idx"
  ON "ai_orchestrations"("conversationId", "createdAt");
CREATE INDEX "ai_orchestrations_userMessageId_idx"
  ON "ai_orchestrations"("userMessageId");

ALTER TABLE "ai_retrieval_snapshots" ADD CONSTRAINT "ai_retrieval_snapshots_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_retrieval_snapshots" ADD CONSTRAINT "ai_retrieval_snapshots_knowledgeDocumentVersionId_fkey"
  FOREIGN KEY ("knowledgeDocumentVersionId") REFERENCES "knowledge_document_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_orchestrationId_fkey"
  FOREIGN KEY ("orchestrationId") REFERENCES "ai_orchestrations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_groundedContextId_fkey"
  FOREIGN KEY ("groundedContextId") REFERENCES "ai_retrieval_snapshots"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_orchestrations" ADD CONSTRAINT "ai_orchestrations_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_orchestrations" ADD CONSTRAINT "ai_orchestrations_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_orchestrations" ADD CONSTRAINT "ai_orchestrations_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_orchestrations" ADD CONSTRAINT "ai_orchestrations_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "ai_conversations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_orchestrations" ADD CONSTRAINT "ai_orchestrations_userMessageId_fkey"
  FOREIGN KEY ("userMessageId") REFERENCES "ai_messages"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_orchestrations" ADD CONSTRAINT "ai_orchestrations_groundedContextId_fkey"
  FOREIGN KEY ("groundedContextId") REFERENCES "ai_retrieval_snapshots"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_orchestrations" ADD CONSTRAINT "ai_orchestrations_finalRunId_fkey"
  FOREIGN KEY ("finalRunId") REFERENCES "ai_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

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

CREATE OR REPLACE FUNCTION validate_ai_citation() RETURNS trigger AS $$
DECLARE
  snapshot_workspace uuid;
  snapshot_document_version uuid;
BEGIN
  SELECT snapshot."workspaceId", snapshot."knowledgeDocumentVersionId"
  INTO snapshot_workspace, snapshot_document_version
  FROM "ai_retrieval_snapshots" snapshot WHERE snapshot."id" = NEW."snapshotId";

  IF NEW."chunkSetId" IS NULL THEN
    IF snapshot_workspace IS NULL OR NEW."sourceType" <> 'MARKDOWN_DOCUMENT' OR NOT EXISTS (
      SELECT 1
      FROM "knowledge_document_versions" version
      JOIN "knowledge_documents" document ON document."id" = version."documentId"
      WHERE version."id" = snapshot_document_version
        AND document."id" = NEW."sourceId"
        AND document."workspaceId" = snapshot_workspace
        AND version."versionNumber" = NEW."documentVersion"
    ) THEN
      RAISE EXCEPTION 'Direct AI citation does not match its GroundedContext and immutable document version';
    END IF;
  ELSIF snapshot_workspace IS NULL OR NOT EXISTS (
    SELECT 1 FROM "knowledge_chunk_sets" chunk_set
    WHERE chunk_set."id" = NEW."chunkSetId"
      AND chunk_set."workspaceId" = snapshot_workspace
      AND chunk_set."sourceType" = NEW."sourceType"
      AND chunk_set."sourceId" = NEW."sourceId"
      AND chunk_set."sourceVersion" = COALESCE(NEW."documentVersion", NEW."extractionVersion")
  ) THEN
    RAISE EXCEPTION 'AI citation does not match its GroundedContext workspace and immutable source';
  END IF;

  IF encode(digest(NEW."displayedExcerpt", 'sha256'), 'hex') <> NEW."displayedExcerptChecksum" THEN
    RAISE EXCEPTION 'AI citation excerpt checksum mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_ai_run_orchestration() RETURNS trigger AS $$
BEGIN
  IF NEW."groundedContextId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ai_retrieval_snapshots" context
    WHERE context."id" = NEW."groundedContextId" AND context."workspaceId" = NEW."workspaceId"
  ) THEN
    RAISE EXCEPTION 'AI run GroundedContext does not match its workspace';
  END IF;
  IF NEW."orchestrationId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ai_orchestrations" orchestration
    WHERE orchestration."id" = NEW."orchestrationId"
      AND orchestration."workspaceId" = NEW."workspaceId"
      AND orchestration."createdByUserId" = NEW."requestedByUserId"
      AND orchestration."groundedContextId" = NEW."groundedContextId"
      AND orchestration."status" = 'RUNNING'
  ) THEN
    RAISE EXCEPTION 'AI run does not match its orchestration and GroundedContext';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_ai_run_orchestration
BEFORE INSERT OR UPDATE OF "groundedContextId", "orchestrationId", "orchestrationRole", "orchestrationStep"
ON "ai_runs" FOR EACH ROW EXECUTE FUNCTION validate_ai_run_orchestration();

CREATE FUNCTION validate_ai_orchestration() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "workspaces" workspace
    WHERE workspace."id" = NEW."workspaceId"
      AND workspace."organizationId" = NEW."organizationId"
  ) OR NOT EXISTS (
    SELECT 1 FROM "ai_retrieval_snapshots" context
    WHERE context."id" = NEW."groundedContextId"
      AND context."workspaceId" = NEW."workspaceId"
      AND context."createdByUserId" = NEW."createdByUserId"
  ) THEN
    RAISE EXCEPTION 'AI orchestration tenant or GroundedContext identity is invalid';
  END IF;
  IF NEW."conversationId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ai_messages" message
    JOIN "ai_conversations" conversation ON conversation."id" = message."conversationId"
    WHERE conversation."id" = NEW."conversationId"
      AND conversation."workspaceId" = NEW."workspaceId"
      AND conversation."ownerUserId" = NEW."createdByUserId"
      AND message."id" = NEW."userMessageId"
      AND message."workspaceId" = NEW."workspaceId"
      AND message."authorUserId" = NEW."createdByUserId"
      AND message."role" = 'USER'
  ) THEN
    RAISE EXCEPTION 'AI orchestration conversation identity is invalid';
  END IF;
  IF NEW."finalRunId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ai_runs" run
    WHERE run."id" = NEW."finalRunId"
      AND run."orchestrationId" = NEW."id"
      AND run."workspaceId" = NEW."workspaceId"
      AND run."status" = 'SUCCEEDED'
      AND run."orchestrationRole" = CASE
        WHEN NEW."mode" = 'FAST' THEN 'CANDIDATE'::"AiOrchestrationRole"
        ELSE 'SYNTHESIZER'::"AiOrchestrationRole"
      END
  ) THEN
    RAISE EXCEPTION 'AI orchestration final run is invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_ai_orchestration
BEFORE INSERT OR UPDATE ON "ai_orchestrations"
FOR EACH ROW EXECUTE FUNCTION validate_ai_orchestration();

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
     (OLD."groundedContextId" IS NOT NULL AND OLD."groundedContextId" IS DISTINCT FROM NEW."groundedContextId") THEN
    RAISE EXCEPTION 'AI run identity is immutable';
  END IF;
  IF OLD."status" = 'PROCESSING' AND NEW."status" = 'PROCESSING' AND
     OLD."groundedContextId" IS NULL AND NEW."groundedContextId" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'PROCESSING' OR NEW."status" NOT IN ('SUCCEEDED', 'FAILED') THEN
    RAISE EXCEPTION 'invalid AI run transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION protect_ai_orchestration() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AI orchestration history is append-only'; END IF;
  IF OLD."organizationId" <> NEW."organizationId" OR OLD."workspaceId" <> NEW."workspaceId" OR
     OLD."createdByUserId" <> NEW."createdByUserId" OR
     OLD."conversationId" IS DISTINCT FROM NEW."conversationId" OR
     OLD."userMessageId" IS DISTINCT FROM NEW."userMessageId" OR
     OLD."groundedContextId" <> NEW."groundedContextId" OR OLD."mode" <> NEW."mode" OR
     OLD."policyKey" <> NEW."policyKey" OR OLD."policyVersion" <> NEW."policyVersion" OR
     OLD."orchestrationVersion" <> NEW."orchestrationVersion" OR OLD."createdAt" <> NEW."createdAt" THEN
    RAISE EXCEPTION 'AI orchestration identity is immutable';
  END IF;
  IF OLD."status" = 'PENDING' AND NEW."status" = 'RUNNING' THEN RETURN NEW; END IF;
  IF OLD."status" = 'RUNNING' AND NEW."status" IN
    ('SUCCEEDED', 'PARTIALLY_SUCCEEDED', 'FAILED', 'CANCELLED') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid AI orchestration transition';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_ai_runs_update_delete
BEFORE UPDATE OR DELETE ON "ai_runs" FOR EACH ROW EXECUTE FUNCTION protect_ai_run();
CREATE TRIGGER protect_ai_snapshots_update_delete
BEFORE UPDATE OR DELETE ON "ai_retrieval_snapshots" FOR EACH ROW EXECUTE FUNCTION protect_ai_immutable_row();
CREATE TRIGGER protect_ai_orchestrations_update_delete
BEFORE UPDATE OR DELETE ON "ai_orchestrations" FOR EACH ROW EXECUTE FUNCTION protect_ai_orchestration();
