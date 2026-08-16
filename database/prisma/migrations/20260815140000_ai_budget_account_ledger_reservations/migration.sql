CREATE TYPE "AiBudgetLedgerEntryType" AS ENUM ('CREDIT', 'DEBIT');
CREATE TYPE "AiBudgetReservationStatus" AS ENUM ('RESERVED', 'SETTLED', 'RELEASED');

CREATE TABLE "ai_budget_accounts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_budget_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_budget_accounts_workspaceId_key" UNIQUE ("workspaceId"),
  CONSTRAINT "ai_budget_accounts_id_workspaceId_key" UNIQUE ("id", "workspaceId"),
  CONSTRAINT "ai_budget_accounts_workspaceId_fkey" FOREIGN KEY ("workspaceId")
    REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE "ai_budget_reservations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "accountId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "routingDecisionId" UUID,
  "idempotencyKey" TEXT NOT NULL,
  "reservedAmountUsd" NUMERIC(65,12) NOT NULL,
  "status" "AiBudgetReservationStatus" NOT NULL DEFAULT 'RESERVED',
  "settledAmountUsd" NUMERIC(65,12),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMPTZ(6),
  "releasedAt" TIMESTAMPTZ(6),
  CONSTRAINT "ai_budget_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_budget_reservations_routingDecisionId_key" UNIQUE ("routingDecisionId"),
  CONSTRAINT "ai_budget_reservation_routing_scope_key"
    UNIQUE ("routingDecisionId", "workspaceId"),
  CONSTRAINT "ai_budget_reservations_id_accountId_workspaceId_key"
    UNIQUE ("id", "accountId", "workspaceId"),
  CONSTRAINT "ai_budget_reservations_accountId_idempotencyKey_key"
    UNIQUE ("accountId", "idempotencyKey"),
  CONSTRAINT "ai_budget_reservations_amount_check"
    CHECK ("reservedAmountUsd" >= 0 AND ("settledAmountUsd" IS NULL OR "settledAmountUsd" >= 0)),
  CONSTRAINT "ai_budget_reservations_idempotency_key_check"
    CHECK (char_length("idempotencyKey") BETWEEN 1 AND 200),
  CONSTRAINT "ai_budget_reservations_state_check" CHECK (
    ("status" = 'RESERVED' AND "settledAmountUsd" IS NULL AND "settledAt" IS NULL AND "releasedAt" IS NULL)
    OR
    ("status" = 'SETTLED' AND "settledAmountUsd" IS NOT NULL AND "settledAmountUsd" <= "reservedAmountUsd"
      AND "settledAt" IS NOT NULL AND "releasedAt" IS NULL)
    OR
    ("status" = 'RELEASED' AND "settledAmountUsd" IS NULL AND "settledAt" IS NULL
      AND "releasedAt" IS NOT NULL)
  ),
  CONSTRAINT "ai_budget_reservations_account_workspace_fkey"
    FOREIGN KEY ("accountId", "workspaceId") REFERENCES "ai_budget_accounts"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ai_budget_reservations_workspaceId_fkey" FOREIGN KEY ("workspaceId")
    REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "ai_routing_decisions_id_workspaceId_key"
  ON "ai_routing_decisions"("id", "workspaceId");

