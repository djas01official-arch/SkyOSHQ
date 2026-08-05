-- CreateEnum
CREATE TYPE "BackgroundJobKind" AS ENUM ('DOCUMENT_EXTRACTION', 'KNOWLEDGE_CHUNKING', 'KNOWLEDGE_EMBEDDING');

-- CreateEnum
CREATE TYPE "BackgroundJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "BackgroundJobAttemptOutcome" AS ENUM ('SUCCEEDED', 'RETRY_SCHEDULED', 'FAILED', 'LEASE_EXPIRED');

-- CreateTable
CREATE TABLE "background_jobs" (
    "id" UUID NOT NULL,
    "kind" "BackgroundJobKind" NOT NULL,
    "status" "BackgroundJobStatus" NOT NULL DEFAULT 'QUEUED',
    "workspaceId" UUID NOT NULL,
    "requestedByUserId" UUID NOT NULL,
    "domainJobId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "availableAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workerId" TEXT,
    "lockedAt" TIMESTAMPTZ(6),
    "leaseExpiresAt" TIMESTAMPTZ(6),
    "firstStartedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "durationMs" BIGINT,
    "lastError" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "background_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "background_jobs_attempts_valid" CHECK ("maxAttempts" BETWEEN 1 AND 25 AND "attemptCount" BETWEEN 0 AND "maxAttempts"),
    CONSTRAINT "background_jobs_idempotency_key_valid" CHECK (length(btrim("idempotencyKey")) BETWEEN 1 AND 250),
    CONSTRAINT "background_jobs_worker_id_valid" CHECK ("workerId" IS NULL OR length(btrim("workerId")) BETWEEN 1 AND 120),
    CONSTRAINT "background_jobs_duration_valid" CHECK ("durationMs" IS NULL OR "durationMs" >= 0),
    CONSTRAINT "background_jobs_last_error_valid" CHECK ("lastError" IS NULL OR jsonb_typeof("lastError") = 'object'),
    CONSTRAINT "background_jobs_state_valid" CHECK (
        ("status" = 'QUEUED' AND "workerId" IS NULL AND "lockedAt" IS NULL AND "leaseExpiresAt" IS NULL AND "completedAt" IS NULL AND "attemptCount" < "maxAttempts")
        OR ("status" = 'PROCESSING' AND "workerId" IS NOT NULL AND "lockedAt" IS NOT NULL AND "leaseExpiresAt" > "lockedAt" AND "completedAt" IS NULL AND "attemptCount" > 0)
        OR ("status" IN ('SUCCEEDED', 'FAILED') AND "workerId" IS NULL AND "lockedAt" IS NULL AND "leaseExpiresAt" IS NULL AND "completedAt" IS NOT NULL AND "firstStartedAt" IS NOT NULL AND "durationMs" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "background_job_attempts" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "workerId" TEXT NOT NULL,
    "outcome" "BackgroundJobAttemptOutcome" NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "finishedAt" TIMESTAMPTZ(6) NOT NULL,
    "durationMs" BIGINT NOT NULL,
    "error" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "background_job_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "background_job_attempts_number_valid" CHECK ("attemptNumber" > 0),
    CONSTRAINT "background_job_attempts_worker_id_valid" CHECK (length(btrim("workerId")) BETWEEN 1 AND 120),
    CONSTRAINT "background_job_attempts_time_valid" CHECK ("finishedAt" >= "startedAt" AND "durationMs" >= 0),
    CONSTRAINT "background_job_attempts_error_valid" CHECK ("error" IS NULL OR jsonb_typeof("error") = 'object')
);

-- CreateIndex
CREATE UNIQUE INDEX "background_jobs_idempotencyKey_key" ON "background_jobs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "background_jobs_status_availableAt_createdAt_idx" ON "background_jobs"("status", "availableAt", "createdAt") WHERE "status" = 'QUEUED';

-- CreateIndex
CREATE INDEX "background_jobs_status_leaseExpiresAt_idx" ON "background_jobs"("status", "leaseExpiresAt") WHERE "status" = 'PROCESSING';

-- CreateIndex
CREATE INDEX "background_jobs_workspaceId_status_createdAt_idx" ON "background_jobs"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "background_jobs_requestedByUserId_createdAt_idx" ON "background_jobs"("requestedByUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "background_jobs_kind_domainJobId_key" ON "background_jobs"("kind", "domainJobId");

-- CreateIndex
CREATE INDEX "background_job_attempts_jobId_createdAt_idx" ON "background_job_attempts"("jobId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "background_job_attempts_jobId_attemptNumber_key" ON "background_job_attempts"("jobId", "attemptNumber");

-- AddForeignKey
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "background_job_attempts" ADD CONSTRAINT "background_job_attempts_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "background_jobs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Attempt rows are completed execution snapshots and are never rewritten.
CREATE FUNCTION prevent_background_job_attempt_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'background job attempts are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER background_job_attempts_reject_updates
BEFORE UPDATE ON "background_job_attempts"
FOR EACH ROW EXECUTE FUNCTION prevent_background_job_attempt_mutation();

CREATE TRIGGER background_job_attempts_reject_deletes
BEFORE DELETE ON "background_job_attempts"
FOR EACH ROW EXECUTE FUNCTION prevent_background_job_attempt_mutation();

-- Tenant scope, handler identity, idempotency, and input payload are immutable.
CREATE FUNCTION prevent_background_job_identity_mutation() RETURNS trigger AS $$
BEGIN
    IF NEW."id" <> OLD."id"
       OR NEW."kind" <> OLD."kind"
       OR NEW."workspaceId" <> OLD."workspaceId"
       OR NEW."requestedByUserId" <> OLD."requestedByUserId"
       OR NEW."domainJobId" <> OLD."domainJobId"
       OR NEW."idempotencyKey" <> OLD."idempotencyKey"
       OR NEW."payload" <> OLD."payload"
       OR NEW."maxAttempts" <> OLD."maxAttempts"
       OR NEW."createdAt" <> OLD."createdAt" THEN
        RAISE EXCEPTION 'background job identity is immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER background_jobs_protect_identity
BEFORE UPDATE ON "background_jobs"
FOR EACH ROW EXECUTE FUNCTION prevent_background_job_identity_mutation();

-- Durable lease recovery is the one safe backward transition for domain job
-- state machines. Service code resets timestamps and attachment state together.
CREATE OR REPLACE FUNCTION prevent_document_processing_job_mutation() RETURNS trigger AS $$
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
    OR (OLD."status" = 'PROCESSING' AND NEW."status" = 'QUEUED'
        AND NEW."startedAt" IS NULL AND NEW."completedAt" IS NULL AND NEW."errorMessage" IS NULL)
  ) THEN
    RAISE EXCEPTION 'invalid document processing job transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_knowledge_chunking_job_mutation() RETURNS trigger AS $$
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
    OR (OLD."status" = 'PROCESSING' AND NEW."status" = 'QUEUED'
        AND NEW."startedAt" IS NULL AND NEW."completedAt" IS NULL AND NEW."errorMessage" IS NULL)
  ) THEN
    RAISE EXCEPTION 'invalid knowledge chunking job transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
    IF NOT (
      (OLD."status" = 'ACTIVE' AND NEW."status" = 'ARCHIVED' AND NEW."archivedAt" IS NOT NULL)
      OR (OLD."status" = 'ARCHIVED' AND NEW."status" = 'ACTIVE' AND NEW."archivedAt" IS NULL)
    ) THEN
      RAISE EXCEPTION 'invalid knowledge attachment lifecycle transition';
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'knowledge attachment lifecycle changes must increment version';
    END IF;
  ELSIF NEW."version" <> OLD."version" THEN
    RAISE EXCEPTION 'knowledge attachment version requires a lifecycle change';
  END IF;
  IF NEW."processingStatus" IS DISTINCT FROM OLD."processingStatus" THEN
    IF NOT (
      (OLD."processingStatus" IN ('UPLOADED', 'PROCESSED', 'FAILED') AND NEW."processingStatus" = 'PROCESSING')
      OR (OLD."processingStatus" = 'PROCESSING' AND NEW."processingStatus" IN ('UPLOADED', 'PROCESSED', 'FAILED'))
    ) THEN
      RAISE EXCEPTION 'invalid knowledge attachment processing transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
