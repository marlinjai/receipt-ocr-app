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

## Which day a pay-later purchase counts on (researched 2026-10-15)

The question: under cash-basis profit determination (Einnahmenüberschussrechnung, section 4 (3)
of the income tax act, EStG) an expense counts in the year it is paid (section 11 (2) sentence 1
EStG). When a pay-later service (Klarna) stands between buyer and merchant, is that the purchase
day or the day the money leaves the buyer's bank account? This replaces the open question that
stood here.

### The finding in plain language

The answer depends on what the service legally does at the purchase (the file shows that only in
part, see "What the real file holds"). What counts under section 11 is the day the payer gives up control over
the money ("Verlust der wirtschaftlichen Verfügungsmacht", official hints H 11, "Allgemeines"):
the day the payer has done everything on his side to make the payment happen.

1. **Card payment (a credit card, the service's card included): the charge day.** A finance
   court ruled that a business expense paid by credit card is paid when the holder signs the charge slip
   (or confirms the payment at the terminal), not when the card issuer later debits the bank
   account. By authorizing the charge the holder has done everything needed; that the bank
   collects later is the card's credit side, not a later payment. This is a lower fiscal court
   (Finanzgericht Rheinland-Pfalz), final, and the prevailing view in the commentary. The
   Federal Fiscal Court (Bundesfinanzhof, BFH) has not ruled on credit cards, and the official
   hints H 11 have no credit card entry. They do say the same for a bank transfer (paid when the
   order reaches the bank, not when the account is debited) and for a cheque (paid when handed
   over or posted), which is the same logic. The service's card is such a card: its terms call
   it a Visa credit card issued by Klarna Bank AB, using it gives the order to pay (section 6.1:
   "Du erteilst mit dem Einsatz deiner Karte die Zustimmung (Autorisierung) zur Ausführung eines
   Zahlungsauftrags"), the service pays the merchant and the holder reimburses the service
   later, by direct debit, by invoice or on the monthly statement (sections 10.1 to 10.3). How
   the holder reimburses does not move the day: the card purchase is paid at the charge.
2. **Instalments financed by the service ("Term Loan"): the purchase day.** The service grants
   the buyer a consumer credit and the merchant is paid at the purchase. An expense paid with
   borrowed money is paid when the borrowed money is paid out to the creditor; the later
   instalments repay the loan and are not expenses (their interest and fees are, when paid). The
   official hint for special expenses says so in so many words (H 10.1: "Dies gilt auch, wenn sie der
   Stpfl. mit Darlehensmitteln bestritten hat", BFH 15 March 1974). That hint is written for special expenses
   (Sonderausgaben) and is applied here by analogy to business expenses; its file number was not
   found, only the official journal reference.
3. **"Pay later" at a shop's checkout (Klarna chosen as the way to pay in the shop, by invoice or
   "In 30 Tagen zahlen", without the card): the day the buyer pays the service, not the
   purchase day.** Here the service does not pay on the buyer's behalf. Its own terms say that the shop assigns its claim to the service ("Der Shop
   tritt die Forderung an die Klarna Bank AB ab", Klarna terms "Jetzt kaufen, später bezahlen!",
   version 3.3.0). The buyer's debt stays the same debt with a new creditor, and the buyer has
   given up nothing at the purchase: no card was charged, no credit line drawn, no order sent to
   a bank. So nothing is paid in the sense of section 11 until the buyer's money goes to the
   service: the day of the bank debit (or the PayPal or other payment) that settles the
   statement holding the purchase. No court has ruled on Klarna or on an assigned purchase
   price; this result follows from the statute, the official hints and the service's terms. The
   purchase day has no support in this case.

The ten-day rule for regularly recurring payments (section 11 (2) sentence 2 with (1) sentence 2)
does not change this: a single purchase is not a recurring payment.

**Assets are outside the question.** For an asset that is depreciated (or written off as a
low-value asset), the cash-basis method follows the depreciation rules, not the payment day
(section 4 (3) sentence 3 EStG). Depreciation starts in the month the asset is acquired, that is
delivered (section 7 (1) sentence 4 EStG). The app already does this: `acquisitionDate` in
`src/lib/tax/assets.ts` is "the day the asset was delivered or made ready. Depreciation starts
here, not at payment." The payment day only decides the year for ordinary expenses (supplies,
subscriptions, services, items expensed directly).

