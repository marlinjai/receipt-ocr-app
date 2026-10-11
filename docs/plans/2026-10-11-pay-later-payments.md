---
title: Pay-later purchases as payments, one rule for money that only funds another account
summary: The purchase list of the pay-later service (Klarna) becomes a payment source like the bank and PayPal files. A debit that only funds another imported payment account (PayPal's debit on the bank, the pay-later service's settlement, a PayPal purchase charged to the pay-later card) is recognized as a transfer between own accounts by one rule. Receipts whose euro amount is an estimate get a proposed payment, accepted one by one or all at once. Linking a payment no longer redraws thousands of list entries.
type: plan
status: in-progress
tags: [finance, tax, payments, import, matching, performance]
projects: [receipt-ocr-app]
date: 2026-10-11
---

# Pay-later purchases as payments

Follows `docs/plans/2026-10-07-finance-tax-dashboard-and-advisory.md` (slice 3, payments). Built
unattended on 2026-10-11; every decision below was taken without asking and can be overruled.

## Why

51 receipts of 2025 stand on an estimated euro amount because they were paid with the pay-later
service's card. The bank shows only that service's consolidated settlements, never the single
purchase. The purchases are in the service's own list, which the app could not read.

Importing that list creates a second problem, which already exists for PayPal: the purchase and
the later debit on the bank are the same money. Today the bank-side debit shows up as an open
"payment without a document", so a PayPal purchase is counted twice in the payment view.

## What is built

1. **A fourth file source, `klarna_csv`.** Same guarantees as the others: read whole or not at
   all, idempotent, every import can be undone, a wrong file is refused in German.
2. **One funding rule.** A payment whose counterparty names the service of ANOTHER imported
   payment account of the workspace is a transfer between own accounts.
3. **Proposals for estimated receipts**, with one action that accepts every unambiguous one.
4. **A payments page that stays quick with a year of payments.**

## The file

The service offers no table export. The file is the owner's conversion of the service's data
extract (the copy of personal data under the General Data Protection Regulation, GDPR) merged
with details read from the service's web pages. It exists with 13 and with 17 columns.

- One row is one purchase. Columns read: `created_date` (the purchase day), `activated` (the day
  the merchant captured it), `amount` (always positive, point as decimal sign), `currency`,
  `merchant`, `items`, `payment_method`, `status`, `payment_reference`, `statement_number`.
- Not in the file at all: refunds, part refunds, the settlements the service collects from the
  bank, single instalments. `settled` is always empty. Those movements only exist on the bank or
  PayPal side.

## Decisions

1. **Recognized by column names, not by position.** Six names must be present
   (`created_date`, `amount`, `currency`, `merchant`, `status`, `payment_reference`); extra or
   reordered columns do not matter, so both variants of the file are read. There is no
   other-language variant to support because the service has no export of its own; status words
   are read in German and English.
2. **Booking day is the purchase day**, the capture day is kept as value day. In 2025 the capture
   follows the purchase by 0 to 3 days in 485 of 492 rows, and the receipt carries the purchase
   day, so this is the day the proposal window is measured from.
3. **Identity is the service's payment reference** where a row has one (unique in the file), so
   the same purchase from the 13-column and the 17-column file is stored once. A row without one
   falls back to the identity the other sources use (day, amount, names, order of appearance).
   The identity of N26, Tomorrow and PayPal rows is NOT touched: changing it would double the
   payments already on production at the next import.
4. **A purchase paid in instalments is one payment of the full amount on the purchase day.** How
   the service collects the money is a transfer (decision 7).
5. **Rows left out, counted and reported:** another currency; a purchase the merchant has not
   processed yet (`not_completed`); a cancelled or fully refunded purchase (`cancelled`); a zero
   amount; a second row with the same payment reference (`duplicate_row`). A part refund is not
   in the file, so such a purchase stays in full and the refund is linked from the bank side by
   hand, as for every other source.
