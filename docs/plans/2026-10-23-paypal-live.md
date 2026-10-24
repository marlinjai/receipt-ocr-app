---
title: PayPal live through the bank interface, foreign currency, and removing an empty account
summary: The PayPal account, fed from PayPal's CSV export so far, can now be continued live through Enable Banking. The list keeps the days it covers, the live feed continues after them, a movement seen by both sources is recognized as one by PayPal's transaction code, the account stays "the PayPal wallet" for the funding rule after the switch, dollar purchases are imported at the reference exchange rate and marked as an estimate until a file supplies the real euro amount, and an account without payments, imports or connection can be removed.
type: plan
status: in-progress
tags: [finance, payments, bank, paypal, enable-banking, currency]
projects: [receipt-ocr-app]
date: 2026-10-23
---

# PayPal live through the bank interface

Owner's request of 2026-10-23. The five things to build were decided by the owner; every
remaining decision below was taken in this session and is marked "decided, say so if you
disagree".

## Background in one paragraph

An account (`TaxAccount`) is fed from export files or from the live bank connection through
Enable Banking (an open-banking aggregator that reads accounts under the European payment
services directive, PSD2; code in `src/lib/tax/payments/bank/`, operations in
`docs/operations/bank-sync.md`). The owner's PayPal account (company "Whiz-Art Media", kind
`payment_service`) is fed from PayPal's CSV export (`paypal_csv`, 559 payments up to
29.09.2026). Starting a live connection on it was refused on purpose (`account_source_unsupported`)
for two reasons: the interface describes the same movements differently, so overlapping days
would store them twice; and the funding rule (`resolveFunding` in
`src/lib/tax/payments/funding.ts`, which makes a PayPal debit on the bank a transfer instead of a
second expense) recognized "the PayPal wallet" only from the `paypal_csv` import format.

A live test on 2026-10-23 (consent on a throwaway account, nothing imported) showed what PayPal
gives over the interface for 89 days: 133 movements (131 booked, 2 rejected), 127 with a
counterparty name, no remittance text, the fields `bank_transaction_code`,
`credit_debit_indicator`, `creditor`, `debtor`, `entry_reference`, `status`,
`transaction_amount`, `transaction_date` (no booking or value date), 127 in EUR and 6 in USD
(without the euro conversion), 6 without a name. One session account, "PAYPAL_BUSINESS_ACCOUNT",
currency "XXX" (several currencies). Klarna offers only its current account over the
interface, not the pay-later purchases, so Klarna stays on its list import.

## The model

1. **Which service an account holds is stored on the import, not guessed from the label.**
   A new nullable column `service` on `TaxImportBatch`. The live fetch sets it to `paypal` when
   the connection's institution is PayPal (its name contains "paypal", case ignored), otherwise
   it stays empty. `heldService` (funding rule, reconciliation, intermediary check) reads the
   format of every import and, for an import of the bank interface, its `service`. Because it is
   on the import, the recognition survives ending the connection (which deletes the connection
   row) and undoing a list import. Decided, say so if you disagree: the alternative of reading
   the connection row fails after "Trennen" when no CSV import is left.

2. **The PayPal account has two sources that may share it**: the CSV list (`paypal_csv`) and the
   bank interface with service `paypal`. `importPayments` allows exactly this pair besides the
   existing pair of bank sources (N26 or Tomorrow file plus the interface). Everything else
   mixed in one account is still `format_mismatch`: a JSON file uploaded by hand onto the PayPal
   account (it carries no service), the PayPal live feed on a bank account, Klarna with anything.

3. **Days: the source that brought a day first keeps it** (the existing rule in
   `coverage.ts`, which works by format: `paypal_csv` and `enable_banking_json` are two
   formats, so it holds for the wallet unchanged). The list covers up to 29.09.2026, the live
   feed reaches 89 days back (to late July), so its rows on 29.07. to 28.09. are left out as
   `covered_by_other_source`, and on the list's first and last day only what goes beyond the
   stored movements is added. Verified by a database test on a wallet account.

