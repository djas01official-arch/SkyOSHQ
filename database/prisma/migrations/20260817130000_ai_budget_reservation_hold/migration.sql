ALTER TYPE "AiBudgetReservationStatus" ADD VALUE 'HELD';

CREATE TYPE "AiBudgetReservationHoldReason" AS ENUM (
  'UNKNOWN_PROVIDER_COST',
  'ACTUAL_COST_OVERRUN',
  'ACCOUNTING_UNRESOLVED'
);

ALTER TABLE "ai_budget_reservations"
  ADD COLUMN "holdReason" "AiBudgetReservationHoldReason",
  ADD COLUMN "heldAt" TIMESTAMPTZ(6);

ALTER TABLE "ai_budget_reservations"
  DROP CONSTRAINT "ai_budget_reservations_state_check",
  ADD CONSTRAINT "ai_budget_reservations_state_check" CHECK (
    (
      "status" = 'RESERVED'
      AND "holdReason" IS NULL
      AND "heldAt" IS NULL
      AND "settledAmountUsd" IS NULL
      AND "settledAt" IS NULL
      AND "releasedAt" IS NULL
    )
    OR
    (
      "status" = 'HELD'
      AND "holdReason" IS NOT NULL
      AND "heldAt" IS NOT NULL
      AND "settledAmountUsd" IS NULL
      AND "settledAt" IS NULL
      AND "releasedAt" IS NULL
    )
    OR
    (
      "status" = 'SETTLED'
      AND "settledAmountUsd" IS NOT NULL
      AND "settledAmountUsd" <= "reservedAmountUsd"
      AND "settledAt" IS NOT NULL
      AND "releasedAt" IS NULL
      AND (("holdReason" IS NULL AND "heldAt" IS NULL) OR ("holdReason" IS NOT NULL AND "heldAt" IS NOT NULL))
    )
    OR
    (
      "status" = 'RELEASED'
      AND "settledAmountUsd" IS NULL
      AND "settledAt" IS NULL
      AND "releasedAt" IS NOT NULL
      AND (("holdReason" IS NULL AND "heldAt" IS NULL) OR ("holdReason" IS NOT NULL AND "heldAt" IS NOT NULL))
    )
  );

DROP INDEX "ai_budget_reservations_active_idx";
CREATE INDEX "ai_budget_reservations_active_idx"
  ON "ai_budget_reservations"("accountId", "createdAt")
  WHERE "status" IN ('RESERVED', 'HELD');

CREATE OR REPLACE FUNCTION protect_ai_budget_reservation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AI budget reservations cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'RESERVED'
      OR NEW."holdReason" IS NOT NULL
      OR NEW."heldAt" IS NOT NULL
      OR NEW."settledAmountUsd" IS NOT NULL
      OR NEW."settledAt" IS NOT NULL
      OR NEW."releasedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'AI budget reservations must begin in RESERVED status';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."accountId" <> NEW."accountId"
    OR OLD."workspaceId" <> NEW."workspaceId"
    OR OLD."routingDecisionId" IS DISTINCT FROM NEW."routingDecisionId"
    OR OLD."idempotencyKey" <> NEW."idempotencyKey"
    OR OLD."reservedAmountUsd" <> NEW."reservedAmountUsd"
    OR OLD."createdAt" <> NEW."createdAt" THEN
    RAISE EXCEPTION 'AI budget reservation financial identity is immutable';
  END IF;

  IF OLD."holdReason" IS NOT NULL AND NEW."holdReason" IS DISTINCT FROM OLD."holdReason" THEN
    RAISE EXCEPTION 'AI budget reservation hold reason is immutable';
  END IF;
  IF OLD."heldAt" IS NOT NULL AND NEW."heldAt" IS DISTINCT FROM OLD."heldAt" THEN
    RAISE EXCEPTION 'AI budget reservation hold timestamp is immutable';
  END IF;

  IF OLD."status" = 'RESERVED' AND NEW."status" = 'HELD'
    AND NEW."holdReason" IS NOT NULL AND NEW."heldAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'RESERVED' AND NEW."status" IN ('SETTLED', 'RELEASED')
    AND NEW."holdReason" IS NULL AND NEW."heldAt" IS NULL THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'HELD' AND NEW."status" IN ('SETTLED', 'RELEASED')
    AND NEW."holdReason" = OLD."holdReason" AND NEW."heldAt" = OLD."heldAt" THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid AI budget reservation lifecycle transition';
END;
$$ LANGUAGE plpgsql;
