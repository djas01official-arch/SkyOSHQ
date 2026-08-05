ALTER TABLE "ai_runs"
ADD COLUMN "referencedCitationIds" text[] NOT NULL DEFAULT ARRAY[]::text[];
