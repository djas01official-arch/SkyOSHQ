CREATE TYPE "AiProviderExecutionReferenceType" AS ENUM (
  'REQUEST_ID'
);

CREATE TABLE "ai_run_provider_execution_references" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "runId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "providerKey" VARCHAR(128) NOT NULL,
  "referenceType" "AiProviderExecutionReferenceType" NOT NULL,
  "referenceValue" VARCHAR(200) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_run_provider_execution_references_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_run_provider_execution_reference_identity_key"
    UNIQUE ("providerKey", "referenceType", "referenceValue"),
  CONSTRAINT "ai_run_provider_execution_reference_provider_key_check"
    CHECK ("providerKey" ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  CONSTRAINT "ai_run_provider_execution_reference_value_check"
    CHECK (
      char_length("referenceValue") BETWEEN 1 AND 200
      AND "referenceValue" = btrim("referenceValue")
      AND "referenceValue" ~ '^[A-Za-z0-9._:-]+$'
    ),
  CONSTRAINT "ai_run_provider_execution_references_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ai_run_provider_execution_references_run_workspace_fkey"
    FOREIGN KEY ("runId", "workspaceId") REFERENCES "ai_runs"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "ai_run_provider_execution_references_runId_createdAt_idx"
  ON "ai_run_provider_execution_references"("runId", "createdAt");
CREATE INDEX "ai_run_provider_execution_references_workspaceId_createdAt_idx"
  ON "ai_run_provider_execution_references"("workspaceId", "createdAt");

CREATE FUNCTION protect_ai_run_provider_execution_reference() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'AI run provider execution references are append-only';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "ai_runs" run
    WHERE run."id" = NEW."runId"
      AND run."workspaceId" = NEW."workspaceId"
      AND run."providerKey" = NEW."providerKey"
      AND run."providerRequestId" = NEW."referenceValue"
  ) THEN
    RAISE EXCEPTION 'AI run provider execution reference does not match its run';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "protect_ai_run_provider_execution_references_append_only"
BEFORE INSERT OR UPDATE OR DELETE ON "ai_run_provider_execution_references"
FOR EACH ROW EXECUTE FUNCTION protect_ai_run_provider_execution_reference();
