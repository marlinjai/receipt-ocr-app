-- Who bears a receipt's cost, decided by a model that learns the person (plan
-- docs/plans/2026-11-07-learned-assignment.md). One new table for the decisions, keyed to
-- the receipt facts they were taken on; and a freetext statement may name no single
-- assignment ("Amazon is mixed"), so its column takes null. Nothing existing changes value.
CREATE TABLE "receipt_assignment_decisions" (
    "row_id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "fingerprint" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "assignment" TEXT,
    "confidence" DOUBLE PRECISION,
    "reason" TEXT,
    "model" TEXT,
    "facts" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_as" TEXT,
    "answered_at" TIMESTAMP(3),

    CONSTRAINT "receipt_assignment_decisions_pkey" PRIMARY KEY ("row_id")
);

CREATE INDEX "receipt_assignment_decisions_auth_workspace_id_outcome_idx" ON "receipt_assignment_decisions"("auth_workspace_id", "outcome");

ALTER TABLE "classification_rules" ALTER COLUMN "zuordnung" DROP NOT NULL;