4. **Identity of a PayPal movement: PayPal's own transaction code**, read from
   `entry_reference`, for every row that has one and whose code no other row of the same fetch
   repeats (then `sourceHash = referenceHash(code)`, the same scheme the pay-later list uses). A
   row without a code, or with a code twice, keeps the content hash (day, amount or original
   amount and currency, counterparty, text, code). Decided, say so if you disagree: per row, so a
   movement keeps its identity across fetches whatever the other rows of the window look like.
   The adoption of a numbered row onto a stored unnumbered one (`adoptUnreferenced`, built for the
   pay-later list) now only looks at stored rows of the same format, so a live row can never take
   over a CSV row's identity.

5. **A movement seen by both sources is recognized as one by the code.** The CSV stores the
   "Transaktionscode" in `entryReference`. Before the day rule runs, an import of either source
   looks up the other source's stored payments of the account by `entryReference`; a row whose
   code is stored there is the same movement and is left out (counted as `known_from_other_source`).
   For a purchase in another currency the CSV's euro row carries the code of the currency
   conversion and names the purchase's own code as "Zugehöriger Transaktionscode"; the reader
   keeps that related code (not stored, not part of the identity) so the match also finds the
   purchase. Both cases are built and tested, because the live test did not compare the codes:
   - **Codes equal** (expected): the overlap problem disappears, every day is matched by code.
   - **Codes differ**: nothing matches by code, and the day rule of point 3 alone keeps every
     movement once.

6. **Foreign currency.** The reader of the interface skips non-EUR rows (`other_currency`) for
   every bank, and keeps doing so for banks. For the PayPal live feed it reads them: the
   original amount and currency are kept (`originalAmountCents`, `originalCurrency`), the euro
   amount is the original times the European Central Bank (ECB) reference rate of the booking
   day from the rate cache the app already uses for foreign receipts (`fx_rates`, migration
   0002, `getFxRate` in `src/lib/fx-rates.ts`, which fetches a missing rate once from
   frankfurter.dev and caches it), and `amountEstimated = true`. The reader stays pure: the live
   fetch looks the rates up first and hands them to the reader. The identity uses the original
   amount and currency, never the euro amount, so a rate fetched later never changes it.
   - **No rate** (an unknown currency, or the rate service down): the row is left out of that
     fetch, its day becomes a notice "Kurs fehlt" on the connection, and the next fetch starts
     before that day, so the row arrives as soon as a rate exists. Never a guessed rate.
   - **The real euro amount wins.** A later CSV import that recognizes an estimated live
     payment (by code, point 5) writes the CSV's euro amount on it and clears the estimate; links
     stay. When a fetch brings a code the CSV already holds, nothing changes (the CSV amount is
     real). On the list's edge days an estimated row is compared by day and counterparty, not by
     amount, so a dollar purchase is not stored twice when the codes differ.
   - **A link does not settle an estimate.** Today a payment linked to a receipt gives the
     receipt the euro amount the bank charged and settles a foreign receipt for good. A linked
     payment that is an estimate keeps the receipt on the estimate basis (`reference_rate`,
     which already shows "Betrag geschätzt"), so the tax figures never present an estimate as
     what was charged. Decided, say so if you disagree: the alternative of a person typing the
     real amount is not built; the CSV import is the way to the real amount.
   - **The funding rule pairs an estimated purchase with its funding debit within 6 percent**
     (PayPal's conversion margin of about 3 to 4.5 percent over the reference rate, plus the rate
     of the following day), still only when exactly one fits closest. Exact amounts for
     everything else.