### What the real file holds

Counted on the owner's file (1,131 rows, counts only). In 2025: 489 purchases "Invoice", 1
"Term Loan", 2 "Direct Debit". In 2024: 130 "Invoice", 3 "Term Loan". In 2026 so far: 407
"Invoice", 84 "In 30 Tagen zahlen" (64 of them with the card marked), 1 "Cards", 1 "Direct
Debit".

"Invoice" does not mean case 3. It names how the service is reimbursed (the statement), and both
card purchases and checkout purchases carry it. In 2024 and 2025 the file has no field that
separates the two: `card` is filled only on the 2026 rows read from the service's web pages. A
merchant text in the card network's form (a `*` between the network or wallet name and the shop,
"PAYPAL *shop") marks a card purchase: 109 of the 489 "Invoice" rows of 2025 have one, and
the 83 PayPal purchases charged to the card (see "Reality (2026-10-11)") are card purchases. The
rest are mostly checkout purchases, with card purchases among them whose text has no `*`.

### Decided, say so if you disagree

**Decision 2 (booking day is the purchase day) stands for card purchases and financed
instalments, and does not stand for checkout purchases paid later. The code must change; nothing
was changed in this pull request.** What is to be built:

- Each pay-later purchase is classified, derived on read:
  - **Card** (case 1, purchase day as today): `payment_method` is `Cards`, or `card` is marked,
    or the merchant text has the card network's form (a `*` between two names).
  - **Financed** (case 2, purchase day as today): `Term Loan`.
  - **Direct debit**: the day the debit leaves the bank; the capture day (`activated`) is the
    closest value in the file, a day or two after the purchase.
  - **Checkout, paid later** (case 3): every other `Invoice` or `In 30 Tagen zahlen` row, and any
    unknown wording (the cautious reading, named after the import like any unknown status).
    Its tax day is the day the money leaves for the service: the collection (bank debit, or
    PayPal payment) that settles the statement holding the purchase.
