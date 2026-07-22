-- CreateTable
CREATE TABLE "overview_selections" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "overview_selections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "overview_selections_auth_workspace_id_name_key" ON "overview_selections"("auth_workspace_id", "name");

