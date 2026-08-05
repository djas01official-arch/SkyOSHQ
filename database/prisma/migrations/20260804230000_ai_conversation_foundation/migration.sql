CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "AiConversationStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "AiMessageRole" AS ENUM ('USER', 'ASSISTANT');
CREATE TYPE "AiRunStatus" AS ENUM ('PROCESSING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "ai_conversations" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" uuid NOT NULL,
  "ownerUserId" uuid NOT NULL,
  "title" text NOT NULL,
  "status" "AiConversationStatus" NOT NULL DEFAULT 'ACTIVE',
  "archivedAt" timestamptz(6),
  "createdAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz(6) NOT NULL,
  CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_conversations_archive_state_check" CHECK (
    ("status" = 'ACTIVE' AND "archivedAt" IS NULL) OR
    ("status" = 'ARCHIVED' AND "archivedAt" IS NOT NULL)
  ),
  CONSTRAINT "ai_conversations_title_check" CHECK (char_length("title") BETWEEN 1 AND 120)
);

CREATE UNIQUE INDEX "ai_conversations_id_workspaceId_key"
  ON "ai_conversations"("id", "workspaceId");
CREATE INDEX "ai_conversations_workspaceId_status_updatedAt_idx"
  ON "ai_conversations"("workspaceId", "status", "updatedAt");
CREATE INDEX "ai_conversations_ownerUserId_updatedAt_idx"
  ON "ai_conversations"("ownerUserId", "updatedAt");

CREATE TABLE "ai_messages" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "conversationId" uuid NOT NULL,
  "workspaceId" uuid NOT NULL,
  "authorUserId" uuid,
  "generatedByRunId" uuid,
  "role" "AiMessageRole" NOT NULL,
  "content" text NOT NULL,
  "createdAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_messages_role_identity_check" CHECK (
    ("role" = 'USER' AND "authorUserId" IS NOT NULL AND "generatedByRunId" IS NULL) OR
    ("role" = 'ASSISTANT' AND "authorUserId" IS NULL AND "generatedByRunId" IS NOT NULL)
  ),
  CONSTRAINT "ai_messages_content_check" CHECK (char_length("content") BETWEEN 1 AND 12000)
);

CREATE UNIQUE INDEX "ai_messages_generatedByRunId_key" ON "ai_messages"("generatedByRunId");
CREATE INDEX "ai_messages_conversationId_createdAt_idx" ON "ai_messages"("conversationId", "createdAt");
CREATE INDEX "ai_messages_workspaceId_createdAt_idx" ON "ai_messages"("workspaceId", "createdAt");
CREATE INDEX "ai_messages_authorUserId_createdAt_idx" ON "ai_messages"("authorUserId", "createdAt");

