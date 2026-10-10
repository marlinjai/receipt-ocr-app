-- The hash of the register files of an export, so an erasure can tell whether the
-- company's export still equals the register. Null on older exports, which then
-- never count as covering the printed guest names.
ALTER TABLE "company_exports" ADD COLUMN "register_sha256" TEXT;
