---
title: The invoice number decides duplicates
summary: Every receipt gets its invoice number (Rechnungsnummer), read at upload and backfilled from the stored text. Two receipts of the same vendor with the same number, or with the very same file, are one receipt, handled without asking anybody: at upload the second copy is not kept (its file goes to the receipt that is there), and copies that already exist are archived into the more complete one, reversibly. Only where a number is missing does the review list still ask whether two look-alike receipts are the same purchase.
type: plan
status: decided
tags: [receipts, review, duplicates, upload]
projects: [receipt-ocr-app]
date: 2026-10-29
---

# The invoice number decides duplicates

## Why

The owner, 2026-10-29: "In 'Belege prüfen' we should not need to decide whether receipts are
duplicates: each receipt has an invoice number, which is the unique identifier. The system must
handle that fully automatically."

Today `lookAlikes` (`src/lib/review/reasons.ts`) pairs receipts with the same file hash, or the same
day and total from a vendor that can be the same, and every pair is a question in "Belege prüfen".
No invoice number is stored anywhere. Measured on production (Whiz-Art Media, 1156 receipts with
text): about 79 percent print an invoice, receipt or order number next to a keyword; business-meal
till receipts often print none.

## Decisions (taken by the owner on 2026-10-29)

1. **Every receipt gets an invoice number**, read by the reader with the other fields at upload,
   electronic invoices (XRechnung, ZUGFeRD) from their XML where it carries one. It is compared in a
   normalized form (trimmed, case folded, without spaces and without a leading "#", "Nr.", "No."),
   and shown as printed. Stored receipts are backfilled from their stored text, deterministically
   where that is reliable, through the model only where the code already reads stored text through
   it. Never an invented number: unknown stays empty.
2. **Same vendor (as `sameVendor` judges it) and the same normalized number is the same invoice**,
   handled without asking:
   - at upload the arriving receipt is not kept as a second receipt; the person is told it is
     already there, with a link. A file the kept receipt does not have yet (one with the buyer's VAT
     number, say) is added to it, never lost;
   - pairs that already exist: an automatic pass keeps the more complete receipt (linked payments,
     group membership, filled assignment and category, files, then the older one) and archives the
     other (reversible, never a hard delete), recording which receipt it went into so it can be
     restored.
3. **Different invoice numbers are never a duplicate question.** Known edge, accepted: Lemon Squeezy
   once issued two different invoice numbers for one payment.
4. **Only where either receipt has no invoice number** does today's look-alike question stay.
5. **The same file hash stays an automatic duplicate** (identical file, same receipt).

## Decisions taken while designing (by the implementing session, 2026-10-29, say so if you disagree)

6. **The number is a column of the receipts table, "Rechnungsnummer"**, holding the printed form.
   It is visible, searchable, exported and editable in the grid like every other field, so a person
   corrects a misread number where they see it. The normalized form is derived from that cell by one
   function (`invoiceNumberKey`, `src/lib/extraction/invoice-number.ts`) wherever two receipts are
   compared, instead of a second cell that a grid edit could leave stale. Decision 1's intent
   (compare normalized, show printed) holds without a copy that can disagree with what the person
   sees.
7. **The normalized form also drops dashes, slashes, dots and underscores** between the characters
   ("RE-2026/0042" and "RE 2026 0042" are one number): optical character recognition varies
   separators far more often than two real invoice numbers of one vendor differ by a separator alone.
8. **A weak number is shown but never decides**: fewer than four letters and digits, no digit at
   all, or digits only and fewer than five of them. Such a number ("Nr. 17", "Bon 4711") repeats
   across tills and days; it falls to today's look-alike question instead of archiving a different
   purchase.
9. **Only a number the document labels as its own invoice or receipt number is read**: Rechnungsnummer
   and its spellings (Rechnungs-Nr., Rechnung Nr., Re.-Nr.), Invoice number / No. / #, Receipt number
   / # (as online services print it), Facture, Fattura; on a credit note only its own Gutschriftsnummer.
   Order, customer, contract, transaction and till numbers (Bestellnummer, Kundennummer, Bon-Nr.,
   Beleg-Nr., Trans.-Nr.) are never taken: an order can have several invoices, and a till's numbers
   repeat across its registers and stores. A text that labels two different numbers of the same kind
   gives none, and a label preceded by "zu", "auf", "Storno" or "for" names another document.
