-- Look-alike receipts settled without asking (plan docs/plans/2026-11-05-duplicates-without-asking.md).
-- Additive: one new table and five new nullable columns. receipt_pair_decisions records what the
-- look-alike pass decided about a pair (a number read again, or the model comparing both pages);
-- receipt_reviews marks a receipt whose number the pass read again and where it came from;
-- receipt_merges says what decided a merge and keeps the model's sentence.
CREATE TABLE "receipt_pair_decisions" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "row_id_a" TEXT NOT NULL,
    "row_id_b" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "decided_by" TEXT NOT NULL,
    "model" TEXT,
    "confidence" DOUBLE PRECISION,
    "reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_pair_decisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receipt_pair_decisions_row_id_a_row_id_b_key" ON "receipt_pair_decisions"("row_id_a", "row_id_b");
CREATE INDEX "receipt_pair_decisions_auth_workspace_id_idx" ON "receipt_pair_decisions"("auth_workspace_id");
CREATE INDEX "receipt_pair_decisions_row_id_b_idx" ON "receipt_pair_decisions"("row_id_b");

ALTER TABLE "receipt_reviews" ADD COLUMN "invoice_number_reread_at" TIMESTAMP(3);
ALTER TABLE "receipt_reviews" ADD COLUMN "invoice_number_source" TEXT;

ALTER TABLE "receipt_merges" ADD COLUMN "decided_by" TEXT;
ALTER TABLE "receipt_merges" ADD COLUMN "decision_note" TEXT;
ALTER TABLE "receipt_merges" ADD COLUMN "decision_model" TEXT;
