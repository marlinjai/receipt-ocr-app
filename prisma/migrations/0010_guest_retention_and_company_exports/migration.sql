-- A held printed guest copy keeps its name and company but loses its link to a
-- contact, once the contact is erased. retain_until says when the copy may go.
ALTER TABLE "meal_guests" ALTER COLUMN "contact_id" DROP NOT NULL;
ALTER TABLE "meal_guests" ADD COLUMN "retain_until" TIMESTAMP(3);

-- One row per data export handed to a company (the zip with its register and contacts).
-- A company that has taken its export no longer needs the held copies kept by us.
CREATE TABLE "company_exports" (
    "id" TEXT NOT NULL,
    "auth_tenant_id" TEXT NOT NULL,
    "file_count" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_exports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "company_exports_auth_tenant_id_idx" ON "company_exports"("auth_tenant_id");
