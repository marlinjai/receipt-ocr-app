---
title: The filed return decides the counterparties
summary: The app classifies counterparties from what the company already knows for sure before it asks a model or a person. A receipt that matches a payment by vendor, amount and day counts as evidence even when nobody linked them; receipts split between business and private make a counterparty "Teils, teils"; payment-service prefixes no longer split one merchant into dozens of counterparties; a payment linked to one of the company's own invoices is business income; and in a year whose return is filed, nothing is asked any more, because the return already says what was business.
type: plan
status: in-progress
tags: [receipts, payments, classification, tax]
projects: [receipt-ocr-app]
date: 2026-10-25
---

# The filed return decides the counterparties

## Why

The owner, 2026-10-25, on the open proposals (211 counterparties for 2026, 222 for 2025): "we
already filled the report for 2025, so we should be really sure about the splits of, for
example, telecom, freenet, online shops, the betriebliche Ausgaben, the private ones. We should
actually be able to predict that very, very accurately."

He is right. The 2025 return was built from the receipts in this app (241 under Whiz-Art Media,
with their assignment and shares), so for 2025 the answer per payment already exists. The app
does not use it, for four reasons found on production on 2026-10-25:

1. **Receipts are never matched to outgoing payments by themselves.** Only incoming payments are
   linked automatically, to the company's own invoices (`linkByReference` in
   `src/lib/tax/payments/service.ts`). Telekom Deutschland has 12 payments of 39.95 EUR in 2025
   and 12 receipts of 39.95 EUR, and not one is linked ("Beleg wählen" on every payment). A
   receipt is only proposed for a payment the owner already called business (`needing` in
   `src/lib/tax/service.ts`), so a counterparty nobody answered never gets one.
2. **The classifier only counts linked receipts** (`counterpartyEvidence` in
   `src/lib/tax/payments/classify-service.ts`), so unlinked Telekom receipts say nothing.
3. **Split receipts say nothing.** `receiptVerdict` (`src/lib/tax/payments/classify.ts`) returns
   no verdict as soon as one receipt is split between business and private, although that is
   exactly what "Teils, teils" means. Telekom and freenet carry 50 percent business and 30
   percent study.
4. **Payment-service prefixes split a merchant.** The counterparty key keeps the order code after
   the prefix: "AMAZON* KT2PC3H85" and "AMAZON PRIM* RM6YU97N4" are separate counterparties with
   one payment each (29 Amazon lines in the 2025 list). neverless needed three answers
   ("neverless.com", "PSP*neverless.com", "Neverless Labs SL").

A fifth gap showed with On AG: the four payments linked to invoices 33, 34, 39 and 40 are business
income for certain, but invoice links are not evidence, so the model guessed from the amount.

## Decisions (taken by the coordinating session on 2026-10-25, say so if you disagree)

1. **A receipt that matches is evidence, linked or not.** For the classifier, a payment counts as
   "paid by" a receipt when exactly one unlinked receipt of the same vendor (vendor key equal to
   the counterparty key, or a vendor learned from an existing link) has the same amount and a day
   within the window `proposeMatches` already uses, and that receipt fits no other payment. This
   is the existing `amount_date_vendor` candidate, used as evidence only: no link is written, the
   owner's rule that amount and date alone never link stays. Linking stays a click (and the
   payments tab offers these pairs as candidates for every counterparty, not only answered ones).
2. **Split receipts make "Teils, teils".** When at least half of a counterparty's payments are
   paid by receipts (linked or matched) and those receipts are split, or are of both kinds, the
   verdict is "Teils, teils", certain. All business stays business, all private stays private, as
   today.
3. **One merchant, one counterparty.** The counterparty key drops payment-service prefixes and the
   order code behind them: `AMAZON*`, `AMZN Mktp`, `AMZN`, `PAYPAL *`, `PP*`, `PSP*`, `SumUp *`,
   `SQ *`, `ZETTLE_*`, `GOOGLE *`, `APPLE.COM/BILL`. The list is data in one module with tests on
   real payment texts. Stored answers and verdicts under an old key are carried to the new key by
   a migration; where two old keys of one merchant hold different answers, the person's answer
   wins over the app's, and of two different person answers neither is carried (the merchant is
   asked again, and the migration logs how many).
