-- The year-change list answered by filed years and rules (plan docs/plans/2026-10-23-year-boundary-by-rule.md).
-- Additive: one nullable column. The day the income tax return of a year was filed, as an ISO day
-- ("2026-10-17"), null while the year is open. Which company filed which year is entered through
-- the income-tax tab, never written here: no company's facts go into schema history.
ALTER TABLE "tax_year_settings" ADD COLUMN "filed_on" TEXT;
