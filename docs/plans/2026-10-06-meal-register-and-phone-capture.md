---
title: Business-meal register (Bewirtungsverzeichnis) and phone capture
summary: Record guests, occasion, place, tip and host per business meal, derive completeness and the 70 percent deductible amount, export a per-year register as PDF and CSV, and add a camera capture path on the phone that leads straight into the meal details. Draft, no code yet.
type: plan
status: draft
tags: [receipts, bewirtung, tax, register, export, phone-capture, stateful-flow]
projects: [receipt-ocr-app]
date: 2026-10-06
---

# Business-meal register and phone capture

## Goal

1. **Register.** German income tax law (section 4 paragraph 5 number 2 of the
   Einkommensteuergesetz) allows 70 percent of a business meal as an expense only when
   the receipt is accompanied by: date, place, the persons hosted, the business
   occasion, the amount, and the host's signature. The app should hold these facts per
   meal and produce a register per calendar year that can be handed to the tax office.
2. **Phone capture.** Photograph a receipt on the phone, have it read and categorized,
   and, when it is a meal, be asked for the meal facts right away.

Waiting for this: 17 meal receipts from 2025 and about 15 from 2026 that have no
guests or occasion recorded.

## The one design idea

`processReceipt` (the server action in `src/app/app/actions.ts` that turns an upload
into a table row) saves the row before any follow-up question could be asked. So the
meal details are never a wizard that must survive a reload: they are fields on a row
that already exists. **A queue of "incomplete meals" (rows that are a business meal but
lack guests or occasion) is therefore at once the resume path, the re-entry path and
the way the backlog gets worked off.** The prompt after a phone capture is only a
shortcut into that same form.

Second rule: **completeness and the deductible amount are computed on read, never
stored.** They are derived from category, meal type, guests, occasion and amounts, so
they cannot go stale when one of those changes.

## What exists today (verified in code)

- **Upload**: `src/components/ReceiptUploader.tsx` takes several images or Portable
  Document Format (PDF) files, and per file runs presigned upload, optical character
  recognition (OCR) via `/api/ocr`, then `processReceipt`. The file input already
  offers "take photo" on a phone, but there is no dedicated camera button, and the
  page (`src/app/app/page.tsx`) redirects to the dashboard when the batch ends.
- **OCR**: `src/app/api/ocr/route.ts` calls Google Cloud Vision. For a PDF it reads
  at most pages 1 to 5 and merges them into one text, so a PDF is always one receipt.
- **Classification**: `classifyWithWebSearch` in `src/lib/web-search.ts` calls the
  Anthropic interface directly (not OpenRouter; OpenRouter in `src/lib/ai-client.ts`
  serves the chat sidebar and the optional multimodal OCR path). It returns name,
  category, account, assignment and tax rate. Fallback rules live in
  `src/lib/extract-receipt-fields.ts`.
- **Two fallback rules are wrong for a register**: `VENDOR_CATEGORY_MAP` files
  supermarkets under "Bewirtung", and `REDUCED_RATE_CATEGORIES` defaults "Bewirtung"
  to 7 percent value-added tax (VAT), while a restaurant meal eaten in is 19 percent.
- **Data**: receipts are rows of the generic data table (`dt_rows`, cells as JSON,
  `prisma/schema.prisma`). The column list `COLUMNS` in `src/app/app/actions.ts` is
  applied additively by `initializeReceiptsTable` on every dashboard load, so new
  columns reach every workspace without a migration. Category "Bewirtung" maps to
  account 4650 of the German standard chart of accounts SKR03
  (`src/lib/receipts-constants.ts`). There are no meal fields.
- **Views and export**: `src/app/app/dashboard/DashboardClient.tsx` with
  `src/components/ReceiptDetailPanel.tsx`; one comma-separated values (CSV) export in
  `src/lib/export-csv.ts` (semicolon delimiter, German number format). No PDF library
  in `package.json`, no register view.