7. **Rejected and nameless rows.**
   - Status `RJCT` (rejected) and every other non-booked status: skipped, counted (`rejected`,
     `not_booked`). Decided, say so if you disagree.
   - **Without a name, money out** (a payout to the bank): the funding rule already pairs it with
     the bank's credit naming PayPal of the same amount within the window, and both become a
     transfer. Without such a credit it is asked about like any payment without a name.
   - **Without a name, money in** (a top-up from the bank): new rule, a credit without a name on
     the wallet is a transfer when exactly one debit on another account names the service with
     the same amount from 3 days before to 10 days after; that debit is a transfer anyway (bank)
     or by this pairing (card). Without one it is asked about.
   - The reconciliation per service leaves rows without a name out of "listed": a payout is no
     purchase.

8. **Starting a connection, by what the account holds** (`startConsent`):

   | The account holds | PayPal institution | Any other institution |
   |---|---|---|
   | nothing | allowed | allowed |
   | a `paypal_csv` import, or a live import with service `paypal` | allowed | `institution_mismatch` |
   | a `klarna_csv` import | `account_source_unsupported` (Klarna's purchases are not offered) | same |
   | a bank file or a bank live import | `institution_mismatch` | allowed |

   The refusal text for a list-fed account now says PayPal can be connected and Klarna cannot.

9. **"Konto entfernen".** A button on an account in the payments tab, shown only when the
   account has no payments, no imports and no live connection, with a confirmation. The
   service (`deleteAccount`) checks again under the account's row lock (the same lock an import
   takes, so an import arriving at the same moment cannot be lost) and refuses with
   `account_not_empty` otherwise. A connection must be ended first ("Trennen"); the account is
   never removed together with a connection. A share of the account with another company goes
   with it (there is nothing to share). Workspace-scoped like every finance write.

## Unhappy paths

| Situation | What happens |
|---|---|
| Consent expired or revoked | Unchanged: the connection reads `expired`/`revoked`, the payments stay, "Freigabe erneuern" renews. The service stays recognized (it is on the imports). |
| PayPal refuses (consent cancelled, rate limit, error) | Unchanged handling of the connection; nothing is imported. |
| A day covered by both sources | The source that brought it first keeps it; same code means same movement in both directions; on edge days only what goes beyond the stored movements is added. |
| A list imported after the live feed started | Its rows on live days: recognized by code (estimates take the real amount) or left out by the day rule. Its days after the live feed's last day are read as usual. |
| Undoing an import | Unchanged rule: the list cannot be undone while a later live import relies on its days (`batch_has_later_source`); a live import can be undone while nothing later relies on it. A real amount written by a CSV import onto a live payment stays when that CSV import is undone (the amount is real; the estimate does not come back). Decided, say so if you disagree. |
| A currency the rate cache does not know | Left out of that fetch, notice "Kurs fehlt" with the day, retried on every fetch; never imported with a guessed rate. |
| The switch back to file import | "Trennen", then import the CSV: point 5 and the day rule apply, nothing stored twice, estimates replaced by real amounts where recognized. |
| PayPal live on an account fed from a bank, or a bank on the PayPal account | Refused at the start (`institution_mismatch`), and the import refuses the mix as well. |
| "Konto entfernen" on an account that got a payment a moment ago | Refused under the lock (`account_not_empty`), the screen reloads. |

## Tests (the four paths of the stateful-flow standard)

Database tests (`src/lib/tax/payments/bank/__tests__/paypal-live.dbtest.ts` and additions to
`payments.dbtest.ts`), unit tests for the reader and the funding rule.

1. **Forward**: list up to a day, consent at PayPal, first fetch: list days stay the list's,
   later days arrive; a USD purchase arrives with its estimate and original amount; a PayPal
   debit on the bank is a transfer and twins with the live purchase; the reconciliation counts
   the live purchases.
2. **Change an earlier input**: a CSV imported after the live feed replaces an estimate with the
   real amount (codes equal); counter-case: the same CSV imported again changes nothing and an
   EUR live payment keeps its amount. Codes differ: nothing matched by code, the day rule keeps
   every movement once.
3. **Resume**: a fetch without a rate leaves the day as a notice; the next fetch, with the rate
   in the cache, imports the row and the notice goes. A renewed consent continues.
