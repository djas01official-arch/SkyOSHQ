CREATE TYPE "AiKnowledgeActionType" AS ENUM (
  'SUMMARIZE',
  'EXTRACT_ACTION_ITEMS',
  'IDENTIFY_RISKS',
  'EXTRACT_KEY_DECISIONS'
);

ALTER TABLE "ai_runs"
  ADD COLUMN "knowledgeActionType" "AiKnowledgeActionType",
  ADD COLUMN "knowledgeDocumentVersionId" UUID;

ALTER TABLE "ai_runs"
  ADD CONSTRAINT "ai_runs_knowledge_action_source_check"
  CHECK (
    ("knowledgeActionType" IS NULL AND "knowledgeDocumentVersionId" IS NULL)
    OR
    ("knowledgeActionType" IS NOT NULL AND "knowledgeDocumentVersionId" IS NOT NULL)
  );

ALTER TABLE "ai_runs"
  ADD CONSTRAINT "ai_runs_knowledgeDocumentVersionId_fkey"
  FOREIGN KEY ("knowledgeDocumentVersionId")
  REFERENCES "knowledge_document_versions"("id")
  ON DELETE RESTRICT
  ON UPDATE RESTRICT;

CREATE INDEX "ai_runs_knowledgeDocumentVersionId_createdAt_idx"
  ON "ai_runs"("knowledgeDocumentVersionId", "createdAt");

ALTER TABLE "ai_run_citations"
  ALTER COLUMN "chunkSetId" DROP NOT NULL;

CREATE OR REPLACE FUNCTION validate_ai_run_identity() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ai_messages" message
    WHERE message."id" = NEW."userMessageId"
      AND message."conversationId" = NEW."conversationId"
      AND message."workspaceId" = NEW."workspaceId"
      AND message."authorUserId" = NEW."requestedByUserId"
      AND message."role" = 'USER'
  ) THEN
    RAISE EXCEPTION 'AI run user message does not match its conversation, workspace, and requester';
  END IF;
  IF NEW."knowledgeDocumentVersionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "knowledge_document_versions" version
    JOIN "knowledge_documents" document ON document."id" = version."documentId"
    WHERE version."id" = NEW."knowledgeDocumentVersionId"
      AND document."workspaceId" = NEW."workspaceId"
  ) THEN
    RAISE EXCEPTION 'AI Knowledge action source does not match its workspace';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_ai_citation() RETURNS trigger AS $$
DECLARE
  snapshot_workspace uuid;
BEGIN
  SELECT snapshot."workspaceId" INTO snapshot_workspace
  FROM "ai_retrieval_snapshots" snapshot WHERE snapshot."id" = NEW."snapshotId";

  IF NEW."chunkSetId" IS NULL THEN
    IF snapshot_workspace IS NULL OR NEW."sourceType" <> 'MARKDOWN_DOCUMENT' OR NOT EXISTS (
      SELECT 1
      FROM "ai_retrieval_snapshots" snapshot
      JOIN "ai_runs" run ON run."id" = snapshot."runId"
      JOIN "knowledge_document_versions" version
        ON version."id" = run."knowledgeDocumentVersionId"
      JOIN "knowledge_documents" document ON document."id" = version."documentId"
      WHERE document."id" = NEW."sourceId"
        AND document."workspaceId" = snapshot_workspace
        AND snapshot."id" = NEW."snapshotId"
        AND run."knowledgeActionType" IS NOT NULL
        AND version."versionNumber" = NEW."documentVersion"
    ) THEN
      RAISE EXCEPTION 'Direct AI citation does not match its workspace and immutable document version';
    END IF;
  ELSIF snapshot_workspace IS NULL OR NOT EXISTS (
    SELECT 1 FROM "knowledge_chunk_sets" chunk_set
    WHERE chunk_set."id" = NEW."chunkSetId"
      AND chunk_set."workspaceId" = snapshot_workspace
      AND chunk_set."sourceType" = NEW."sourceType"
      AND chunk_set."sourceId" = NEW."sourceId"
      AND chunk_set."sourceVersion" = COALESCE(NEW."documentVersion", NEW."extractionVersion")
  ) THEN
    RAISE EXCEPTION 'AI citation does not match its retrieval workspace and immutable source';
  END IF;

  IF encode(digest(NEW."displayedExcerpt", 'sha256'), 'hex') <> NEW."displayedExcerptChecksum" THEN
    RAISE EXCEPTION 'AI citation excerpt checksum mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION protect_ai_run() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AI run history is append-only'; END IF;
  IF OLD."conversationId" <> NEW."conversationId" OR OLD."workspaceId" <> NEW."workspaceId" OR
     OLD."requestedByUserId" <> NEW."requestedByUserId" OR OLD."userMessageId" <> NEW."userMessageId" OR
     OLD."providerKey" <> NEW."providerKey" OR OLD."modelKey" <> NEW."modelKey" OR
     OLD."modelVersion" <> NEW."modelVersion" OR OLD."createdAt" <> NEW."createdAt" OR
     OLD."knowledgeActionType" IS DISTINCT FROM NEW."knowledgeActionType" OR
     OLD."knowledgeDocumentVersionId" IS DISTINCT FROM NEW."knowledgeDocumentVersionId" THEN
    RAISE EXCEPTION 'AI run identity is immutable';
  END IF;
  IF OLD."status" <> 'PROCESSING' OR NEW."status" NOT IN ('SUCCEEDED', 'FAILED') THEN
    RAISE EXCEPTION 'invalid AI run transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
