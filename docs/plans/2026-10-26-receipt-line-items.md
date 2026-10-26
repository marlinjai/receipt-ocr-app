---
title: Every line of every receipt
summary: Each receipt's printed positions (what, how many, what it cost, at which tax rate) are read and stored, and each line gets a kind of purchase finer than the twelve spending categories (groceries, drinks, alcohol, coffee and tea, sweets, drugstore, a meal, a drink in a café). The spending overview shows what the money bought, month by month, across business and private receipts. Receipts already in the app get their lines from their stored text.
type: plan
status: in-progress
tags: [receipts, spending, line-items, ai]
projects: [receipt-ocr-app]
date: 2026-10-26
---

# Every line of every receipt

## Why

The owner, 2026-10-26: "wir wollen für alles Belege, egal ob betrieblich oder privat. Sobald eine
Zahlung gemacht wird und ein Bankkonto das realisiert, muss immer direkt ein Beleg hochgeladen
werden, sodass wir nachvollziehen können, was wir in Supermärkten gekauft haben, was für einen
Kaffee wir konsumiert haben, ob das Essen oder Trinken war. Wir brauchen für jede Ausgabe, jedes
Line Item, eine vollumfängliche Dokumentation und Auswertung unserer Finanzen."

What exists: a receipt for every payment, private ones included, was decided on 2026-10-14 (plan
2026-10-14-personal-spending-and-bank-feed, decision 3) and is built: after every bank fetch and
file import the missing-receipt loop (`src/lib/spending/loop.ts`) finds a matching receipt, looks
in the expenses mailbox, or notifies the owner. What does not exist: the receipt's lines. The
reader stores one short "what was bought" per receipt ("USB-Stick + 2"). `tax_receipt_lines` holds
only the tax splits a person makes, which must add up and change the statement, so it is the wrong
place for a supermarket's thirty positions.

## Decisions (taken by the coordinating session on 2026-10-26, say so if you disagree)

1. **A table of its own, for reading, never for tax.** `receipt_items` (row id, company, position,
   the text as printed, quantity, unit price, gross cents in the receipt's currency, tax rate,
   kind, how it was read). It never changes the statement, the shares or a tax split; those stay
   with `tax_receipt_lines` and the receipt's decision.
2. **Read with the receipt, in the same call.** The classification call
   (`src/lib/receipt-classifier.ts`) also returns the lines, in a strict format, with the deposit
   ("Pfand"), discounts and returned deposit as lines of their own, so the lines add up to the
   total. An electronic invoice (XRechnung, ZUGFeRD) takes its lines from the XML instead.
3. **The kinds of purchase.** Each line gets one kind, finer than the twelve spending categories
   and mapped into them: groceries (Lebensmittel), drinks without alcohol, alcohol, coffee and tea
   (beans, capsules), sweets and snacks, drugstore and hygiene, household, a meal (eating out), a
   drink in a café or bar (coffee, tea, a soft drink), a drink with alcohol out, deposit and
   discount, shipping, software and services, devices and electronics, clothing, other. The list
   is data in one module, with German labels.
