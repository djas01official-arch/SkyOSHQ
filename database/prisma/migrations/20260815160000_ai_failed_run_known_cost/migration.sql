ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_terminal_usage_check";

ALTER TABLE "ai_runs"
  ADD CONSTRAINT "ai_runs_terminal_usage_check" CHECK (
    "status" = 'SUCCEEDED' OR
    ("inputTokens" IS NULL AND "cacheWriteInputTokens" IS NULL AND
     "cacheWrite1HourInputTokens" IS NULL AND "cachedInputTokens" IS NULL AND
     "outputTokens" IS NULL AND "reasoningTokens" IS NULL AND
     "totalTokens" IS NULL AND "estimatedCostUsd" IS NULL) OR
    ("status" = 'FAILED' AND "inputTokens" IS NOT NULL AND
     "outputTokens" IS NOT NULL AND "totalTokens" IS NOT NULL AND
     "estimatedCostUsd" IS NOT NULL)
  );