4. **A payment linked to an own invoice is business evidence** for income: all incoming payments
   of a counterparty linked to invoices make it business, certain. Outgoing payments of the same
   counterparty (buying in the On shop) keep their own question; the existing safeguard that the
   model never calls a payer non-business alone is unchanged.
5. **A filed year asks nothing.** For a payment whose year is recorded as filed
   (`tax_year_settings.filed_on`), the return already gave the answer: paid by a business or
   split receipt means it was claimed as that receipt says; anything else was not claimed. So:
   - payments of filed years are not listed under "Wer ist das?" and raise no open check;
   - a counterparty whose payments all lie in filed years and of which none is paid by a business
     or split receipt gets the verdict "Privat", certain, reason "In der Erklärung {Jahr} nicht
     abgesetzt", unless the model proposes "Eigenes Konto" (a transfer to an own savings
     account), which stays a proposal as today (the model never decides own account alone);
   - a counterparty with payments in open years too is decided for the open years by the rules
     above and the model, with the filed years' result as evidence passed to it.
   A person's answer still wins over all of this, so a forgotten business expense can still be
   answered business (it then shows as a receipt to add, which the owner can take into an
   amended return or leave).
6. **Order of the evidence**: person > own names > invoice links > receipts (linked or matched) >
   filed year > model, the first that decides wins. The fingerprint of a verdict covers the new
   evidence too (matched receipts, invoice links, the filed days), so a change in any of them
   decides that counterparty again exactly once.

## Expected effect (to be measured, not promised)

For 2025 the open list should shrink to own-account transfers and the few counterparties a
person must name; for 2026, Telekom, freenet, Amazon and the other split vendors move from
proposals to decided. The run reports, per rule, how many counterparties it decided, and the
build reports the before and after counts on production.

## Build order

1. The key normalization with its migration (decision 3), tests on real texts.
2. Matched receipts and invoice links in `counterpartyEvidence`, the split rule (decisions 1, 2,
   4), the fingerprint.
3. The filed-year rule (decision 5) in the evidence step and in the payments tab and open checks.
4. Fresh-agent review, pull request, land-pr. After the deploy, run "Jetzt einordnen" on
   production and report the counts per year before and after.

## Tests (four paths, standard `stateful-flow-testing.md`)

- Forward: 12 Telekom payments and 12 split receipts give "Teils, teils" without a link and
  without a model call; Amazon payments with order codes share one key; a counterparty only in a
  filed year with no matching receipt is private; an invoice-linked income is business.
- Backtrack and revise: clearing a filing day brings the filed-year questions back and the
  verdicts that rested on it are made again; a person's answer overrides every rule; unlinking a
  receipt changes the evidence once.
- Resume: a reload shows the same verdicts, nothing stored but verdicts and answers.
- Re-entry: a second run decides nothing already decided; the key migration run twice changes
  nothing the second time.

## Reality (decided while building, 2026-10-26, say so if you disagree)

- **PayPal and Klarna keep their name in the key.** The funding rule (`funding.ts`) recognizes a
  bank debit that pays a PayPal or Klarna purchase by the word "paypal" or "klarna" in the
  counterparty; cutting "PAYPAL *" off would count those purchases twice. So decision 3 cuts only
  merchants with an order code behind the star (Amazon, Amazon Prime, eBay, Airbnb, Lime,
  Revolut, A2 Hosting, Moneynet, Uber) and card terminal providers in front of the shop (SumUp,
  Zettle, Square, SPC, UZR, NYX, NYA, EDK, Eventbrite, CCV, FastSpring, Mollie, PSP), taken from
  the 147 coded names among the 781 counterparties on production (`src/lib/tax/payments/merchant.ts`,
  tests on those shapes). `PP*` (PayPal) is left alone for the same reason. The payment text
  (reference) is still keyed as before, because the funding rule reads it too.
