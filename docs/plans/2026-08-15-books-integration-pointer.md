---
title: "Pointer: the Books plan lives in framer-clone"
type: plan
status: draft
date: 2026-08-15
summary: "receipt-ocr-app's side of the receipts-plus-invoices accounting suite. The full cross-repo plan is homed in framer-clone; this file records what lands here and why the plan is not in this repo."
tags: [books, invoices, receipts, auth-brain, tenant-scoping, cross-repo, pointer]
projects: [receipt-ocr-app, framer-clone]
---

# Pointer: the Books plan lives in framer-clone

Canonical plan: `ERP-suite/projects/framer-clone/docs/plans/2026-08-15-books-receipts-invoices-integration.md`.

Backlog intent: `knowledge-base/backlog/intents/receipts-ocr-own-tax-use.md`.

## Why it is homed there

Roughly 85 percent of the new work is the document tier (customers, offers, invoices, credit notes, templates, numbering), which lands in `framer-clone/prisma/schema.prisma` and a new `framer-clone/src/server/books/` module. framer-clone already carries the correct German tax model, integer-cents money discipline, append-only invoice semantics, the Storno/Gutschrift entity, and the `variantRef` binding socket. Rebuilding those here would be a duplicate.

## What lands in this repo

**Phase 0 (prerequisite, blocks everything else):** tenant awareness.

- Add `authTenantId` to `DtTable` and to the four models already carrying `authWorkspaceId` (`SheetImportConfig`, `WorkspaceVendorAttribution`, `OverviewSelection`, `WorkspaceNotes`). Migration `0007_tenant_scoping`.
- Add `sessionTenantId` and `tenantIdForWorkspace` to `src/lib/auth-workspace.ts`, reading `active_tenant.id` and `workspaces[].tenant_id` from the auth-brain verify payload. Populate on every write path.
- Backfill existing rows via the auth-brain admin machine API.
- Housekeeping in the same PR: `2026-07-16-auth-brain-multi-tenant-integration.md` and `2026-07-24-import-page-drive-browser.md` still say `in-progress` and `2026-07-20-google-sheets-import.md` still says `draft` for work that shipped; README and `docs/public/architecture.md` still describe the retired Cloudflare D1/Workers stack.

**Phase 4:** one read-only machine endpoint.

`GET /api/books/expenses?tenantId=&from=&to=` returning normalized expense lines mapped from the existing `dt_rows` cells. Authenticated by an auth-brain **service-account API key** (`verifyApiKey`), not the existing shared `SERVICE_TOKEN`, because that token path is not tenant-scoped (already flagged in this repo's ROADMAP). Tenant enforced server-side.

Everything else in phases 1 to 5 is framer-clone work. Nothing here reads or writes the framer-clone database, and framer-clone never connects to this one.

## The scoping decision this repo has to absorb

The books are scoped to the **auth-brain tenant (the company)**, not the workspace, because `tenants` is the only tier carrying `legal_name`, `vat_id`, and `billing_address`, and because app grants and billing are already tenant-level. This repo's storage stays workspace-scoped exactly as it is; `authTenantId` is a denormalized addition, not a migration of the partition key.
