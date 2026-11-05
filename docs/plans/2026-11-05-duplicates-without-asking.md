---
title: Look-alike receipts settled without asking
summary: Before "Belege prüfen" asks whether two look-alike receipts are one purchase, the app settles it itself. It reads a missing invoice number again (stored text with wider layouts, the stored file name where the text carries it, then the small upload model with the page), and the existing rule merges the same number or separates different ones. Where no number decides, the strongest model compares both pages; a confident "same" merges reversibly, "different" keeps both, anything else stays asked with the model's reason. Every decision is recorded and keyed to the facts it rests on.
type: plan
status: completed
tags: [receipts, review, duplicates, models]
projects: [receipt-ocr-app]
date: 2026-11-05
---

# Look-alike receipts settled without asking

## Why

The invoice number decides duplicates since the plan
[2026-10-29-invoice-number-duplicates](2026-10-29-invoice-number-duplicates.md): the same vendor with
the same number is one receipt, merged automatically, and "Belege prüfen" asks only where a number is
missing ("Mögliches Duplikat"). On production an Adobe receipt (file
"Adobe-Invoice-2026-01-20-IEN2026004022987.pdf") had no number although its stored text carries
"IEN2026004022987": the backfill of 2026-10-29 used fixed text patterns only and missed Adobe's layout
(labels in one column, values in the next), while the model reading at upload read it fine. So the pair
stayed a question for a person. The owner, 2026-11-05: "It should never need us to do this process
manually."

## Decisions (taken with the owner on 2026-11-05)

1. **Read the number again before asking.** For every look-alike pair where one or both receipts lack a
   number: first the fixed patterns on the stored text, extended to the stored file name and to layouts
   like Adobe's; if still missing, the model the upload reads with (Haiku 5.5, page and text), asked only
   for the number. The number is stored on the receipt where its cell is empty, never over a number a
   person typed. Then the existing rule decides: same vendor and same number is merged through the
   existing reversible archive, different numbers are two invoices and the warning disappears.
2. **Only where no number decides after that, the strongest model compares both pages** (Claude Opus 5.5,
   configurable as `AI_DUPLICATE_MODEL`, default `anthropic/claude-opus-5.5` on OpenRouter, and
   `ANTHROPIC_DUPLICATE_MODEL`, default `claude-opus-5-5`, on the direct Anthropic path): same purchase,
   two purchases, or unsure, with a one-sentence reason. "Same" with high confidence merges through the
   same reversible archive; "different" keeps both and the pair is not asked again; "unsure" or any model
   failure leaves the pair in "Belege prüfen" with the reason shown. Never a merge on a failure. What
   decided each pair (the rule, a number read again, the model and its reason) is recorded, visible and
   reversible.
3. **It runs where look-alike pairs arise** (after an upload, a retake, "Seite neu lesen", an edit of the
   vendor, day, total or number) **and as a repeatable operation over all pairs of a company**,
   idempotent, bounded per run, safe to resume.
4. **The chat sidebar's default model is Sonnet 5.5** (`anthropic/claude-sonnet-5.5`, was 4.6).

## Decisions taken while building (by the implementing session, 2026-11-05, say so if you disagree)

5. **A number from the file name counts only where the stored text carries it as a whole token**, and only
   where the name says it is an invoice or a receipt ("Invoice", "Rechnung", "Receipt", and so on; for a
   credit note a credit note word) and names no order, customer or contract. The candidate must be an
   unmistakable identifier: letters and digits mixed, or six digits at least, never a date stamp
   ("Rechnung_20260120.pdf" gives none). Without the text check two receipts named after the day they were
   saved would share a "number" and be merged. The upload uses the same source (after the text's label,
   before the model's answer).
6. **The column below a label** (`columnar` in `src/lib/extraction/invoice-number.ts`): a label that ends
   its line without a value takes the one unmistakable identifier in the next six lines, and none where
   there are two (a customer number in the same box). A value right after its label always wins, so every
   receipt the parser read before reads the same. Dates with a month name ("20-JAN-2026") are never a
   number any more.
7. **The model's number is taken only where the stored text carries it** (decision 11 of the 2026-10-29
   plan holds): a receipt read from its image alone gets no number, and its pair goes on to the comparison.
8. **This overrides decision 12 of the 2026-10-29 plan for look-alike pairs only**: the backfill of all
   receipts stays deterministic; the model reads a stored receipt's number only when that receipt is one of
   a pair that would otherwise be asked about. The receipts the 2026-10-29 backfill already looked at
   (`invoice_number_read_at`) are reached anyway, because the pass starts from the pairs, not from that
   mark.
