CREATE FUNCTION verify_knowledge_document_current_version() RETURNS trigger AS $$
DECLARE
  latest_version INTEGER;
  latest_title TEXT;
  latest_content TEXT;
BEGIN
  SELECT "versionNumber", "title", "markdownContent"
  INTO latest_version, latest_title, latest_content
  FROM "knowledge_document_versions"
  WHERE "documentId" = NEW."id"
  ORDER BY "versionNumber" DESC
  LIMIT 1;

  IF latest_version IS NULL
     OR latest_version <> NEW."version"
     OR latest_title IS DISTINCT FROM NEW."title"
     OR latest_content IS DISTINCT FROM NEW."content" THEN
    RAISE EXCEPTION 'knowledge document must match its latest immutable version';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER verify_knowledge_document_current_version
AFTER INSERT OR UPDATE ON "knowledge_documents"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_knowledge_document_current_version();

CREATE FUNCTION verify_knowledge_document_version_append() RETURNS trigger AS $$
DECLARE
  current_version INTEGER;
  latest_version INTEGER;
BEGIN
  SELECT "version" INTO current_version
  FROM "knowledge_documents"
  WHERE "id" = NEW."documentId";

  SELECT MAX("versionNumber") INTO latest_version
  FROM "knowledge_document_versions"
  WHERE "documentId" = NEW."documentId";

  IF current_version IS NULL OR latest_version <> current_version THEN
    RAISE EXCEPTION 'appended version must be the current document version';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER verify_knowledge_document_version_append
AFTER INSERT ON "knowledge_document_versions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_knowledge_document_version_append();
