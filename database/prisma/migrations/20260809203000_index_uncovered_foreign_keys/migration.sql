-- PostgreSQL does not create indexes for referencing foreign-key columns.
-- These non-destructive indexes cover the remaining single-column relations
-- that are not already the leading columns of another index.
CREATE INDEX "organizations_createdByUserId_idx" ON "organizations"("createdByUserId");
CREATE INDEX "workspaces_createdByUserId_idx" ON "workspaces"("createdByUserId");
CREATE INDEX "ai_run_citations_chunkSetId_idx" ON "ai_run_citations"("chunkSetId");
