ALTER TABLE "ai_runs"
  ADD COLUMN "cacheWriteInputTokens" integer,
  ADD COLUMN "cachedInputTokens" integer,
  ADD COLUMN "totalTokens" integer,
  ADD COLUMN "providerRequestId" text,
  ADD COLUMN "estimatedCostUsd" numeric(20, 12);

ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_usage_check";

ALTER TABLE "ai_runs"
  ADD CONSTRAINT "ai_runs_usage_check" CHECK (
    ("inputTokens" IS NULL OR "inputTokens" >= 0) AND
    ("cacheWriteInputTokens" IS NULL OR
      ("inputTokens" IS NOT NULL AND "cacheWriteInputTokens" BETWEEN 0 AND "inputTokens")) AND
    ("cachedInputTokens" IS NULL OR
      ("inputTokens" IS NOT NULL AND "cachedInputTokens" BETWEEN 0 AND "inputTokens")) AND
    (COALESCE("cacheWriteInputTokens", 0) + COALESCE("cachedInputTokens", 0) <=
      COALESCE("inputTokens", 0)) AND
    ("outputTokens" IS NULL OR "outputTokens" >= 0) AND
    ("totalTokens" IS NULL OR
      ("inputTokens" IS NOT NULL AND "outputTokens" IS NOT NULL AND
       "totalTokens" = "inputTokens" + "outputTokens")) AND
    ("estimatedCostUsd" IS NULL OR
      ("inputTokens" IS NOT NULL AND "outputTokens" IS NOT NULL AND "estimatedCostUsd" >= 0)) AND
    ("durationMs" IS NULL OR "durationMs" >= 0)
  ),
  ADD CONSTRAINT "ai_runs_provider_request_id_check" CHECK (
    "providerRequestId" IS NULL OR
    "providerRequestId" ~ '^[A-Za-z0-9._:-]{1,200}$'
  ),
  ADD CONSTRAINT "ai_runs_terminal_usage_check" CHECK (
    "status" = 'SUCCEEDED' OR
    ("inputTokens" IS NULL AND "cacheWriteInputTokens" IS NULL AND
     "cachedInputTokens" IS NULL AND "outputTokens" IS NULL AND "totalTokens" IS NULL AND
     "estimatedCostUsd" IS NULL)
  );
