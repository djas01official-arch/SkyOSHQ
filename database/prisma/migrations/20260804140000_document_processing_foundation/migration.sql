CREATE TYPE "KnowledgeAttachmentProcessingStatus" AS ENUM (
    'UPLOADED',
    'PROCESSING',
    'PROCESSED',
    'FAILED'
);

CREATE TYPE "DocumentProcessingJobStatus" AS ENUM (
    'QUEUED',
    'PROCESSING',
    'SUCCEEDED',
    'FAILED'
);

ALTER TABLE "knowledge_attachments"
ADD COLUMN "processingStatus" "KnowledgeAttachmentProcessingStatus" NOT NULL DEFAULT 'UPLOADED';

CREATE UNIQUE INDEX "knowledge_attachments_id_workspaceId_key"
ON "knowledge_attachments"("id", "workspaceId");

CREATE INDEX "knowledge_attachments_workspaceId_processingStatus_idx"
ON "knowledge_attachments"("workspaceId", "processingStatus");

CREATE TABLE "document_processing_jobs" (
    "id" UUID NOT NULL,
    "attachmentId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "requestedByUserId" UUID NOT NULL,
    "parserName" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "status" "DocumentProcessingJobStatus" NOT NULL DEFAULT 'QUEUED',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),

    CONSTRAINT "document_processing_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_processing_jobs_parser_name_not_empty" CHECK (length(btrim("parserName")) > 0),
    CONSTRAINT "document_processing_jobs_parser_version_not_empty" CHECK (length(btrim("parserVersion")) > 0),
    CONSTRAINT "document_processing_jobs_state" CHECK (
        ("status" = 'QUEUED' AND "startedAt" IS NULL AND "completedAt" IS NULL AND "errorMessage" IS NULL)
        OR ("status" = 'PROCESSING' AND "startedAt" IS NOT NULL AND "completedAt" IS NULL AND "errorMessage" IS NULL)
        OR ("status" = 'SUCCEEDED' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "errorMessage" IS NULL)
        OR ("status" = 'FAILED' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "errorMessage" IS NOT NULL)
    )
);

