CREATE TYPE "KnowledgeChunkSourceType" AS ENUM (
    'MARKDOWN_DOCUMENT',
    'ATTACHMENT_EXTRACTION'
);

CREATE TYPE "KnowledgeChunkingJobStatus" AS ENUM (
    'QUEUED',
    'PROCESSING',
    'SUCCEEDED',
    'FAILED'
);

CREATE TABLE "knowledge_chunking_jobs" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "requestedByUserId" UUID NOT NULL,
    "sourceType" "KnowledgeChunkSourceType" NOT NULL,
    "sourceId" UUID NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "documentVersionId" UUID,
    "attachmentExtractionId" UUID,
    "strategyKey" TEXT NOT NULL,
    "strategyVersion" TEXT NOT NULL,
    "status" "KnowledgeChunkingJobStatus" NOT NULL DEFAULT 'QUEUED',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),

    CONSTRAINT "knowledge_chunking_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_chunking_jobs_source_version_positive" CHECK ("sourceVersion" > 0),
    CONSTRAINT "knowledge_chunking_jobs_strategy_key_not_empty" CHECK (length(btrim("strategyKey")) > 0),
    CONSTRAINT "knowledge_chunking_jobs_strategy_version_not_empty" CHECK (length(btrim("strategyVersion")) > 0),
    CONSTRAINT "knowledge_chunking_jobs_source_reference" CHECK (
        ("sourceType" = 'MARKDOWN_DOCUMENT' AND "documentVersionId" IS NOT NULL AND "attachmentExtractionId" IS NULL)
        OR ("sourceType" = 'ATTACHMENT_EXTRACTION' AND "documentVersionId" IS NULL AND "attachmentExtractionId" IS NOT NULL)
    ),
    CONSTRAINT "knowledge_chunking_jobs_state" CHECK (
        ("status" = 'QUEUED' AND "startedAt" IS NULL AND "completedAt" IS NULL AND "errorMessage" IS NULL)
        OR ("status" = 'PROCESSING' AND "startedAt" IS NOT NULL AND "completedAt" IS NULL AND "errorMessage" IS NULL)
        OR ("status" = 'SUCCEEDED' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "errorMessage" IS NULL)
        OR ("status" = 'FAILED' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND length(btrim("errorMessage")) > 0)
    )
);

CREATE TABLE "knowledge_chunk_sets" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "sourceType" "KnowledgeChunkSourceType" NOT NULL,
    "sourceId" UUID NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "documentVersionId" UUID,
    "attachmentExtractionId" UUID,
    "strategyKey" TEXT NOT NULL,
    "strategyVersion" TEXT NOT NULL,
    "chunkCount" INTEGER NOT NULL,
    "createdByJobId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunk_sets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_chunk_sets_source_version_positive" CHECK ("sourceVersion" > 0),
    CONSTRAINT "knowledge_chunk_sets_chunk_count_positive" CHECK ("chunkCount" > 0),
    CONSTRAINT "knowledge_chunk_sets_strategy_key_not_empty" CHECK (length(btrim("strategyKey")) > 0),
    CONSTRAINT "knowledge_chunk_sets_strategy_version_not_empty" CHECK (length(btrim("strategyVersion")) > 0),
    CONSTRAINT "knowledge_chunk_sets_source_reference" CHECK (
        ("sourceType" = 'MARKDOWN_DOCUMENT' AND "documentVersionId" IS NOT NULL AND "attachmentExtractionId" IS NULL)
        OR ("sourceType" = 'ATTACHMENT_EXTRACTION' AND "documentVersionId" IS NULL AND "attachmentExtractionId" IS NOT NULL)
    )
);

CREATE TABLE "knowledge_chunks" (
    "id" UUID NOT NULL,
    "chunkSetId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "characterStart" INTEGER,
    "characterEnd" INTEGER,
    "tokenEstimate" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_chunks_ordinal_nonnegative" CHECK ("ordinal" >= 0),
    CONSTRAINT "knowledge_chunks_text_not_empty" CHECK (length("text") > 0),
    CONSTRAINT "knowledge_chunks_token_estimate_positive" CHECK ("tokenEstimate" > 0),
    CONSTRAINT "knowledge_chunks_checksum_format" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "knowledge_chunks_offsets" CHECK (
        ("characterStart" IS NULL AND "characterEnd" IS NULL)
        OR ("characterStart" >= 0 AND "characterEnd" > "characterStart")
    )
);

CREATE UNIQUE INDEX "knowledge_chunking_jobs_active_source_key"
ON "knowledge_chunking_jobs"("workspaceId", "sourceType", "sourceId", "sourceVersion")
WHERE "status" IN ('QUEUED', 'PROCESSING');