10. **A credit note has its own number, never the number of the invoice it corrects**, and a receipt
   with a negative total is never the same invoice as one with a positive total (a credit note's text
   names its invoice's number).
11. **Where the number comes from, in order**: the XML of an electronic invoice; else the deterministic
   parse of the text; else the model's answer, only when the recognized text carries that number as a
   whole token (`carriesInvoiceNumber`). A reading from the page image alone (no recognized text)
   gives no number: nothing can confirm it.
12. **The backfill is deterministic only**: it parses the stored text (an electronic invoice's stored
   text already names "Rechnungsnummer: ..."), costs nothing and makes no model call. The model reads
   the number only within readings the app already makes (upload, retake, "Seite neu lesen"). Each
   receipt the backfill looked at is marked (`receipt_reviews.invoice_number_read_at`), so a second
   run reads nothing again and a number a person removed is not filled back.
13. **A reading fills the number only where the cell is empty** (retake, "Seite neu lesen",
   backfill), like the category and the assignment: a number a person typed is never overwritten. A
   person who wants a new reading empties the cell and reads again.
14. **Keeping the more complete receipt, in this order**: more linked payments, in a group, assignment
   and category filled, more files, more of a person's entries (meal guests, a tax decision for the
   receipt), then the older, then the smaller row id. The archived receipt's payment links move to
   the kept one (where the kept one is not linked to that payment already), and its files the kept
   one lacks are added to the kept one as further references. Both are recorded and undone by a
   restore.
15. **A restore is the person's word that the two are different**: the archived receipt comes back,
   the moved links and added files go back, and the pair is recorded as distinct (as "Beide
   behalten" does). The automatic pass never archives a pair a person said is different, neither for
   the same number nor for the same file. A restored receipt can still be merged with a third receipt
   that carries its number. Restore lives on the kept receipt's view ("Zusammengeführt", with
   "Wiederherstellen"), because archived receipts are shown nowhere else.
16. **"Upload anyway" for an identical file goes**: decision 5 makes the same file the same receipt,
   so the upload page and the phone capture say it is already there, with a link, and offer nothing
   else.
17. **The pass runs where receipts change, never on a read**: after an upload, a retake and "Seite
   neu lesen" (for that receipt), after a person changes a number (the backtrack path), at the end of
   each backfill run (button "Rechnungsnummern lesen" on the receipts page, `POST
   /api/receipts/invoice-numbers`) and daily after the bank sync. Loading "Belege prüfen" never
   archives anything; it simply no longer asks about pairs the pass handles.
18. **Setting one value on many receipts at once is refused for the invoice number column**: a
   number is one receipt's own, and the same value on twenty receipts would archive nineteen.
19. **Two uploads of the same invoice at the same moment** can both be kept (neither sees the other
   yet); the next pass merges them. Accepted: the window is seconds and the outcome is the same.

## Build order

1. The parser and normalization (`src/lib/extraction/invoice-number.ts`) with tests; the column.
2. The reading at upload: the classification answer gets `invoiceNumber`, the settle rule of
   decision 11, the cell.
3. Sameness as pure rules in `reasons.ts`: the automatic pairs (same file, same invoice) and the ask
   pairs (look-alikes where a number is missing). The review list asks only the second kind.
4. The merge pass and the restore (`src/lib/review/merge.ts`, table `receipt_merges`), the upload
   path that keeps no second receipt, the uploader's and phone capture's "already there".
5. The backfill (`src/lib/review/invoice-number-backfill.ts`), its route, button and daily run.
6. The receipt view's "Zusammengeführt" with restore; the grid edit that re-runs the pass.

## Tests (four paths, standard `stateful-flow-testing.md`)

- **Forward**: a text with "Rechnungsnummer: RE-2026-0042" gives that number; an upload of the same
  invoice as a second file keeps no second receipt and adds the file to the first; existing pairs
  with the same number or file are archived into the more complete one with the record.
- **Backtrack and revise**: a person corrects one receipt's number to another number, and the pair
  leaves the look-alike question at once; corrects it to the other receipt's number, and the pass
  merges them; keeps the same number, and nothing changes.
- **Resume**: a backfill interrupted after some receipts, run again, reads only the rest; a third run
  finds nothing left and writes nothing.
- **Re-entry**: a restored receipt is not archived again by the next pass (the pair is distinct now),
  but is merged with a third receipt of the same number; a merge run twice changes nothing the second
  time.
