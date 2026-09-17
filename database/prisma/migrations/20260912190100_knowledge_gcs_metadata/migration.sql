ALTER TABLE "knowledge_attachments"
ADD COLUMN "storageGeneration" VARCHAR(32),
ADD COLUMN "storageEtag" VARCHAR(256),
ADD COLUMN "storageCrc32c" VARCHAR(64);

ALTER TABLE "knowledge_attachments"
ADD CONSTRAINT "knowledge_attachments_storage_generation_format"
CHECK ("storageGeneration" IS NULL OR "storageGeneration" ~ '^[1-9][0-9]*$');

ALTER TABLE "knowledge_attachments"
ADD CONSTRAINT "knowledge_attachments_storage_crc32c_format"
CHECK ("storageCrc32c" IS NULL OR "storageCrc32c" ~ '^[A-Za-z0-9+/]{6}==$');

CREATE OR REPLACE FUNCTION prevent_knowledge_attachment_metadata_mutation() RETURNS trigger AS $$
BEGIN
  IF NEW."id" <> OLD."id"
     OR NEW."workspaceId" <> OLD."workspaceId"
     OR NEW."documentId" <> OLD."documentId"
     OR NEW."uploaderUserId" <> OLD."uploaderUserId"
     OR NEW."originalFilename" <> OLD."originalFilename"
     OR NEW."storageKey" <> OLD."storageKey"
     OR NEW."storageGeneration" IS DISTINCT FROM OLD."storageGeneration"
     OR NEW."storageEtag" IS DISTINCT FROM OLD."storageEtag"
     OR NEW."storageCrc32c" IS DISTINCT FROM OLD."storageCrc32c"
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
      (NEW."processingStatus" = 'QUEUED'
        AND OLD."processingStatus" IN ('UPLOADED', 'PROCESSED', 'READY', 'FAILED'))
      OR (OLD."processingStatus" = 'QUEUED'
        AND NEW."processingStatus" IN ('UPLOADED', 'PROCESSING', 'FAILED'))
      OR (OLD."processingStatus" = 'UPLOADED' AND NEW."processingStatus" = 'PROCESSING')
      OR (OLD."processingStatus" = 'PROCESSING'
        AND NEW."processingStatus" IN ('QUEUED', 'UPLOADED', 'PROCESSED', 'FAILED'))
      OR (OLD."processingStatus" = 'PROCESSED'
        AND NEW."processingStatus" IN ('CHUNKING', 'PROCESSING'))
      OR (OLD."processingStatus" = 'CHUNKING'
        AND NEW."processingStatus" IN ('EMBEDDING', 'FAILED'))
      OR (OLD."processingStatus" = 'EMBEDDING'
        AND NEW."processingStatus" IN ('READY', 'FAILED', 'CHUNKING'))
      OR (OLD."processingStatus" IN ('READY', 'FAILED')
        AND NEW."processingStatus" = 'EMBEDDING')
      OR (OLD."processingStatus" = 'READY' AND NEW."processingStatus" = 'PROCESSING')
      OR (OLD."processingStatus" = 'FAILED' AND NEW."processingStatus" = 'PROCESSING')
    ) THEN
      RAISE EXCEPTION 'invalid knowledge attachment processing transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
