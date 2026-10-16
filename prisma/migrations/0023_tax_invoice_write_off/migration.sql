-- The part of an issued invoice that will never be paid and is booked out
-- instead of staying open: a transfer fee the client deducted, or a remainder a
-- person settles as not collectable. It ends the open claim on its day; it is
-- never income (cash basis). Additive: two columns, existing rows read 0 and
-- no day, which is what they meant before.
ALTER TABLE "tax_issued_invoices" ADD COLUMN "written_off_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tax_issued_invoices" ADD COLUMN "written_off_on" TEXT;