6. **A negative amount** (not in today's file) is read as money back, kind `refund`.
7. **The funding rule, one place (`fundedAccount` in `src/lib/tax/payments/funding.ts`, applied
   when payments are loaded).** Every account knows which service it holds from the format of its
   imports: `paypal_csv` means PayPal, `klarna_csv` means Klarna. A payment on any OTHER account
   whose counterparty contains that service's name as a word is `own_transfer`, in both
   directions. That covers PayPal's debit on the bank, the pay-later settlement on the bank, a
   PayPal purchase charged to the pay-later card, and money PayPal pays back to the bank.
   Chosen over the account's label because the label is free text ("Mein Zahlungsdienst") and
   the format is evidence. The rule only applies while such an account has an import: without
   the service's own list the bank debit is the only record and keeps asking.
8. **Order of precedence for what a payment is:** the counterparty answer "own account", then a
   person's re-labelling of the single payment, then the funding rule, then what the file says.
   Unchanged except for the new third step.
9. **No migration.** The rule is derived on read, the link method is free text. Nothing stored is
   rewritten: all payments and all links made by hand stay valid. A link that sits on a payment
   which now counts as a transfer keeps counting for its receipt and stays listed under
   "Zuordnungen", where it can be taken back.
10. **A fee of the service that is collected together with a settlement** is part of the transfer,
    because the bank line does not show it separately. It is not claimed. Nothing is built for it.
11. **Proposals for estimated receipts** (`proposeEstimateMatches` in `match.ts`): a receipt whose
    euro amount is an estimate and that has no link; a payment out, of kind spend, with no link,
    whose counterparty is not answered as private; the receipt's vendor in the payment's
    counterparty or text (or the counterparty's name in the vendor); booked from 3 days before to
    10 days after the receipt; amount within 8 percent of the estimate. Unambiguous means the
    receipt has exactly one such payment and the payment fits no other open receipt of that
    vendor (a euro receipt with the exact amount counts as a fit too). Proposals do not wait for
    the counterparty question: the vendor on a receipt is the evidence.
12. **Nothing is linked silently.** Every proposal is listed with a button; "Alle n eindeutigen
    Vorschläge übernehmen" links the unambiguous ones. The server works the list out again and
    never trusts the browser's. Such a link carries the method `estimate`.
13. **Speed.** Measured first (see "Measured" below), then fixed where the time went.

## Tests

Parser and matching as unit tests; the import flow against a real database on all four paths of
`standards/stateful-flow-testing.md`: forward (import, proposal, accept), change an earlier input
(undo removes payments and links, the proposal and the bank-side question come back; an
overlapping file adds only what is new), resume (the same file is refused, a reload shows the
same state), re-entry (a refused file leaves nothing behind, import works again after an undo,
accepting twice links nothing twice). Every fixture row is invented.

## Measured

Production may not be touched, so the time was measured on a local throwaway database seeded with
invented rows: 2,150 payments on three accounts, 550 receipts, 120 counterparties answered as
business, which leaves 890 open payments. The page was drawn in the test browser environment
(jsdom), so the render figures compare before with after and are not browser times.

| Step of one manual link | Before | After |
|---|---|---|
| Server: check that the receipt is the workspace's | 2,499 ms | 47 ms |
| Server: the link including that check | 1,795 ms | 52 ms |
| Server: compute the statement that is sent back | 110 to 130 ms | 81 to 100 ms |
| Page: entries of the receipt picker in the document | 489,500 (550 per open payment) | 0 until a picker is opened, then 550 |
| Page: redraw after the link, 200 open payments drawn | 892 ms | 33 ms |
| Page: redraw when the buttons are disabled, 200 drawn | 1,013 ms | 29 ms |
| Page: redraw after the link, all 890 drawn | out of memory | 52 ms |

Where the time went, and what was done:

1. **The page.** Every open payment carried its own picker with every receipt of two years. One
   action redraws the list three times (buttons off, new statement, buttons on), so the cost
   was paid three times. The picker is now drawn for one payment at a time, behind "Von Hand
   zuordnen".
2. **The row check.** The table package's single-row read is not told which table the row is in
   and asks every table of the database in turn, one query each (1,900 tables in the test
   database; the number on production is not known here). `loadReceipts` now reads one row from
   the workspace's own receipts table, which is one query. This also serves every other
   single-receipt action of the finance area.
3. **Not the cause:** computing the statement (about 0.1 seconds) and the proposals. The answer
   of an action is still the whole statement (815 kB for the seeded year); that was left as it is
   because it is how every finance action keeps the screen free of figures worked out in the browser.

## Reality (2026-10-11)

- Built on the branch `feat/pay-later-payments`, not deployed, nothing imported on production.
- The real file was read locally for counts only: 1,128 purchases in the 17-column file, 3 left
  out as not processed, every purchase of the 13-column file found again under the same identity
  in the longer one. Of the 492 purchases of 2025, 83 are PayPal purchases charged to the
  pay-later card, which count as transfers once PayPal's list is in the same workspace.
- `pnpm check:roadmap` fails on two lines of `ROADMAP.md` that passed their 30 days on
  2026-10-11 (the machine path to tenant-scoped authentication and the workspace dropdown). They
  are not part of this work and were not re-confirmed without the owner.
