-- Workspace-scoped Markdown knowledge documents.
CREATE TYPE "KnowledgeDocumentStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

CREATE TABLE "knowledge_documents" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "authorUserId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" "KnowledgeDocumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "archivedAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "knowledge_documents_workspaceId_slug_key"
    ON "knowledge_documents"("workspaceId", "slug");
CREATE INDEX "knowledge_documents_workspaceId_status_updatedAt_idx"
    ON "knowledge_documents"("workspaceId", "status", "updatedAt");
CREATE INDEX "knowledge_documents_authorUserId_createdAt_idx"
    ON "knowledge_documents"("authorUserId", "createdAt");

ALTER TABLE "knowledge_documents"
    ADD CONSTRAINT "knowledge_documents_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "knowledge_documents"
    ADD CONSTRAINT "knowledge_documents_authorUserId_fkey"
    FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "prevent_knowledge_document_workspace_reassignment"()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."workspaceId" <> OLD."workspaceId" THEN
        RAISE EXCEPTION 'Knowledge document workspaceId cannot be reassigned';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "knowledge_documents_workspace_immutable"
BEFORE UPDATE ON "knowledge_documents"
FOR EACH ROW EXECUTE FUNCTION "prevent_knowledge_document_workspace_reassignment"();
