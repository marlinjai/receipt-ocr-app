---
title: A receipt reading that sees the page
summary: The language model that classifies a receipt is given the page itself (the image, or the PDF pages) next to the recognized text, and also reads date, total, currency, net and tax lines from it. Its answer is a second reading that the invoice's own arithmetic and the recognized text check; it is never stored on its own word.
type: plan
status: decided
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

**Provider and model.** Production holds the OpenRouter key only, so the call goes through
OpenRouter and no new secret is needed. PDF pages are sent as a file part with the parser pinned to
`native`, so the model receives the pages and not a text extract; images as an image part. The
default model is set in `src/lib/ai-client.ts` and can be changed with `AI_CLASSIFY_MODEL`; no
production setting is needed. Which model, and what it costs per receipt, is measured on the 2025
documents (see "Measured"). The direct Anthropic path (not set up in production) gets the page too,
so both paths read the same way. The `claude-api` reference recommends the largest model by
default; for one page of an invoice the choice here is by measured result and price.

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
  another, with `total_unconfirmed` when no label names any. A page answer that does not stand in
  the recognized text is never stored. Tax lines from the model count only when their figures
  stand in the text.
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

**What is stored.** No new column and no migration. The settled values go into the cells that
exist; doubts go into the review flags (a string list), with two new ones: `date_conflict` and
`page_not_read`. The model's raw answer is not stored. Token counts are logged, document content
never.

**On failure.** The upload never fails because of the model. Provider down or timing out (60
seconds, one retry): the receipt is stored with the text reading and `not_classified`, as today.
The provider refuses the file (a 4xx answer): one more call with the text alone, then
`page_not_read`. File missing, unreadable or over a limit: text alone, `page_not_read`. A refusal
or an answer that is no JSON object: `not_classified`. No recognized text at all: no call, the row
is "Nicht lesbar" as today, because nothing could check the answer.

**A stored receipt.** "Seite neu lesen" in the receipt's detail panel reads the stored file and the
stored text again (`rereadReceipt`). It writes date, total, net, tax rate, currency with its
exchange rate, and vendor. It fills category, account, assignment and the meal facts only where
they are empty, and replaces the name only where it is empty or still the file name. It never
touches the business share, the project or the status. Tax decisions live in the tax module's own
tables and are untouched by construction. A group is refused. The retake of a photo
(`retakeReceipt`) reset the assignment and the business share until now; it keeps an assignment
that is set and a business share that differs from the default of the vendor read before.

**Privacy.** The page goes to the same provider the recognized text already goes to. Nothing new
leaves the system in kind, only in form (the picture of the text instead of the text alone).

## The flow, all four paths

- **Forward:** upload, text recognition, one call with page and text, settle, store, flags.
- **Backtrack:** a retake replaces the file and reads again; fields a person decided stay.
- **Resume:** "Seite neu lesen" on a stored row reads the stored file with the stored text.
- **Re-entry after failure:** a row stored as `not_classified` or `page_not_read` is read again the
  same way; a new reading replaces the old flags and reopens the receipt for confirmation.

## Measured

`scripts/evaluate-page-reading.ts <folder> <table.csv>` runs text recognition, the text reader and
the page reading over a folder of documents and compares date and total with a hand-checked table.
It prints counts and tallies per vendor, never document text. The numbers of the run on the 2025
purchase documents, the model chosen from them and the cost per receipt are recorded below once
the run is done.