CREATE TABLE "knowledge_attachment_extractions" (
    "id" UUID NOT NULL,
    "attachmentId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "extractionNumber" INTEGER NOT NULL,
    "parserName" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "extractedText" TEXT NOT NULL,
    "textSha256" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_attachment_extractions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_attachment_extractions_number_positive" CHECK ("extractionNumber" > 0),
    CONSTRAINT "knowledge_attachment_extractions_parser_name_not_empty" CHECK (length(btrim("parserName")) > 0),
    CONSTRAINT "knowledge_attachment_extractions_parser_version_not_empty" CHECK (length(btrim("parserVersion")) > 0),
    CONSTRAINT "knowledge_attachment_extractions_checksum_format" CHECK ("textSha256" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "document_processing_jobs_active_attachment_key"
ON "document_processing_jobs"("attachmentId")
WHERE "status" IN ('QUEUED', 'PROCESSING');

CREATE INDEX "document_processing_jobs_attachmentId_status_createdAt_idx"
ON "document_processing_jobs"("attachmentId", "status", "createdAt");

CREATE INDEX "document_processing_jobs_workspaceId_status_createdAt_idx"
ON "document_processing_jobs"("workspaceId", "status", "createdAt");

CREATE INDEX "document_processing_jobs_requestedByUserId_createdAt_idx"
ON "document_processing_jobs"("requestedByUserId", "createdAt");

CREATE UNIQUE INDEX "knowledge_attachment_extractions_jobId_key"
ON "knowledge_attachment_extractions"("jobId");

CREATE UNIQUE INDEX "knowledge_attachment_extractions_attachmentId_extractionNumber_key"
ON "knowledge_attachment_extractions"("attachmentId", "extractionNumber");

CREATE INDEX "knowledge_attachment_extractions_workspaceId_createdAt_idx"
ON "knowledge_attachment_extractions"("workspaceId", "createdAt");

ALTER TABLE "document_processing_jobs"
ADD CONSTRAINT "document_processing_jobs_attachment_workspace_fkey"
FOREIGN KEY ("attachmentId", "workspaceId")
REFERENCES "knowledge_attachments"("id", "workspaceId")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "document_processing_jobs"
ADD CONSTRAINT "document_processing_jobs_requestedByUserId_fkey"
FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "knowledge_attachment_extractions"
ADD CONSTRAINT "knowledge_attachment_extractions_attachment_workspace_fkey"
FOREIGN KEY ("attachmentId", "workspaceId")
REFERENCES "knowledge_attachments"("id", "workspaceId")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "knowledge_attachment_extractions"
ADD CONSTRAINT "knowledge_attachment_extractions_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "document_processing_jobs"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION prevent_knowledge_attachment_metadata_mutation() RETURNS trigger AS $$
BEGIN
  IF NEW."id" <> OLD."id"
     OR NEW."workspaceId" <> OLD."workspaceId"
     OR NEW."documentId" <> OLD."documentId"
     OR NEW."uploaderUserId" <> OLD."uploaderUserId"
     OR NEW."originalFilename" <> OLD."originalFilename"
     OR NEW."storageKey" <> OLD."storageKey"
     OR NEW."mimeType" <> OLD."mimeType"
     OR NEW."sizeBytes" <> OLD."sizeBytes"
     OR NEW."sha256Checksum" <> OLD."sha256Checksum"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'knowledge attachment metadata is immutable';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NEW."processingStatus" IS DISTINCT FROM OLD."processingStatus" THEN
    RAISE EXCEPTION 'attachment lifecycle and processing state must change separately';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'knowledge attachment lifecycle changes must increment version';
    END IF;
  ELSIF NEW."version" <> OLD."version" THEN
    RAISE EXCEPTION 'knowledge attachment version requires a lifecycle change';
  END IF;

  IF NEW."processingStatus" IS DISTINCT FROM OLD."processingStatus" THEN
    IF NOT (
      (OLD."processingStatus" IN ('UPLOADED', 'PROCESSED', 'FAILED') AND NEW."processingStatus" = 'PROCESSING')
      OR (OLD."processingStatus" = 'PROCESSING' AND NEW."processingStatus" IN ('PROCESSED', 'FAILED'))
    ) THEN
      RAISE EXCEPTION 'invalid knowledge attachment processing transition';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION prevent_document_processing_job_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'document processing jobs are retained';
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."attachmentId" <> OLD."attachmentId"
     OR NEW."workspaceId" <> OLD."workspaceId"
     OR NEW."requestedByUserId" <> OLD."requestedByUserId"
     OR NEW."parserName" <> OLD."parserName"
     OR NEW."parserVersion" <> OLD."parserVersion"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'document processing job identity is immutable';
  END IF;

  IF NOT (
    (OLD."status" = 'QUEUED' AND NEW."status" = 'PROCESSING')
    OR (OLD."status" = 'PROCESSING' AND NEW."status" IN ('SUCCEEDED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'invalid document processing job transition';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_document_processing_job_update
BEFORE UPDATE ON "document_processing_jobs"
FOR EACH ROW EXECUTE FUNCTION prevent_document_processing_job_mutation();

CREATE TRIGGER prevent_document_processing_job_delete
BEFORE DELETE ON "document_processing_jobs"
FOR EACH ROW EXECUTE FUNCTION prevent_document_processing_job_mutation();

CREATE FUNCTION prevent_knowledge_attachment_extraction_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'knowledge attachment extractions are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_knowledge_attachment_extraction_update
BEFORE UPDATE ON "knowledge_attachment_extractions"
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_attachment_extraction_mutation();

CREATE TRIGGER prevent_knowledge_attachment_extraction_delete
BEFORE DELETE ON "knowledge_attachment_extractions"
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_attachment_extraction_mutation();