- **Access**: `src/middleware.ts` gates everything by the shared login session. Data
  is partitioned by the active workspace, resolved on the server
  (`src/lib/auth-guards.ts`); writes need `receipts.row.write`, uploads
  `receipts.upload`.
- **Phone shell**: `public/manifest.json` makes the app installable. `public/sw.js`
  is a service worker that deliberately deletes its caches and unregisters itself, so
  there is no offline support and no share target today.
- **Gaps found on the way**: no duplicate detection anywhere; when OCR fails the
  uploader throws before `processReceipt`, so the uploaded file ends up with no row;
  `processReceipt` returns nothing, so the caller cannot know which row was created.

## Data model changes

New columns on the Receipts table, added to `COLUMNS` (self-healing, no migration):

| Column | Type | Notes |
|---|---|---|
| Meal Type | select | "Geschäftsessen (extern)", "Mitarbeiterbewirtung (intern)", "Verpflegung auf Reise", "Keine Bewirtung". Maps to the earlier automation's `hospitality.type` values `business_meal_external`, `staff_meal_internal`, `travel_meal`. |
| Occasion | text | The concrete business reason. |
| Guests | text | One person per line: name, then company or role. |
| Place | text | Restaurant name and address, prefilled from Vendor and the OCR text. |
| Tip | number | In the receipt currency, entered separately from Gross. |
| Host | text | Prefilled with the signed-in user's display name. |
| Consumption | select | "Vor Ort" or "Außer Haus"; drives the 19 or 7 percent default. |
| Meal Details At | date | When the details were last saved (a true timestamp, never backdated). |

Guest count is derived from the lines in Guests, not stored. The file's SHA-256
content hash goes into the existing `dt_files.metadata` JSON (duplicate detection).

One new Prisma model `WorkspaceTaxSettings` (migration `0008`): `authWorkspaceId`
unique, `authTenantId`, `deductsInputVat` boolean, `hostAddressThresholdEur`
(default 250). It decides the base of the 70 percent (see Rules).

One module `src/lib/meals/rules.ts` holds the two pure functions every surface uses
(detail panel, queue, register, both exports), so the rule exists exactly once:

- `mealStatus(row)`: `not_a_meal`, `excluded` (with reason), `incomplete` (with the
  list of missing fields) or `complete`.
- `mealDeduction(row, settings)`: base, 70 percent deductible, 30 percent
  non-deductible, input VAT.

## Rules

- A row is a **register entry** when Category is "Bewirtung", Meal Type is
  "Geschäftsessen (extern)" and the assignment (Zuordnung) is not "Privat".
- It is **complete** only with: date, place, gross amount, occasion, host, and at
  least one guest besides the host. A meal eaten alone is not a business meal: with
  no guest the form says so and offers "Verpflegung auf Reise" or "Keine Bewirtung".
- Occasion must be specific. Reject empty text and generic one-word entries
  ("Geschäftsessen", "Meeting", "Besprechung") with a hint to name the topic.
- **Deductible amount**: base times 0.70. When the workspace deducts input VAT the
  base is net plus tip and the input VAT is listed in full beside it; when it does
  not (small-business rule) the base is gross plus tip. Amounts in euros via the
  existing FX Rate column. The existing Business Share column is not applied on top.
- **Tip** counts into the base only when entered; the form reminds that it must be
  noted on the receipt.
- Above the threshold in the settings the receipt must name the host; the form shows
  a warning, it does not block. The threshold value and the base rule are to be
  confirmed with the tax advisor before the first export is filed.
- Staff meals and travel meals are recorded but never enter the 70 percent register.

## User flows

**Phone**

1. Open the installed app, tap "Foto aufnehmen" (a second input with
   `capture="environment"`, one file). The photo is scaled to at most 2000 pixels on
   the long edge and converted to JPEG in the browser, since the file column only
   allows PDF, PNG and JPEG.
