-- PostgreSQL full-text index for active, workspace-scoped Knowledge search.
ALTER TABLE "knowledge_documents"
    ADD COLUMN "searchVector" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
        setweight(to_tsvector('simple', coalesce("content", '')), 'B')
    ) STORED;

CREATE INDEX "knowledge_documents_active_search_idx"
    ON "knowledge_documents" USING GIN ("searchVector")
    WHERE "status" = 'ACTIVE';
