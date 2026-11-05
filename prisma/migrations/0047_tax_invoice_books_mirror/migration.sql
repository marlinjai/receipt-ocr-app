-- The read-only mirror of the invoices framer-clone's Books issue (invoicing plan, step 4).
-- Additive: every existing row stays a register row (entered here from its PDF), all new
-- columns are nullable or defaulted, and nothing existing is rewritten.
--   source               'register' (entered here) or 'books' (written only by the mirror)
--   books_document_id    the Books document (sales_document.id) the row mirrors
--   due_date             the due day the Books document states
--   cancelled_on         the day a credit note cancelled the invoice; no claim from then on
--   replaces_invoice_id  the invoice a corrected (replacement) invoice replaces
ALTER TABLE "tax_issued_invoices" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'register';
ALTER TABLE "tax_issued_invoices" ADD COLUMN "books_document_id" TEXT;
ALTER TABLE "tax_issued_invoices" ADD COLUMN "due_date" TEXT;
ALTER TABLE "tax_issued_invoices" ADD COLUMN "cancelled_on" TEXT;
ALTER TABLE "tax_issued_invoices" ADD COLUMN "replaces_invoice_id" TEXT;
CREATE UNIQUE INDEX "tax_issued_invoices_auth_workspace_id_books_document_id_key" ON "tax_issued_invoices"("auth_workspace_id", "books_document_id");