CREATE TABLE "ai_runs" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "conversationId" uuid NOT NULL,
  "workspaceId" uuid NOT NULL,
  "requestedByUserId" uuid NOT NULL,
  "userMessageId" uuid NOT NULL,
  "providerKey" text NOT NULL,
  "modelKey" text NOT NULL,
  "modelVersion" text NOT NULL,
  "status" "AiRunStatus" NOT NULL DEFAULT 'PROCESSING',
  "inputTokens" integer,
  "outputTokens" integer,
  "durationMs" integer,
  "failureCode" text,
  "failureMessage" text,
  "createdAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" timestamptz(6),
  CONSTRAINT "ai_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_runs_identity_check" CHECK (
    "providerKey" ~ '^[a-z0-9][a-z0-9._-]{0,119}$' AND
    "modelKey" ~ '^[a-z0-9][a-z0-9._-]{0,119}$' AND
    "modelVersion" ~ '^[a-z0-9][a-z0-9._-]{0,119}$'
  ),
  CONSTRAINT "ai_runs_usage_check" CHECK (
    ("inputTokens" IS NULL OR "inputTokens" >= 0) AND
    ("outputTokens" IS NULL OR "outputTokens" >= 0) AND
    ("durationMs" IS NULL OR "durationMs" >= 0)
  ),
  CONSTRAINT "ai_runs_state_check" CHECK (
    ("status" = 'PROCESSING' AND "completedAt" IS NULL AND "failureCode" IS NULL AND "failureMessage" IS NULL) OR
    ("status" = 'SUCCEEDED' AND "completedAt" IS NOT NULL AND "failureCode" IS NULL AND "failureMessage" IS NULL AND "durationMs" IS NOT NULL) OR
    ("status" = 'FAILED' AND "completedAt" IS NOT NULL AND "failureCode" IS NOT NULL AND "failureMessage" IS NOT NULL AND "durationMs" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "ai_runs_id_workspaceId_key" ON "ai_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "ai_runs_active_user_message_key"
  ON "ai_runs"("userMessageId") WHERE "status" = 'PROCESSING';
CREATE INDEX "ai_runs_conversationId_createdAt_idx" ON "ai_runs"("conversationId", "createdAt");
CREATE INDEX "ai_runs_workspaceId_status_createdAt_idx" ON "ai_runs"("workspaceId", "status", "createdAt");
CREATE INDEX "ai_runs_requestedByUserId_createdAt_idx" ON "ai_runs"("requestedByUserId", "createdAt");
CREATE INDEX "ai_runs_userMessageId_createdAt_idx" ON "ai_runs"("userMessageId", "createdAt");

CREATE TABLE "ai_retrieval_snapshots" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "runId" uuid NOT NULL,
  "workspaceId" uuid NOT NULL,
  "queryChecksum" char(64) NOT NULL,
  "contextChecksum" char(64) NOT NULL,
  "context" text NOT NULL,
  "resultCount" integer NOT NULL,
  "characterCount" integer NOT NULL,
  "createdAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_retrieval_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_retrieval_snapshots_counts_check" CHECK (
    "resultCount" >= 0 AND "characterCount" >= 0
  ),
  CONSTRAINT "ai_retrieval_snapshots_checksums_check" CHECK (
    "queryChecksum" ~ '^[0-9a-f]{64}$' AND "contextChecksum" ~ '^[0-9a-f]{64}$'
  )
);

CREATE UNIQUE INDEX "ai_retrieval_snapshots_runId_key" ON "ai_retrieval_snapshots"("runId");
CREATE UNIQUE INDEX "ai_retrieval_snapshots_runId_workspaceId_key"
  ON "ai_retrieval_snapshots"("runId", "workspaceId");
CREATE INDEX "ai_retrieval_snapshots_workspaceId_createdAt_idx"
  ON "ai_retrieval_snapshots"("workspaceId", "createdAt");

CREATE TABLE "ai_run_citations" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "snapshotId" uuid NOT NULL,
  "citationId" text NOT NULL,
  "sourceType" "KnowledgeChunkSourceType" NOT NULL,
  "sourceId" uuid NOT NULL,
  "documentSlug" text NOT NULL,
  "documentVersion" integer,
  "attachmentId" uuid,
  "filename" text,
  "extractionVersion" integer,
  "chunkSetId" uuid NOT NULL,
  "chunkOrdinal" integer NOT NULL,
  "characterStart" integer,
  "characterEnd" integer,
  "displayedExcerpt" text NOT NULL,
  "displayedExcerptChecksum" char(64) NOT NULL,
  "createdAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_run_citations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_run_citations_shape_check" CHECK (
    ("sourceType" = 'MARKDOWN_DOCUMENT' AND "documentVersion" IS NOT NULL AND "attachmentId" IS NULL AND "filename" IS NULL AND "extractionVersion" IS NULL) OR
    ("sourceType" = 'ATTACHMENT_EXTRACTION' AND "documentVersion" IS NULL AND "attachmentId" IS NOT NULL AND "filename" IS NOT NULL AND "extractionVersion" IS NOT NULL)
  ),
  CONSTRAINT "ai_run_citations_offsets_check" CHECK (
    "chunkOrdinal" >= 0 AND
    (("characterStart" IS NULL AND "characterEnd" IS NULL) OR
     ("characterStart" >= 0 AND "characterEnd" > "characterStart"))
  ),
  CONSTRAINT "ai_run_citations_checksum_check" CHECK (
    "displayedExcerptChecksum" ~ '^[0-9a-f]{64}$'
  )
);

CREATE UNIQUE INDEX "ai_run_citations_snapshotId_citationId_key"
  ON "ai_run_citations"("snapshotId", "citationId");
CREATE UNIQUE INDEX "ai_run_citations_snapshotId_chunkSetId_chunkOrdinal_key"
  ON "ai_run_citations"("snapshotId", "chunkSetId", "chunkOrdinal");
CREATE INDEX "ai_run_citations_sourceType_sourceId_idx" ON "ai_run_citations"("sourceType", "sourceId");
CREATE INDEX "ai_run_citations_attachmentId_idx" ON "ai_run_citations"("attachmentId");

ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_workspace_fkey"
  FOREIGN KEY ("conversationId", "workspaceId") REFERENCES "ai_conversations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_authorUserId_fkey"
  FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_conversation_workspace_fkey"
  FOREIGN KEY ("conversationId", "workspaceId") REFERENCES "ai_conversations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_requestedByUserId_fkey"
  FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_userMessageId_fkey"
  FOREIGN KEY ("userMessageId") REFERENCES "ai_messages"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_generatedByRunId_fkey"
  FOREIGN KEY ("generatedByRunId") REFERENCES "ai_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_retrieval_snapshots" ADD CONSTRAINT "ai_retrieval_snapshots_run_workspace_fkey"
  FOREIGN KEY ("runId", "workspaceId") REFERENCES "ai_runs"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_retrieval_snapshots" ADD CONSTRAINT "ai_retrieval_snapshots_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_run_citations" ADD CONSTRAINT "ai_run_citations_snapshotId_fkey"
  FOREIGN KEY ("snapshotId") REFERENCES "ai_retrieval_snapshots"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_run_citations" ADD CONSTRAINT "ai_run_citations_chunkSetId_fkey"
  FOREIGN KEY ("chunkSetId") REFERENCES "knowledge_chunk_sets"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION validate_ai_run_identity() RETURNS trigger AS $$
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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_ai_run_identity
BEFORE INSERT ON "ai_runs" FOR EACH ROW EXECUTE FUNCTION validate_ai_run_identity();

