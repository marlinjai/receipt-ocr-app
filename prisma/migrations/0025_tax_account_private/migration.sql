-- The owner can say that a whole account is private: its payments are not
-- asked about. Additive: one column with a default, no row is rewritten.
ALTER TABLE "tax_accounts" ADD COLUMN "is_private" BOOLEAN NOT NULL DEFAULT false;
