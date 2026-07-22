-- CreateTable
CREATE TABLE "workspace_vendor_attribution" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "share" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_vendor_attribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_notes" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_vendor_attribution_auth_workspace_id_vendor_key" ON "workspace_vendor_attribution"("auth_workspace_id", "vendor");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_notes_auth_workspace_id_key" ON "workspace_notes"("auth_workspace_id");

