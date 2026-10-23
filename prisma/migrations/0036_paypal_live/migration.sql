-- PayPal live through the bank interface (plan 2026-10-23-paypal-live). Additive only.

-- The payment service an import of the bank interface holds ('paypal'), else NULL.
ALTER TABLE "tax_import_batches" ADD COLUMN "service" TEXT;

-- A movement in another currency: the source's amount and currency, and whether the euro amount is an estimate.
ALTER TABLE "tax_payments" ADD COLUMN "original_amount_cents" INTEGER;
ALTER TABLE "tax_payments" ADD COLUMN "original_currency" TEXT;
ALTER TABLE "tax_payments" ADD COLUMN "amount_estimated" BOOLEAN NOT NULL DEFAULT false;
