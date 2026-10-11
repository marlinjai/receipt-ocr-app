-- A purchase that a later import of the pay-later list shows as cancelled or
-- refunded in full is kept and marked, not deleted: the mark names the import
-- that said so, and undoing that import clears it (ON DELETE SET NULL), so the
-- payment and its links count again. Additive: one nullable column, no row is
-- rewritten and no link is touched.
ALTER TABLE "tax_payments" ADD COLUMN "cancelled_by_batch_id" TEXT;

ALTER TABLE "tax_payments" ADD CONSTRAINT "tax_payments_cancelled_by_batch_id_fkey" FOREIGN KEY ("cancelled_by_batch_id") REFERENCES "tax_import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
