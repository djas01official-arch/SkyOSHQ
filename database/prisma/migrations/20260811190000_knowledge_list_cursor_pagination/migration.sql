-- Replace the bounded-list prefix index with the complete deterministic
-- keyset order used by active, workspace-scoped Knowledge pagination.
CREATE INDEX "knowledge_documents_list_page_idx"
ON "knowledge_documents"("workspaceId", "status", "updatedAt" DESC, "title", "id");

DROP INDEX "knowledge_documents_workspaceId_status_updatedAt_idx";