CREATE INDEX "knowledge_chunking_jobs_workspaceId_status_createdAt_idx"
ON "knowledge_chunking_jobs"("workspaceId", "status", "createdAt");
CREATE INDEX "knowledge_chunking_jobs_sourceType_sourceId_sourceVersion_createdAt_idx"
ON "knowledge_chunking_jobs"("sourceType", "sourceId", "sourceVersion", "createdAt");
CREATE INDEX "knowledge_chunking_jobs_requestedByUserId_createdAt_idx"
ON "knowledge_chunking_jobs"("requestedByUserId", "createdAt");
CREATE INDEX "knowledge_chunking_jobs_documentVersionId_idx"
ON "knowledge_chunking_jobs"("documentVersionId");
CREATE INDEX "knowledge_chunking_jobs_attachmentExtractionId_idx"
ON "knowledge_chunking_jobs"("attachmentExtractionId");

CREATE UNIQUE INDEX "knowledge_chunk_sets_createdByJobId_key"
ON "knowledge_chunk_sets"("createdByJobId");
CREATE INDEX "knowledge_chunk_sets_workspaceId_createdAt_idx"
ON "knowledge_chunk_sets"("workspaceId", "createdAt");
CREATE INDEX "knowledge_chunk_sets_sourceType_sourceId_sourceVersion_createdAt_idx"
ON "knowledge_chunk_sets"("sourceType", "sourceId", "sourceVersion", "createdAt");
CREATE INDEX "knowledge_chunk_sets_strategyKey_strategyVersion_idx"
ON "knowledge_chunk_sets"("strategyKey", "strategyVersion");
CREATE INDEX "knowledge_chunk_sets_documentVersionId_idx"
ON "knowledge_chunk_sets"("documentVersionId");
CREATE INDEX "knowledge_chunk_sets_attachmentExtractionId_idx"
ON "knowledge_chunk_sets"("attachmentExtractionId");

CREATE UNIQUE INDEX "knowledge_chunks_chunkSetId_ordinal_key"
ON "knowledge_chunks"("chunkSetId", "ordinal");
CREATE INDEX "knowledge_chunks_chunkSetId_idx" ON "knowledge_chunks"("chunkSetId");

ALTER TABLE "knowledge_chunking_jobs"
ADD CONSTRAINT "knowledge_chunking_jobs_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "knowledge_chunking_jobs"
ADD CONSTRAINT "knowledge_chunking_jobs_requestedByUserId_fkey"
FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "knowledge_chunking_jobs"
ADD CONSTRAINT "knowledge_chunking_jobs_documentVersionId_fkey"
FOREIGN KEY ("documentVersionId") REFERENCES "knowledge_document_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "knowledge_chunking_jobs"
ADD CONSTRAINT "knowledge_chunking_jobs_attachmentExtractionId_fkey"
FOREIGN KEY ("attachmentExtractionId") REFERENCES "knowledge_attachment_extractions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "knowledge_chunk_sets"
ADD CONSTRAINT "knowledge_chunk_sets_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "knowledge_chunk_sets"
ADD CONSTRAINT "knowledge_chunk_sets_createdByJobId_fkey"
FOREIGN KEY ("createdByJobId") REFERENCES "knowledge_chunking_jobs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "knowledge_chunk_sets"
ADD CONSTRAINT "knowledge_chunk_sets_documentVersionId_fkey"
FOREIGN KEY ("documentVersionId") REFERENCES "knowledge_document_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "knowledge_chunk_sets"
ADD CONSTRAINT "knowledge_chunk_sets_attachmentExtractionId_fkey"
FOREIGN KEY ("attachmentExtractionId") REFERENCES "knowledge_attachment_extractions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "knowledge_chunks"
ADD CONSTRAINT "knowledge_chunks_chunkSetId_fkey"
FOREIGN KEY ("chunkSetId") REFERENCES "knowledge_chunk_sets"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION validate_knowledge_chunk_source() RETURNS trigger AS $$
DECLARE
  matched BOOLEAN;
