---
title: A receipt reading that sees the page
summary: The language model that classifies a receipt is given the page itself (the image, or the PDF pages) next to the recognized text, and also reads date, total, currency, net and tax lines from it. Its answer is a second reading that the invoice's own arithmetic and the recognized text check; it is never stored on its own word.
type: plan
status: in-progress
tags: [receipts, reader, vision, extraction, review]
projects: [receipt-ocr-app]
date: 2026-10-11
---

# A receipt reading that sees the page

## Why

Text recognition returns labels and amounts in separate runs. The text reader settles a total from
the invoice's own arithmetic (net plus tax equals a printed total) and ranks dates by their label
(merged 2026-10-11). What it cannot settle: a total that only its position on the page pairs with
its label, a document whose totals the torn text loses, and a model answer from text cut at 6,000
characters. A model that sees the page can tell which amount stands next to "Total". It can also
be wrong, so its answer is checked.

## What is built

On upload, and on request for a receipt that is already stored, the one model call that classifies
the receipt gets the page as well:

1. The file is fetched from the storage service on the server (the id is checked against the
   session's workspace first), cut to the limits below, and sent with the recognized text.
2. The model answers what it answers today (name, vendor, category, assignment, tax rate, tax
   lines, meal facts, total) plus the invoice date, the currency, the net and whether the
   document states a total at all.
3. `src/lib/receipt-reading.ts` settles the fields from the two readings. It is one pure function,
   used by the upload, by the new reading of a stored row and by the evaluation script.

## Decisions (decided by the session, say so if you disagree)

**One call, not two.** The page goes into the existing classification call. A second call would
pay the prompt and the answer twice and leave two model opinions to reconcile. The text is still
sent with the page: it costs little, and it is what the answer is checked against. The old
experiment behind `USE_MULTIMODAL_OCR` (a model in place of text recognition, answer trusted
blindly, never switched on in production) is removed, because this replaces it.

**Provider and model.** Production holds the OpenRouter key only (checked through the secrets
proxy: no Anthropic key, no model setting), so the call goes through OpenRouter and no new secret
is needed. PDF pages are sent as a file part with the parser pinned to `native`, so the model
receives the pages and not a text extract; images as an image part. The model is **Claude Haiku
5.5** (`anthropic/claude-haiku-5.5`), the default in `src/lib/ai-client.ts`, changeable with
`AI_CLASSIFY_MODEL` (it no longer follows `AI_MODEL`, the chat model); no production setting is
needed. It was chosen by measurement (see
"Measured"): on the 2025 documents it read every date and every total that Claude Sonnet 5.5 read
on the sample, at a twentieth of the price. The `claude-api` reference recommends the largest
model by default; for one page of an invoice whose answer is checked anyway, the measured result
decides. The direct Anthropic path (not set up in production) gets the page too, so both paths
read the same way. Structured output is not requested: the prompt and the tolerant parser that
production already relies on stay, so a model without that feature cannot fail every upload.

**Limits.** A PDF of up to 6 pages is sent whole. A longer one is sent as its first 3 and last 2
pages (the head with vendor and date, the end with the totals), built with `pdf-lib`. A file over
8 MB after that, an image over 3.5 MB or of a type other than JPEG, PNG, WebP or GIF is not sent.
Photos are already scaled to 2,000 pixels on the long edge in the browser before upload, so no
server-side scaling is added. Beyond a limit the receipt is read from the text alone and says so
(flag `page_not_read`).

**How the answer is checked.**

- *Total.* A total the invoice's arithmetic proves stands; a differing page answer raises
  `total_conflict`. New proofs the page answer can complete, all on printed figures only: its total,
  net and tax all stand in the recognized text and add up; or its total stands in the text above
  the tax groups and the total less the tax is printed too (duties next to taxed services, the
  customs invoice). Where nothing is proven and the page answer stands in the text, it is taken:
  without a flag when a label names the same amount, with `total_conflict` when a label names
  another (also where the page answer is one labelled amount and a larger one is labelled further
  down, an invoice with its total above a usage table), with `total_unconfirmed` when no label
  names any. A page answer that does not stand in the recognized text is never stored. Tax lines
  from the model count only when their figures stand in the text. Every reading says what its
  total rests on (`basis`), so a wrong total can be traced to its rule.
- *No total.* When the model saw the page and says the document states no total (a leasing
  application with a monthly rate only), an unproven label reading is dropped and the amount stays
  empty, which the review list shows as "Betrag fehlt". A proven total stands and raises
  `total_conflict`.
- *Date.* A date the text labels (invoice date, plain "Datum", order or payment date) stands; a
  differing page answer raises the new flag `date_conflict`. Where the text has no date or only an
  unlabelled or service-period one, the page answer is taken if that day is printed in the text.
  Otherwise the text date stands with `date_conflict`, or the date stays empty.
- *Currency.* A currency the text settles stands. Otherwise the page answer is taken if its code
  or sign is in the text.
- *Vendor.* Unchanged: `chooseVendor` already checks the model's name against the text.

**The review list after a page reading.** The review list reads the stored text again without a
model and offers what differs as "Neue Lesart". A total the page reading settled (the customs
invoice) must not be offered back as the text's 57.09: where the reader, handed the stored total
as the page's, settles on exactly that total without a conflict, the stored total stands and its
net and rate are what is compared.

**What is stored.** No new column and no migration. The settled values go into the cells that
exist; doubts go into the review flags (a string list), with two new ones: `date_conflict` and
`page_not_read`. The model's raw answer is not stored. Token counts are logged, document content
never.

**Whose file.** The file id comes from the browser. Before its bytes are fetched and shown to a
model, it must be a fresh upload (referenced nowhere) or referenced by the session's workspace;
`processReceipt` and `retakeReceipt` refuse anything else. Until now a receipt could be saved with
another workspace's file id.

**On failure.** The upload never fails because of the model. Provider down or timing out (60
seconds, one retry): the receipt is stored with the text reading and `not_classified`, as today.
The provider refuses the file (a 4xx answer): one more call with the text alone, then
`page_not_read`. File missing, unreadable or over a limit: text alone, `page_not_read`. A refusal
or an answer that is no JSON object: `not_classified`. No recognized text at all: no call, the row
is "Nicht lesbar" as today, because nothing could check the answer.

**A stored receipt.** "Seite neu lesen" in the receipt's detail panel reads the stored file and the
stored text again (`rereadReceipt`). It writes date, total, net, tax rate, currency with its
exchange rate, vendor, and the printed tax groups of a receipt that is no meal. It fills category,
account, assignment and the meal facts only where they are empty. It replaces the name only where
the reader built it: empty, still the file name, or stating the total that is now read
differently. The status moves on only from "Pending". It never touches the business share or the
project. Tax decisions live in the tax module's own tables and are untouched by construction. A
group is refused. When the model does not answer, or cannot be given the page, nothing is written
at all and the person is told so: a reading without the page is not what was asked for. The retake
of a photo (`retakeReceipt`) reset the assignment and the business share until now; it keeps an
assignment that is set and a business share that differs from the default of the vendor read
before.

**Privacy.** The page goes to the same provider the recognized text already goes to. Nothing new
leaves the system in kind, only in form (the picture of the text instead of the text alone).

## The flow, all four paths

- **Forward:** upload, text recognition, one call with page and text, settle, store, flags.
- **Backtrack:** a retake replaces the file and reads again; fields a person decided stay.
- **Resume:** "Seite neu lesen" on a stored row reads the stored file with the stored text.
- **Re-entry after failure:** a row stored as `not_classified` or `page_not_read` is read again the
  same way; a new reading replaces the old flags and reopens the receipt for confirmation.

## Measured

`scripts/evaluate-page-reading.ts <folder> <table.csv>` runs what an upload runs (text recognition,
the text reader, the model call, the settling) over a folder of documents and compares date and
total with a hand-checked table. It prints counts and tallies per vendor, never document text, and
can go on from a state file when a run is cut off.

Run on 2026-10-11 on the 2025 purchase documents: 235 documents (296 table rows less 61 marked
as duplicates), all PDF, hand-checked date and total each.

| Reading | Dates right | Totals right | Wrong totals | Cost per receipt |
|---|---|---|---|---|
| Text reader alone, no model | 218 of 235 | 223 of 235 | 9 wrong, 3 missing | none |
| Before: text and Claude Sonnet 4.6 reading the text alone (production until now) | 218 of 235 | 226 of 235 | 9 wrong | 0.0096 US dollars |
| After: text and Claude Haiku 5.5 seeing the page | 235 of 235 | 235 of 235 | none | 0.0008 US dollars |

- The 17 wrong dates of the text reading (16 of them one telephone provider's invoices) carried no
  flag at all before. The 9 wrong totals before were spread over four vendors, the customs invoice
  among them, and 8 of the 9 raised a conflict.
- After: 11 of the 235 totals are stored with a flag for a look (8 `total_conflict`, 3
  `total_unconfirmed`), all 11 correct. No wrong total and no wrong date without a flag. One
  document could not be given to the model (`page_not_read`) and was read from its text.
- The sample of 40 asked for first (the customs invoice, three Namecheap and three Cursor invoices,
  the order page with "Total" and "Grand Total", both leasing papers, the restaurant receipt)
  came out 40 of 40 for date and total with Claude Haiku 5.5 and with Claude Sonnet 5.5; Sonnet
  cost 0.0153 US dollars per receipt, Haiku 0.0008.
- Reproduced: two full runs with the same code gave the same tallies, apart from one answer in
  the first that was no JSON object (stored as `not_classified`).
- What the number does not say: the last rule (a page answer that is one of two labelled totals
  stands) was written after the first full run showed three invoices of one vendor overruled by
  the text. The 235 of 235 is therefore measured on the documents the rule was written against,
  not on unseen ones. The first full run, before that rule, had 232 of 235 totals right and the
  three wrong ones flagged.
- All 235 documents are PDF files. Photos of paper receipts uploaded as images are covered by
  tests on invented documents only, not by this measurement.
- Cost of the whole measurement: about 4 US dollars, of which 2.25 for the "before" run.
