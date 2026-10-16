-- Classification rules move from the browser's local storage to the server, one
-- set per workspace (company), so that they apply when a receipt is uploaded.
-- Additive: one new table, nothing existing is touched.
CREATE TABLE "classification_rules" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "type" TEXT NOT NULL,
    "match_value" TEXT NOT NULL,
    "zuordnung" TEXT NOT NULL,
    "category_override" TEXT,
    "label" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "classification_rules_pkey" PRIMARY KEY ("id")
);

-- One rule per kind and text in a workspace: importing the same browser rules twice adds nothing.
CREATE UNIQUE INDEX "classification_rules_auth_workspace_id_type_match_value_key" ON "classification_rules"("auth_workspace_id", "type", "match_value");
