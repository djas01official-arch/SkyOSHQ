CREATE OR REPLACE FUNCTION verify_knowledge_chunk_count() RETURNS trigger AS $$
DECLARE
  expected_count INTEGER;
  actual_count INTEGER;
BEGIN
  SELECT "chunkCount" INTO expected_count
  FROM "knowledge_chunk_sets"
  WHERE "id" = NEW."chunkSetId";
  SELECT count(*) INTO actual_count
  FROM "knowledge_chunks"
  WHERE "chunkSetId" = NEW."chunkSetId";
  IF expected_count IS DISTINCT FROM actual_count THEN
    RAISE EXCEPTION 'knowledge chunk count does not match persisted chunks';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION verify_knowledge_chunk_set_count() RETURNS trigger AS $$
DECLARE
  actual_count INTEGER;
BEGIN
  SELECT count(*) INTO actual_count
  FROM "knowledge_chunks"
  WHERE "chunkSetId" = NEW."id";
  IF NEW."chunkCount" IS DISTINCT FROM actual_count THEN
    RAISE EXCEPTION 'knowledge chunk count does not match persisted chunks';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER verify_knowledge_chunk_set_count ON "knowledge_chunk_sets";
CREATE CONSTRAINT TRIGGER verify_knowledge_chunk_set_count
AFTER INSERT ON "knowledge_chunk_sets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_knowledge_chunk_set_count();
