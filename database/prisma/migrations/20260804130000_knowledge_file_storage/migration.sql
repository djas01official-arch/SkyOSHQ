CREATE TYPE "KnowledgeAttachmentStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

CREATE UNIQUE INDEX "knowledge_documents_id_workspaceId_key"
ON "knowledge_documents"("id", "workspaceId");

CREATE TABLE "knowledge_attachments" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "uploaderUserId" UUID NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256Checksum" CHAR(64) NOT NULL,
    "status" "KnowledgeAttachmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "archivedAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "knowledge_attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_attachments_size_positive" CHECK ("sizeBytes" > 0),
    CONSTRAINT "knowledge_attachments_version_positive" CHECK ("version" > 0),
    CONSTRAINT "knowledge_attachments_checksum_format" CHECK ("sha256Checksum" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "knowledge_attachments_mime_allowed" CHECK (
        "mimeType" IN (
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'image/png',
            'image/jpeg'
        )
    ),
    CONSTRAINT "knowledge_attachments_archive_state" CHECK (
        ("status" = 'ACTIVE' AND "archivedAt" IS NULL)
        OR ("status" = 'ARCHIVED' AND "archivedAt" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "knowledge_attachments_storageKey_key"
ON "knowledge_attachments"("storageKey");

CREATE UNIQUE INDEX "knowledge_attachments_active_document_checksum_key"
ON "knowledge_attachments"("documentId", "sha256Checksum")
WHERE "status" = 'ACTIVE';

CREATE INDEX "knowledge_attachments_documentId_status_createdAt_idx"
ON "knowledge_attachments"("documentId", "status", "createdAt");

CREATE INDEX "knowledge_attachments_workspaceId_status_idx"
ON "knowledge_attachments"("workspaceId", "status");

CREATE INDEX "knowledge_attachments_uploaderUserId_createdAt_idx"
ON "knowledge_attachments"("uploaderUserId", "createdAt");

ALTER TABLE "knowledge_attachments"
ADD CONSTRAINT "knowledge_attachments_document_workspace_fkey"
FOREIGN KEY ("documentId", "workspaceId")
REFERENCES "knowledge_documents"("id", "workspaceId")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "knowledge_attachments"
ADD CONSTRAINT "knowledge_attachments_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "knowledge_attachments"
ADD CONSTRAINT "knowledge_attachments_uploaderUserId_fkey"
FOREIGN KEY ("uploaderUserId") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION prevent_knowledge_attachment_metadata_mutation() RETURNS trigger AS $$
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

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'knowledge attachment lifecycle changes must increment version';
    END IF;
  ELSIF NEW."version" <> OLD."version" THEN
    RAISE EXCEPTION 'knowledge attachment version requires a lifecycle change';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_knowledge_attachment_metadata_update
BEFORE UPDATE ON "knowledge_attachments"
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_attachment_metadata_mutation();