BEGIN
  IF NEW."sourceType" = 'MARKDOWN_DOCUMENT' THEN
    SELECT TRUE INTO matched
    FROM "knowledge_document_versions" version
    JOIN "knowledge_documents" document ON document."id" = version."documentId"
    WHERE version."id" = NEW."documentVersionId"
      AND document."id" = NEW."sourceId"
      AND document."workspaceId" = NEW."workspaceId"
      AND version."versionNumber" = NEW."sourceVersion";
  ELSE
    SELECT TRUE INTO matched
    FROM "knowledge_attachment_extractions" extraction
    WHERE extraction."id" = NEW."attachmentExtractionId"
      AND extraction."attachmentId" = NEW."sourceId"
      AND extraction."workspaceId" = NEW."workspaceId"
      AND extraction."extractionNumber" = NEW."sourceVersion";
  END IF;

  IF matched IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'knowledge chunk source identity does not match its immutable source version';
  END IF;

  IF TG_TABLE_NAME = 'knowledge_chunk_sets' AND NOT EXISTS (
    SELECT 1 FROM "knowledge_chunking_jobs" job
    WHERE job."id" = NEW."createdByJobId"
      AND job."workspaceId" = NEW."workspaceId"
      AND job."sourceType" = NEW."sourceType"
      AND job."sourceId" = NEW."sourceId"
      AND job."sourceVersion" = NEW."sourceVersion"
      AND job."documentVersionId" IS NOT DISTINCT FROM NEW."documentVersionId"
      AND job."attachmentExtractionId" IS NOT DISTINCT FROM NEW."attachmentExtractionId"
      AND job."strategyKey" = NEW."strategyKey"
      AND job."strategyVersion" = NEW."strategyVersion"
      AND job."status" = 'PROCESSING'
  ) THEN
    RAISE EXCEPTION 'knowledge chunk set does not match its creating job';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_knowledge_chunking_job_source
BEFORE INSERT ON "knowledge_chunking_jobs"
FOR EACH ROW EXECUTE FUNCTION validate_knowledge_chunk_source();
CREATE TRIGGER validate_knowledge_chunk_set_source
BEFORE INSERT ON "knowledge_chunk_sets"
FOR EACH ROW EXECUTE FUNCTION validate_knowledge_chunk_source();

CREATE FUNCTION prevent_knowledge_chunking_job_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'knowledge chunking jobs are retained';
  END IF;
  IF NEW."id" <> OLD."id"
     OR NEW."workspaceId" <> OLD."workspaceId"
     OR NEW."requestedByUserId" <> OLD."requestedByUserId"
     OR NEW."sourceType" <> OLD."sourceType"
     OR NEW."sourceId" <> OLD."sourceId"
     OR NEW."sourceVersion" <> OLD."sourceVersion"
     OR NEW."documentVersionId" IS DISTINCT FROM OLD."documentVersionId"
     OR NEW."attachmentExtractionId" IS DISTINCT FROM OLD."attachmentExtractionId"
     OR NEW."strategyKey" <> OLD."strategyKey"
     OR NEW."strategyVersion" <> OLD."strategyVersion"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'knowledge chunking job identity is immutable';
  END IF;
  IF NOT (
    (OLD."status" = 'QUEUED' AND NEW."status" = 'PROCESSING')
    OR (OLD."status" = 'PROCESSING' AND NEW."status" IN ('SUCCEEDED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'invalid knowledge chunking job transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_knowledge_chunking_job_update
BEFORE UPDATE ON "knowledge_chunking_jobs"
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_chunking_job_mutation();
CREATE TRIGGER prevent_knowledge_chunking_job_delete
BEFORE DELETE ON "knowledge_chunking_jobs"
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_chunking_job_mutation();

CREATE FUNCTION prevent_knowledge_chunk_output_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'knowledge chunk outputs are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_knowledge_chunk_set_update
BEFORE UPDATE ON "knowledge_chunk_sets"
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_chunk_output_mutation();
CREATE TRIGGER prevent_knowledge_chunk_set_delete
BEFORE DELETE ON "knowledge_chunk_sets"
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_chunk_output_mutation();
CREATE TRIGGER prevent_knowledge_chunk_update
BEFORE UPDATE ON "knowledge_chunks"
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_chunk_output_mutation();
CREATE TRIGGER prevent_knowledge_chunk_delete
BEFORE DELETE ON "knowledge_chunks"
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_chunk_output_mutation();

CREATE FUNCTION verify_knowledge_chunk_count() RETURNS trigger AS $$
DECLARE
  affected_set_id UUID;
  expected_count INTEGER;
  actual_count INTEGER;
BEGIN
  affected_set_id := CASE WHEN TG_TABLE_NAME = 'knowledge_chunk_sets' THEN NEW."id" ELSE NEW."chunkSetId" END;
  SELECT "chunkCount" INTO expected_count FROM "knowledge_chunk_sets" WHERE "id" = affected_set_id;
  SELECT count(*) INTO actual_count FROM "knowledge_chunks" WHERE "chunkSetId" = affected_set_id;
  IF expected_count IS DISTINCT FROM actual_count THEN
    RAISE EXCEPTION 'knowledge chunk count does not match persisted chunks';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER verify_knowledge_chunk_set_count
AFTER INSERT ON "knowledge_chunk_sets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_knowledge_chunk_count();
CREATE CONSTRAINT TRIGGER verify_knowledge_chunk_count_after_insert
AFTER INSERT ON "knowledge_chunks"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_knowledge_chunk_count();
