CREATE TYPE "AiRunCostEvidenceSource" AS ENUM (
  'PROVIDER_USAGE_RECEIPT',
  'PROVIDER_BILLING_EXPORT',
  'INTERNAL_RECONCILIATION'
);

CREATE TABLE "ai_run_cost_evidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "runId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "source" "AiRunCostEvidenceSource" NOT NULL,
  "providerKey" VARCHAR(128) NOT NULL,
  "sourceReference" VARCHAR(512) NOT NULL,
  "costUsd" NUMERIC(65, 12) NOT NULL,
  "observedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_run_cost_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_run_cost_evidence_source_provider_reference_key"
    UNIQUE ("source", "providerKey", "sourceReference"),
  CONSTRAINT "ai_run_cost_evidence_cost_nonnegative_check" CHECK ("costUsd" >= 0),
  CONSTRAINT "ai_run_cost_evidence_provider_key_check"
    CHECK ("providerKey" ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  CONSTRAINT "ai_run_cost_evidence_source_reference_check"
    CHECK (
      char_length("sourceReference") BETWEEN 1 AND 512
      AND "sourceReference" = btrim("sourceReference")
    ),
  CONSTRAINT "ai_run_cost_evidence_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ai_run_cost_evidence_run_workspace_fkey"
    FOREIGN KEY ("runId", "workspaceId") REFERENCES "ai_runs"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "ai_run_cost_evidence_runId_createdAt_idx"
  ON "ai_run_cost_evidence"("runId", "createdAt");
CREATE INDEX "ai_run_cost_evidence_workspaceId_createdAt_idx"
  ON "ai_run_cost_evidence"("workspaceId", "createdAt");

CREATE FUNCTION protect_ai_run_cost_evidence() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'AI run cost evidence is append-only';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "ai_runs" run
    WHERE run."id" = NEW."runId"
      AND run."workspaceId" = NEW."workspaceId"
      AND run."providerKey" = NEW."providerKey"
  ) THEN
    RAISE EXCEPTION 'AI run cost evidence provider provenance does not match its run';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "protect_ai_run_cost_evidence_append_only"
BEFORE INSERT OR UPDATE OR DELETE ON "ai_run_cost_evidence"
FOR EACH ROW EXECUTE FUNCTION protect_ai_run_cost_evidence();
