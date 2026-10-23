---
title: The year-change list answers itself
summary: Payments between 22 December and 10 January no longer wait for a person. A year whose return is filed fixes them the way it was filed, and for open years a rule decides from the payment data (a subscription billed on its own period start stays in the year it was paid, an advance payment of value-added tax in early January belongs to the year before). A person's answer still overrides, and only what no rule settles is asked.
type: plan
status: decided
tags: [receipts, tax, year-boundary, payments]
projects: [receipt-ocr-app]
date: 2026-10-23
---

# The year-change list answers itself

## Why

The owner, 2026-10-23: the year-change list ("Jahreswechsel") "should be ruled out automatically,
as we have all payment bank accounts, Klarna and PayPal, so we know in which year what belongs,
also based on the tax reports that have been sent and filed already."

The list is the ten-day rule of section 11 of the income tax act (Einkommensteuergesetz):
a regularly recurring payment that falls due and is paid between 22 December and 10 January
counts for the year it belongs to, not the year it was paid in (`src/lib/tax/year-boundary.ts`).
Today nothing moves without a person's answer per payment. On 2026-10-23 production showed 17
open entries for Whiz-Art Media, all on the turn 2025 to 2026: Cursor, Google, Patreon, Akamai,
OpenAI, Anthropic, Apple and similar subscriptions, most of them on their receipt date because no
payment is linked.

Two facts settle most of it:

- **2025 is filed.** The owner stated on 2026-10-17 (plan 2026-10-11-pay-later-payments,
  decision 40) that the 2025 return was filed with every purchase on the day it was paid. 2021 to
  2024 are filed as well (plan 2026-10-11-import-tax-years-2021-2024). A payment on the turn of a
  filed year was declared in the year it was paid. Moving it now would make the app differ from
  the filed return, in either direction: a December 2025 payment moved to 2026 would leave 2025
  and count twice, a January 2026 payment moved to 2025 would be claimed in a return that is
  closed.
- **A subscription billed on its own period start belongs to the year of that day.** Cursor on
  26.12.2025 pays the month from 26.12.2025; OpenAI on 04.01.2026 pays the month from 04.01.2026.
  Neither is due for the other year, so the exception does not apply and they stay.

## Decisions (decided by the coordinating session on 2026-10-23, say so if you disagree)

1. **Filed years are recorded.** `TaxYearSettings` gets `filed_on` (a day, null for open). The
   income-tax tab shows "Erklärung {Jahr} abgegeben am …" with a control to set or clear it.
   The migration only adds the column; no company's facts go into schema history. After the
   deploy the coordinating session sets 2021 to 2025 as filed in Whiz-Art Media through that
   control on production, with the day the owner last confirmed it where the real day is not on
   record (2026-10-17 for 2025, 2026-10-11 for 2021 to 2024). The owner can correct each day in
   the tab.
2. **A filed year fixes its turn.** Every entry whose paid year or other year is filed gets the
   derived answer "bleibt im Zahlungsjahr", shown as "Festgelegt durch die abgegebene Erklärung
   {Jahr}". A stored answer saved before the filing day stays as it was (it was filed that way);
   a stored answer saved after it, that would move a payment across a filed year, is not applied
   and is shown with "Weicht von der abgegebenen Erklärung {Jahr} ab", so it is visible and can be
   taken back instead of silently changing a filed year.
3. **Rules for open years**, derived on read, overridable by a person's answer:
   - Value-added tax payments and refunds to or from the tax office: only where the company was
     regularly taxed on that day (`WorkspaceTaxSettings.smallBusiness` false and a
     `vatFrequency` set, so advance returns recur), one paid 1 to 10 January belongs to the year
     before (the advance return for December or the fourth quarter is due on 10 January), and one
     paid 22 to 31 December stays (it pays an earlier period of that year). Under section 19 of
     the value-added tax act (small business, Kleinunternehmer) there are no recurring advance
     payments: a payment to the tax office, such as reverse-charge tax under section 13b declared
     only for the period it arose in, is not regularly recurring and stays in the year it was
     paid. Reason shown: "Kleinunternehmer: keine regelmäßige Vorauszahlung". Narrowed on
     2026-10-23 after the owner pointed out that Whiz-Art Media is a small business.
   - A receipt of a counterparty that recurs (at least three months with a payment in the last
     twelve) stays in the year it was paid: it is billed at the start of the period it pays for.
     Reason shown: "Abo, Zeitraum beginnt am Zahltag".
   - A receipt that does not recur stays: the exception is only for regularly recurring payments.
     Reason shown: "einmalige Zahlung".
   - Only a recurring payment whose receipt names a service period lying wholly in the other year
     (rent for January paid on 28 December) moves; the reading of a service period is used only
     where the receipt already carries one. Anything else no rule settles stays in the list as an
     open question.
4. **Nothing is written by the rules.** The answer is worked out on every read, like the shares
   between companies (migration 0035). `TaxYearBoundaryAnswer` keeps meaning "a person said so"
   and overrides. Changing a filed day, linking a payment or answering a counterparty recomputes
   the list at once.
5. **The tab shows the reason for every entry** and counts as open only what has neither a
   person's answer nor a rule. The "Jahreswechsel" tab count in the finance page shows that open
   number, expected to be zero for 2025/2026.

## Tests (four paths, standard `stateful-flow-testing.md`)

- Forward: the 17 kinds of entries resolve to their rule; the filed year locks its turn; the
  statement totals of a filed year do not change.
- Backtrack and revise: clearing a filed day unlocks the turn and the open-year rules apply;
  a person's answer overrides a rule and taking it back returns the rule; a counterparty that
  stops recurring changes its reason.
- Resume: reload shows the same derived answers (nothing stored but the filed day).
- Re-entry: setting the same filed day twice is a no-op; a stored answer after the filing day is
  reported, never applied.

## Build order

1. Migration (`filed_on`), the filed-day control in the income-tax tab.
2. Derived answers in `loadStatement` (`src/lib/tax/service.ts`) and the reasons in
   `YearBoundaryTab`. Wait for the PayPal live pull request (branch `feat/paypal-live`, which also
   changes `src/lib/tax/service.ts`) to merge, then rebase before opening the pull request; take
   the next free migration number at that point.
3. Fresh-agent review, pull request, land-pr. Afterwards check on production that the open count
   for 2025/2026 is zero.
