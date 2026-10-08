---
title: Business-meal register (Bewirtungsverzeichnis) and phone capture
summary: Record guests, occasion, place, tip and host per business meal, derive completeness and the 70 percent deductible amount, export a per-year register as PDF and CSV, and add a camera capture path on the phone that leads straight into the meal details.
type: plan
status: in-progress
tags: [receipts, bewirtung, tax, register, export, contacts, phone-capture, share-target, service-worker, stateful-flow]
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
  to a single fixed value-added tax (VAT) rate. The rate depends on the receipt date
  and the item: until 31 December 2025 food eaten in a restaurant is taxed at 19
  percent; from 1 January 2026 restaurant and catering food is taxed at 7 percent,
  while drinks stay at 19 percent. One receipt can therefore carry both rates, so the
  rate is read from the receipt's own tax lines and its date, never from the category
  alone.
- **Data**: receipts are rows of the generic data table (`dt_rows`, cells stored as JavaScript Object Notation, JSON,
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
  there is no offline support and no share target today. **Why it was removed**
  (commit `1484707`, 23 March 2026): the earlier worker cached the app pages and every
  `/_next/` script file and served scripts cache-first. After the move from Cloudflare
  Workers to the Node.js server, browsers kept running the old cached scripts, which
  still contained database client code that no longer worked. The replacement clears
  everything and removes itself.
- **Gaps found on the way**: no duplicate detection anywhere; when OCR fails the
  uploader throws before `processReceipt`, so the uploaded file ends up with no row;
  `processReceipt` returns nothing, so the caller cannot know which row was created.

## Data model changes

New columns on the Receipts table, added to `COLUMNS` (self-healing, no migration):

| Column | Type | Notes |
|---|---|---|
| Meal Type | select | "Geschäftsessen (extern)", "Mitarbeiterbewirtung (intern)", "Verpflegung auf Reise", "Keine Bewirtung". Maps to the earlier automation's `hospitality.type` values `business_meal_external`, `staff_meal_internal`, `travel_meal`. |
| Occasion | text | The concrete business reason. |
| Place | text | Restaurant name and address, prefilled from Vendor and the OCR text. |
| Tip | number | In the receipt currency, entered separately from Gross. |
| Host | text | Prefilled with the signed-in user's display name. |
| Consumption | select | "Vor Ort" or "Außer Haus". Only a hint for the VAT default when the receipt shows no tax lines; the receipt date and tax lines take precedence (see the VAT rule below). |
| Meal Details At | date | When the details were last saved (a true timestamp, never backdated). |
| Tax Lines | text | The receipt's own tax lines as JSON: rate, net and tax per rate. Filled by the classifier, editable in the form. |

The file's SHA-256 content hash goes into the existing `dt_files.metadata` JSON
(duplicate detection).

Four new Prisma models (migration `0008_meal_register`), all carrying
`authWorkspaceId` and `authTenantId` like the existing workspace models:

- `Contact`: the contact list. Stable id, `name`, `companyOrRole`, optional `note`,
  `archivedAt`. Unique per workspace on name plus company or role.
- `MealGuest`: one guest on one meal. `rowId` (the receipt row), `contactId`,
  `position`, and a copy of the name and company as they are printed
  (`displayName`, `displayCompany`). The copy means the register prints without
  asking the contact store. Correcting a contact updates the copies; archiving a
  contact leaves them. Deleting a receipt row deletes its guests.
- `WorkspaceTaxSettings`: `hostAddressThresholdEur` (default 250).
- `SmallBusinessStatus`: the section 19 (Kleinunternehmer) status as effective-dated
  entries, never a single flag. Each entry has `effectiveFrom` (a date, or none for
  "from the beginning") and `smallBusiness` (yes or no). The status for a meal is the
  latest entry whose `effectiveFrom` is on or before the meal date; with no entry the
  answer is "not set yet". Changing the status, for example when the turnover threshold
  is crossed and regular taxation begins, adds a new entry from a given date and never
  edits an old one, so earlier meals keep their gross or net basis and historical
  register and export totals do not move.

**The seam for a later shared contact service.** Everything that reads or writes
contacts goes through one interface, `ContactStore` in `src/lib/contacts/store.ts`
(search, get, create, update, archive), with the Prisma table as its only
implementation today. The meal model only ever holds a contact id plus the printed
copy. Replacing the storage with a suite-wide customer relationship management (CRM)
service later means a second implementation of that interface and an id mapping,
with no change to meals, rules, register or export. A suite-wide CRM model and any
synchronisation are out of scope here and tracked on their own roadmap line outside
this repo.

Guest names are therefore never stored in table cells, so the chat sidebar's tools,
which read cells, cannot hand them to the language model.

One module `src/lib/meals/rules.ts` holds the two pure functions every surface uses
(detail panel, queue, register, both exports), so the rule exists exactly once:

- `mealStatus(row, guests)`: `not_a_meal`, `excluded` (with reason), `incomplete` (with the
  list of missing fields) or `complete`.
- `mealDeduction(row, settings, statuses)`: base, 70 percent deductible, 30 percent
  non-deductible, input VAT, using the section 19 status in force on the meal date;
  or "setting missing" when no status entry covers that date.

## Rules

- A row is a **register entry** when Category is "Bewirtung", Meal Type is
  "Geschäftsessen (extern)" and the assignment (Zuordnung) is not "Privat".
- It is **complete** only with: date, place, gross amount, occasion, host, and at
  least one guest besides the host. A meal eaten alone is not a business meal: with
  no guest the form says so and offers "Verpflegung auf Reise" or "Keine Bewirtung".
- Occasion must be specific. Reject empty text and generic one-word entries
  ("Geschäftsessen", "Meeting", "Besprechung") with a hint to name the topic.
- **Deductible amount**: base times 0.70. The base follows from one question per
  workspace: "Is this business a small business under section 19 of the value-added
  tax act (Kleinunternehmer)?" Yes: no input VAT is deducted, the base is gross plus
  tip. No: the base is net plus tip and the input VAT is listed in full beside it.
  There is no default. Until the question is answered the register shows the entries
  but no deductible amounts or totals, with a prompt to answer it, and both exports
  refuse with the same prompt. Amounts in euros via the
  existing FX Rate (foreign exchange rate) column. The existing Business Share column is not applied on top.
- **VAT rate and split.** The input VAT and net amounts come from the tax lines read
  from the receipt (rate, net, tax per line), so a receipt with 7 percent food and 19
  percent drinks is summed per rate. Only when no tax lines were read does the app
  fall back to a default chosen by receipt date (before 1 January 2026: 19 percent
  for food eaten in; from that date: 7 percent for food, 19 percent for drinks) and
  by Consumption, and the entry is flagged "VAT estimated" instead of presented as
  exact.
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
   prefilled and four inputs: guests (picked from the contact list, with "new
   contact" inline), occasion, tip, consumption. "Save" completes it; "Later" leaves it in the queue.
4. Otherwise a short confirmation with the category and "next photo". No redirect
   while capturing.

**Desktop**

- The detail panel gets a "Bewirtung" section with the same form (one component).
- A new page `/app/meals` with a year picker and three tabs: "Unvollständig" (the
  queue, oldest first, each row opens the form with the receipt image beside it),
  "Verzeichnis" (the register) and "Kontakte" (the contact list: add, correct,
  archive). The dashboard shows a badge with the open count.
- The section 19 question is asked on the register tab the first time it is opened
  and can be changed later in the same place. A later change asks "from which date"
  and adds a dated entry, with a note that meals before that date keep their earlier
  status.

**Sharing from another app (share target)**

- On Android, the installed app appears in the system share sheet for images and
  PDFs. A shared file is taken by the service worker, put into the same in-browser
  queue the offline capture uses, and the app opens on the capture screen and
  processes it like a photo taken there. Every queue entry is stamped with the
  workspace and user that were active when it was captured or shared. Before sending,
  the app compares the stamp with the current session: on a match it sends, on a
  mismatch (another workspace or another user logged in meanwhile) it never sends into
  the active workspace, and shows the entry as "belongs to another workspace" with the
  choices to send it into the workspace it came from after switching back, or to
  discard it. A share that arrives while logged out is stamped after login with the
  workspace the user explicitly confirms.
- iOS does not offer web apps as share targets at all. On an iPhone the paths are
  the camera button and the file picker (which includes the photo library). The plan
  does not pretend otherwise; a native share extension would be a separate project.
- If a share arrives before the service worker controls the page (first run), the
  server answers the request with a page that says so and how to retry, instead of
  dropping the file silently.

## Register view and export

Per year, register entries sorted by date, numbered: date, place, guests, occasion,
gross, tip, net, input VAT, deductible 70 percent, non-deductible 30 percent, link to
the receipt. Footer with totals (the two sums that go to accounts 4650 and 4654).
Incomplete entries are listed in their own block, counted in a warning, and not in
the totals. Staff meals and travel meals are shown as a separate count with their
sum, outside the register.

- **CSV**: `GET /api/meals/register?year=2025&format=csv`, reusing the formatting
  helpers of `src/lib/export-csv.ts`, plus the original automation's columns
  (`hospitality.type`, `occasion`, `guests`, `guest_count`, `tip`,
  `consumption_type`, `deductibility_hint`) so old sheets and new export line up.
- **PDF**: same route with `format=pdf`, rendered on the server. A summary table for
  the year, then one sheet per meal with the required facts, the receipt image, and a
  blank line for place, date and signature. The entry timestamp is not printed; it
  stays in the data and the CSV. The app cannot sign: the signature is by hand on the
  print, or the sheet is signed digitally outside the app.
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
| Session expired while capturing | The queue keeps the photo, the app sends the user to login and resumes after return, sending only entries whose workspace stamp matches the session that comes back. |
| Reclassified away from meal after details were entered | The row leaves the register and the queue at once (status is derived). The details stay stored and the panel says "kept, not in the register". Switching back restores the entry unchanged. |
| Meal changed to "Privat" or guests cleared | Same mechanism: excluded or incomplete on the next read. |
| Section 19 question unanswered | Register lists the entries without amounts and asks the question; exports refuse with the same message. |
| Shared file of an unsupported type, or share before the service worker is active | A visible message naming the reason and the next step; nothing is lost silently. |
| A new app version is deployed while the old service worker is installed | The worker caches no application scripts, so it cannot serve old code; see "Service worker" below. |
| Wrong workspace | The register only ever reads the active workspace; the workspace name is printed on the PDF header. |
| Receipt in a foreign currency without a rate | Entry is incomplete with reason "exchange rate missing" instead of exporting a zero. |

Guest names are personal data of third parties: they live in the workspace-scoped
contact and guest tables, never in table cells, are not sent to the classifier, and
are therefore out of reach of the chat sidebar's tools (`src/lib/ai-chat-tools.ts`),
which only read cells.

## Service worker

The new `public/sw.js` must not bring back the stale-script problem, so it is built
around one rule: **it never stores or serves application pages or `/_next/` files.**

- It handles exactly two things: the share-target request (a POST to
  `/share-target`, which it turns into queue entries and a redirect into the app),
  and a failed page navigation while offline, for which it serves one small,
  self-contained page (`/offline.html`, plain markup and inline script, no
  application scripts) that can take photos into the queue.
- Every other request passes through to the network untouched.
- Its cache holds that one file only, under a name that carries a version; activating
  a new version deletes every other cache, including any left by the 2026 worker.
- It takes control at once (`skipWaiting`, `clients.claim`) and does not reload open
  tabs.
- The registration code keeps a kill switch: a server-side flag makes the client
  unregister the worker, so a bad worker can be withdrawn with a deploy.

## Test plan

Unit tests (Vitest, already in the repo) for `mealStatus`, `mealDeduction`, the
register builder and both exports, including rounding and the two VAT bases. `mealDeduction`
is also tested across a status change (a meal before the change date keeps its old
basis), and the queue across a workspace or user change (a mismatched entry is never
sent). Flow
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

Plus: VAT tests for a 2025 receipt (19 percent), a 2026 receipt with 7 percent food
and 19 percent drinks on one receipt, and a receipt without tax lines (estimated and
flagged); a test that saving meal details writes no guest name into any cell (so model-bound
`get_rows` results cannot contain one); contact tests (create, duplicate name,
correct a name and see the printed copies follow, archive and see old meals keep
their guests); service worker tests (share request becomes queue entries, an
application script request is never answered from a cache, an old cache is deleted
on activation); one test that feeds a real recorded classifier response through the real
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
- Entering 32 meals fast: guests picked from the contact list by typing, "same
  guests as previous", keyboard-only save-and-next in the queue.
- The details timestamp is the true entry time. Details recorded long after the meal
  are weaker evidence than timely ones; the app does not hide or alter that.

## Slices in build order

Two pull requests: slices 1 to 3, then slices 4 to 6.

1. **Meal fields, rules, contact list, form, queue.** Columns, migration `0008`,
   `rules.ts`, the contact store and "Kontakte" tab, the form in the detail panel,
   `/app/meals` with the queue. The backlog already in the app can be worked.
2. **Register and export.** Register tab, the section 19 question, CSV and PDF route.
3. **Backlog import.** One-receipt-per-page split, content hash and duplicate checks.
4. **Phone capture.** Camera button, image conversion, `processReceipt` return
   value, bottom sheet, retake, row kept on OCR failure.
5. **Classifier.** Meal type, consumption, tip and per-line tax rates in the Anthropic
   prompt, supermarket fix, and a date- and item-aware VAT fallback replacing the
   fixed 7 percent default.
6. **Offline queue, service worker, share target.** The in-browser queue, the new
   worker as described above, the manifest's share target and the offline page.

Slices 1 to 3 are what the tax return needs; 4 to 6 are the capture comfort.

## Reality after slices 1 to 3 (2026-10-07)

Built as planned, with these differences and facts worth knowing:

- **Host prefill.** The plan promised the signed-in user's display name. The session
  carries only an email address and a user id, so the form prefills the host used
  most recently in the workspace instead; the first entry is typed once.
- **Rules module.** `src/lib/meals/rules.ts` works on a normalized record built by
  one mapper (`src/lib/meals/record.ts`), not on raw rows, because the rules need
  select option names and the rows hold option ids.
- **Register route.** `GET /api/meals/register` refuses an export with incomplete
  entries until the request acknowledges exactly the current count (`ack=N`); the
  page turns that refusal into the confirmation dialog.
- **PDF font.** The built-in font covers German text. A character outside it (for
  example in a foreign name) is reduced to its base letter or "?", and the export
  reports how many characters were simplified.
- **Duplicate check.** A new endpoint `POST /api/upload/check` answers before the
  upload; receipts stored before this change carry no hash and are only caught by
  the soft check on vendor, date and total.
- **Tests.** Unit and component tests run with `pnpm test`. The Prisma queries, the
  migration and workspace isolation are tested against a real Postgres with
  `pnpm test:db`, which needs a local throwaway database and is not part of
  continuous integration (the verify workflow only runs the roadmap check).
- **Still open from the unhappy-path table, by plan in slice 4:** a failed text
  recognition still leaves the uploaded file without a row.

## Reality after slices 4 to 6 (2026-10-07)

- **The app could not be installed before.** The draft said the manifest already
  made the app installable. In production the manifest, its icons and the worker
  script sat behind the login and answered a browser's cookie-less request with a
  redirect. They are public now (they carry no data).
- **Receipt reading is one routine** (`readReceipt` in `src/app/app/actions.ts`) used
  by the first save and by a retake. A failed text recognition still creates the
  row, with the file, status "Pending".
- **Retake** (`retakeReceipt`) swaps the captured photo on the same row and keeps
  meal details and files attached by hand.
- **Queue.** `src/lib/capture/offline-queue.ts` (IndexedDB) is written by three
  parties: the app, the service worker (shared files) and the offline page. A photo
  leaves the queue only after the server has it. A photo that keeps failing can be
  removed by hand after a confirmation.
- **A retake is not queued offline**: it needs its row, so it stays on screen with
  "retry" instead.
- **Service worker** as designed: one cached file, no application code, kill switch
  through `GET /api/client-config` and the `DISABLE_SERVICE_WORKER` variable.
- **Classifier fixture.** The parser test runs a full answer through the real
  parser, but the answer is written to the prompt's contract, not recorded from a
  live call: no model credentials are available where the tests run.
- **Found on the way and fixed:** the exchange-rate recompute filtered the date
  column with strings, which the database rejects; and a review fix on the first
  pull request made the same mistake in the look-alike check. Continuous integration
  now runs typecheck, lint, the unit tests and the database tests.
- **Not verified by a machine, still to do by hand:** camera, home-screen install,
  offline queue and (on Android) sharing on a real phone, and one real upload
  through text recognition and classification in production.
- **Share target** is the last commit of the second pull request so it can be
  reverted on its own. The owner uses an iPhone, where it has no effect; whether to
  keep it is his call.

## Reality after the batch actions (2026-10-08)

Asked for by the owner after the first real use, with 17 entries in the queue: take
receipts that were never a business meal out in one go, and delete receipts from the
page.

- **Queue.** Every entry has a checkbox, there is "Alle auswählen", and a bar with
  the count appears once something is checked. The checked entries and the opened
  entry (the form) are two separate things. Selection logic is pure
  (`src/lib/meals/selection.ts`) and is cut down to the entries still in the list on
  every render, so an entry that left the queue cannot be hit by the next batch.
- **"Keine Bewirtung" for many.** `setMealTypeForRows` in `src/lib/meals/service.ts`
  writes through the same routine as the form save, so the stored state is identical
  to choosing the option in the form: the receipt stays in the books, guests,
  occasion and place stay stored. **Where they are found again:** the meals page
  lists them under "Keine Bewirtung" below the queue and the register, and
  "Wieder aufnehmen" sets the meal type back to an external business meal. The entry
  then returns to the register or the queue exactly as its details stand. The earlier
  meal type itself is not remembered: a receipt that had no type yet comes back as an
  external business meal with its other facts still missing.
- **Delete.** `deleteReceiptRows` removes the stored file first and the row (with its
  file references, selections and guests) only after that succeeded. When the file
  store refuses, the receipt stays complete and is reported, so a row never vanishes
  while its file lives on unreferenced. A file that another row still references is
  kept. The dashboard's own delete still leaves the stored file behind (see the
  roadmap).
- **One receipt at a time without the form.** Both actions sit on every queue entry
  and every register entry. On a queue entry "Keine Bewirtung" acts at once and the
  notice says where the receipt went; on a register entry it asks first, because a
  complete entry carries tax weight. Deleting always asks, names the count and says
  it cannot be undone.
- **A batch never stops at one receipt.** A receipt deleted in another tab and a
  receipt of another workspace are the same to the server (not in this workspace's
  table): skipped, reported, the rest carried out. At most 200 receipts per request.
- **No migration.** Everything is existing cells and existing tables.
- **Not verified by a machine:** the page in a real browser at phone width, and a
  delete against the real file store.

## Reality after the visual polish (2026-10-08)

The owner's review of the batch actions: the checkbox was ugly, ticking one moved the
list, the scroll bars were ugly, the page read as unprofessional.

- **What caused it.** The check box was the browser's own. The batch bar was part of
  the page flow and pushed the list down by 126 pixels when it appeared. The app never
  declared its dark colour scheme, so browsers drew light scroll bars and light native
  controls on a black page. Screen-reader-only labels inside the scrolling list were
  positioned against the page and made the document about 1000 pixels taller than its
  content, which gave the page a scroll bar with nothing to scroll to.
- **Checkbox.** `src/components/ui/Checkbox.tsx`: a real input stretched invisibly over
  a 40 pixel hit area with a drawn box beside it, brushed gold when checked, the mark
  drawn in 140 milliseconds, a mixed state for "Alle auswählen".
- **Nothing moves on selection.** The batch bar and the outcome of an action are
  rendered into a dock fixed to the bottom edge (`src/components/ui/Dock.tsx`); a
  notice without a failure leaves after 8 seconds, a failure stays until closed. Queue
  rows are a fixed two-line grid; opening or checking one changes colours only.
  Measured in a headless browser at 1440 and 390 pixels width: 0 pixels shift of the
  first three rows, the list and the form after checking one entry, all entries, and
  unchecking.
- **Scroll bars.** App-wide in `src/app/globals.css`: `color-scheme: dark`, thin scroll
  bars without a track, gold under the pointer in lists, room reserved where a scroll
  bar appearing would shift content.
- **The confirmation dialog** is rendered into the document body. Inside the page's
  own stacking order it ended up underneath the floating bar on a phone.
- **Kept on purpose:** the queue list still scrolls on its own (capped height on a
  phone, sticky beside the form on a desktop), because with 17 entries the form would
  otherwise sit far below the list. The dashboard table (blue accents, the table
  package's own check boxes) is another page and was not restyled.

## Reality after the receipt viewer and the form fixes (2026-10-08)

From the owner's live use of the queue: receipts scanned sideways could not be turned,
the place stayed empty although the receipt prints it, and choosing the host from the
browser's autofill wiped the place.

- **Why the receipt was a strip in a dark box.** Receipts uploaded with "one receipt
  per page" are one-page PDFs, and the page showed a PDF in a browser frame, which
  cannot be turned, zoomed or fitted. The viewer (`src/components/meals/ReceiptViewer.tsx`)
  draws the PDF page to a picture in the browser with pdf.js (`pdfjs-dist`, loaded
  only when a PDF is opened) and then treats it like a photographed receipt.
- **Rotation** is stored as `rotation` (0, 90, 180, 270, clockwise) in the metadata of
  the file reference (`dt_files.metadata`, next to the content hash). No migration,
  and the stored file is never rewritten. The dashboard's detail panel and its
  fullscreen view use the same viewer and the same stored value; the register export
  turns an appended PDF page and a drawn picture by it.
- **The first-open guess.** Without a stored rotation a page clearly wider than tall
  opens turned a quarter clockwise, because a till receipt is tall. Which way round a
  sideways scan lies cannot be told from its shape, so the guess can be upside down;
  it is not stored, and the first turn the user makes is.
- **Place.** The classifier's answer for the place arrives only when it gives one and
  only on rows filed as a meal at upload. `src/lib/meals/place.ts` reads name, street
  and postal code with town from the header of the recognized text without a model. It
  is the fallback at upload and the prefill of the form for stored receipts with an
  empty place; a stored place is never replaced, it gets the action "Aus Beleg
  übernehmen" instead. Without both a street and a postal code with town nothing is
  offered and the field opens with the vendor name alone. No model call, no cost.
- **Autofill.** The host field carried `autocomplete="name"`, so browsers and password
  managers took host and place for "my name, my address". Both fields now opt out and
  carry names that say what they are, and a change to the place that arrives while
  the focus is elsewhere is dropped. The host is prefilled from the last one used, and
  a host typed on one receipt is offered on the next even before the first save.
- **Layout.** List, form, receipt, with the receipt the widest column at the full
  height of the window; below that width the receipt comes above the form.
- **Batch bar.** The first version floated in the middle of the bottom edge and lay
  on top of the form's date, amount and tip fields. On a desktop it now has a slot of
  fixed height at the foot of the queue column (there whether or not anything is
  checked, kept in view at the bottom of the window), so it covers no field and still
  moves nothing. On a phone it is a full-width bar fixed to the bottom edge, and the
  page keeps more padding below than the bar is tall. Outcome notices appear above
  the queue column as well.
- **Not verified by a machine:** real browser autofill and a real password manager
  (a headless browser has neither), and the place parser on the owner's own receipts.

## Decisions (2026-10-06)

Approved by the owner on 2026-10-06, all six slices to be built.

1. **Base of the 70 percent.** One question per workspace, whether the business is a
   small business under section 19 of the value-added tax act. Yes gives gross, no
   gives net. No default; totals and exports wait for the answer.
2. **Guests.** A contact list from the start, as a small self-contained table behind
   the `ContactStore` interface. A suite-wide CRM model gets its own plan elsewhere;
   no synchronisation is built here.
3. **Shape of the PDF.** Summary table plus one sheet per meal with the receipt image
   and a signature line, built with the `pdf-lib` package.
4. **Share target.** Included (the draft had recommended leaving it out). It brings
   back a service worker, designed as described under "Service worker". Android
   only, because iOS offers no share target to web apps.
5. **Entry date.** True timestamp in the data and the CSV; the printed sheet has a
   blank date and signature line.
6. **Staff and travel meals.** Recorded, kept out of the 70 percent register, shown
   as a separate count.
7. **Export with incomplete entries.** Allowed after a confirmation that names the
   count; incomplete entries in their own block outside the totals.

Still to confirm with the tax advisor before the first export is filed: the amount
above which the receipt must name the host (default 250 euros in the settings).
