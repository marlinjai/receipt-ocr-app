-- The total the reader read when it recorded its doubts about a receipt, in
-- cents of the receipt's currency. A stored total that differs from it was
-- corrected since, and its "Betrag prüfen" doubt ends. Additive: one nullable
-- column; rows recorded before it stay without, and their doubts stand.
ALTER TABLE "receipt_reviews" ADD COLUMN "read_gross_cents" INTEGER;
