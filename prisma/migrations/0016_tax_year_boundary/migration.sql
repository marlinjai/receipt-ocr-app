-- The ten-day rule at the turn of the year (section 11 of the income tax act):
-- a regularly recurring payment made between 22 December and 10 January counts
-- for the year it belongs to. A person answers per payment; the answer is kept
-- with the payment day it was given for, so it stops applying when that day changes.
CREATE TABLE "tax_year_boundary_answers" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "subject_kind" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "cash_day" TEXT NOT NULL,
    "belongs_to_other_year" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_year_boundary_answers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tax_year_boundary_answers_auth_workspace_id_subject_kind_su_key" ON "tax_year_boundary_answers"("auth_workspace_id", "subject_kind", "subject_id");