2. The browser hashes the file, the server checks for a duplicate, then upload, OCR
   and classification run as today. `processReceipt` now returns row id, category and
   meal type.
3. If the row is a business meal, a bottom sheet opens with Place, amount and date
   prefilled and four inputs: guests (with suggestions from earlier entries),
   occasion, tip, consumption. "Save" completes it; "Later" leaves it in the queue.
4. Otherwise a short confirmation with the category and "next photo". No redirect
   while capturing.

**Desktop**

- The detail panel gets a "Bewirtung" section with the same form (one component).
- A new page `/app/meals` with a year picker and two tabs: "Unvollständig" (the
  queue, oldest first, each row opens the form with the receipt image beside it) and
  "Verzeichnis" (the register). The dashboard shows a badge with the open count.

## Register view and export

Per year, register entries sorted by date, numbered: date, place, guests, occasion,
gross, tip, net, input VAT, deductible 70 percent, non-deductible 30 percent, link to
the receipt. Footer with totals (the two sums that go to accounts 4650 and 4654).
Incomplete entries are listed in their own block, counted in a warning, and not in
the totals.

- **CSV**: `GET /api/meals/register?year=2025&format=csv`, reusing the formatting
  helpers of `src/lib/export-csv.ts`, plus the original automation's columns
  (`hospitality.type`, `occasion`, `guests`, `guest_count`, `tip`,
  `consumption_type`, `deductibility_hint`) so old sheets and new export line up.
- **PDF**: same route with `format=pdf`, rendered on the server. A summary table for
  the year, then one sheet per meal with the required facts, the receipt image, and a
  line for place, date and signature. The app cannot sign: the signature is by hand
  on the print, or the sheet is signed digitally outside the app.
- Both are generated from the same register builder and carry the generation time.
  Exporting with open incomplete entries is allowed after an explicit confirmation
  that names the count.

## Unhappy paths

| Situation | Behaviour |
|---|---|
| Blurry photo | Confidence below 60 or no amount or no date found: row is saved as "Pending", the sheet offers "retake", which replaces the file on the same row and reruns OCR. Never a second row. |
| OCR or classification fails | The row is still created with the file attached and status "Pending", fields empty for manual entry. The error is shown, not swallowed. Fixes today's orphaned file. |
| Same file uploaded twice | Hash match in the workspace: nothing is uploaded, the uploader shows "already there" with a link to the existing row and an explicit "upload anyway". |
| Same receipt photographed twice | Different hash, so a soft check on vendor, date and gross warns after OCR and offers to discard the new row. |
| Offline on the phone | Photos wait in an in-browser queue (IndexedDB) with a visible "n waiting" counter, and are sent when the connection returns or the app is next opened. A failed send stays in the queue with a retry button. Meal details need the row, so they follow after sync. |
| Session expired while capturing | The queue keeps the photo, the app sends the user to login and resumes after return. |
| Reclassified away from meal after details were entered | The row leaves the register and the queue at once (status is derived). The details stay stored and the panel says "kept, not in the register". Switching back restores the entry unchanged. |
| Meal changed to "Privat" or guests cleared | Same mechanism: excluded or incomplete on the next read. |
| Wrong workspace | The register only ever reads the active workspace; the workspace name is printed on the PDF header. |
| Receipt in a foreign currency without a rate | Entry is incomplete with reason "exchange rate missing" instead of exporting a zero. |

Guest names are personal data of third parties: they stay in workspace-scoped cells,
are not sent to the classifier, and the Guests column is withheld from the rows that
the chat sidebar's read tools (`src/lib/ai-chat-tools.ts`, run from
`src/components/AiChatSidebar.tsx`) hand to the language model.

## Test plan

Unit tests (Vitest, already in the repo) for `mealStatus`, `mealDeduction`, the
register builder and both exports, including rounding and the two VAT bases. Flow
tests of the form and queue with jsdom. The four paths, all part of done:

