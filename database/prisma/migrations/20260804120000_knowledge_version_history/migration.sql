CREATE TABLE "knowledge_document_versions" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "markdownContent" TEXT NOT NULL,
    "authorUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_document_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "knowledge_document_versions_documentId_versionNumber_key"
ON "knowledge_document_versions"("documentId", "versionNumber");

CREATE INDEX "knowledge_document_versions_documentId_createdAt_idx"
ON "knowledge_document_versions"("documentId", "createdAt");

CREATE INDEX "knowledge_document_versions_authorUserId_createdAt_idx"
ON "knowledge_document_versions"("authorUserId", "createdAt");

ALTER TABLE "knowledge_document_versions"
ADD CONSTRAINT "knowledge_document_versions_documentId_fkey"
FOREIGN KEY ("documentId") REFERENCES "knowledge_documents"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "knowledge_document_versions"
ADD CONSTRAINT "knowledge_document_versions_authorUserId_fkey"
FOREIGN KEY ("authorUserId") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

INSERT INTO "knowledge_document_versions" (
    "id",
    "documentId",
    "versionNumber",
    "title",
    "markdownContent",
    "authorUserId",
    "createdAt"
)
SELECT
    gen_random_uuid(),
    "id",
    "version",
    "title",
    "content",
    "authorUserId",
    "updatedAt"
FROM "knowledge_documents";

CREATE FUNCTION prevent_knowledge_document_version_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'knowledge document versions are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_knowledge_document_version_update
BEFORE UPDATE ON "knowledge_document_versions"
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_document_version_mutation();

CREATE TRIGGER prevent_knowledge_document_version_delete
BEFORE DELETE ON "knowledge_document_versions"
FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_document_version_mutation();
