---
title: Every line of every receipt
summary: Each receipt's printed positions (what, how many, what it cost, at which tax rate) are read and stored, and each line gets a kind of purchase finer than the twelve spending categories (groceries, drinks, alcohol, coffee and tea, sweets, drugstore, a meal, a drink in a café). The spending overview shows what the money bought, month by month, across business and private receipts. Receipts already in the app get their lines from their stored text.
type: plan
status: decided
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
