---
title: Import from Google Sheets (Receipts)
summary: A repeatable, per-workspace "Import from Sheets" feature in the Receipts app. The user connects Google via OAuth, points at a sheet + tab, maps columns to the 19 Receipts fields once, and imports. Re-runnable with dedup so it doubles as a sync.
type: plan
status: draft
tags: [receipt-ocr, google-sheets, import, oauth, multi-tenant]
projects: [receipt-ocr-app]
date: 2026-07-20
---

# Import from Google Sheets (Receipts)

**Status: draft, awaiting Marlin's sign-off on the open decisions before implementation.**

## Goal

Get Lola Stories' invoice data (currently living in a Google Sheet) into the Receipts app, and make it repeatable for any workspace/company, not a one-off script. The user connects their Google account, picks a sheet, maps its columns to the Receipts fields once, and imports. Running it again reconciles new/changed rows instead of duplicating.

Trigger: an **Import from Sheets** button next to the existing Upload Receipt / Recompute FX / AI controls on the dashboard.

## Why this is net-new

There is no Google Sheets importer anywhere in the codebase today (confirmed on `origin/main`). The Lola Stories Receipts workspace is empty because (a) the app's pre-existing data was all Marlin's freelance receipts, migrated to `receipts-marlinjai` by the 2026-07-16 multi-tenant migration, and (b) nothing has ever pulled the Google Sheet in. This feature builds that path.

## Architecture

```
Dashboard "Import from Sheets"
   │
   ├─ 1. Connect Google (per-user OAuth, spreadsheets.readonly)  ── first time only, token stored encrypted per user
   │
   ├─ 2. Pick sheet + tab (Drive Picker, or paste URL + choose tab)
   │
   ├─ 3. Preview + map columns  ── sheet headers -> the 19 Receipts fields; mapping saved per workspace
   │
   └─ 4. Import  ── read rows via Sheets API -> normalize -> dedup by stable key
                     -> insert into dt_tables WHERE workspace_id = <active auth-brain workspace>
                     -> non-EUR rows flow through existing Recompute FX
```

Key properties:
- **Per-workspace.** Everything is scoped to the session's active auth-brain workspace (`receipts-lola-stories` for Lola), reusing the existing `auth.requireSession` / `sessionWorkspaceId` seam. Import is a mutation, so it goes through `guardMutation('receipts.import')`.
- **Configurable mapping, persisted.** The sheet's column layout is the user's, not ours, so the mapping (sheet column -> Receipts field) is chosen in the UI and stored per workspace. Re-imports and future syncs reuse it. This is what makes it "repeatable" and resilient to the sheet changing.
- **Idempotent re-runs (sync).** Each imported row carries a stable source key (hash of the mapped identity fields, e.g. vendor + invoice-no + date + amount, plus the source row id). Re-running upserts by that key: new rows inserted, unchanged skipped, changed updated. No duplicates.
- **FX reuse.** Non-EUR invoices reuse the existing historical-ECB Recompute FX path already in the app.

## Auth model (the "log in with Google" part)

Per-user OAuth, not a shared service account:
- Scope: `https://www.googleapis.com/auth/spreadsheets.readonly` (plus Drive Picker's `drive.file` if we use the Picker for selection). Read-only, no write to the user's Drive.
- The user grants once; we store the refresh token encrypted (same pgcrypto pattern the suite uses), keyed by user + workspace. Subsequent imports need no re-consent.
- This is separate from auth-brain (which handles who may use Receipts). Google OAuth here only authorizes reading the user's Sheets.

## Data model additions

- `sheet_import_config` (per workspace): spreadsheet id, tab/sheet name, header row, column mapping (JSON), dedup-key field list, last-run timestamp.
- `google_oauth_credential` (per user): encrypted refresh token, scopes, expiry.
- Imported dt_rows gain a `source` provenance (`{ kind: 'google-sheet', spreadsheetId, sheetName, rowId, importKey }`) for dedup + traceability. (Stored in the existing dynamic row payload, no dt schema migration.)

## Open decisions (need Marlin)

| # | Decision | Options | Default I'd pick |
|---|----------|---------|------------------|
| 1 | Google auth | Per-user OAuth (user logs in) vs shared service account (share the sheet to it) | Per-user OAuth (matches your ask) |
| 2 | Sheet selection | Google Drive Picker vs paste-URL + tab dropdown | Paste-URL + tab dropdown (simpler, no Picker infra); add Picker later |
| 3 | Sync cadence | Manual re-run button only (v1) vs scheduled/auto | Manual button v1; scheduled sync as a follow-up |
| 4 | Dedup identity | Which columns define "the same invoice" | Confirm once I can read the sheet headers |
| 5 | Multi-tab | One tab per import vs merge several | One tab per import config; multiple configs allowed |

## Phases

1. **OAuth connect**: Google OAuth flow + encrypted per-user token storage + "Connect Google" UI state.
2. **Read + preview**: Sheets API read, tab selection, header detection, preview grid.
3. **Mapping**: column -> Receipts-field mapper UI, persisted per workspace, with sensible auto-detected defaults from header names.
4. **Import + dedup**: normalize rows, upsert by stable key into the active workspace, wire FX for non-EUR, run under `guardMutation`.
5. **Repeat/sync**: re-run button surfaces a diff (new/updated/skipped); optional scheduled sync later.

## Concrete target fields (from `COLUMNS` in `src/app/app/actions.ts`)

**Mappable from a sheet:** Name (primary), Vendor, Gross, Net, Tax Rate, Date, Category, Konto, Status, Zuordnung, Currency, Business Share %, Project.

**Auto-filled, not mapped:**
- `EUR Equivalent`, `Attributed EUR`: formula columns, compute themselves.
- `FX Rate`: filled by the existing Recompute FX path for non-EUR rows.
- `Konto`: can default from Category via `CATEGORY_TO_KONTO` if the sheet has no Konto column.
- `Confidence`, `OCR Text`, `Receipt Image`: OCR-only, left blank on Sheet imports.

The insert path mirrors `processReceipt`: `getTableId(activeWorkspace)` -> `getColumns` -> build cells -> `adapter.createRow`. No dt schema migration for rows (provenance rides the row payload).

## Marlin's setup checklist (external, blocks Phase 1)

1. **Create a Google Cloud OAuth client** (Web application) in the Lumitra GCP project:
   - Authorized redirect URI: `https://receipts.lumitra.co/api/google/oauth/callback` (+ `http://localhost:3000/api/google/oauth/callback` for local dev).
   - Enable the **Google Sheets API** (and Drive API only if we later add the Picker).
   - Consent screen scope: `.../auth/spreadsheets.readonly`.
2. **Fill the Infisical placeholders** (already scaffolded in Receipt OCR / prod): `GOOGLE_SHEETS_CLIENT_ID`, `GOOGLE_SHEETS_CLIENT_SECRET`.
3. **Refresh `gws`/Google auth** (`invalid_rapt`) so the exact sheet headers can be read to lock the Phase-3 default mapping + Phase-4 dedup key.

## Decisions locked (2026-07-20, Marlin: "go with the defaults")

1 per-user OAuth · 2 paste-URL + tab dropdown · 3 manual re-run button (v1) · 4 dedup key TBD from headers · 5 one config per tab.

## Blocked on

- Marlin's setup checklist items 1-3 above. Code that does NOT need the live client or the sheet can start immediately: the Prisma migration (`google_oauth_credential`, `sheet_import_config`), the `receipts.import` permission in `auth.ts`, and the pure row-normalize/dedup module (unit-tested against a synthetic mapping).
