---
title: Financial Overview (Vendor Spend Ledger) + configurable attribution
summary: A charts/KPI overview page on the receipts app that mirrors the "Vendor Spend Ledger" artifact, reading the same dt_rows. Adds workspace-editable per-vendor attribution percentages (replacing the hardcoded VENDOR_BUSINESS_SHARE_DEFAULTS) and a workspace-editable notes block.
type: plan
status: decided
tags: [receipt-ocr, dashboard, charts, attribution, multi-tenant]
projects: [receipt-ocr-app]
date: 2026-07-22
---

# Financial Overview + configurable attribution

**Status: decided (Marlin approved the direction + defaults in-session).**

## Goal

Reproduce the "Lola Stories: Vendor Spend Ledger" artifact as a live **`/app/overview`** page in the receipts app: KPI tiles + vendor/monthly charts over the same `dt_rows`, per-workspace, gated by the same auth. Two additions Marlin flagged:

1. **Configurable percentage attribution** — today attribution is per-row `Business Share %` plus a hardcoded `VENDOR_BUSINESS_SHARE_DEFAULTS`. Make per-vendor attribution **workspace-editable**, with an "apply to ledger" action.
2. **Workspace-editable notes block** — the artifact's "Data notes" / attribution methodology prose, editable and stored per workspace.

## Data mapping (all derivable from the imported columns)

| Panel | Source |
|---|---|
| Total spend (attributed) | Σ Attributed EUR = Σ (Gross × FX Rate × Business Share %/100) |
| Raw billed (no attribution) | Σ EUR Equivalent = Σ (Gross × FX Rate) |
| EUR-native / USD-native spend | split by Currency, native Gross |
| Invoices on file | row count |
| Monthly spend by vendor (EUR + USD, separate scales) | group by month × Vendor, attributed, per currency |
| Total by vendor (EUR equiv) | group by Vendor, Σ Attributed EUR, sorted |
| Total by vendor (native currency) | group by Vendor × Currency, Σ Gross |
| Full ledger | link to the existing table view (not re-embedded) |

Attribution is data-driven: each vendor's share (e.g. Anthropic 30%) is the per-row `Business Share %`, so no hardcoded 30% in the overview.

## Decisions locked

- Notes: **workspace-editable block** (option b).
- Ledger: **link** to the existing table view, not duplicated.
- Currency: **EUR and USD on separate scales** (no blended axis), matching the artifact.
- Charts: **hand-rolled SVG/CSS bars** (dependency-light), styled per the `dataviz` system (accessible, theme-aware).

## Build

### Data model (Prisma migration 0004)
- `workspace_vendor_attribution` (per workspace): vendor (text), share (int 0-100). Unique (authWorkspaceId, vendor). The workspace-editable replacement for `VENDOR_BUSINESS_SHARE_DEFAULTS`; also carries a `defaultShare` fallback via a reserved `*` vendor row or a separate `workspace_settings` row.
- `workspace_notes` (per workspace): markdown text.

### Pure aggregation (tested)
- `overview-aggregate.ts`: `aggregateOverview(invoices) -> OverviewData` computing all KPIs/series from a plain `InvoiceRecord[]`. No I/O; unit-tested (multi-currency totals, per-vendor sort, monthly buckets, attribution math).

### Server
- Read `dt_rows` via `adapter.getRows`, resolve Currency select id->name, map cells -> `InvoiceRecord[]` (compute EUR Equivalent + Attributed EUR from Gross/FX/Share). Feed `aggregateOverview`.
- Attribution store CRUD + **apply-to-ledger** action: writes the chosen per-vendor % into every matching row's `Business Share %` (single source of truth stays the row + its Attributed EUR), gated by `receipts.import`/a new `receipts.attribution` perm.
- Notes get/set, gated on workspace membership.
- On OCR upload, default `Business Share %` now reads the workspace attribution store (falling back to the constant), so the hardcoded map is superseded, not duplicated.

### UI (`/app/overview`)
- KPI hero + 4 tiles; "Total by vendor (EUR)" horizontal bars; "Monthly by vendor" EUR + USD stacked bars (separate scales); "Total by vendor, native currency" grouped bars.
- **Attribution panel**: per-vendor % (editable) + "Apply to ledger"; shows blended/effective rate.
- **Notes block**: editable markdown, saved per workspace.
- Link back to the ledger (table view). Nav link added on the dashboard.

## v2 (same PR, Marlin-requested): time frames, invoice selection, saved selections

Architecture flip: the page now ships the normalized `LedgerInvoice[]` (record + row id + name) and runs `aggregateOverview` CLIENT-side over the filtered subset, so every control re-charts instantly with no round trip.

- **Time frames**: preset chips 1W / 1M / 3M / 6M / YTD / 1Y / All + a custom from→to range. Undated invoices drop out whenever a date bound is active.
- **Selection** (`selection.ts`, pure + tested): a `SelectionDef` combines the time frame, living vendor/currency filters (new imports that match join automatically), and frozen `includeIds`/`excludeIds` sets. All parts AND together. UI: vendor + currency chips, and an invoice picker with two modes — "exclude unchecked" (live) vs "only checked" (frozen).
- **Saved selections** (migration 0005, `overview_selections`): named definitions per workspace, unique by name; dropdown to load, inline save/delete. `POST|DELETE /api/overview/selections` (gated `receipts.row.write`), definitions sanitized on write AND on read.

## Out of scope (v1)
- The artifact's hand-written reconciliation prose becomes the editable notes block (not auto-generated).
- No CSV/PDF export of the overview (the table view already exports CSV).