ALTER TABLE "ai_budget_reservations"
  ADD CONSTRAINT "ai_budget_reservations_routing_decision_workspace_fkey"
  FOREIGN KEY ("routingDecisionId", "workspaceId")
  REFERENCES "ai_routing_decisions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "ai_budget_ledger_entries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "accountId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "reservationId" UUID,
  "type" "AiBudgetLedgerEntryType" NOT NULL,
  "amountUsd" NUMERIC(65,12) NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_budget_ledger_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_budget_ledger_entries_reservationId_key" UNIQUE ("reservationId"),
  CONSTRAINT "ai_budget_ledger_reservation_scope_key"
    UNIQUE ("reservationId", "accountId", "workspaceId"),
  CONSTRAINT "ai_budget_ledger_entries_accountId_idempotencyKey_key"
    UNIQUE ("accountId", "idempotencyKey"),
  CONSTRAINT "ai_budget_ledger_entries_amount_check" CHECK ("amountUsd" >= 0),
  CONSTRAINT "ai_budget_ledger_entries_idempotency_key_check"
    CHECK (char_length("idempotencyKey") BETWEEN 1 AND 200),
  CONSTRAINT "ai_budget_ledger_entries_type_reservation_check" CHECK (
    ("type" = 'CREDIT' AND "reservationId" IS NULL)
    OR ("type" = 'DEBIT' AND "reservationId" IS NOT NULL)
  ),
  CONSTRAINT "ai_budget_ledger_entries_account_workspace_fkey"
    FOREIGN KEY ("accountId", "workspaceId") REFERENCES "ai_budget_accounts"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ai_budget_ledger_entries_workspaceId_fkey" FOREIGN KEY ("workspaceId")
    REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ai_budget_ledger_entries_reservation_account_workspace_fkey"
    FOREIGN KEY ("reservationId", "accountId", "workspaceId")
    REFERENCES "ai_budget_reservations"("id", "accountId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "ai_budget_ledger_entries_workspaceId_createdAt_idx"
  ON "ai_budget_ledger_entries"("workspaceId", "createdAt");
CREATE INDEX "ai_budget_ledger_entries_accountId_type_createdAt_idx"
  ON "ai_budget_ledger_entries"("accountId", "type", "createdAt");
CREATE INDEX "ai_budget_reservations_workspaceId_status_createdAt_idx"
  ON "ai_budget_reservations"("workspaceId", "status", "createdAt");
CREATE INDEX "ai_budget_reservations_active_idx"
  ON "ai_budget_reservations"("accountId", "createdAt") WHERE "status" = 'RESERVED';

CREATE FUNCTION protect_ai_budget_account() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AI budget accounts cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ai_budget_accounts_immutable"
BEFORE UPDATE OR DELETE ON "ai_budget_accounts"
FOR EACH ROW EXECUTE FUNCTION protect_ai_budget_account();

CREATE FUNCTION protect_ai_budget_ledger_entry() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AI budget ledger entries are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ai_budget_ledger_entries_append_only"
BEFORE UPDATE OR DELETE ON "ai_budget_ledger_entries"
FOR EACH ROW EXECUTE FUNCTION protect_ai_budget_ledger_entry();

CREATE FUNCTION protect_ai_budget_reservation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AI budget reservations cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'RESERVED' OR NEW."settledAmountUsd" IS NOT NULL
      OR NEW."settledAt" IS NOT NULL OR NEW."releasedAt" IS NOT NULL THEN
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
  IF OLD."status" <> 'RESERVED' OR NEW."status" NOT IN ('SETTLED', 'RELEASED') THEN
    RAISE EXCEPTION 'Invalid AI budget reservation lifecycle transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ai_budget_reservations_controlled_lifecycle"
BEFORE INSERT OR UPDATE OR DELETE ON "ai_budget_reservations"
FOR EACH ROW EXECUTE FUNCTION protect_ai_budget_reservation();

CREATE FUNCTION verify_ai_budget_settlement() RETURNS trigger AS $$
DECLARE
  reservation "ai_budget_reservations"%ROWTYPE;
  debit "ai_budget_ledger_entries"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'ai_budget_ledger_entries' THEN
    IF NEW."type" <> 'DEBIT' THEN RETURN NULL; END IF;
    SELECT * INTO reservation FROM "ai_budget_reservations" WHERE "id" = NEW."reservationId";
    IF reservation."status" <> 'SETTLED' OR reservation."settledAmountUsd" <> NEW."amountUsd" THEN
      RAISE EXCEPTION 'AI budget settlement debit must match a settled reservation';
    END IF;
  ELSE
    IF NEW."status" <> 'SETTLED' THEN RETURN NULL; END IF;
    SELECT * INTO debit FROM "ai_budget_ledger_entries" WHERE "reservationId" = NEW."id";
    IF debit."id" IS NULL OR debit."type" <> 'DEBIT' OR debit."amountUsd" <> NEW."settledAmountUsd" THEN
      RAISE EXCEPTION 'Settled AI budget reservation requires one matching debit';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ai_budget_ledger_settlement_consistent"
AFTER INSERT ON "ai_budget_ledger_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_ai_budget_settlement();

CREATE CONSTRAINT TRIGGER "ai_budget_reservation_settlement_consistent"
AFTER UPDATE ON "ai_budget_reservations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_ai_budget_settlement();
