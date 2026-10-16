-- The income tax estimate (finance plan, slice 6): wage statements and pay
-- slips, other items of the return, the church tax months of a year, and the
-- federal state for the church tax rate. Additive only.
-- AlterTable
ALTER TABLE "workspace_tax_settings" ADD COLUMN     "federal_state" TEXT;

-- CreateTable
CREATE TABLE "tax_wage_statements" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "year" INTEGER NOT NULL,
    "employer" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "gross_cents" INTEGER NOT NULL,
    "wage_tax_cents" INTEGER NOT NULL,
    "solidarity_cents" INTEGER NOT NULL DEFAULT 0,
    "church_tax_cents" INTEGER NOT NULL DEFAULT 0,
    "pension_employee_cents" INTEGER NOT NULL DEFAULT 0,
    "pension_employer_cents" INTEGER NOT NULL DEFAULT 0,
    "health_employee_cents" INTEGER NOT NULL DEFAULT 0,
    "care_employee_cents" INTEGER NOT NULL DEFAULT 0,
    "unemployment_employee_cents" INTEGER NOT NULL DEFAULT 0,
    "health_with_sick_pay" BOOLEAN NOT NULL DEFAULT true,
    "church_liable" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_wage_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_return_items" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "year" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "amount_cents" INTEGER,
    "days" INTEGER,
    "distance_km" INTEGER,
    "own_car" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_year_settings" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "year" INTEGER NOT NULL,
    "church_months" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_year_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tax_wage_statements_auth_workspace_id_year_employer_month_key" ON "tax_wage_statements"("auth_workspace_id", "year", "employer", "month");

-- CreateIndex
CREATE INDEX "tax_return_items_auth_workspace_id_year_idx" ON "tax_return_items"("auth_workspace_id", "year");

-- CreateIndex
CREATE UNIQUE INDEX "tax_year_settings_auth_workspace_id_year_key" ON "tax_year_settings"("auth_workspace_id", "year");

