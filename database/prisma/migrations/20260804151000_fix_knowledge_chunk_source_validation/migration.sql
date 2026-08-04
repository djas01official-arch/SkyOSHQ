CREATE OR REPLACE FUNCTION validate_knowledge_chunk_source() RETURNS trigger AS $$
DECLARE
  matched BOOLEAN;
BEGIN
  IF NEW."sourceType" = 'MARKDOWN_DOCUMENT' THEN
    SELECT TRUE INTO matched
    FROM "knowledge_document_versions" version
    JOIN "knowledge_documents" document ON document."id" = version."documentId"
    WHERE version."id" = NEW."documentVersionId"
      AND document."id" = NEW."sourceId"
      AND document."workspaceId" = NEW."workspaceId"
      AND version."versionNumber" = NEW."sourceVersion";
  ELSE
    SELECT TRUE INTO matched
    FROM "knowledge_attachment_extractions" extraction
    WHERE extraction."id" = NEW."attachmentExtractionId"
      AND extraction."attachmentId" = NEW."sourceId"
      AND extraction."workspaceId" = NEW."workspaceId"
      AND extraction."extractionNumber" = NEW."sourceVersion";
  END IF;

  IF matched IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'knowledge chunk source identity does not match its immutable source version';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_knowledge_chunk_set_job() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "knowledge_chunking_jobs" job
    WHERE job."id" = NEW."createdByJobId"
      AND job."workspaceId" = NEW."workspaceId"
      AND job."sourceType" = NEW."sourceType"
      AND job."sourceId" = NEW."sourceId"
      AND job."sourceVersion" = NEW."sourceVersion"
      AND job."documentVersionId" IS NOT DISTINCT FROM NEW."documentVersionId"
      AND job."attachmentExtractionId" IS NOT DISTINCT FROM NEW."attachmentExtractionId"
      AND job."strategyKey" = NEW."strategyKey"
      AND job."strategyVersion" = NEW."strategyVersion"
      AND job."status" = 'PROCESSING'
  ) THEN
    RAISE EXCEPTION 'knowledge chunk set does not match its creating job';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_knowledge_chunk_set_job
BEFORE INSERT ON "knowledge_chunk_sets"
FOR EACH ROW EXECUTE FUNCTION validate_knowledge_chunk_set_job();