4. **The lines must add up, or say why not.** On read the lines are checked against the receipt's
   total; a difference over 2 cents is shown on the receipt ("Positionen ergeben 41,20 €, Beleg
   42,10 €") and in the review list, never silently hidden, and the overview counts the receipt's
   total, never the lines' sum.
5. **Receipts already in the app get their lines** from their stored text, in batches like the
   item backfill (`src/lib/receipt-items.ts`): a run per company from the receipts page ("Positionen
   lesen") and on the daily run, at most a fixed number of receipts per run, a failed read leaves
   the receipt to the next run. A receipt without stored text gets none and is listed.
6. **The overview.** The spending page gets "Was gekauft": per month and per kind, what was spent,
   the top items ("Hafermilch, 23 mal, 41,17 €"), and per shop what was bought there. Business and
   private receipts both count, each in its own company, as today.
7. **A line can be corrected.** The receipt view shows the lines; a person changes a line's kind
   (and the answer is remembered for the same text at the same shop, like the vendor rules), never
   its amount there (the receipt is read again for that).
8. **Cost.** The lines lengthen the existing call's answer; the backfill is one model call per
   receipt (every stored receipt once, a few euros in all), logged with token counts and
   never a line's text.

## Build order

1. Migration (`receipt_items`), the kinds module, the strict parser with its add-up check.
2. The lines in the classification call and from electronic invoices; stored on every read.
3. The backfill of stored receipts.
4. The receipt view's lines, the kind correction, the "Was gekauft" overview.
5. Fresh-agent review, pull request, land-pr. After the deploy, run the backfill on production and
   report how many receipts got lines, how many add up and how many did not.

## Tests (four paths, standard `stateful-flow-testing.md`)

- Forward: a supermarket receipt with deposit and a discount gives lines that add up; a café bill
  gives drinks and a meal; an XRechnung takes its lines from the XML.
- Backtrack and revise: a receipt read again replaces its lines and keeps a person's kind answers
  for lines with the same text; a corrected total shows the difference at once.
- Resume: a reload shows the same lines, nothing recomputed but the add-up check.
- Re-entry: the backfill run twice reads nothing a second time; a failed read is retried on the
  next run and never leaves half the lines.

## Reality (2026-10-26, built on branch feat/receipt-line-items)

What was built:

- **Storage** (migration `0040_receipt_items`, additive): `receipt_items` (one row per printed
  position: text, quantity, unit price, gross cents in the receipt's currency, net cents where the
  source states one, tax rate, kind), `receipt_item_readings` (one row per receipt: lines, no lines,
  no stored text, or failed with an attempt count, plus the lines' sum, the model and token counts)
  and `receipt_item_kind_answers` (a person's kind for a text at a shop). `tax_receipt_lines` is
  untouched. Every write of lines goes through `replaceReceiptLines` (`src/lib/line-items/store.ts`):
  delete, insert and the reading record in one transaction under a per-receipt advisory lock. Both
  row delete paths take lines and reading along.
- **Kinds** (`src/lib/line-items/kinds.ts`): the sixteen kinds of decision 3 with German labels, a
  hint per kind for the model, and the mapping into the twelve spending categories.
- **Reading** (`src/lib/receipt-classifier.ts`): the classification call returns `items` with
  deposit, returned deposit and discounts as their own lines; the parser
  (`src/lib/line-items/lines.ts`) is all or nothing. Every upload, retake and "Seite neu lesen"
  replaces the lines; a reading without a usable list leaves the old lines.
- **Electronic invoices** (`src/lib/einvoice/parse.ts`, `src/lib/line-items/einvoice.ts`): UBL and CII
  lines and document-level discounts and surcharges are read from the XML; the receipt's text now
  lists the positions too.
- **Backfill** (`src/lib/line-items/backfill.ts`): "Positionen lesen" on the receipts page
  (`POST /api/receipts/lines`, 5 receipts per request so a request stays well inside a proxy's time
  limit, the page asks again until none is left) and 40 per company, at most 120 in all, after the
  daily bank sync (`/api/internal/bank-sync`). An electronic invoice stored before this takes its
  lines from its stored XML, not its text.
- **Pages**: the receipt view's "Positionen" section with the kind correction; the review list's
  "Positionen prüfen"; the spending page's "Was gekauft" tab (`?ansicht=gekauft`).

Decided while building, say so if you disagree:

1. **A deposit or a discount has no spending category of its own**: it counts towards the category
   of the largest line of its receipt, so returned bottles lower "Lebensmittel und Drogerie".
2. **A kind answer is applied on read, not written onto the lines.** It is stored per company, shop
   (the row's vendor, case and punctuation ignored) and text, so a receipt read again keeps it for
   every line with the same text, and every other receipt of the shop gets it. Choosing the read
   kind again takes the answer back.
3. **An electronic invoice's lines are checked on net** against the invoice's net total, because
   EN 16931 states line amounts net and per-line rounding of the gross alone can exceed 2 cents. A
   line's gross is its net plus its tax rounded per line. An XML line takes the kind of the model's
   line with the same text (else the one at the same place, else "Sonstiges"): no extra model call.
4. **The difference is worked out on read** against the total the row holds now, so a corrected
   total shows (or ends) it at once. In the review list it is a reason a person can settle with
   "Geprüft" (a café bill whose tip is printed apart never adds up).
5. **The backfill uses the small model** that already names stored receipts' items
   (`ANTHROPIC_ITEM_MODEL`), with up to 24,000 characters of stored text (a longer text is cut in the
   middle and the receipt says lines may be missing). A call that does not get through (provider
   down, rate limit, timeout) counts nothing against the receipt; an unusable answer (malformed, cut
   off, declined) or a request the provider refuses for the receipt itself (a 4xx other than
   authentication, payment, timeout, conflict and rate limit) counts, and after 3 the receipt is no
   longer asked about (its view then points to "Seite neu lesen"). A call that did not get through
   is counted apart and reset by any reading: after 6 in a row (a receipt that times out on every
   run) it is no longer asked about either. One call per receipt and run, within a minute, no retry
   inside the request. A missing key stops the run without counting anything. Receipts never tried
   go first, newest first, then the ones that failed, so a stuck receipt never blocks a batch. A
   receipt recorded without text is read again once it holds text. For an old electronic invoice
   whose model call did not get through, or whose file could not be fetched, nothing is written and
   the next run tries again; after an unusable answer its XML lines are stored as "Sonstiges".
6. **The classification call has room for the lines**: the OpenRouter path got 16,000 output tokens
   (was 8,000), the answer timeout is 90 seconds (was 60, the searching Anthropic turn twice that),
   and the lines are the last field of the answer, so an answer cut off inside them still gives
   every fact, without any line. The model choice is unchanged.
8. **A new reading never replaces stored lines with an empty list** (a blurry retake says nothing
   against lines read before), and a line's kind cannot be remembered on a receipt without a vendor
   (it would apply to every receipt without one).
11. **An electronic invoice's line keeps the sign it is stated with**, turned by the document's kind
   (a credit note's +100 is -100), so an invoice that states negative amounts, which EN 16931
   allows, is money back through its own signs and still adds up.
12. **A receipt deleted while its lines are being read gets none back**: the write checks under the
   receipt's lock that the row still exists, and the delete paths remove lines under the same lock.
9. **A confirmation in the review list settles a difference only when it came after the lines were
   read**; a receipt confirmed in 2025 and backfilled now still shows a difference.
10. **"Was gekauft" leaves out a receipt without a total** (and says how many), converts a receipt's
   lines into euros once as a sum, and lets a credit note's discount follow the credit note's own
   category.
7. **"Was gekauft" lives in the active company**, like the rest of the spending page, and uses the
   period chosen at the top of the page by receipt date. A receipt in another currency counts at its
   stored exchange rate; one without a rate is left out and counted.

Not done here: the backfill on production (the coordinating session runs it after the deploy, with
the button on the receipts page or `POST /api/receipts/lines` signed in as the company).