- **Carrying the keys** (`rekey.ts`) runs once per key version, for all companies together (answers
  of one company apply to payments another holds, also across tenants), before anything reads or
  writes a key: the payments' load, every import and bank fetch, every answer that stores a key, the
  spending page and the shop budgets call `ensureMerchantKeys`. A stored marker (`tax_key_versions`,
  migration 0041) says it is done; afterwards a call costs one lookup, then nothing in that process.
  It always runs in a transaction of its own, taking its database lock before any row lock, never
  inside a caller's transaction (a refused link would roll it back while the process believed it
  done); every function that opens a transaction and reads keys inside carries first. The daily
  bank run sweeps once more whatever does not fit the current key, for rows an older server version
  still wrote during a deploy. Rules, category answers and shop budgets are
  carried by their own name and get the merchant's name as their label; disagreeing ones of a
  person are dropped and logged; verdicts on a changed key, and on every key that took over
  payments, are removed and made again (a verdict made on 2 payments must not cover 300).
- **"The same movement" stays judged by the full name.** Import de-duplication (`matchStored`,
  `adoptUnreferenced`) compares the full counterparty, never the merchant key: two Amazon orders on
  one day are two movements.
- **Matching without a link pairs one to one, the closest days first** (`pairReceipts`), with the
  missing-receipt loop's own candidates. "Exactly one candidate" would have matched no monthly
  bill: every payment of a 39.95 EUR line also fits the month before. A tie pairs nothing.
- **A share left open is private.** A receipt stored as "50 percent business, 30 percent study"
  carries no private line; the 20 percent left are private, so it counts as split. Without this
  the Telekom receipts read as all business.
- **The filed-year rule asks the model first.** A transfer to an own savings account looks like
  "not claimed" too. A counterparty the model already called an own account keeps that proposal;
  one it called anything else is private by the filed return; one it was never asked about is asked
  first, and is private unless the model says own account (without a model, the filed year decides
  alone).
- **Fingerprints use classes, not counts**, where a count grows with every payment: whether half
  the payments are paid by receipts, whether all money in pays invoices, whether money also went
  out to an invoice payer. A new invoice payment asks nobody again; the first purchase from a
  client does.
- **The model hears about invoices** ("4 of 4 payments received pay the person's own invoices"),
  also for a client that is a shop too, where the invoices alone decide nothing.
- **The PayPal twin of a bank debit** is still found by the purchase's full name, not the shorter
  merchant key.
- **The filed-year rule does not trust a missed match.** Matching needs the exact amount and a near
  day, so a receipt with a tip, far from its payment, in another currency outside 8 percent or
  without a rate is not paired. Any business or split receipt dated in a filed year whose vendor the
  counterparty's name names keeps the rule out (the payment texts are not read for this: "Apple Pay"
  in a text would let one Apple invoice block every shop) (the model decides instead, told what the filed years hold). A
  payment between 22 December and 10 January counts as a filed-year payment only when the year next
  to it is filed too, because the ten-day rule may count it there.
- **Invoices decide only when all money in pays them.** A payer with invoice payments and other
  money in beside them gets "business, likely", a proposal.
- **The app's "Teils, teils" moves nothing to a receiving company.** Its business part is a
  receipt the holder has but nobody linked, so routing (plan 2026-10-22) ignores it
  (`routingTreatments`); a person's "Teils, teils" still moves what has no receipt linked.
- **A person's "business" in a filed year** still shows its payments as receipts to add.
- **The spending side keeps its receipt checks for filed years.** The missing-receipt loop on the
  spending page (Ausgaben, Belege) asks for a document for every purchase, private ones included
  (plan 2026-10-14, decision 3); it already listed 2025 payments before this change and does not read
  the filing day. Only Finanzen stops asking.
- **Merchant names in the lists.** "Wer ist das?" and what the app decided show the merchant's
  name ("Amazon"), not the first coded spelling, and an answer saved under it has the same key.
- **No new candidates in the payments tab.** The spending page's receipt checks (Ausgaben, Belege)
  already propose these pairs for every payment, answered or not, so decision 1's aside needed no
  change there.
- **A filed year's payments tab** lists nothing under "Wer ist das?" and asks for no receipt, and
  says why ("Die Erklärung {Jahr} ist am … abgegeben").
- **Accepted:** a budget warning already sent for a coded shop name is sent once more after its
  budget is carried to the merchant (its subject contains the key). It happens at most once, only
  where a budget was set on a coded name.