4. **Re-entry**: "Trennen" and a new CSV import (switch back); a live import undone and fetched
   again; an account removed and a new one with the same name created.

Plus workspace isolation of `deleteAccount`, the start gates of point 8, and the two cases of
point 5.

## Accepted on purpose

- **"Konto entfernen" racing an import is not tested as a real race.** Vitest runs one test at a
  time against the database, so two transactions cannot be made to meet reliably. The guard is the
  account row lock that `deleteAccount`, `importPayments` and now `startConsent` all take; the
  sequential cases (`account_not_empty` with payments, imports or a connection; empty again after
  every import was undone) are tested.
- **The 559 PayPal payments already stored carry no related code** (`relatedReference` is new).
  For them a live dollar purchase is matched by the day rule and, on the list's last day, by day
  and counterparty within the tolerance. A live row dated after the list's last day would be stored
  beside its list row; the live test of 2026-10-23 did not compare dates. Only a foreign purchase
  around the list's last day (29.09.2026) can be affected. If it happens, undoing that live import
  and importing a fresh list export (which stores the related code) settles it.
- **A real amount stays when the list that wrote it is undone** (decided above), and so do the
  links scaled to it.

## Reality (2026-10-24)

What was built differs from the decisions above in these points, all found in the review rounds:

- **Links follow the real amount.** When a list gives an estimate its real euro amount, every link
  of that payment (of every company, for a shared payment) is scaled to the new amount, the rounding
  difference on the last link, so a receipt paid in full stays paid in full and nothing is left
  open (`settleEstimate` in `src/lib/tax/payments/service.ts`).
- **The related code is stored.** Migration 0036 also adds `tax_payments.related_reference`: the
  list's euro row of a foreign purchase keeps the purchase's own code there, so the code match of
  point 5 works in both directions (the plan had it "not stored").
- **Days a fetch holds in part.** Migration 0036 also adds `tax_import_batches.partial_days`: the
  days a fetch left a movement out of (no rate, or unreadable). An import of the other source
  compares its rows on those days like on an edge day, so a movement in a currency without a rate
  is not lost to the day rule and arrives from the list with its real amount. "Erledigt" on a
  missing rate now sticks like it does for an unreadable day and stops holding the fetch back.
- **The estimate pairing on edge days checks the amount** within the 6 percent tolerance of point
  6, not only day and counterparty, so a second purchase of the same merchant is never taken for it.
- **A top-up never takes the bank debit from its purchase.** The top-up rule of point 7 decides
  only the credit; the debit is still paired with its purchase like any debit naming PayPal, and
  becomes a transfer by the top-up only when nothing else makes it one. Two equally close debits
  leave the top-up asked about.
- **`startConsent` writes the connection under the account lock** and checks the gate of point 8
  again there.
- **The reconciliation leaves every wallet row without a name out of "listed"**, also a payout no
  bank credit pairs with (point 7).
- Rates are looked up in parallel; a rate service that fails is a missing rate, never a failed fetch.
- **Ties are refused.** Of two estimated purchases within the tolerance the one closer in amount is
  the twin of a funding debit; two equally close give none (the debit stays a transfer).
- **A wallet movement without a readable currency** is an unreadable row (a skipped day and a day
  the import holds in part), never left out in silence.
- **A refused "Konto entfernen" reloads the screen**, so the button goes once the account holds
  something.
- Links are scaled by largest remainder; a link that comes to nothing is removed. A row that settles
  an estimate is counted as settled, not again as covered.

Tests live in `src/lib/tax/payments/bank/__tests__/paypal-live.dbtest.ts` (database, the four
paths plus gates, removal, links, partial days) and `src/lib/tax/payments/__tests__/paypal-live.test.ts`
(reader, funding rule, edge days), not in `payments.dbtest.ts`. Two tests in `bank.dbtest.ts`
follow the changed expectations (the new `unrated` notice; `institution_mismatch` for a bank on the
PayPal list account).
