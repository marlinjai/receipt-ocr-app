-- PayPal live through the bank interface (plan 2026-10-23-paypal-live). Additive only.

-- The payment service an import of the bank interface holds ('paypal'), else NULL.
ALTER TABLE "tax_import_batches" ADD COLUMN "service" TEXT;

-- A movement in another currency: the source's amount and currency, and whether the euro amount is an estimate.
ALTER TABLE "tax_payments" ADD COLUMN "original_amount_cents" INTEGER;
ALTER TABLE "tax_payments" ADD COLUMN "original_currency" TEXT;
ALTER TABLE "tax_payments" ADD COLUMN "amount_estimated" BOOLEAN NOT NULL DEFAULT false;

-- Days of an import's range on which it knowingly lacks a movement (no rate, or unreadable).
ALTER TABLE "tax_import_batches" ADD COLUMN "partial_days" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- PayPal's list: the code of the purchase a currency conversion belongs to. Not part of the identity.
ALTER TABLE "tax_payments" ADD COLUMN "related_reference" TEXT;