9. **A pair where one receipt has a number and the other has none after the re-read is compared too**, not
   only pairs where both lack one: the brief said "neither", but the owner's requirement is that nobody has
   to do this by hand, and such a pair is exactly as unanswerable by the rule.
10. **Thresholds**: "same" merges at a confidence of 0.9 or more (`SAME_CONFIDENCE`), "different" ends the
   question at 0.75 or more (`DIFFERENT_CONFIDENCE`); below either the pair counts as unsure. Merging is the
   heavier step (reversible, still an archive), so it has the higher bar.
11. **The model's "different" is not a person's "Beide behalten".** It is stored apart
   (`receipt_pair_decisions`), ends the question in "Belege prüfen", but never stops a later rule: a person
   who types the same number on both still gets them merged. A restore of a model merge is the person's
   word, as for every merge: the pair is recorded as different (`distinct_from`) and the model's decision
   is removed.
12. **Every decision is keyed to the facts it rests on** (`pairFingerprint`: both receipts' vendor, day,
   total, currency, compared number and file contents). A corrected vendor or a new photo makes the
   decision count for nothing and the pair is decided again (the backtrack path of the stateful-flow
   standard). A name change is no new fact.
13. **Bounded and resumable**: per run at most a few model calls (`LOOK_ALIKE_LIMITS`: a request of the
   tools page 6 number readings and 3 comparisons, after a change 2 and 2, daily 20 and 10 per company). A
   receipt is marked (`receipt_reviews.invoice_number_reread_at`, with `invoice_number_source`) once its
   number reading had an answer, so a call that did not get through is tried again next run and one that
   answered is never repeated; a number a person removes later is not filled back. A pair the model kept
   failing on is asked about no more after 3 attempts (`MAX_JUDGE_ATTEMPTS`) and stays for a person with
   that reason. Without any model configured nothing is counted against a receipt or a pair.
14. **No page, no comparison**: a receipt without a file, or a page the model cannot be shown (too large,
   unreadable), makes the pair unsure with that reason and no call; a page the store did not deliver counts
   as a failure and is tried again.
15. **After a change the pass runs after the answer** (`after()` of Next.js), so an upload is not slowed by
   a model call; the upload page may still show the look-alike warning it found, and the pair is settled
   moments later. The repeatable operation over a company is a route plus a button, as the number backfill
   is (the production image is a standalone Next.js build without `tsx`, so a script could not run there):
   `POST /api/receipts/look-alikes`, the button "Duplikate klären" on the tools page, and daily after the
   bank sync, right after the number backfill.

## Reality (2026-11-05)

Built as decided, in one pull request:

- **The number**: `invoiceNumberFromFileName`, `rereadStoredInvoiceNumber` and the column look-ahead in
  `src/lib/extraction/invoice-number.ts`; `settleInvoiceNumber` takes the upload's file name.
- **The models**: `readInvoiceNumberOnly` and `judgeSamePurchase` in `src/lib/receipt-classifier.ts`,
  `getDuplicateModel` and the new chat default in `src/lib/ai-client.ts`.
- **The pass**: `src/lib/review/look-alikes.ts` (`settleLookAlikes`, `settleLookAlikesAfterChange`,
  `dailyLookAlikeSettle`), the pairs from `loadLookAlikePairs` in `src/lib/review/service.ts` (the same
  snapshots and `lookAlikes` as "Belege prüfen"), the model's merge `mergeJudgedPair` in
  `src/lib/review/merge.ts`.
- **The record**: migration `0046_receipt_pair_decisions` (additive: the table `receipt_pair_decisions`,
  `receipt_reviews.invoice_number_reread_at` and `invoice_number_source`, `receipt_merges.decided_by`,
  `decision_note`, `decision_model`). The kept receipt's "Zusammengeführt" says "von der App nachgelesen"
  or "laut Sprachmodell derselbe Kauf" with the model's sentence; "Belege prüfen" shows the reason next to a
  pair the pass could not settle.
- **Where it runs**: `processReceipt`, `retakeReceipt`, `rereadReceipt` (`src/app/app/actions.ts`), a grid
  edit of vendor, day, total or number (`src/app/app/dashboard/actions.ts`), `POST
  /api/receipts/look-alikes` with the button "Duplikate klären" (`src/app/app/tools/LookAlikesPanel.tsx`),
  and daily in `/api/internal/bank-sync`.

Not done here: the run on production. After the deploy the daily run settles every company within days
(10 comparisons per company and day). To settle a company at once, sign in as that company, open
"Werkzeuge" and press "Duplikate klären" (it repeats `POST /api/receipts/look-alikes` until it answers
`remaining: 0`).
