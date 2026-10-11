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

## Decisions changed by the review of 2026-10-11

An independent review after the first deploy found the funding rule too wide and several ways
for the same money to count twice or to stay counted. These decisions replace the ones named.
Built on the branch `fix/pay-later-review-findings`.

14. **The funding rule is narrow (replaces 7).** Now `resolveFunding` in `funding.ts`:
    - It holds only on days the service's own list covers: from the first to the last booked day
      of the account that holds the list. Outside them the line on the other account is the only
      record of the purchase and stays an ordinary payment. No days are added after the last
      one: a collection after the end of the list asks, and a person says it is a transfer.
    - A debit on a BANK account naming the service is a transfer, with or without a purchase of
      the same amount in the list, because a bank shows the consolidated collection.
    - A row on a card or on another service's account naming the service ("PAYPAL *shop" on the
      pay-later card) is a transfer only when the service's list holds a purchase of exactly that
      amount booked so that the row lies from 3 days before to 10 days after it (its twin), and
      a purchase is the twin of one row only. Otherwise it may be a guest checkout and stays an
      ordinary payment.
    - Money coming IN from a wallet (PayPal) is balance paid out: a transfer. Money coming in
      from a pay-later service (Klarna) is money back for a purchase, because its list holds no
      refunds: kind `refund`, asked about payment by payment, linked to the receipt as money back.
15. **The rule can be seen and overruled in the screen (adds to 8).** The payments tab lists the
    payments the rule made a transfer, collapsed, with count and sum, each with "Kein Übertrag,
    eine eigene Zahlung" (the payment goes back to what its file says and is asked about again).
    An open payment that names a held service offers "Übertrag zwischen eigenen Konten". Both
    are a re-labelling of the single payment and are taken back under "Von dir umgewidmete
    Zahlungen". Stored in the existing column `kind_override`.
16. **What the rule hides is reconciled (replaces 10).** Per service and year the tab sets the
    bank debits the rule treats as transfers against the purchases the service's list states,
    with the difference named and a table per month with a running difference. The year is
    called out when the difference is more than one euro or one percent of the listed purchases.
    Judged per year, not per month: a pay-later service collects weeks after the purchase, so
    single months never fit. For a wallet only MORE collected than listed is called out: it also
    pays from its balance or a card, so less collected than listed is its normal case and is
    shown without an alarm. A late fee, interest or a purchase missing from the list shows as
    "more collected than listed"; the person marks that debit as a payment of its own.
17. **A purchase cancelled or refunded in full after it was imported stops counting (adds to
    5).** The file names such purchases by identity; a payment stored under one is marked with
    the import that said so (`cancelled_by_batch_id`). It is kept, is in no list, count or sum,
    and cannot be linked. Its links are kept too and count for nothing: the tab lists the
    purchase with the receipt that lost its payment. Undoing that import clears the mark (the
    foreign key does), and payment and link count again. Chosen over deleting the links because
    deleting cannot be undone.
18. **One additive migration (replaces 9), `0019_tax_payment_cancelled`:** one nullable column
    with a foreign key. No row is rewritten and no link is touched.
19. **The same money counts once on a receipt.** A payment and the debit that funds it (its
    twin, see 14) are one sum: linked to the same receipt, only the purchase side counts and the
    debit's link is shown as not counting. Linking the purchase to a receipt whose only link
    sits on that debit moves the link and says so. Any other link that would take a receipt
    more than 8 percent beyond its own amount (the tolerance of the proposals) is refused with
    what is already on it; the screen asks ("Dieser Beleg hat schon eine Zahlung über ...") and
    links on a yes. Several payments on one receipt stay possible. One writer per receipt at a
    time (a transaction-level advisory lock on the receipt's id).
20. **A purchase stored without the service's number is recognized when a later file gives it
    one (adds to 3).** Exactly one stored row without a number and exactly one new row with one
    must agree on day, amount and merchant; the stored row then takes the number as its
    identity and keeps its links. Purchases only: money back is never merged. The same inside one file. With more than one candidate on
    either side nothing is guessed and both stay. In today's file no such pair exists (6 rows
    without a number, none repeated by a numbered row).
21. **Accepting proposals (replaces 12 in part).** One "Übernehmen" and the bulk action use the
    same server path and both record the method `estimate`. The screen sends the pairs the
    person saw; linked is only what is in that list and still a proposal when worked out again
    (for the bulk action: still unambiguous). Each link is checked once more inside its write
    (payment and receipt both still free), so a second tab cannot double it. Each link is its
    own transaction and the answer says exactly how many were linked and how many were left out.
22. **Status words are named one by one (replaces part of 5).** Every status the list is known
    to carry is listed in the reader, including "read", a leftover of the conversion on one row
    that says nothing about the payment and is read as a purchase. A part refund in any spelling
    keeps the purchase in full and is reported after the import, because the list gives no
    amount for it. An unknown status refuses the file and names the word. The currency is read
    whatever its case.