- A person can relabel one purchase the other way ("Mit der Karte bezahlt" or "Auf Rechnung
  bezahlt"), stored like the existing re-labelling in `kind_override`, listed and reversible.
- The residual error is named: a card purchase whose text has no `*` lands on the collection
  day. That error is in the later direction (it never claims an expense before anything was
  paid), it only matters for purchases in the last days of a year, and the person can overrule
  it; the screen lists those December purchases for a look.
- How to find the collection day: the bank debits the funding rule (decision 14) already
  recognizes as the service's collections are the candidates. Match by `statement_number` where
  the bank line carries it; otherwise the first collection on or after the purchase whose amount
  the open purchases of that statement add up to; otherwise the purchase stays on its purchase
  day and is listed as "Einzugstag unbekannt" for a look. Nothing is stored and no migration is
  needed, like the funding rule.
- The proposals for estimated receipts (decision 11) keep measuring their window from the
  purchase day: that is the day on the receipt. Only the year a linked purchase counts in moves.
- The reconciliation per service and year (decision 16) is unchanged: it compares money, not
  tax days.

Why this and not "keep the purchase day": the purchase day would move expenses into a year in
which nothing was paid, which section 11 does not allow and an audit can reverse; the error is
small in amount (only the turn of the year moves) but it is an error, and the app is meant to
produce a return that holds. Why not "always the collection day": for cards and loans the
sources say the purchase day, and moving those would be wrong the other way.

### What it means at the turn of the year

- A purchase on the card in December counts in December, even when the service collects it in
  January (case 1).
- A purchase financed in instalments in December counts in December in full (case 2).
- A purchase at a shop's checkout, paid later, in December that the service collects in January
  counts in **January**, in the new year (case 3).
- The statements that cross the turn of the year (the December 2024 statement, 1,513.12 euros
  collected in 2025, and the December 2025 statement, 924.43 euros collected in 2026, see the
  reconciliation note in `ROADMAP.md`) hold card and checkout purchases together. Only their
  checkout purchases move year, and only the business ones matter: the checkout business
  purchases of December 2024 belong to 2025, those of December 2025 to 2026. Their card
  purchases stay in the year of the purchase.
- Until the change is built, the app counts every pay-later purchase on its purchase day. For
  2025 that means: the checkout business purchases of the December 2025 statement are counted in
  2025 and should be in 2026, and those of the December 2024 statement are missing from 2025.
  Those are the purchases to check by hand before the 2025 return is filed.

### The financed MacBook

The laptop of 25 November 2025 (2,849.00 euros) was bought through PayPal with the purchase
financed by a pay-later loan, so the service's list holds it in full while the bank only shows
instalments. Under case 2 the purchase price is paid when the loan pays the merchant, that is in
November 2025, and the instalments are loan repayments, not expenses. But that day does not
decide its year either: a laptop is an asset, depreciated from the month of delivery (section 4
(3) sentence 3 with section 7 EStG); with the one-year useful life the finance ministry accepts
for computer hardware (the app's method `computer_one_year`) it is written off in the year of
acquisition, 2025. The draft's note "paid via PayPal" is therefore harmless for the amount and
the year, but should say "financed through a pay-later loan, acquired 25 November 2025". Interest
and fees of the loan, if any, are business expenses in the year each is paid, in the business
share of the laptop.

### Sources

Statute and official guidance:

- Section 11 EStG (Vereinnahmung und Verausgabung), paragraph 2, Federal Ministry of Justice,
  gesetze-im-internet.de: https://www.gesetze-im-internet.de/estg/__11.html
- Section 4 (3) EStG (cash-basis profit determination, sentence 3 on depreciation),
  gesetze-im-internet.de: https://www.gesetze-im-internet.de/estg/__4.html
- Official income tax hints H 11 EStH 2024, Federal Ministry of Finance, entries "Allgemeines"
  (control over the money, BFH of 21 November 1989, BStBl II 1990 p. 310), "Überweisung" (BFH of
  6 March 1997, BStBl II p. 509), "Scheck" (BFH of 24 September 1985, IX R 2/80, BStBl II 1986
  p. 284), "Damnum" (outflow at the loan payout, BFH of 10 March 1970, BStBl II p. 453); no entry
  on credit cards or on loan-financed payments:
  https://esth.bundesfinanzministerium.de/esth/2024/A-Einkommensteuergesetz/II-Einkommen-2-24b/6-Vereinnahmung-und-Verausgabung-11-11b/Paragraf-11/inhalt.html
- Official income tax hints H 10.1 EStH 2024, entry "Abzugshöhe/Abzugszeitpunkt" (paid also when
  paid with borrowed money, BFH of 15 March 1974, BStBl II p. 513; file number not found):
  https://esth.bundesfinanzministerium.de/esth/2024/A-Einkommensteuergesetz/II-Einkommen-2-24b/5-Sonderausgaben-10-10g/Paragraf-10/inhalt.html

Case law:

- Finanzgericht Rheinland-Pfalz, judgment of 18 March 2013, 5 K 1875/10, final: credit card
  payment is paid with the signature on the charge slip, not with the account debit. Lower court
  only; no BFH decision on credit cards was found. Reported in AStW 11/2013 p. 771 (IWW):
  https://www.iww.de/astw/rechtsprechung/einnahme-ueberschuss-rechnung-wann-liegt-bei-zahlung-mit-einer-kreditkarte-der-abfluss-der-betriebsausgabe-vor-f70318
- No court decision on Klarna, PayPal "pay later" or an assigned purchase price was found.

Terms of the service (facts about the product, not tax law):

- Klarna, "Klarna Kreditkarte", general terms of the Klarna credit card, version 3.1.0 of 27
  August 2026: a Visa credit card issued by Klarna Bank AB (section 1.4), using it authorizes a
  payment order (section 6.1), the service pays the merchant and the holder reimburses it by
  direct debit, invoice or monthly statement (sections 10.1 to 10.3):
  https://cdn.klarna.com/1.0/shared/content/legal/terms/0/de_de/cardholder

- Klarna, "Jetzt kaufen, später bezahlen!" (invoice terms, Germany), version 3.3.0 of 10 July
  2026: the shop assigns its claim to Klarna Bank AB, the buyer pays Klarna:
  https://cdn.klarna.com/1.0/shared/content/legal/terms/0/de_de/invoice
- Klarna, "Klarna Ratenkauf" (Germany): instalments are a credit Klarna grants, under a signed
  instalment contract: https://cdn.klarna.com/1.0/shared/content/legal/terms/0/de_de/account

Commentary (supports, does not decide):

- Haufe Finance Office, "Einnahmen-Überschussrechnung, Zu- und Abfluss von Betriebsausgaben",
  section 4, overview of outflow by payment type (card: the day of the card payment):
  https://www.haufe.de/finance/haufe-finance-office-premium/einnahmen-ueberschussrechnung-zu-und-abfluss-von-betrie-4-uebersicht-zeitpunkt-des-abflusses-bei-den-unterschiedlichen-zahlungsarten_idesk_PI20354_HI5302761.html

### Built (2026-10-16), decided, say so if you disagree

Built on the branch `feat/pay-later-tax-day`. These decisions were taken while building and
change or add to the list above.

32. **Two stored columns after all (replaces "nothing is stored and no migration is needed").**
    The stored payment kept neither the payment method, nor the card mark, nor the statement
    number, so the classification cannot be derived from what is stored. Migration
    `0030_tax_payment_pay_later_detail` adds two nullable columns to `tax_payments`:
    `source_detail` (JavaScript Object Notation, JSON: the method wording, whether a card is marked, the statement number,
    the purchase's own number) and `pay_method_override` (a person's "card" or "checkout"). No
    row is rewritten. The tax day itself is still worked out on read (`tax-day.ts`).
33. **A person's correction is its own column, not `kind_override` (replaces "stored like the
    existing re-labelling in `kind_override`").** `kind_override` says what a payment is (spend,
    private, a transfer) and its "Zurücksetzen" clears it; one purchase can be both re-labelled
    private and paid by card, so the two answers must not wipe each other. The corrections are
    listed in their own block, "Von dir umgestellt", each with the other answer and
    "Zurücksetzen".
34. **The order of the rules.** A card the list marks wins over the wording (`Cards`, or the
    `card` column filled), because "Invoice" is carried by card purchases too. Then `Term Loan`
    is financed and `Direct Debit` direct debit, whatever the merchant text. Then a `*` between
    two names in the merchant text marks a card. Then `Invoice` and `In <n> Tagen zahlen` (any
    number) are checkout. Every other wording is checkout and named after
    the import ("Unbekannte Zahlungsarten"). The real list has four such wordings besides the
    known ones (`Flexible Amount`, `Fixed Amount`, `Direct Bank Transfer`, an empty one; 6 rows
    of 1,131): read as checkout they stay on the purchase day as "Einzugstag unbekannt" unless a
    collection of their statement's sum exists, which errs in the later direction only.
35. **Purchases imported before the details were kept stay on their purchase day.** They are not
    read as checkout: that would list about 1,100 purchases as "Einzugstag unbekannt" on
    production. A `*` in the stored merchant text still makes one a card purchase. The tab says
    how many there are and that the list is to be read again once.
36. **Reading the list again fills in the details only.** When an import meets a stored purchase
    of the same identity without details, it writes the details and nothing else (one statement
    per 5,000 rows); details already there are never overwritten, with one exception: the
    shorter variant of the list has no card column, so its purchases store the card mark as
    unknown (not as "no card"), and a later longer list fills in that one field. The import says how many it
    filled ("Bei n schon vorhandenen Käufen wurde die Zahlungsart ergänzt"). The very same file
    imported again is no longer refused when it has details to fill in: it fills them, records
    no new import and says so; with nothing to fill it is refused as before. An import limited
    to one year fills in the purchases of every year of the file, and counts as not empty when
    it filled something in. When a purchase listed twice (once from the web pages without a
    number) is merged, a card either row marked stays marked.
37. **How a collection is found, in this order:** a bank line of exactly the purchase's amount
    naming its own number settles that purchase (an invoice paid by transfer; 14 lines of the
    real bank files carry such a number; a part payment naming it settles nothing, the purchase
    stays "unknown"); a bank line naming the statement number settles the statement; otherwise
    the first collection from the statement's last open purchase up to 60 days later whose
    amount is exactly what the statement's open purchases add up to, less money back booked on
    it (card and financed purchases of the statement included: the service collects the whole
    statement). The 60 days keep a later month of the same sum (a subscription) from being
    taken for a statement whose own collection is missing. A bank debit the funding rule pairs
    with a direct-debit purchase is that purchase's own money and settles no statement; a debit
    it pairs with any other purchase still can (the pairing only takes the nearest purchase of
    the same amount, and a checkout invoice is collected outside its window). Numbers are found
    in the bank text whatever punctuation stands in or around them. Each collection settles one statement,
    statements in the order of their last purchase. A collection is a debit the funding rule
    makes a transfer, or one a person marked a transfer whose counterparty names the service (a
    collection after the last day the list covers). A debit a person said is a payment of its
    own settles nothing.
38. **Where the day is used.** The receipt's cash day (`linkedByRow`, and so `paidByRow`) takes
    the tax day of its linked purchase. The ten-day rule (`yearBoundary` and the check behind
    saving an answer, `paymentDayOfRow`) reads the same day; `paymentDayOfRow` now goes through
    `linkedByRow`, so it also counts the same money once and leaves cancelled purchases out, as
    the statement does (it reads all payments of the workspace when the receipt has a link,
    which is slower than before but the same answer as the statement). The reverse charge
    (section 13b of the value-added tax act, where the buyer owes the tax) dates a receipt by
    the same paid day, so it follows the tax day too, which is intended. The list of years
    includes a year a purchase is collected in. Lists,
    proposals, reconciliation, the spending pages and invoice income keep the booking day.
39. **What is listed for a look:** checkout purchases bought in one year and collected in the next
    (in both years' tabs, with "Mit der Karte bezahlt"), direct debits captured in the next year,
    checkout purchases of the year without a collection ("Einzugstag unbekannt", same button),
    the corrections (in the year of the purchase and the year it counts in, each listed once),
    and the count of purchases without details. Private purchases and transfers are left out: they decide no year.

### Taken back (2026-10-17): every pay-later purchase counts on its purchase day

40. **Decided by the owner on 2026-10-17: every pay-later purchase counts on its purchase day,
    however it was paid (replaces decisions 32 to 39 in their effect).** Reasons:
    - The 2025 return was already filed on purchase days. Moving the December 2025 checkout
      purchases to their collection day would count them a second time in 2026. One method
      applied every year is what holds in an audit.
    - The difference is small: it only moves checkout purchases of the last weeks of a year by
      some weeks, and an audit moving them would shift an expense by one year, never lose it.
    - The real files cannot say which purchases a consolidated monthly collection pays (the
      list's `statement_number` is per purchase, no bank line names a statement), so the
      collection-day rule would have reached few purchases anyway.
    The research above still describes the strict reading of section 11 of the income tax act;
    the purchase day is a simplification knowingly chosen and applied consistently since 2025.
    Decision 2 (the booking day is the purchase day) stands again for every pay-later purchase;
    this also replaces the decided block of 2026-10-15 in "Which day a pay-later purchase counts
    on", which said the code must change for checkout purchases.
41. **The code of decisions 32 to 39 is removed** (pull request "fix(finance): every pay-later
    purchase counts on its purchase day"): the classification, the collection matching, the
    correction buttons and the list in the payments tab, and the storing of the list's payment
    details. Kept: `paymentDayOfRow` goes through `linkedByRow`, so the ten-day check counts the
    same money once and leaves cancelled purchases out, as the statement does.
42. **The two columns of migration 0030 stay in the database, unused**, so schema and database
    agree. Dropping them is a separate migration that removes data on production (whatever
    was written between the deploy of pull request #158 and this change), so it waits for the
    owner's yes.

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

## Reality (2026-10-15)

- The review fixes (pull request #80, branch `fix/pay-later-review-findings`: the bounded and
  reversible transfer rule, the same money counting once, bulk accept in one write) merged on
  2026-10-11 as squash commit f23e672. The line above that calls them "not deployed" is
  outdated.
- The day question is answered above. The change it calls for (the collection day for invoice
  and monthly-statement purchases) is not built yet; until it is, the December statements are
  the payments to check by hand.

## Reality (2026-10-16)

- The day rule is built on `feat/pay-later-tax-day` (decisions 32 to 39), not merged when this
  was written.
- Checked on the owner's files, counts and shapes only: **no bank line of the N26 and Tomorrow
  exports carries a statement number** (0 of 109 lines naming the service). The amount rule is
  therefore the one that works on production; the statement match is built as decided and tested
  on an invented line. 14 Tomorrow lines carry a purchase's own number, which the first rule uses.
- **What the owner does once after the deploy:** import the same pay-later list file again into
  the same account. The purchases already stored get their payment details and nothing else of
  them changes, links included; the import says how many were filled in. (Importing it with
  "Nur Zahlungen aus 2025", pull request #141, works as well.) Never undo the earlier import for
  this: that drops the links made on its purchases. Until then every stored purchase counts on
  its purchase day as before, and the tab says how many are waiting.
- **Checked on the real list after the review: its `statement_number` is not the monthly
  statement.** 1,129 numbers for 1,131 purchases, so it is a number per purchase (every
  payment method carries one, the list holds no money back). The amount rule therefore finds a
  collection only where the service collected exactly one purchase. A consolidated monthly
  collection matches nothing, and those checkout purchases stay on their purchase day as
  "Einzugstag unbekannt": the same day as before this change, now listed for a look. Which
  purchases a consolidated collection pays is not in any file the app reads; finding it (the
  service's monthly statement, or a sum over the open purchases before a collection) is open
  and needs a decision on how far to guess.
- Then look at "Tag der Zahlung bei Später-bezahlen-Käufen" for 2025: December purchases on
  invoice whose collection was found count in the next year (a card purchase among them whose
  text did not show the card is put back with "Mit der Karte bezahlt"); the December purchases
  under "Einzugstag unbekannt" are, until the open point above is settled, the ones to check
  by hand before the 2025 return, as before.
- Known limit: a statement paid from PayPal (not from the bank) is no collection by the funding
  rule, which on a non-bank account needs a purchase of exactly that amount. Its purchases show
  as "Einzugstag unbekannt" until a person marks that PayPal payment "Übertrag zwischen eigenen
  Konten"; from then on it counts as the collection (the same path is tested
  with a bank debit after the last day the list covers).

## Reality (2026-10-17)

- Pull request #158 (the collection-day rule) merged on 2026-10-16 and was taken back the next
  day by decision 40. The owner action named in "Reality (2026-10-16)" (import the list again)
  is not needed: nothing reads the payment details any more.
- Open: drop `source_detail` and `pay_method_override` (decision 42), on the owner's yes.
