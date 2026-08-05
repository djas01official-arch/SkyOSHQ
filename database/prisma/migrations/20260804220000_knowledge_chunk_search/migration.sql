ALTER TABLE "knowledge_chunks"
ADD COLUMN "searchVector" tsvector
GENERATED ALWAYS AS (to_tsvector('simple', coalesce("text", ''))) STORED;

CREATE INDEX "knowledge_chunks_search_idx"
ON "knowledge_chunks" USING GIN ("searchVector");