1. **Forward**: capture, classified as meal, details entered, row complete, appears
   in the register with the right 70 percent amount.
2. **Backtrack and revise**: change Category away from "Bewirtung" and the row leaves
   register and queue, details retained; change it back and the same entry returns.
   Change gross, tip or the VAT setting and the deductible amount changes with it.
   Counter-case: reopening and saving with the same inputs changes nothing, including
   the details timestamp.
3. **Resume**: reload during the bottom sheet, the row is in the queue with the
   partial input that was saved; reload with photos in the offline queue, they are
   still there and are sent once. A stored row from before this feature (no meal
   cells) reads as incomplete, not as an error.
4. **Re-entry**: editing a completed entry updates it in place; retrying a failed
   upload or a retake never produces a second row; the same file again hits the hash
   check; a new export after an edit reflects the edit.

Plus: one test that feeds a real recorded classifier response through the real
parser (not a mock), a test per row of the unhappy-path table, a workspace isolation
test on the register route, and a manual pass on a real iPhone and a real Android
phone for camera, home-screen install and the offline queue.

## Getting the backlog in

- Meal receipts **already in the app** show up in the queue the moment slice 1 ships,
  because they are "Bewirtung" rows without guests. Rows the fallback rules filed
  wrongly (supermarkets) get "Keine Bewirtung" with one click and leave the queue.
- Receipts **only on disk as scans**: the uploader gets a switch "one receipt per
  page". The PDF is split in the browser into one-page PDFs, and each runs through
  the normal per-file pipeline. This avoids the five-page limit and the merged text.
- Entering 32 meals fast: guest suggestions from earlier entries, "same guests as
  previous", keyboard-only save-and-next in the queue.
- The details timestamp is the true entry time. Details recorded long after the meal
  are weaker evidence than timely ones; the app does not hide or alter that.

## Slices in build order

1. **Meal fields, rules, form, queue.** Columns, `rules.ts`, the form in the detail
   panel, `/app/meals` with the queue. The backlog already in the app can be worked.
2. **Register and export.** Register tab, tax settings model, CSV and PDF route.
3. **Backlog import.** One-receipt-per-page split, content hash and duplicate checks.
4. **Phone capture.** Camera button, image conversion, `processReceipt` return
   value, bottom sheet, retake, row kept on OCR failure.
5. **Classifier.** Meal type, consumption and tip in the Anthropic prompt, supermarket
   and 7 percent fallback fixes.
6. **Offline queue.** Only after 4 is in daily use.

Slices 1 to 3 are what the tax return needs; 4 to 6 are the capture comfort.

## Open decisions

1. **Base of the 70 percent.** Net (input VAT deducted in full) or gross
   (small-business rule, no input VAT)? Recommendation: a workspace setting, as
   planned, with the owner stating once which applies; no default is guessed.
2. **Guests as text or as a contact list.** Recommendation: text, one person per
   line, with suggestions from earlier entries. The register only prints names; a
   contacts table can be added later through the data table's relation column.
3. **Shape of the PDF.** Table only, or summary table plus one signed sheet per meal?
   Recommendation: summary plus one sheet per meal with the receipt image, built with
   the `pdf-lib` package, which the page split in slice 3 needs anyway.
4. **Share target ("share to Receipts" from the photo app).** It needs a working
   service worker, and the current one was removed on purpose. Recommendation: not in
   this plan; camera button and home-screen install first, decide after two weeks of
   use.
5. **Entry date on the printed sheet.** Recommendation: keep the true timestamp in
   the data and the CSV, and leave the printed sheet with a blank date and signature
   line that is filled in by hand.
6. **Staff and travel meals.** Recommendation: record the type, keep them out of the
   70 percent register, and show them as a separate count so nothing is lost.
7. **Blocking export while entries are incomplete.** Recommendation: do not block;
   confirm with the count and list the incomplete ones in their own block.
