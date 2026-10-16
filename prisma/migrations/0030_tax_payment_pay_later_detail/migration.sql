-- How a purchase of the pay-later list was paid, so the day it counts on can
-- be worked out (card and financed purchases on the purchase day, checkout
-- purchases paid later on the day of the collection that settles them).
-- `source_detail` keeps what the list says (payment method wording, whether a
-- card is marked, the statement number); NULL for every other source and for
-- rows imported before this column existed, until the list is read again.
-- `pay_method_override` is a person's correction of one purchase ('card' or
-- 'checkout'), kept apart from `kind_override` because a purchase can be both
-- re-labelled (private, a transfer) and paid by card. Additive: two nullable
-- columns, no row is rewritten.
ALTER TABLE "tax_payments" ADD COLUMN "source_detail" JSONB;
ALTER TABLE "tax_payments" ADD COLUMN "pay_method_override" TEXT;
