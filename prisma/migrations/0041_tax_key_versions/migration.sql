-- The filed return decides the counterparties (plan docs/plans/2026-10-25-filed-year-decides-counterparties.md).
-- Additive: one new table. A row says up to which version a stored key was carried over after the way the app
-- makes it changed (`counterparty_key`: the merchant key of payments and counterparty answers). The carrying
-- itself runs in the app (src/lib/tax/payments/rekey.ts), once, before any key is read or written.
CREATE TABLE "tax_key_versions" (
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_key_versions_pkey" PRIMARY KEY ("name")
);
