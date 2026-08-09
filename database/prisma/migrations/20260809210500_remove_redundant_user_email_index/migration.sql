-- The unique users_email_key B-tree already supports email lookups.
-- Removing this exact duplicate avoids redundant write and storage cost.
DROP INDEX IF EXISTS "users_email_idx";
