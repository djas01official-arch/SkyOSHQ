-- pgvector is required by both development and test databases before any
-- embedding table can be created. The migration fails clearly if the server
-- image does not provide the extension package.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "KnowledgeEmbeddingJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "knowledge_embedding_jobs" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "chunkSetId" UUID NOT NULL,
    "requestedByUserId" UUID NOT NULL,
    "providerKey" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "status" "KnowledgeEmbeddingJobStatus" NOT NULL DEFAULT 'QUEUED',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),

    CONSTRAINT "knowledge_embedding_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_embedding_jobs_dimensions_valid" CHECK ("dimensions" BETWEEN 1 AND 2000),
    CONSTRAINT "knowledge_embedding_jobs_provider_valid" CHECK (
        length(btrim("providerKey")) BETWEEN 1 AND 120
        AND length(btrim("modelKey")) BETWEEN 1 AND 120
        AND length(btrim("modelVersion")) BETWEEN 1 AND 120
    ),
    CONSTRAINT "knowledge_embedding_jobs_state_valid" CHECK (
        ("status" = 'QUEUED' AND "startedAt" IS NULL AND "completedAt" IS NULL AND "errorMessage" IS NULL)
        OR ("status" = 'PROCESSING' AND "startedAt" IS NOT NULL AND "completedAt" IS NULL AND "errorMessage" IS NULL)
        OR ("status" = 'SUCCEEDED' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "errorMessage" IS NULL)
        OR ("status" = 'FAILED' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "errorMessage" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "knowledge_embedding_sets" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "chunkSetId" UUID NOT NULL,
    "createdByJobId" UUID NOT NULL,
    "providerKey" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "inputChecksum" CHAR(64) NOT NULL,
    "embeddingCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_embedding_sets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_embedding_sets_dimensions_valid" CHECK ("dimensions" BETWEEN 1 AND 2000),
    CONSTRAINT "knowledge_embedding_sets_count_valid" CHECK ("embeddingCount" > 0),
    CONSTRAINT "knowledge_embedding_sets_input_checksum_valid" CHECK ("inputChecksum" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "knowledge_embedding_sets_provider_valid" CHECK (
        length(btrim("providerKey")) BETWEEN 1 AND 120
        AND length(btrim("modelKey")) BETWEEN 1 AND 120
        AND length(btrim("modelVersion")) BETWEEN 1 AND 120
    )
);

-- CreateTable
CREATE TABLE "knowledge_embeddings" (
    "id" UUID NOT NULL,
    "embeddingSetId" UUID NOT NULL,
    "chunkId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "chunkSha256" CHAR(64) NOT NULL,
    "inputChecksum" CHAR(64) NOT NULL,
    "vector" vector NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_embeddings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_embeddings_ordinal_valid" CHECK ("ordinal" >= 0),
    CONSTRAINT "knowledge_embeddings_chunk_checksum_valid" CHECK ("chunkSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "knowledge_embeddings_input_checksum_valid" CHECK ("inputChecksum" ~ '^[0-9a-f]{64}$')
);

-- CreateIndex
CREATE INDEX "knowledge_embedding_jobs_workspaceId_status_createdAt_idx" ON "knowledge_embedding_jobs"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "knowledge_embedding_jobs_chunkSetId_createdAt_idx" ON "knowledge_embedding_jobs"("chunkSetId", "createdAt");

-- CreateIndex
CREATE INDEX "knowledge_embedding_jobs_requestedByUserId_createdAt_idx" ON "knowledge_embedding_jobs"("requestedByUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_embedding_jobs_active_generation_key" ON "knowledge_embedding_jobs"("workspaceId", "chunkSetId", "providerKey", "modelKey", "modelVersion") WHERE (status = ANY (ARRAY['QUEUED'::"KnowledgeEmbeddingJobStatus", 'PROCESSING'::"KnowledgeEmbeddingJobStatus"]));

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_embedding_sets_createdByJobId_key" ON "knowledge_embedding_sets"("createdByJobId");

-- CreateIndex
CREATE INDEX "knowledge_embedding_sets_workspaceId_createdAt_idx" ON "knowledge_embedding_sets"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "knowledge_embedding_sets_chunkSetId_createdAt_idx" ON "knowledge_embedding_sets"("chunkSetId", "createdAt");

-- CreateIndex
CREATE INDEX "knowledge_embedding_sets_providerKey_modelKey_modelVersion__idx" ON "knowledge_embedding_sets"("providerKey", "modelKey", "modelVersion", "createdAt");

-- CreateIndex
CREATE INDEX "knowledge_embeddings_chunkId_idx" ON "knowledge_embeddings"("chunkId");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_embeddings_embeddingSetId_ordinal_key" ON "knowledge_embeddings"("embeddingSetId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_embeddings_embeddingSetId_chunkId_key" ON "knowledge_embeddings"("embeddingSetId", "chunkId");

-- AddForeignKey
ALTER TABLE "knowledge_embedding_jobs" ADD CONSTRAINT "knowledge_embedding_jobs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "knowledge_embedding_jobs" ADD CONSTRAINT "knowledge_embedding_jobs_chunkSetId_fkey" FOREIGN KEY ("chunkSetId") REFERENCES "knowledge_chunk_sets"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "knowledge_embedding_jobs" ADD CONSTRAINT "knowledge_embedding_jobs_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "knowledge_embedding_sets" ADD CONSTRAINT "knowledge_embedding_sets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "knowledge_embedding_sets" ADD CONSTRAINT "knowledge_embedding_sets_chunkSetId_fkey" FOREIGN KEY ("chunkSetId") REFERENCES "knowledge_chunk_sets"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "knowledge_embedding_sets" ADD CONSTRAINT "knowledge_embedding_sets_createdByJobId_fkey" FOREIGN KEY ("createdByJobId") REFERENCES "knowledge_embedding_jobs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "knowledge_embeddings" ADD CONSTRAINT "knowledge_embeddings_embeddingSetId_fkey" FOREIGN KEY ("embeddingSetId") REFERENCES "knowledge_embedding_sets"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "knowledge_embeddings" ADD CONSTRAINT "knowledge_embeddings_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "knowledge_chunks"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION validate_knowledge_embedding_job_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "knowledge_chunk_sets" chunk_set
    WHERE chunk_set."id" = NEW."chunkSetId"
      AND chunk_set."workspaceId" = NEW."workspaceId"
  ) THEN
    RAISE EXCEPTION 'embedding job chunk set must belong to its workspace';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_knowledge_embedding_job_scope_on_insert
BEFORE INSERT ON "knowledge_embedding_jobs"
FOR EACH ROW EXECUTE FUNCTION validate_knowledge_embedding_job_scope();

CREATE FUNCTION validate_knowledge_embedding_set() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "knowledge_embedding_jobs" job
    WHERE job."id" = NEW."createdByJobId"
      AND job."workspaceId" = NEW."workspaceId"
      AND job."chunkSetId" = NEW."chunkSetId"
      AND job."providerKey" = NEW."providerKey"
      AND job."modelKey" = NEW."modelKey"
      AND job."modelVersion" = NEW."modelVersion"
      AND job."dimensions" = NEW."dimensions"
      AND job."status" = 'PROCESSING'
  ) THEN
    RAISE EXCEPTION 'embedding set does not match its active creating job';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_knowledge_embedding_set_on_insert
BEFORE INSERT ON "knowledge_embedding_sets"
FOR EACH ROW EXECUTE FUNCTION validate_knowledge_embedding_set();

CREATE FUNCTION validate_knowledge_embedding_row() RETURNS trigger AS $$
DECLARE
  expected_dimensions INTEGER;
BEGIN
  SELECT embedding_set."dimensions" INTO expected_dimensions
  FROM "knowledge_embedding_sets" embedding_set
  JOIN "knowledge_chunks" chunk
    ON chunk."chunkSetId" = embedding_set."chunkSetId"
  WHERE embedding_set."id" = NEW."embeddingSetId"
    AND chunk."id" = NEW."chunkId"
    AND chunk."ordinal" = NEW."ordinal"
    AND chunk."sha256" = NEW."chunkSha256";

  IF expected_dimensions IS NULL THEN
    RAISE EXCEPTION 'embedding row does not match its immutable source chunk';
  END IF;
  IF vector_dims(NEW."vector") <> expected_dimensions THEN
    RAISE EXCEPTION 'embedding vector dimension does not match its embedding set';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_knowledge_embedding_row_on_insert
BEFORE INSERT ON "knowledge_embeddings"
FOR EACH ROW EXECUTE FUNCTION validate_knowledge_embedding_row();

CREATE FUNCTION prevent_knowledge_embedding_job_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'knowledge embedding jobs are retained';
  END IF;
  IF NEW."id" <> OLD."id"
     OR NEW."workspaceId" <> OLD."workspaceId"
     OR NEW."chunkSetId" <> OLD."chunkSetId"
     OR NEW."requestedByUserId" <> OLD."requestedByUserId"
     OR NEW."providerKey" <> OLD."providerKey"
     OR NEW."modelKey" <> OLD."modelKey"
     OR NEW."modelVersion" <> OLD."modelVersion"
     OR NEW."dimensions" <> OLD."dimensions"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'knowledge embedding job identity is immutable';
  END IF;
  IF NOT (
    (OLD."status" = 'QUEUED' AND NEW."status" = 'PROCESSING')
    OR (OLD."status" = 'PROCESSING' AND NEW."status" IN ('SUCCEEDED', 'FAILED'))
    OR (OLD."status" = 'PROCESSING' AND NEW."status" = 'QUEUED'
        AND NEW."startedAt" IS NULL AND NEW."completedAt" IS NULL AND NEW."errorMessage" IS NULL)
  ) THEN
    RAISE EXCEPTION 'invalid knowledge embedding job transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_knowledge_embedding_job_update
BEFORE UPDATE ON "knowledge_embedding_jobs"
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_embedding_job_mutation();

CREATE TRIGGER prevent_knowledge_embedding_job_delete
BEFORE DELETE ON "knowledge_embedding_jobs"
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_embedding_job_mutation();

CREATE FUNCTION prevent_knowledge_embedding_output_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'knowledge embedding outputs are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_knowledge_embedding_set_update
BEFORE UPDATE ON "knowledge_embedding_sets"
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_embedding_output_mutation();

CREATE TRIGGER prevent_knowledge_embedding_set_delete
BEFORE DELETE ON "knowledge_embedding_sets"
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_embedding_output_mutation();

CREATE TRIGGER prevent_knowledge_embedding_update
BEFORE UPDATE ON "knowledge_embeddings"
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_embedding_output_mutation();

CREATE TRIGGER prevent_knowledge_embedding_delete
BEFORE DELETE ON "knowledge_embeddings"
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_embedding_output_mutation();

CREATE FUNCTION verify_knowledge_embedding_count() RETURNS trigger AS $$
DECLARE
  affected_set_id UUID;
  expected_count INTEGER;
  actual_count INTEGER;
BEGIN
  affected_set_id := CASE
    WHEN TG_TABLE_NAME = 'knowledge_embedding_sets' THEN NEW."id"
    ELSE NEW."embeddingSetId"
  END;
  SELECT "embeddingCount" INTO expected_count
  FROM "knowledge_embedding_sets" WHERE "id" = affected_set_id;
  SELECT count(*) INTO actual_count
  FROM "knowledge_embeddings" WHERE "embeddingSetId" = affected_set_id;
  IF expected_count IS DISTINCT FROM actual_count THEN
    RAISE EXCEPTION 'embedding count does not match persisted vectors';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER verify_knowledge_embedding_set_count
AFTER INSERT ON "knowledge_embedding_sets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_knowledge_embedding_count();

CREATE CONSTRAINT TRIGGER verify_knowledge_embedding_count_after_insert
AFTER INSERT ON "knowledge_embeddings"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_knowledge_embedding_count();
