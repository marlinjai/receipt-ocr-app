-- Business-meal register (Bewirtungsverzeichnis): the three tables that do not
-- fit into the generic receipts table.
--
-- The meal facts themselves (meal type, occasion, place, tip, host, ...) are
-- ordinary columns on the Receipts data table and need no migration: they are
-- added by initializeReceiptsTable() on the next page load. What needs real
-- tables is the contact list, the guests per meal, and one tax setting per
-- workspace.
--
-- Additive only. Nothing existing is altered, so this is safe to apply to the
-- live database at boot (start.sh runs `prisma migrate deploy`).

-- The contact list. company_or_role is NOT NULL DEFAULT '' on purpose: with a
-- nullable column the unique index below would accept the same person twice,
-- because Postgres treats NULLs as distinct.
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "name" TEXT NOT NULL,
    "company_or_role" TEXT NOT NULL DEFAULT '',
    "note" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contacts_auth_workspace_id_name_company_or_role_key"
    ON "contacts"("auth_workspace_id", "name", "company_or_role");

-- One guest on one meal. row_id has NO foreign key: a receipt row lives either
-- in dt_rows or in a per-table physical table (tbl_<id>) once the data-table
-- adapter has migrated the table, so there is no single table to reference.
-- The row delete paths remove the guests in application code instead.
-- contact_id has no foreign key either, by design: the contact store is the
-- part meant to be replaceable by a shared service later, and display_name /
-- display_company carry everything the register prints.
CREATE TABLE "meal_guests" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "row_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "display_name" TEXT NOT NULL,
    "display_company" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meal_guests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meal_guests_row_id_contact_id_key" ON "meal_guests"("row_id", "contact_id");
CREATE INDEX "meal_guests_auth_workspace_id_row_id_idx" ON "meal_guests"("auth_workspace_id", "row_id");
CREATE INDEX "meal_guests_contact_id_idx" ON "meal_guests"("contact_id");

-- One row per workspace. small_business is nullable and has no default on
-- purpose: NULL means "the owner has not answered the section 19 question yet",
-- and the register refuses to show deductible amounts until it is answered. A
-- default would silently guess the base of the 70 percent.
CREATE TABLE "workspace_tax_settings" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "small_business" BOOLEAN,
    "host_address_threshold_eur" INTEGER NOT NULL DEFAULT 250,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_tax_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspace_tax_settings_auth_workspace_id_key"
    ON "workspace_tax_settings"("auth_workspace_id");
