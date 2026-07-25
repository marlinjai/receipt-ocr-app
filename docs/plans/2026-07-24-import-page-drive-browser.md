---
type: plan
status: in-progress
title: Dedicated import page with Google Drive browser
summary: Move the Sheets import out of the toolbar popover onto a full /app/import page, add a Drive folder/file browser for picking the spreadsheet and the invoices folder, and fix the PDF preview convention the attach step broke.
tags: [sheets-import, drive, ui]
date: 2026-07-24
---

# Dedicated import page with Google Drive browser

The "Import from Sheets" popover has outgrown its 384px box: connect step, sheet URL,
tab picker, 12-field mapping, dedup identity, and the Drive attach step all squeezed
into a toolbar dropdown. It becomes a full page at `/app/import`, and both the
spreadsheet and the invoices folder become pickable by browsing the user's Drive
hierarchy instead of pasting URLs / typing folder names.

## Scope

1. **Page `/app/import`**: auth-gated like the dashboard, replaces the popover.
   Sections: Google connection, source spreadsheet (Drive browser + paste-URL
   fallback, tab picker), column mapping + dedup + import, attach invoices (Drive
   folder browser + source-file column). The dashboard toolbar button becomes a link.
   OAuth callback returns to `/app/import` (that is where the flow lives now).
2. **Drive browse API**: `GET /api/google/drive/browse?parent=root|shared|<folderId>`
   behind `receipts.import`. Returns child folders plus files filtered to
   spreadsheets / PDF / PNG / JPEG. `shared` is the "Shared with me" pseudo-folder.
3. **Config prefill**: `GET /api/sheet-import/config` returns the workspace's latest
   import config (spreadsheet, tab, mapping, dedup, attach folder, source column) so
   a returning user sees their setup instead of a blank form. New nullable columns
   `attach_folder_id`, `attach_folder_name`, `source_file_header` on
   `sheet_import_configs` (migration 0006), persisted by a successful attach run.
4. **Attach by folder id**: the attach endpoint accepts `folderId` (from the browser)
   with `folderName` kept as fallback.
5. **PDF preview convention fix**: app uploads store PDF cells as
   `/api/files/<id>/thumbnail`; the attach step wrote bare `/api/files/<id>`, which
   renders a raw PDF into `<img>` (broken thumbnail + broken lightbox). Attach now
   writes the `/thumbnail` form for PDFs and, on re-run, repairs existing bare PDF
   URLs in place (no re-upload, no re-download).

## Non-goals

Scheduled auto-sync stays out (manual re-run v1 per earlier decision).

Update 2026-07-25: shared-drive enumeration (drives.list) moved INTO scope — the
invoices live in the "Founders" shared drive, which is invisible from both My Drive
and Shared-with-me. Shared drives now appear at the browser root; their roots are
navigated as `drive:<id>` (drive corpus), and plain folder ids use the allDrives
corpus so folders inside shared drives list correctly.

## Tests

Pure helpers get unit tests: browse-entry classification, receipt-image URL
convention (`receiptImageUrl`, `repairedImageUrl`). Revision paths: re-running attach
after the convention fix upgrades old URLs (covered by `repairedImageUrl` tests +
idempotent-run logic); reopening the page restores config (prefill endpoint).
