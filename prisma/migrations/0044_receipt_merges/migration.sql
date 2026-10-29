-- The invoice number decides duplicates (plan docs/plans/2026-10-29-invoice-number-duplicates.md).
-- Additive: one new table and one new nullable column. receipt_merges records a receipt the app
-- archived as the same receipt as another one (same file, or same invoice number from the same
-- vendor), with what the merge changed so a restore undoes it; receipt_reviews.invoice_number_read_at
-- marks a receipt the invoice number backfill has looked at. The number itself is a text column of
-- each company's receipts table ("Rechnungsnummer"), added by ensureReceiptsTable.
CREATE TABLE "receipt_merges" (
    "row_id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "kept_row_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "invoice_number" TEXT,
    "moved_payment_link_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "added_file_ref_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "merged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_merges_pkey" PRIMARY KEY ("row_id")
);

CREATE INDEX "receipt_merges_auth_workspace_id_idx" ON "receipt_merges"("auth_workspace_id");
CREATE INDEX "receipt_merges_kept_row_id_idx" ON "receipt_merges"("kept_row_id");

ALTER TABLE "receipt_reviews" ADD COLUMN "invoice_number_read_at" TIMESTAMP(3);
