-- An issued invoice with more than one value-added tax rate keeps one group per rate,
-- so the advance return can report each rate on its own. Additive and nullable:
-- invoices at one rate keep deriving their single group from treatment, total and tax.
ALTER TABLE "tax_issued_invoices" ADD COLUMN "tax_groups" JSONB;