CREATE FUNCTION validate_ai_snapshot() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ai_runs" run
    WHERE run."id" = NEW."runId"
      AND run."workspaceId" = NEW."workspaceId"
      AND run."status" = 'PROCESSING'
  ) THEN
    RAISE EXCEPTION 'AI retrieval snapshot does not match an active run';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_ai_snapshot
BEFORE INSERT ON "ai_retrieval_snapshots" FOR EACH ROW EXECUTE FUNCTION validate_ai_snapshot();

CREATE FUNCTION validate_ai_citation() RETURNS trigger AS $$
DECLARE
  snapshot_workspace uuid;
BEGIN
  SELECT snapshot."workspaceId" INTO snapshot_workspace
  FROM "ai_retrieval_snapshots" snapshot WHERE snapshot."id" = NEW."snapshotId";
  IF snapshot_workspace IS NULL OR NOT EXISTS (
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

CREATE TRIGGER validate_ai_citation
BEFORE INSERT ON "ai_run_citations" FOR EACH ROW EXECUTE FUNCTION validate_ai_citation();

CREATE FUNCTION protect_ai_conversation_identity() RETURNS trigger AS $$
BEGIN
  IF OLD."workspaceId" <> NEW."workspaceId" OR OLD."ownerUserId" <> NEW."ownerUserId" OR
     OLD."createdAt" <> NEW."createdAt" THEN
    RAISE EXCEPTION 'AI conversation identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_ai_conversation_identity
BEFORE UPDATE ON "ai_conversations" FOR EACH ROW EXECUTE FUNCTION protect_ai_conversation_identity();

CREATE FUNCTION protect_ai_immutable_row() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AI message, retrieval snapshot, and citation history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_ai_messages_update_delete
BEFORE UPDATE OR DELETE ON "ai_messages" FOR EACH ROW EXECUTE FUNCTION protect_ai_immutable_row();
CREATE TRIGGER protect_ai_snapshots_update_delete
BEFORE UPDATE OR DELETE ON "ai_retrieval_snapshots" FOR EACH ROW EXECUTE FUNCTION protect_ai_immutable_row();
CREATE TRIGGER protect_ai_citations_update_delete
BEFORE UPDATE OR DELETE ON "ai_run_citations" FOR EACH ROW EXECUTE FUNCTION protect_ai_immutable_row();

CREATE FUNCTION protect_ai_run() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AI run history is append-only'; END IF;
  IF OLD."conversationId" <> NEW."conversationId" OR OLD."workspaceId" <> NEW."workspaceId" OR
     OLD."requestedByUserId" <> NEW."requestedByUserId" OR OLD."userMessageId" <> NEW."userMessageId" OR
     OLD."providerKey" <> NEW."providerKey" OR OLD."modelKey" <> NEW."modelKey" OR
     OLD."modelVersion" <> NEW."modelVersion" OR OLD."createdAt" <> NEW."createdAt" THEN
    RAISE EXCEPTION 'AI run identity is immutable';
  END IF;
  IF OLD."status" <> 'PROCESSING' OR NEW."status" NOT IN ('SUCCEEDED', 'FAILED') THEN
    RAISE EXCEPTION 'invalid AI run transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_ai_runs_update_delete
BEFORE UPDATE OR DELETE ON "ai_runs" FOR EACH ROW EXECUTE FUNCTION protect_ai_run();

CREATE FUNCTION validate_ai_snapshot_count() RETURNS trigger AS $$
DECLARE
  expected_count integer;
  actual_count integer;
BEGIN
  SELECT "resultCount" INTO expected_count FROM "ai_retrieval_snapshots"
  WHERE "id" = COALESCE(NEW."snapshotId", OLD."snapshotId");
  IF expected_count IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO actual_count FROM "ai_run_citations"
  WHERE "snapshotId" = COALESCE(NEW."snapshotId", OLD."snapshotId");
  IF expected_count <> actual_count THEN
    RAISE EXCEPTION 'AI retrieval snapshot citation count mismatch';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER validate_ai_snapshot_count_from_citation
AFTER INSERT OR UPDATE OR DELETE ON "ai_run_citations"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_ai_snapshot_count();

CREATE FUNCTION validate_ai_snapshot_count_from_snapshot() RETURNS trigger AS $$
DECLARE
  actual_count integer;
BEGIN
  SELECT count(*) INTO actual_count FROM "ai_run_citations" WHERE "snapshotId" = NEW."id";
  IF NEW."resultCount" <> actual_count THEN
    RAISE EXCEPTION 'AI retrieval snapshot citation count mismatch';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER validate_ai_snapshot_count_from_snapshot
AFTER INSERT OR UPDATE ON "ai_retrieval_snapshots"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_ai_snapshot_count_from_snapshot();
