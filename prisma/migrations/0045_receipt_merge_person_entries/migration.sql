-- A duplicate merge now also moves the archived receipt's meal guests and tax decision to the kept
-- receipt; the record keeps their ids so a restore moves them back. Additive.
ALTER TABLE "receipt_merges" ADD COLUMN "moved_meal_guest_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "receipt_merges" ADD COLUMN "moved_tax_decision_id" TEXT;
