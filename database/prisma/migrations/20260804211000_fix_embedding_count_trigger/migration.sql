-- A trigger shared by the embedding-set and embedding-row tables must not
-- reference a field that is absent from the current trigger record. PL/pgSQL
-- resolves the CASE expression against the record shape before branch use, so
-- select the table-specific field in an explicit control-flow branch.
CREATE OR REPLACE FUNCTION verify_knowledge_embedding_count() RETURNS trigger AS $$
DECLARE
  affected_set_id UUID;
  expected_count INTEGER;
  actual_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'knowledge_embedding_sets' THEN
    affected_set_id := NEW."id";
  ELSE
    affected_set_id := NEW."embeddingSetId";
  END IF;

  SELECT "embeddingCount" INTO expected_count
  FROM "knowledge_embedding_sets" WHERE "id" = affected_set_id;
  SELECT count(*) INTO actual_count
  FROM "knowledge_embeddings" WHERE "embeddingSetId" = affected_set_id;
  IF expected_count IS DISTINCT FROM actual_count THEN
    RAISE EXCEPTION 'embedding count does not match persisted vectors';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
