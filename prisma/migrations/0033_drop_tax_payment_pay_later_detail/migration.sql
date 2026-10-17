-- The two columns of 0030 served a rule that was taken back on 2026-10-17:
-- every pay-later purchase counts on its purchase day, so nothing reads how a
-- purchase was paid or a person's correction of it. Dropped with the owner's
-- yes of 2026-10-17; what was written into them since 0030 is not needed.
ALTER TABLE "tax_payments" DROP COLUMN "source_detail";
ALTER TABLE "tax_payments" DROP COLUMN "pay_method_override";