23. **Money back with its purchase's reference is a movement of its own (corrects 6):** its
    identity is the reference plus "refund", so it is no double of the purchase.
24. **The day is the day in German time.** The list states its time zone; today's file is in
    German time on every row and its days stand as written. A list in another zone is moved by
    its time, so a purchase at 23:30 in UTC on 31 December counts on 1 January.

## Decisions from the production run of 2026-10-11

The list was imported on production with the first version (1,128 purchases, 44 proposals
accepted in bulk). What that run showed changed these decisions.

25. **Accepting many proposals is one write (replaces the last sentence of 21).** All links of a
    bulk accept are made in one transaction: payments and receipts locked in one statement each,
    what is stored read once, every pair checked once more, the links written together. The
    first version made one transaction per link and took over 30 seconds for 44 links with the
    database a network away. A second press is a no-op on the server (nothing of the list is
    still free), and the button is locked and says "Übernimmt n Vorschläge …" from the press
    until the answer is in.
26. **One payment for two receipts is not a proposal to accept.** When the sum of two estimated
    receipts of the vendor in the window fits the payment within the tolerance, and fits better
    than either receipt alone, both are shown with "eine Zahlung für mehrere Belege?" and
    without a button; neither the bulk action nor a single accept links them. The person links
    the payment by hand with a part of the amount for each. Sums of two only.
27. **A counterparty stands for the vendor it was linked to.** The list names the product where
    the invoice names the company. Every existing link from a payment out to a receipt pairs the
    payment's counterparty with that receipt's vendor, and later proposals use the pairing
    beside the names. Derived from the links when the page is computed: nothing is stored, so
    there is no migration, and taking the link back takes the pairing back. Chosen over a table
    of pairings because a stored pairing would outlive the link it came from.
28. **An unknown status wording does not refuse the file (replaces part of 22).** The real
    wordings are relative to the export day ("Gestern bezahlt", "Am 3. Sept. bezahlt", "In 13
    Tagen fällig") and open-ended. A wording the reader does not know is read as a purchase,
    counted and named after the import for a look. Dropping a real purchase in silence is the
    worse mistake; a purchase read by mistake is visible and can be marked private. The flag is
    shown once, after the import; it is not stored on the payment.
29. **Money in from a wallet is a transfer only with its counterpart (replaces part of 14).** A
    credit naming PayPal is a transfer only when PayPal's own list shows the same amount leaving
    it without a merchant, from 3 days after to 10 days before the credit; that row of the list
    is then a transfer too. Otherwise the credit is what its file says and is asked about. On
    the real files of 2025 none of the 14 such credits has a counterpart, so all are asked about.
30. **The bank's part of a wallet purchase (adds to 14 and 19).** A bank debit without a
    counterparty whose text names the merchant of exactly one purchase in the wallet's list,
    booked from 3 days before to 10 days after it and no larger than it, is the part of that
    purchase drawn from the bank: a transfer, and the purchase's twin, so both linked to one
    receipt count once. What the PayPal file offers beyond that: it has a row per bank funding
    ("Bankgutschrift auf PayPal-Konto") that points at its purchase, but every such row carries
    the status "Ausstehend" and was left out at import, and an imported file cannot be imported
    again without undoing it (which would drop its links). So the stored data holds no funding
    rows, and the rule works from the bank line's text instead. On the real files of 2025 this
    recognizes 4 of the 269 bank debits without a counterparty.
31. **The list of transfers names the receipt a transfer is linked to**, because a linked
    payment appears in no other list.

## Open question for the owner

**Which day does a pay-later purchase count on?** The booking day is the purchase day (decision
2). For "pay in 30 days" and for instalments the money leaves the bank account later, so a
purchase of December that is collected in January counts in the old year once it is linked.
Under cash-basis accounting (section 11 of the income tax act) that is a tax judgment: paying
with a pay-later service can be seen as paid on the purchase day (the service paid the merchant
and the buyer owes the service, like a credit card), or as paid when the buyer's money leaves.
Not decided here. Until it is, the purchase day stands, and the payments at the turn of the
year are the ones to look at.

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

## Reality (2026-10-11, after the review)

- The first version merged and deployed on 2026-10-11 (squash commit 54fefd8). The fixes above
  are on `fix/pay-later-review-findings`, not deployed.
- On production the fix changes this at deploy, without any import: every bank debit naming
  PayPal outside the days the PayPal list covers (the list covers 2025; the bank lists reach from
  September 2024 to September 2026) is an ordinary payment again and asks. Money the pay-later
  service paid back to the bank becomes a refund that asks for its receipt.
- The real file reads exactly as before (1,128 purchases, 3 left out, the same identities), so
  an import made with the first version stays valid and a repeat adds nothing.
- The database tests ran on throwaway databases of their own. On a fresh database the whole
  suite passes; the five timeouts of the first run came from the shared test database, which
  held about 2,100 tables of earlier runs.

